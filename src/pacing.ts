import {
  calculateChunkAirtimeMs,
  resolveSendPacingConfig,
  type SendPacingConfig,
} from "./airtime.js";
import {
  removeSendConfirmedWait,
  waitForSendConfirmed,
  type SendConfirmedPayload,
} from "./device-client.js";

type PendingAckWait = {
  ackCode: number;
  promise: Promise<SendConfirmedPayload | { timeout: true }>;
};

type PacingState = {
  inFlight: Promise<unknown> | null;
  hasSentFrame: boolean;
  lastFrameFailed: boolean;
  lastFrameAckCode?: number;
  ackWaitPending: boolean;
  lastFrameAirtimeMs: number;
  lastFrameSentAt: number;
  /**
   * ACK waiter pre-registered in afterFrame for the most recently sent frame.
   * Registering eagerly (rather than in the next beforeFrame) closes the race
   * where a confirm arrives before the next frame is invoked, which would
   * otherwise be dropped and force the next frame to burn the full
   * ackTimeoutMs. Strict tag equality and fail-closed semantics are retained.
   */
  pendingAckWait: PendingAckWait | null;
};

const accountPacingStates = new Map<string, PacingState>();

function getOrCreateState(accountId: string): PacingState {
  let state = accountPacingStates.get(accountId);
  if (!state) {
    state = {
      inFlight: null,
      hasSentFrame: false,
      lastFrameFailed: false,
      lastFrameAckCode: undefined,
      ackWaitPending: false,
      lastFrameAirtimeMs: 0,
      lastFrameSentAt: 0,
      pendingAckWait: null,
    };
    accountPacingStates.set(accountId, state);
  }
  return state;
}

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(typeof reason === "string" ? reason : "send aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal.reason));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type PacingFrameContext = {
  /**
   * Wait for the required gap from the previous outbound frame before sending
   * the next one. Must be awaited immediately before each transmission.
   */
  beforeFrame: (frameBytes: number) => Promise<void>;
  /**
   * Record the frame that was just sent so the next outbound send can pace
   * relative to it. Optionally accepts the expected ACK tag from the node.
   * Call immediately after a successful transmission.
   */
  afterFrame: (frameBytes: number, expectedAckCode?: number) => void;
};

export type WithPacedSendOptions = {
  /** If aborted, the paced sequence stops before the next frame. */
  abortSignal?: AbortSignal;
};

/**
 * Serialize all outbound text sends for an account and enforce inter-frame
 * airtime pacing. Every frame — SDK-chunked pieces, internal sub-chunks, and
 * pairing replies — runs through the same gate.
 */
