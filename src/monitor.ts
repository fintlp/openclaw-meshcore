import { Constants } from "@liamcottle/meshcore.js";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { resolveMeshcoreAccount } from "./accounts.js";
import { createAccountStatusSink } from "./channel-api.js";
import {
  contactHasMissingMetadata,
  getContactByPubkey,
  POSITION_RESYNC_AFTER_MS,
  rememberContact,
} from "./contact-book.js";
import {
  createThrottledContactSync,
  syncContactsFromNode,
} from "./contact-sync.js";
import {
  connectMeshcoreDevice,
  disconnectMeshcoreDevice,
  getMeshcoreDevice,
  resolveSenderNodeId,
  type MeshcoreDeviceHandle,
} from "./device-client.js";
import { appendGroupLogEntry } from "./group-log.js";
import { isOutboundEcho, rememberOutboundEcho } from "./echo-dedupe.js";
import { updateNodeStatusOps } from "./node-status.js";
import { handleMeshcoreInbound } from "./inbound.js";
import {
  formatMeshcoreChannelTarget,
  formatMeshcoreNodeId,
  isMeshcoreGroupTarget,
  parseMeshcoreChannelIndex,
  parseMeshcoreNodeId,
} from "./normalize.js";
import { bytesToHex } from "./protocol.js";
import { formatMeshcoreEndpoint } from "./transport.js";
import { getMeshcoreRuntime } from "./runtime.js";
import { sendMessageMeshcore } from "./send.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";

const CHANNEL_ID = "meshcore" as const;

// Track the last staleness-based position re-sync per contact so a moving
// peer triggers at most one getContacts call per POSITION_RESYNC_AFTER_MS window.
const lastPositionResyncByContact = new Map<string, number>();

function positionResyncKey(accountId: string, pubkeyHex: string): string {
  return `${accountId}:${pubkeyHex}`;
}

/** @internal Reset staleness-based re-sync tracking; tests only. */
export function resetPositionResyncStateForTests(): void {
  lastPositionResyncByContact.clear();
}

function shouldResyncPosition(stored: { lastAdvert: number }, accountId: string, pubkeyHex: string): boolean {
  if (stored.lastAdvert <= 0) {
    return false;
  }
  const elapsedMs = Date.now() - stored.lastAdvert * 1000;
  if (elapsedMs <= POSITION_RESYNC_AFTER_MS) {
    return false;
  }
  const key = positionResyncKey(accountId, pubkeyHex);
  const lastResync = lastPositionResyncByContact.get(key) ?? 0;
  if (Date.now() - lastResync <= POSITION_RESYNC_AFTER_MS) {
    return false;
  }
  lastPositionResyncByContact.set(key, Date.now());
  return true;
}

export type MeshcoreMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastError?: string;
    connected?: boolean;
    lastConnectedAt?: number;
    lastEventAt?: number;
    lastTransportActivityAt?: number;
  }) => void;
  onMessage?: (
    message: MeshcoreInboundMessage,
    handle: MeshcoreDeviceHandle,
  ) => void | Promise<void>;
  reconnectCount?: number;
  lastRestartReason?: string;
  lastRestartAt?: number;
};

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function channelIndexFromPacket(channel: number): number {
  if (Number.isFinite(channel) && channel >= 0 && channel <= 7) {
    return channel;
  }
  return 0;
}

function messageIdFromContactMessage(message: {
  pubKeyPrefix?: Uint8Array;
  senderTimestamp?: number;
  text?: string;
}): string {
  const prefix = message.pubKeyPrefix
    ? Array.from(new Uint8Array(message.pubKeyPrefix))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    : "unknown";
  const timestamp = Number(message.senderTimestamp ?? Date.now());
  const hash = String(message.text ?? "").slice(0, 20);
  return `mc-dm-${prefix}-${timestamp}-${hash}`;
}

