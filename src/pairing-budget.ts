/**
 * Pairing-request containment. Reservations happen synchronously BEFORE the
 * host pairing controller can persist a pending record or send a reply.
 * This budget counts attempts, not radio frames; send.ts separately enforces
 * the packet partition on chunks and retries.
 */

export const PAIRING_REQUEST_WINDOW_MS = 600_000;
export const PAIRING_REQUEST_MAX_ATTEMPTS = 3;
export const PAIRING_KEY_COOLDOWN_MS = 60_000;
const MAX_TRACKED_KEYS_PER_ACCOUNT = 256;

export type PairingChallengeResult = {
  issued: boolean;
  coalesced: boolean;
  reason?: "max-sends-too-low" | "cooldown" | "budget" | "state-cap";
};

type AccountState = {
  requests: number[];
  lastRequestByKey: Map<string, number>;
  inFlight: Map<string, Promise<PairingChallengeResult>>;
};

const accounts = new Map<string, AccountState>();

function stateFor(accountId: string): AccountState {
  let state = accounts.get(accountId);
  if (!state) {
    state = { requests: [], lastRequestByKey: new Map(), inFlight: new Map() };
    accounts.set(accountId, state);
  }
  return state;
}

function trackKey(state: AccountState, nodeId: string, nowMs: number): void {
  if (!state.lastRequestByKey.has(nodeId) && state.lastRequestByKey.size >= MAX_TRACKED_KEYS_PER_ACCOUNT) {
    const oldest = state.lastRequestByKey.keys().next().value as string | undefined;
    if (oldest !== undefined) state.lastRequestByKey.delete(oldest);
  }
  state.lastRequestByKey.delete(nodeId);
  state.lastRequestByKey.set(nodeId, nowMs);
}

export function runPairingChallenge(params: {
  accountId: string;
  nodeId: string;
  maxSends: number;
  nowMs?: number;
  issue: () => Promise<void>;
}): Promise<PairingChallengeResult> {
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isInteger(params.maxSends) || params.maxSends <= 1) {
    return Promise.resolve({ issued: false, coalesced: false, reason: "max-sends-too-low" });
  }
  const state = stateFor(params.accountId);
  const existing = state.inFlight.get(params.nodeId);
  if (existing) {
    return existing.then((result) => ({ ...result, coalesced: true }));
  }
  const last = state.lastRequestByKey.get(params.nodeId);
  if (last !== undefined && nowMs - last < PAIRING_KEY_COOLDOWN_MS) {
    return Promise.resolve({ issued: false, coalesced: false, reason: "cooldown" });
  }
  state.requests = state.requests.filter((at) => at > nowMs - PAIRING_REQUEST_WINDOW_MS);
  if (state.requests.length >= PAIRING_REQUEST_MAX_ATTEMPTS) {
    return Promise.resolve({ issued: false, coalesced: false, reason: "budget" });
  }
  if (state.inFlight.size >= MAX_TRACKED_KEYS_PER_ACCOUNT) {
    return Promise.resolve({ issued: false, coalesced: false, reason: "state-cap" });
  }

  // Reserve synchronously. No await or host callback runs before this point.
  state.requests.push(nowMs);
  trackKey(state, params.nodeId, nowMs);

  let resolveShared!: (result: PairingChallengeResult) => void;
  let rejectShared!: (error: unknown) => void;
  const shared = new Promise<PairingChallengeResult>((resolve, reject) => {
    resolveShared = resolve;
    rejectShared = reject;
  });
  state.inFlight.set(params.nodeId, shared);

  const cleanup = () => {
    if (state.inFlight.get(params.nodeId) === shared) {
      state.inFlight.delete(params.nodeId);
    }
  };
  try {
    // issue() is invoked only after the in-flight marker is visible, so a
    // concurrent frame for the same key coalesces instead of reserving again.
    void params.issue().then(
      () => {
        cleanup();
        resolveShared({ issued: true, coalesced: false });
      },
      (error) => {
        cleanup();
        rejectShared(error);
      },
    );
  } catch (error) {
    cleanup();
    rejectShared(error);
  }
  return shared;
}

export function resetPairingRequestBudgetForTests(accountId?: string): void {
  if (accountId === undefined) accounts.clear();
  else accounts.delete(accountId);
}

export function pairingBudgetStateSizeForTests(accountId: string): number {
  const state = accounts.get(accountId);
  return (state?.lastRequestByKey.size ?? 0) + (state?.inFlight.size ?? 0);
}
