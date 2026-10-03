import {
  calculateChunkAirtimeMs,
  resolveSendPacingConfig,
  type SendPacingConfig,
} from "./airtime.js";

type PacingState = {
  inFlight: Promise<unknown> | null;
  hasSentFrame: boolean;
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
      },
    });
  })();

  // Keep the queue alive even if this send throws; the next send should not be
  // blocked by a previous failure.
  state.inFlight = current.catch(() => undefined);
  return await current;
}

/** Clear per-account pacing state. Intended for tests only. */
export function clearPacingStateForTests(): void {
  accountPacingStates.clear();
}
