import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveMeshcoreAccount } from "./accounts.js";
import {
  attachSendConfirmedHandler,
  connectMeshcoreDevice,
  getMeshcoreDevice,
  nodeIdToPubkey,
  removeSendConfirmedWait,
  waitForSendConfirmed,
  type MeshcoreDeviceHandle,
  type SendConfirmedPayload,
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
import { assertSendRateLimit, resolveSendRateLimitConfig } from "./rate-limit.js";
import {
  DELIVERY_REPORT_TIMEOUT_MAX_MS,
  MeshcoreDeliveryFailedError,
  resolveDeliveryReportTimeoutMs,
  resolveSendRetryConfig,
} from "./send-retry.js";

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
  txtType?: number,
): Promise<{ expectedAckCrc?: number; estTimeout?: number }> {
  const sendPromise =
    txtType !== undefined
      ? connection.sendTextMessage(pubkey, chunk, txtType)
      : connection.sendTextMessage(pubkey, chunk);
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
  /** Internal override for the retry backoff clock (tests only). */
  retryBackoffSleep?: (ms: number) => Promise<void>;
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

// SignedPlain (txtType 2) payloads begin with a 4-byte sender_prefix field
// inside the wire text frame. The library passes the supplied text through to
// sendCommandSendTxtMsg unchanged; whether the node firmware prepends the
// prefix automatically or expects the caller to reserve the first 4 bytes is
// not statically provable. Shrink the effective text budget conservatively.
// TODO: verify with a live SignedPlain DM that the recipient parses the prefix
// correctly (issue #40).
const MESHCORE_SIGNED_PLAIN_PREFIX_LENGTH = 4;

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

let cachedGraphemeSegmenter: Intl.Segmenter | undefined;
let segmenterFallbackWarned = false;

/**
 * Grapheme cluster segmenter, or undefined when the runtime has no
 * Intl.Segmenter — then hard splits fall back to code points (logged once)
 * instead of crashing. Availability is re-checked per call so tests can stub
 * it.
 */
function getGraphemeSegmenter(): Intl.Segmenter | undefined {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    if (!segmenterFallbackWarned) {
      segmenterFallbackWarned = true;
      console.warn(
        "[meshcore] Intl.Segmenter unavailable — chunk hard splits fall back to code points",
      );
    }
    return undefined;
  }
  cachedGraphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return cachedGraphemeSegmenter;
}

/**
 * Hard-split units of a no-whitespace piece: grapheme clusters, or code
 * points when Intl.Segmenter is unavailable (issue #58).
 */
function hardSplitUnits(piece: string): Array<{ text: string; bytes: number }> {
  const segmenter = getGraphemeSegmenter();
  const units: Array<{ text: string; bytes: number }> = [];
  if (segmenter) {
    for (const { segment } of segmenter.segment(piece)) {
      units.push({ text: segment, bytes: utf8ByteLength(segment) });
    }
  } else {
    for (const ch of piece) {
      units.push({ text: ch, bytes: utf8ByteLength(ch) });
    }
  }
  return units;
}