function messageIdFromChannelMessage(message: {
  channelIdx?: number;
  senderTimestamp?: number;
  text?: string;
}): string {
  const channel = Number(message.channelIdx ?? 0);
  const timestamp = Number(message.senderTimestamp ?? Date.now());
  const hash = String(message.text ?? "").slice(0, 20);
  return `mc-ch-${channel}-${timestamp}-${hash}`;
}

/**
 * The pinned dependency does not skip the 4 signature bytes that precede the
 * text in a SignedPlain (txtType === 2) contact message. Re-encode the parsed
 * string, drop the first four bytes, and decode the remainder so the payload
 * flows into the inbound handler without leading garbage.
 */
function stripSignedPlainPrefix(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return new TextDecoder().decode(bytes.slice(4));
}

export function buildInboundMessage(params: {
  message: Record<string, unknown>;
  handle: MeshcoreDeviceHandle;
  isGroup: boolean;
}): MeshcoreInboundMessage | null {
  const text = String(params.message.text ?? "").trim();
  if (!text) {
    return null;
  }
  if (isOutboundEcho(text)) {
    return null;
  }

  const meshChannel = channelIndexFromPacket(Number(params.message.channelIdx ?? 0));

  if (params.isGroup) {
    const target = formatMeshcoreChannelTarget(meshChannel);
    return {
      messageId: messageIdFromChannelMessage(params.message),
      target,
      senderNodeId: target,
      text,
      timestamp: Number(params.message.senderTimestamp ?? Date.now()) * 1000,
      isGroup: true,
      meshChannel,
      snr: typeof params.message.snr === "number" ? params.message.snr : undefined,
    };
  }

  const pubKeyPrefix = params.message.pubKeyPrefix;
  const prefixBytes =
    pubKeyPrefix instanceof Uint8Array
      ? pubKeyPrefix
      : Array.isArray(pubKeyPrefix)
        ? new Uint8Array(pubKeyPrefix)
        : new Uint8Array(0);

  const { nodeId, name } = resolveSenderNodeId({
    pubkeyPrefix: prefixBytes,
    contacts: params.handle.contacts,
  });

  return {
    messageId: messageIdFromContactMessage(params.message),
    target: nodeId,
    senderNodeId: nodeId,
    senderName: name,
    text,
    timestamp: Number(params.message.senderTimestamp ?? Date.now()) * 1000,
    isGroup: false,
    meshChannel,
    snr: typeof params.message.snr === "number" ? params.message.snr : undefined,
  };
}

export function formatInboundLogLine(params: {
  accountId: string;
  message: MeshcoreInboundMessage;
  logMessageContent: boolean;
}): string {
  const kind = params.message.isGroup ? "group" : "dm";
  const meta = `[${params.accountId}] inbound ${kind} from ${params.message.senderNodeId} on ${params.message.target} id=${params.message.messageId}`;
  if (!params.logMessageContent) {
    return `${meta} (${params.message.text.length} chars)`;
  }
  return `${meta}: ${params.message.text.slice(0, 80)}`;
}

