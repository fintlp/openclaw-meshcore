import {
  calculateChunkAirtimeMs,
  resolveSendPacingConfig,
  type SendPacingConfig,
} from "./airtime.js";
import { waitForSendConfirmed } from "./device-client.js";

type PacingState = {
  inFlight: Promise<unknown> | null;
  hasSentFrame: boolean;
  lastFrameFailed: boolean;
  ackWaitPending: boolean;
  lastFrameAirtimeMs: number;
  lastFrameSentAt: number;
};

const accountPacingStates = new Map<string, PacingState>();

function getOrCreateState(accountId: string): PacingState {
  let state = accountPacingStates.get(accountId);
  if (!state) {
    state = {
      inFlight: null,
      hasSentFrame: false,
      lastFrameFailed: false,
      ackWaitPending: false,
      lastFrameAirtimeMs: 0,
      lastFrameSentAt: 0,
    };
    accountPacingStates.set(accountId, state);
  }
  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PacingFrameContext = {
  /**
   * Wait for the required gap from the previous outbound frame before sending
   * the next one. Must be awaited immediately before each transmission.
   */
  beforeFrame: (frameBytes: number) => Promise<void>;
  /**
   * Record the frame that was just sent so the next outbound send can pace
   * relative to it. Call immediately after a successful transmission.
   */
  afterFrame: (frameBytes: number) => void;
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
): Promise<T> {
  const pacing = resolveSendPacingConfig(rawPacing);
  const state = getOrCreateState(accountId);

  const previous = state.inFlight;
  const current = (async () => {
    // Wait for any previous send on this account to finish (including pacing
    // delays and chunk loops). This serializes outbound frames.
    await previous;

    return await work({
      beforeFrame: async (frameBytes) => {
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
        const elapsed = Date.now() - state.lastFrameSentAt;

        if (pacing.mode === "ack") {
          // In ack mode each subsequent frame waits for the previous frame's
          // SendConfirmed push (FIFO). If the previous send failed, there will
          // be no confirm; recover immediately so the next send is not blocked.
          if (state.lastFrameFailed) {
            state.lastFrameFailed = false;
            return;
          }

          // If the timeout window has already elapsed since the previous send,
          // do not wait again.
          if (elapsed >= pacing.ackTimeoutMs) {
            return;
          }

          state.ackWaitPending = true;
          const result = await waitForSendConfirmed({
            accountId,
            timeoutMs: pacing.ackTimeoutMs - elapsed,
          });
          state.ackWaitPending = false;

          if ("timeout" in result) {
            // Confirm never arrived: fall back to the airtime-based gap since
            // the last send, but do not wait longer than we already have.
            const totalElapsed = Date.now() - state.lastFrameSentAt;
            const remaining = Math.max(0, gapNeeded - totalElapsed);
            if (remaining > 0) {
              await sleep(remaining);
            }
          }
          return;
        }

        const delay = Math.max(0, gapNeeded - elapsed);
        if (delay > 0) {
          await sleep(delay);
        }
      },
      afterFrame: (frameBytes) => {
        if (!pacing.enabled) {
          return;
        }
        state.hasSentFrame = true;
        // Store the base (pre-margin) airtime; the margin is reapplied when
        // computing the next inter-frame gap so it is not double-applied.
        state.lastFrameAirtimeMs = calculateChunkAirtimeMs(frameBytes, radioParams, pacing);
        state.lastFrameSentAt = Date.now();
        state.lastFrameFailed = false;
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
      state.hasSentFrame = false;
    });
  return await current;
}

/** Clear per-account pacing state. Intended for tests only. */
export function clearPacingStateForTests(): void {
  accountPacingStates.clear();
}