/** Exported for tests; production callers go through chunkTextWithNumbering. */
export function chunkText(text: string, limit: number): string[] {
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
      // Grapheme clusters, not code points: a combined character (emoji ZWJ
      // sequence, flag, skin tone, niqqud, tashkeel, decomposed accent) must
      // never be cut across two messages (issue #58). A single grapheme
      // larger than the limit falls back to code points rather than looping
      // or dropping text.
      for (const unit of hardSplitUnits(piece)) {
        if (unit.bytes > limit) {
          for (const ch of unit.text) {
            const chBytes = utf8ByteLength(ch);
            if (currentBytes > 0 && currentBytes + chBytes > limit) {
              pushCurrent();
            }
            current += ch;
            currentBytes += chBytes;
          }
          continue;
        }
        if (currentBytes > 0 && currentBytes + unit.bytes > limit) {
          pushCurrent();
        }
        current += unit.text;
        currentBytes += unit.bytes;
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
/** Exported for tests; production callers go through sendMessageMeshcore. */
export function chunkTextWithNumbering(
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
  const plainChunkLimit = Math.min(
    account.config.textChunkLimit ?? MESHCORE_WIRE_CHUNK_LIMIT,
    MESHCORE_WIRE_CHUNK_LIMIT,
  );
  const outboundSignedPlain = account.config.outboundSignedPlain === true;
  // SignedPlain payloads embed a 4-byte sender_prefix in the wire text field.
  // Reserve that space from the text budget to avoid firmware truncation.
  const chunkLimit = outboundSignedPlain
    ? Math.max(1, plainChunkLimit - MESHCORE_SIGNED_PLAIN_PREFIX_LENGTH)
    : plainChunkLimit;
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

  // Only DMs may be signed; groups are receive-only and stay Plain.
  const txtType = outboundSignedPlain ? 2 : undefined;

  const pacingConfig = resolveSendPacingConfig(
    account.config.sendPacing as Record<string, unknown> | undefined,
  );

  const retryConfig = resolveSendRetryConfig(
    account.config.sendRetry as Record<string, unknown> | undefined,
  );
  const backoffSleep =
    opts.retryBackoffSleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Stable id used for dead-letter logging if the queue watchdog has to kill
  // this send before the final frame id is known.
  const pendingMessageId = `${target}-${Date.now()}-${chunks.length}`;

  const abortController = new AbortController();
  const pacingOptions: WithPacedSendOptions = { abortSignal: abortController.signal };

  const onDisconnected = () => {
    abortController.abort(new MeshcoreSendAbortedError("connection lost", "connection_lost"));
  };
  handle.connection.on("disconnected", onDisconnected);

  type TransmitOutcome = {
    result: SendMeshcoreResult;
    /** Ack tag of the final frame, when the node returned one. */
    finalAckCode?: number;
    /** Delivery report for the final frame (only awaited when retry is on). */
    report?: SendConfirmedPayload | { timeout: true };
  };

  const transmitOnce = async (): Promise<TransmitOutcome> => {
    // Flood guard: refuse the whole message (never partially aired) when the
    // account's rolling airtime budget is exhausted. Runs per attempt: every
    // (re)transmission burns airtime and must consume budget through the same
    // choke point, so a refused retry stops the loop whole.
    assertSendRateLimit({
      accountId: account.accountId,
      packets: chunks.length,
      config: resolveSendRateLimitConfig(
        account.config.sendRateLimit as Record<string, unknown> | undefined,
      ),
      scope: "DM",
    });

    const sendQueueBudgetMs =
      opts.sendQueueBudgetMs ??
      Math.max(
        SEND_QUEUE_BUDGET_MIN_MS,
        chunks.length * (pacingConfig.maxDelayMs + pacingConfig.ackTimeoutMs) +
          (retryConfig.enabled ? DELIVERY_REPORT_TIMEOUT_MAX_MS : 0) +
          SEND_QUEUE_BUDGET_PAD_MS,
      );

    const budgetTimer = setTimeout(() => {
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
          let lastAckCode: number | undefined;
          let lastEstTimeout: number | undefined;
          for (const chunk of chunks) {
            const chunkBytes = utf8ByteLength(chunk);
            await ctx.beforeFrame(chunkBytes);
            rememberOutboundEcho(chunk);
            const response = await raceSendTextMessage(
              handle.connection,
              pubkey,
              chunk,
              abortController.signal,
              txtType,
            );
            lastMessageId = String(response.expectedAckCrc ?? response.estTimeout ?? Date.now());
            lastAckCode = response.expectedAckCrc;
            lastEstTimeout = response.estTimeout;
            ctx.afterFrame(chunkBytes, response.expectedAckCrc);
          }

          recordMeshcoreOutboundActivity(account.accountId);

          const result: SendMeshcoreResult = {
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

          // Delivery-report wait (issue #25): only when retry is enabled and
          // the node returned an ack tag for the final frame. The wait runs
          // inside the paced work so it takes over the pre-registered waiter
          // synchronously (no confirm can interleave and be dropped), and so
          // the send queue stays serialized while the report is pending. The
          // window derives from the firmware's own estTimeout — the same
          // window the MeshOS app uses before flagging non-delivery — which
          // makes a timeout the protocol's definitive non-delivery signal.
          let report: SendConfirmedPayload | { timeout: true } | undefined;
          if (retryConfig.enabled && lastAckCode !== undefined) {
            const reportTimeoutMs = resolveDeliveryReportTimeoutMs({
              estTimeoutMs: lastEstTimeout,
              fallbackMs: pacingConfig.ackTimeoutMs,
            });
            report = await ctx.awaitFrameReport(lastAckCode, reportTimeoutMs);
          }

          return { result, finalAckCode: lastAckCode, report };
        },
        pacingOptions,
      );
    } finally {
      clearTimeout(budgetTimer);
    }
  };

  try {
    if (!retryConfig.enabled) {
      // Default (fire-and-forget) path: identical behavior to pre-retry sends.
      return (await transmitOnce()).result;
    }

    let attempt = 0;
    while (true) {
      attempt += 1;
      const outcome = await transmitOnce();

      if (outcome.finalAckCode === undefined) {
        // The node returned no ack tag for the final frame, so delivery cannot
        // be correlated to a report. Retrying blind would be timeout-ambiguous
        // (issue #25: retry only on definitive non-delivery) — fire-and-forget.
        return outcome.result;
      }

      if (outcome.report && !("timeout" in outcome.report)) {
        if (attempt > 1) {
          console.log(
            `[meshcore] DM to ${target} confirmed delivered on attempt ${attempt}/${retryConfig.maxAttempts}`,
          );
        }
        return outcome.result;
      }

      if (attempt >= retryConfig.maxAttempts) {
        break;
      }

      // console.log, not logger.info: retries burn shared LoRa airtime and
      // must be auditable (issue #14 pattern, same as adverts/rate-limit).
      console.log(
        `[meshcore] DM to ${target} not confirmed within report window; ` +
          `retry ${attempt + 1}/${retryConfig.maxAttempts} in ${retryConfig.backoffMs}ms`,
      );

      // Late-ACK guard: the backoff window doubles as a last listen for a
      // tardy SendConfirmed. A confirm arriving during backoff cancels the
      // retry, so a late delivery report never causes a duplicate send.
      const lateReport = waitForSendConfirmed({
        accountId: account.accountId,
        expectedAckCode: outcome.finalAckCode,
        timeoutMs: retryConfig.backoffMs,
      });
      const backoffOutcome = await new Promise<"confirmed" | "elapsed" | "aborted">(
        (resolve) => {
          let settled = false;
          const finish = (value: "confirmed" | "elapsed" | "aborted") => {
            if (!settled) {
              settled = true;
              abortController.signal.removeEventListener("abort", onAbort);
              resolve(value);
            }
          };
          const onAbort = () => finish("aborted");
          if (abortController.signal.aborted) {
            finish("aborted");
            return;
          }
          abortController.signal.addEventListener("abort", onAbort, { once: true });
          lateReport.then((report) => finish("timeout" in report ? "elapsed" : "confirmed"));
          backoffSleep(retryConfig.backoffMs).then(
            () => finish("elapsed"),
            () => finish("elapsed"),
          );
        },
      );

      if (backoffOutcome === "confirmed") {
        console.log(
          `[meshcore] DM to ${target} confirmed by late delivery report during backoff; no retry sent`,
        );
        return outcome.result;
      }
      // Not confirmed: cancel the guard waiter (no-op if its timer already
      // settled it) so a later confirm is dropped, never credited elsewhere.
      removeSendConfirmedWait(account.accountId, outcome.finalAckCode);
      if (backoffOutcome === "aborted") {
        throw createAbortError(abortController.signal.reason);
      }
    }

    console.error(
      `[meshcore] DM to ${target} not confirmed delivered after ${retryConfig.maxAttempts} attempt(s); giving up`,
    );
    throw new MeshcoreDeliveryFailedError(
      `MeshCore DM to ${target} was not confirmed delivered after ${retryConfig.maxAttempts} attempt(s)`,
      retryConfig.maxAttempts,
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
    handle.connection.off("disconnected", onDisconnected);
  }
}