export function monitorMeshcoreProvider(
  opts: MeshcoreMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getMeshcoreRuntime();
  const cfg = opts.config ?? (core.config.current() as CoreConfig);
  const account = resolveMeshcoreAccount({
    cfg,
    accountId: opts.accountId,
  });

  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.configured) {
    return Promise.reject(
      new Error(
        `MeshCore is not configured for account "${account.accountId}" (need host in channels.meshcore).`,
      ),
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "meshcore",
    accountId: account.accountId,
  });
  const logMessageContent = account.config.logInboundMessageContent === true;

  return (async () => {
    const handle = await connectMeshcoreDevice({
      accountId: account.accountId,
      host: account.host,
      port: account.port,
      reconnectCount: opts.reconnectCount ?? 0,
      lastRestartReason: opts.lastRestartReason,
      lastRestartAt: opts.lastRestartAt,
      advertLat: account.config.advertLat,
      advertLon: account.config.advertLon,
    });

    const allowedChannels = new Set(account.config.channels ?? [0]);
    const unsubscribers: Array<() => void> = [];
    let settled = false;
    let resolveMonitor: ((value: { stop: () => void }) => void) | null = null;
    let rejectMonitor: ((reason: Error) => void) | null = null;
    const groupMonitorMode = account.config.groupMonitorMode ?? "digest";

    function extractSenderPubkeyPrefix(message: Record<string, unknown>): string | undefined {
      const prefix = message.pubKeyPrefix;
      const bytes =
        prefix instanceof Uint8Array
          ? prefix
          : Array.isArray(prefix)
            ? new Uint8Array(prefix as number[])
            : undefined;
      if (!bytes || bytes.length === 0) {
        return undefined;
      }
      return bytesToHex(bytes.slice(0, 6)).toLowerCase();
    }

    const contactSync = createThrottledContactSync({
      getContacts: async () => handle.connection.getContacts(),
      rememberContact,
      accountId: account.accountId,
      log: (message) => logger.info(message),
      debugLog: (message) => {
        if (core.logging.shouldLogVerbose()) {
          logger.debug?.(message);
        }
      },
      throttleMs: 60_000,
    });

    const doCleanup = () => {
      if (settled) return;
      settled = true;
      contactSync.dispose();
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      clearInterval(pollTimer);
      void disconnectMeshcoreDevice(account.accountId);
    };

    const onContactMsgRecv = (message: Record<string, unknown>) => {
      opts.statusSink?.({
        lastEventAt: Date.now(),
        lastTransportActivityAt: Date.now(),
      });
      void (async () => {
        try {
          if (Number(message.txtType) === 2) {
            message.text = stripSignedPlainPrefix(String(message.text ?? ""));
          }
          const inbound = buildInboundMessage({ message, handle, isGroup: false });
          if (!inbound) {
            return;
          }
          logger.info(
            formatInboundLogLine({
              accountId: account.accountId,
              message: inbound,
              logMessageContent,
            }),
          );
          core.channel.activity.record({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            direction: "inbound",
            at: inbound.timestamp,
          });
          if (opts.onMessage) {
            await opts.onMessage(inbound, handle);
            return;
          }
          await handleMeshcoreInbound({
            message: inbound,
            account,
            config: cfg,
            runtime,
            sendReply: async (target, text, replyToId) => {
              try {
                const { sendMessageMeshcore } = await import("./send.js");
                await sendMessageMeshcore(target, text, {
                  cfg,
                  accountId: account.accountId,
                  replyTo: replyToId,
                  deviceHandle: handle,
                });
                rememberOutboundEcho(text);
                opts.statusSink?.({ lastOutboundAt: Date.now() });
                core.channel.activity.record({
                  channel: CHANNEL_ID,
                  accountId: account.accountId,
                  direction: "outbound",
                });
              } catch (err) {
                // A failed reply (e.g. a pairing challenge to a prefix-only sender whose
                // full pubkey is not yet known) must not fail the inbound/pairing flow.
                console.error(
                  `[${account.accountId}] DM reply to ${target} failed (non-fatal): ${String(err)}`,
                );
              }
            },
            statusSink: opts.statusSink,
          });
        } catch (err) {
          const line = `[${account.accountId}] DM inbound handler failed: ${String(err)}`;
          logger.error?.(line);
          runtime.error?.(line);
        }
      })();
    };

    const onChannelMsgRecv = (message: Record<string, unknown>) => {
      opts.statusSink?.({
        lastEventAt: Date.now(),
        lastTransportActivityAt: Date.now(),
      });
      void (async () => {
        try {
          const inbound = buildInboundMessage({ message, handle, isGroup: true });
          if (!inbound) {
            return;
          }
          const meshChannel = channelIndexFromPacket(Number(message.channelIdx ?? 0));
          if (!allowedChannels.has(meshChannel)) {
            if (core.logging.shouldLogVerbose()) {
              logger.debug?.(
                `[${account.accountId}] skip mesh channel ${meshChannel} (not in allowlist)`,
              );
            }
            return;
          }

          logger.info(
            formatInboundLogLine({
              accountId: account.accountId,
              message: inbound,
              logMessageContent,
            }),
          );

          core.channel.activity.record({
            channel: CHANNEL_ID,
            accountId: account.accountId,
            direction: "inbound",
            at: inbound.timestamp,
          });

          if (groupMonitorMode === "digest") {
            appendGroupLogEntry({
              ts: new Date().toISOString(),
              channel: inbound.target,
              senderPubkeyPrefix: extractSenderPubkeyPrefix(message),
              name: inbound.senderName,
              text: inbound.text,
            });
            return;
          }

          if (opts.onMessage) {
            await opts.onMessage(inbound, handle);
            return;
          }

          await handleMeshcoreInbound({
            message: inbound,
            account,
            config: cfg,
            runtime,
            sendReply: async () => {
              runtime.error?.(
                `[${account.accountId}] blocked outbound reply to group ${inbound.target}: groups are receive-only`,
              );
            },
            statusSink: opts.statusSink,
          });
        } catch (err) {
          const line = `[${account.accountId}] channel inbound handler failed: ${String(err)}`;
          logger.error?.(line);
          runtime.error?.(line);
        }
      })();
    };

    const onDisconnected = () => {
      const now = Date.now();
      updateNodeStatusOps({ connectionState: "disconnected", since: toIso(now) });
      opts.statusSink?.({
        connected: false,
        lastEventAt: now,
        lastTransportActivityAt: now,
      });
      if (settled) return;
      doCleanup();
      rejectMonitor?.(new Error("MeshCore device disconnected"));
    };

    // meshcore.js emits response events by NUMERIC code (Constants.ResponseCodes):
    // ContactMsgRecv = 7 (ContactMsgRecvV3 = 16 is normalised into 7 by the library),
    // ChannelMsgRecv = 8 (ChannelMsgRecvV3 = 17 -> 8). Only connected/disconnected/error/rx/tx
    // are emitted as strings. Registering on the friendly names never fires.
    const EVENT_CONTACT_MSG_RECV = 7;
    const EVENT_CHANNEL_MSG_RECV = 8;
    handle.connection.on(EVENT_CONTACT_MSG_RECV, onContactMsgRecv);
    handle.connection.on(EVENT_CHANNEL_MSG_RECV, onChannelMsgRecv);
    handle.connection.on("disconnected", onDisconnected);

    unsubscribers.push(() => handle.connection.off(EVENT_CONTACT_MSG_RECV, onContactMsgRecv));
    unsubscribers.push(() => handle.connection.off(EVENT_CHANNEL_MSG_RECV, onChannelMsgRecv));
    unsubscribers.push(() => handle.connection.off("disconnected", onDisconnected));

    // Advert pushes carry full pubkeys (PushCodes.Advert = 0x80 in auto-add mode,
    // PushCodes.NewAdvert = 0x8A in manual-add mode) — cache them so 6-byte DM
    // prefixes become addressable reply targets. NewAdvert carries the full
    // contact metadata advertised by the peer; store every field in the contact
    // book (issue #11).
    const EVENT_ADVERT = 0x80;
    const EVENT_NEW_ADVERT = 0x8a;
    const onAdvert = (advert: Record<string, unknown>) => {
      try {
        const pk = advert.publicKey;
        const bytes =
          pk instanceof Uint8Array
            ? pk
            : Array.isArray(pk)
              ? new Uint8Array(pk as number[])
              : undefined;
        if (!bytes || bytes.length !== 32) {
          return;
        }
        rememberContact(
          {
            publicKey: bytes,
            type: typeof advert.type === "number" ? advert.type : undefined,
            flags: typeof advert.flags === "number" ? advert.flags : undefined,
            outPathLen: typeof advert.outPathLen === "number" ? advert.outPathLen : undefined,
            outPath:
              advert.outPath instanceof Uint8Array
                ? advert.outPath
                : Array.isArray(advert.outPath)
                  ? new Uint8Array(advert.outPath as number[])
                  : undefined,
            advName: typeof advert.advName === "string" ? advert.advName : undefined,
            lastAdvert: typeof advert.lastAdvert === "number" ? advert.lastAdvert : undefined,
            advLat: typeof advert.advLat === "number" ? advert.advLat : undefined,
            advLon: typeof advert.advLon === "number" ? advert.advLon : undefined,
            lastMod: typeof advert.lastMod === "number" ? advert.lastMod : undefined,
          },
          account.accountId,
        );
      } catch {
        // best-effort cache
      }
    };
    const onNewAdvert = (advert: Record<string, unknown>) => {
      // 0x8A arrives with full metadata; store it directly.
      onAdvert(advert);
    };

    const onLegacyAdvert = (advert: Record<string, unknown>) => {
      // 0x80 only carries the pubkey for known contacts. Remember what we have,
      // then schedule a debounced contact-list sync if the stored entry still
      // lacks metadata, or if the stored position is stale enough that a moving
      // peer may have updated coordinates (issue #18 item 3).
      onAdvert(advert);
      try {
        const pk = advert.publicKey;
        const bytes =
          pk instanceof Uint8Array
            ? pk
            : Array.isArray(pk)
              ? new Uint8Array(pk as number[])
              : undefined;
        if (!bytes || bytes.length !== 32) {
          return;
        }
        const stored = getContactByPubkey(bytes, account.accountId);
        if (!stored) {
          return;
        }
        if (contactHasMissingMetadata(stored)) {
          contactSync.schedule();
          return;
        }
        const pubkeyHex = bytesToHex(bytes).toLowerCase();
        if (shouldResyncPosition(stored, account.accountId, pubkeyHex)) {
          contactSync.schedule();
        }
      } catch {
        // best-effort scheduling
      }
    };

    handle.connection.on(EVENT_ADVERT, onLegacyAdvert);
    handle.connection.on(EVENT_NEW_ADVERT, onNewAdvert);
    unsubscribers.push(() => handle.connection.off(EVENT_ADVERT, onLegacyAdvert));
    unsubscribers.push(() => handle.connection.off(EVENT_NEW_ADVERT, onNewAdvert));

    // SendConfirmed pushes (0x82): update transport activity timestamp
    const onSendConfirmed = () => {
      opts.statusSink?.({
        lastEventAt: Date.now(),
        lastTransportActivityAt: Date.now(),
      });
    };
    handle.connection.on(Constants.PushCodes.SendConfirmed, onSendConfirmed);
    unsubscribers.push(() => handle.connection.off(Constants.PushCodes.SendConfirmed, onSendConfirmed));

    // Periodically drain any queued messages (firmware may emit MsgWaiting push).
    const pollTimer = setInterval(() => {
      void (async () => {
        try {
          await handle.connection.getWaitingMessages();
        } catch {
          // Best-effort polling.
        }
      })();
    }, 5_000);

    opts.statusSink?.({
      connected: true,
      lastConnectedAt: Date.now(),
      lastEventAt: Date.now(),
      lastTransportActivityAt: Date.now(),
    });

    // One-shot contact-list sync on connect: fetches full metadata for contacts
    // the node already knows about (issue #11).
    void syncContactsFromNode({
      getContacts: async () => handle.connection.getContacts(),
      rememberContact,
      accountId: account.accountId,
      log: (message) => logger.info(message),
      debugLog: (message) => {
        if (core.logging.shouldLogVerbose()) {
          logger.debug?.(message);
        }
      },
    });

    logger.info(
      `[${account.accountId}] connected to MeshCore at ${formatMeshcoreEndpoint({ host: account.host, port: account.port })}`,
    );

    return new Promise<{ stop: () => void }>((resolve, reject) => {
      resolveMonitor = resolve;
      rejectMonitor = reject;

      const onAbort = () => {
        if (settled) return;
        doCleanup();
        resolve({ stop: () => {} });
      };
      opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

      if (settled) {
        opts.abortSignal?.removeEventListener("abort", onAbort);
        reject(new Error("MeshCore device disconnected during startup"));
      }
    });
  })();
}