export async function withPacedSend<T>(
  accountId: string,
  rawPacing: Record<string, unknown> | undefined,
  radioParams: { radioSf?: number; radioBw?: number; radioCr?: number } | undefined,
  work: (ctx: PacingFrameContext) => Promise<T>,
  options?: WithPacedSendOptions,
): Promise<T> {
  const pacing = resolveSendPacingConfig(rawPacing);
  const state = getOrCreateState(accountId);
  const signal = options?.abortSignal;

  const previous = state.inFlight;
  const current = (async () => {
    // Wait for any previous send on this account to finish (including pacing
    // delays and chunk loops). This serializes outbound frames.
    await previous;
    throwIfAborted(signal);

    return await work({
      beforeFrame: async (frameBytes) => {
        throwIfAborted(signal);
        if (!pacing.enabled) {
          return;
        }
        // No previous frame recorded yet -> first transmission, no delay.
        if (!state.hasSentFrame) {
          return;
        }

        const gapNeeded = Math.max(
          pacing.minDelayMs,
          Math.min(
            pacing.maxDelayMs,
            Math.ceil(state.lastFrameAirtimeMs * pacing.airtimeMargin),
          ),
        );
        // Ack correlation requires the previous frame's expected tag: without
        // one we cannot safely attribute a confirm, so we skip the wait and fall
        // through to the airtime floor (fail-closed). A failed previous frame
        // also skips the wait — no confirm will arrive for it.
        if (
          pacing.mode === "ack" &&
          !state.lastFrameFailed &&
          state.lastFrameAckCode !== undefined
        ) {
          // The waiter was pre-registered in afterFrame for the previous
          // frame's exact tag. Await that existing pending wait instead of
          // registering a new one here: a confirm that arrived before this frame
          // was invoked has already resolved it (fast path), and the
          // pre-started timeout still bounds the wait when none arrives.
          const pending = state.pendingAckWait;
          if (pending && pending.ackCode === state.lastFrameAckCode) {
            state.ackWaitPending = true;
            try {
              const result = signal
                ? await Promise.race([
                    pending.promise,
                    new Promise<never>((_, reject) => {
                      const onAbort = () => {
                        removeSendConfirmedWait(accountId, pending.ackCode);
                        reject(createAbortError(signal.reason));
                      };
                      if (signal.aborted) {
                        onAbort();
                        return;
                      }
                      signal.addEventListener("abort", onAbort, { once: true });
                    }),
                  ])
                : await pending.promise;
              if (!("timeout" in result)) {
                return;
              }
              // Confirm timed out: fall through to enforce the airtime gapNeeded floor.
            } finally {
              state.ackWaitPending = false;
              // One waiter per frame: consume it so it cannot be reused.
              if (state.pendingAckWait === pending) {
                state.pendingAckWait = null;
              }
            }
          }
        }

        // Apply time-mode gap floor (used in "time" mode, upon ACK timeout,
        // or after a failed previous frame where no ACK will arrive).
        state.lastFrameFailed = false;
        const totalElapsed = Date.now() - state.lastFrameSentAt;
        const delay = Math.max(0, gapNeeded - totalElapsed);
        if (delay > 0) {
          await sleep(delay, signal);
        }
      },
      afterFrame: (frameBytes, expectedAckCode) => {
        if (!pacing.enabled) {
          return;
        }
        state.hasSentFrame = true;
        state.lastFrameAckCode = expectedAckCode;
        // Store the base (pre-margin) airtime; the margin is reapplied when
        // computing the next inter-frame gap so it is not double-applied.
        state.lastFrameAirtimeMs = calculateChunkAirtimeMs(frameBytes, radioParams, pacing);
        state.lastFrameSentAt = Date.now();
        state.lastFrameFailed = false;

        // Pre-register this frame's ACK waiter now, while the tag is known, so a
        // confirm that arrives before the next frame is invoked is not dropped.
        // Only an exact tag match releases it (see dispatchSendConfirmed);
        // unmatched confirms are still dropped, never buffered. When the frame
        // sequence ends with no subsequent send, the waiter settles on its own
        // via its timeout — no timer/promise leak and no unhandled rejection.
        state.pendingAckWait = null;
        if (pacing.mode === "ack" && expectedAckCode !== undefined) {
          const promise = waitForSendConfirmed({
            accountId,
            expectedAckCode,
            timeoutMs: pacing.ackTimeoutMs,
          });
          // The waiter never rejects (it resolves with { timeout: true }); the
          // guard covers an unawaited pending wait whose send sequence ended.
          promise.catch(() => {});
          state.pendingAckWait = { ackCode: expectedAckCode, promise };
        }
      },
    });
  })();

  // Keep the queue alive even if this send throws; the next send should not be
  // blocked by a previous failure. Catching the error here prevents unhandled
  // promise rejections on the internal in-flight promise.
  state.inFlight = current
    .then(() => {
      state.lastFrameFailed = false;
    })
    .catch(() => {
      state.lastFrameFailed = true;
      // Note: do not reset hasSentFrame to false. If a frame was sent before
      // the failure, the radio channel still needs the airtime gap floor.
    });
  return await current;
}

/** Clear per-account pacing state. Intended for tests only. */
export function clearPacingStateForTests(): void {
  accountPacingStates.clear();
}
