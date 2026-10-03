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
  lastFrameAckCode?: number;
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
      lastFrameAckCode: undefined,
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
   * relative to it. Optionally accepts the expected ACK tag from the node.
   * Call immediately after a successful transmission.
   */
  afterFrame: (frameBytes: number, expectedAckCode?: number) => void;
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

        if (pacing.mode === "ack" && !state.lastFrameFailed) {
          // If the timeout window has already elapsed since the previous send,
          // do not wait again.
          if (elapsed < pacing.ackTimeoutMs) {
            state.ackWaitPending = true;
            const result = await waitForSendConfirmed({
              accountId,
              expectedAckCode: state.lastFrameAckCode,
              timeoutMs: pacing.ackTimeoutMs - elapsed,
            });
            state.ackWaitPending = false;

            if (!("timeout" in result)) {
              return;
            }
            // Confirm timed out: fall through to enforce the airtime gapNeeded floor.
          }
        }

        // Apply time-mode gap floor (used in "time" mode, upon ACK timeout,
        // or after a failed previous frame where no ACK will arrive).
        state.lastFrameFailed = false;
        const totalElapsed = Date.now() - state.lastFrameSentAt;
        const delay = Math.max(0, gapNeeded - totalElapsed);
        if (delay > 0) {
          await sleep(delay);
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
