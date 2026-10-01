import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { resolveMeshcoreAccount } from "./accounts.js";
import { createAccountStatusSink } from "./channel-api.js";
import {
  connectMeshcoreDevice,
  disconnectMeshcoreDevice,
  getMeshcoreDevice,
  rememberAdvertContact,
  resolveSenderNodeId,
  type MeshcoreDeviceHandle,
} from "./device-client.js";
import { isOutboundEcho, rememberOutboundEcho } from "./echo-dedupe.js";
import { handleMeshcoreInbound } from "./inbound.js";
import {
  formatMeshcoreChannelTarget,
  formatMeshcoreNodeId,
  isMeshcoreGroupTarget,
  parseMeshcoreChannelIndex,
  parseMeshcoreNodeId,
} from "./normalize.js";
import { formatMeshcoreEndpoint } from "./transport.js";
import { getMeshcoreRuntime } from "./runtime.js";
import { sendMessageMeshcore } from "./send.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";

const CHANNEL_ID = "meshcore" as const;

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
};

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
    });

    const allowedChannels = new Set(account.config.channels ?? [0]);
    const unsubscribers: Array<() => void> = [];
    let settled = false;
    let resolveMonitor: ((value: { stop: () => void }) => void) | null = null;
    let rejectMonitor: ((reason: Error) => void) | null = null;

    const doCleanup = () => {
      if (settled) return;
      settled = true;
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
      opts.statusSink?.({
        connected: false,
        lastEventAt: Date.now(),
        lastTransportActivityAt: Date.now(),
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
    // prefixes become addressable reply targets.
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
        if (bytes && bytes.length === 32) {
          rememberAdvertContact(
            bytes,
            typeof advert.advName === "string" && advert.advName.trim()
              ? advert.advName
              : undefined,
          );
        }
      } catch {
        // best-effort cache
      }
    };
    handle.connection.on(EVENT_ADVERT, onAdvert);
    handle.connection.on(EVENT_NEW_ADVERT, onAdvert);
    unsubscribers.push(() => handle.connection.off(EVENT_ADVERT, onAdvert));
    unsubscribers.push(() => handle.connection.off(EVENT_NEW_ADVERT, onAdvert));

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
