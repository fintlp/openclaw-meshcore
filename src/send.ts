import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-message";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveMeshcoreAccount } from "./accounts.js";
import {
  attachSendConfirmedHandler,
  connectMeshcoreDevice,
  getMeshcoreDevice,
  nodeIdToPubkey,
  type MeshcoreDeviceHandle,
} from "./device-client.js";
import { rememberOutboundEcho } from "./echo-dedupe.js";
import {
  formatMeshcoreNodeId,
  isMeshcoreGroupTarget,
  normalizeMeshcoreMessagingTarget,
  parseMeshcoreChannelIndex,
  parseMeshcoreNodeId,
} from "./normalize.js";
import { withPacedSend, type WithPacedSendOptions } from "./pacing.js";
import { getMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";
import { resolveSendPacingConfig } from "./airtime.js";

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "send aborted");
}

/**
 * Race a sendTextMessage call against an AbortSignal. If the signal aborts
 * first, the abandoned library promise is swallowed so its late
 * settlement/rejection cannot surface as an unhandledRejection.
 */
function raceSendTextMessage(
  connection: MeshcoreDeviceHandle["connection"],
  pubkey: Uint8Array,
  chunk: string,
  signal: AbortSignal | undefined,
): Promise<{ expectedAckCrc?: number; estTimeout?: number }> {
  const sendPromise = connection.sendTextMessage(pubkey, chunk);
  if (!signal) {
    return sendPromise;
  }
  if (signal.aborted) {
    sendPromise.catch(() => {});
    return Promise.reject(createAbortError(signal.reason));
  }
  return new Promise<{ expectedAckCrc?: number; estTimeout?: number }>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", onAbort);
      }
    };
    sendPromise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    const onAbort = () => {
      cleanup();
      // Swallow the orphaned library promise so it cannot become an
      // unhandledRejection if it settles after we have already aborted.
      sendPromise.catch(() => {});
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type SendMeshcoreOptions = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
  target?: string;
  deviceHandle?: MeshcoreDeviceHandle;
  /** Internal override for the queue watchdog budget (tests only). */
  sendQueueBudgetMs?: number;
};

/** Error thrown when a paced send is aborted mid-sequence. */
export class MeshcoreSendAbortedError extends Error {
  constructor(
    message: string,
    public cause: string,
  ) {
    super(message);
    this.name = "MeshcoreSendAbortedError";
  }
}

const SEND_QUEUE_BUDGET_MIN_MS = 30_000;
const SEND_QUEUE_BUDGET_PAD_MS = 5_000;

type SendMeshcoreResult = {
  messageId: string;
  target: string;
  receipt: MessageReceipt;
};

// Empirical (issue #5): node firmware 1.16 truncates text frames at 127 bytes
// on the wire; chunking larger silently loses each chunk's tail at the joins.
export const MESHCORE_WIRE_CHUNK_LIMIT = 127;

function recordMeshcoreOutboundActivity(accountId: string): void {
  try {
    getMeshcoreRuntime().channel.activity.record({
      channel: "meshcore",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "MeshCore runtime not initialized") {
      throw error;
    }
  }
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function chunkText(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (utf8ByteLength(trimmed) <= limit) {
    return [trimmed];
  }
  // The wire frame limits BYTES, not characters: a code-point-sized chunk full
  // of multibyte runes (em-dashes, emoji, umlauts) overflows the frame and its
  // tail is truncated on air. Chunk by UTF-8 byte length, prefer whitespace
  // boundaries, and never split inside a multibyte character.
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  const pushCurrent = () => {
    const part = current.trim();
    if (part) {
      chunks.push(part);
    }
    current = "";
    currentBytes = 0;
  };
  for (const piece of trimmed.split(/(\s+)/)) {
    const pieceBytes = utf8ByteLength(piece);
    if (currentBytes > 0 && currentBytes + pieceBytes > limit) {
      pushCurrent();
    }
    if (pieceBytes > limit) {
      // Single word longer than the limit: hard-split at a byte-safe boundary.
      for (const ch of piece) {
        const chBytes = utf8ByteLength(ch);
        if (currentBytes > 0 && currentBytes + chBytes > limit) {
          pushCurrent();
        }
        current += ch;
        currentBytes += chBytes;
      }
    } else {
      current += piece;
      currentBytes += pieceBytes;
    }
  }
  pushCurrent();
  return chunks;
}

function prefixLengthForChunkCount(count: number): number {
  // Worst-case prefix is "[N/N] "; both numbers have the same digit count.
  // Invariant: index <= count implies digit-width(index) <= digit-width(count).
  return utf8ByteLength(`[${count}/${count}] `);
}

/**
 * Chunk text and prepend "[n/N] " to each chunk when numbering is enabled.
 * The prefix is budgeted inside the wire limit, and single-chunk messages
 * are never prefixed.
 */
function chunkTextWithNumbering(
  text: string,
  limit: number,
  numberingEnabled: boolean,
): string[] {
  let chunks = chunkText(text, limit);
  if (!numberingEnabled || chunks.length <= 1) {
    return chunks;
  }

  // The prefix length depends on the final chunk count. Re-chunk with a
  // reduced limit until the count stabilizes; the worst-case prefix for that
  // count is then safe for every chunk.
  while (true) {
    const count = chunks.length;
    const prefixLen = prefixLengthForChunkCount(count);
    const resized = chunkText(text, Math.max(1, limit - prefixLen));
    if (resized.length === count) {
      return resized.map((chunk, index) => `[${index + 1}/${count}] ${chunk}`);
    }
    chunks = resized;
  }
}

function resolveTarget(to: string, opts?: SendMeshcoreOptions): string {
  const fromArg = normalizeMeshcoreMessagingTarget(to);
  if (fromArg) {
    return fromArg;
  }
  const fromOpt = normalizeMeshcoreMessagingTarget(opts?.target ?? "");
  if (fromOpt) {
    return fromOpt;
  }
  throw new Error(`Invalid MeshCore target: ${to}`);
}

export async function sendMessageMeshcore(
  to: string,
  text: string,
  opts: SendMeshcoreOptions,
): Promise<SendMeshcoreResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "MeshCore send") as CoreConfig;
  const account = resolveMeshcoreAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `MeshCore is not configured for account "${account.accountId}" (need host in channels.meshcore).`,
    );
  }

  const target = resolveTarget(to, opts);
  // The firmware drops the TCP companion session when a text frame exceeds
  // 127 bytes (live-proven 2026-10-09), so values above the wire cap are
  // clamped even if an operator sets them.
  const chunkLimit = Math.min(
    account.config.textChunkLimit ?? MESHCORE_WIRE_CHUNK_LIMIT,
    MESHCORE_WIRE_CHUNK_LIMIT,
  );
  const chunkNumbering = account.config.chunkNumbering ?? true;
  const chunks = chunkTextWithNumbering(text, chunkLimit, chunkNumbering);
  if (chunks.length === 0) {
    throw new Error("Message must be non-empty for MeshCore sends");
  }

  const handle =
    opts.deviceHandle ??
    getMeshcoreDevice(account.accountId) ??
    (await connectMeshcoreDevice({
      accountId: account.accountId,
      host: account.host,
      port: account.port,
    }));

  attachSendConfirmedHandler(handle.connection, account.accountId);

  if (isMeshcoreGroupTarget(target)) {
    throw new Error(
      `MeshCore group sends are disabled: ${target} is receive-only (LoRa airtime rule)`,
    );
  }

  const nodeId = parseMeshcoreNodeId(target);
  if (!nodeId) {
    throw new Error(`Invalid MeshCore DM target: ${target}`);
  }
  const pubkey = nodeIdToPubkey(nodeId, account.accountId);

  const pacingConfig = resolveSendPacingConfig(
    account.config.sendPacing as Record<string, unknown> | undefined,
  );

  const sendQueueBudgetMs =
    opts.sendQueueBudgetMs ??
    Math.max(
      SEND_QUEUE_BUDGET_MIN_MS,
      chunks.length * (pacingConfig.maxDelayMs + pacingConfig.ackTimeoutMs) +
        SEND_QUEUE_BUDGET_PAD_MS,
    );

  // Stable id used for dead-letter logging if the queue watchdog has to kill
  // this send before the final frame id is known.
  const pendingMessageId = `${target}-${Date.now()}-${chunks.length}`;

  const abortController = new AbortController();
  const pacingOptions: WithPacedSendOptions = { abortSignal: abortController.signal };

  let budgetTimer: ReturnType<typeof setTimeout> | null = null;
  let onDisconnected: (() => void) | null = null;

  const disposeAbortWatchdogs = () => {
    if (budgetTimer) {
      clearTimeout(budgetTimer);
      budgetTimer = null;
    }
    if (onDisconnected) {
      handle.connection.off("disconnected", onDisconnected);
      onDisconnected = null;
    }
  };

  onDisconnected = () => {
    abortController.abort(new MeshcoreSendAbortedError("connection lost", "connection_lost"));
  };
  handle.connection.on("disconnected", onDisconnected);

  budgetTimer = setTimeout(() => {
    abortController.abort(
      new MeshcoreSendAbortedError("send queue budget exceeded", "queue_budget_exceeded"),
    );
  }, sendQueueBudgetMs);

  try {
    return await withPacedSend(
      account.accountId,
      account.config.sendPacing as Record<string, unknown> | undefined,
      handle.selfInfo,
      async (ctx) => {
        let lastMessageId = "";
        for (const chunk of chunks) {
          const chunkBytes = utf8ByteLength(chunk);
          await ctx.beforeFrame(chunkBytes);
          rememberOutboundEcho(chunk);
          const response = await raceSendTextMessage(
            handle.connection,
            pubkey,
            chunk,
            abortController.signal,
          );
          lastMessageId = String(response.expectedAckCrc ?? response.estTimeout ?? Date.now());
          ctx.afterFrame(chunkBytes, response.expectedAckCrc);
        }

        recordMeshcoreOutboundActivity(account.accountId);

        return {
          messageId: lastMessageId,
          target,
          receipt: createMessageReceiptFromOutboundResults({
            results: [
              {
                channel: "meshcore",
                messageId: lastMessageId,
                conversationId: target,
              },
            ],
            kind: "text",
            ...(opts.replyTo ? { replyToId: opts.replyTo } : {}),
          }),
        };
      },
      pacingOptions,
    );
  } catch (error) {
    if (error instanceof MeshcoreSendAbortedError) {
      const logMessage =
        error.cause === "queue_budget_exceeded"
          ? `[meshcore] send queue budget exceeded; dead-letter message id ${pendingMessageId}`
          : `[meshcore] send aborted (${error.cause}); dead-letter message id ${pendingMessageId}`;
      console.error(logMessage);
    }
    throw error;
  } finally {
    disposeAbortWatchdogs();
  }
}
