import {
  PAIRING_DEFAULT_REPLY_PACKETS,
  PAIRING_KEY_COOLDOWN_MS,
  PAIRING_REQUEST_MAX_ATTEMPTS,
  PAIRING_REQUEST_WINDOW_MS,
} from "./pairing-constants.js";
import { pairingPacketCap } from "./rate-limit.js";

export {
  PAIRING_KEY_COOLDOWN_MS,
  PAIRING_REQUEST_MAX_ATTEMPTS,
  PAIRING_REQUEST_WINDOW_MS,
} from "./pairing-constants.js";

/**
 * Pairing-request containment. Reservations happen synchronously BEFORE the
 * host pairing controller can persist a pending record or send a reply.
 * Only a newly created challenge whose reply send completes keeps its account
 * reservation. Already-pending coalescing and failed reply delivery release it.
 * Radio packets are still accounted independently in send.ts, including any
 * frames transmitted before a delivery failure.
 */

export type PairingChallengeIssueOutcome = {
  /** The host's create-if-missing result. */
  created: boolean;
  /** False when the host reports sendPairingReply failure via onReplyError. */
  replyDelivered: boolean;
};

export type PairingChallengeResult = {
  issued: boolean;
  coalesced: boolean;
  reason?:
    | "max-sends-too-low"
    | "pairing-reply-too-large"
    | "cooldown"
    | "budget"
    | "state-cap"
    | "already-pending"
    | "delivery-failed";
};

type AccountState = {
  requests: number[];
  lastRequestByKey: Map<string, number>;
  inFlight: Map<string, Promise<PairingChallengeResult>>;
};

const MAX_TRACKED_KEYS_PER_ACCOUNT = 256;
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
  /** Packet count measured from the actual host-shaped reply and chunker. */
  requiredPackets?: number;
  nowMs?: number;
  issue: () => Promise<PairingChallengeIssueOutcome>;
}): Promise<PairingChallengeResult> {
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isInteger(params.maxSends) || params.maxSends <= 1) {
    return Promise.resolve({ issued: false, coalesced: false, reason: "max-sends-too-low" });
  }
  const requiredPackets = params.requiredPackets ?? PAIRING_DEFAULT_REPLY_PACKETS;
  const cap = pairingPacketCap({
    enabled: true,
    maxSends: params.maxSends,
    windowMs: PAIRING_REQUEST_WINDOW_MS,
  }, requiredPackets);
  if (!Number.isInteger(requiredPackets) || requiredPackets < 1 || cap < requiredPackets) {
    return Promise.resolve({ issued: false, coalesced: false, reason: "pairing-reply-too-large" });
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
  const releaseReservation = () => {
    const index = state.requests.lastIndexOf(nowMs);
    if (index >= 0) state.requests.splice(index, 1);
  };

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
  const reject = (error: unknown) => {
    cleanup();
    releaseReservation();
    rejectShared(error);
  };
  try {
    // issue() is invoked only after the in-flight marker is visible, so a
    // concurrent frame for the same key coalesces instead of reserving again.
    void params.issue().then(
      (outcome) => {
        cleanup();
        if (!outcome.created) {
          // The host coalesced into an existing pending record. No new
          // challenge or reply exists, so this cannot spend the account budget.
          releaseReservation();
          resolveShared({ issued: false, coalesced: true, reason: "already-pending" });
          return;
        }
        if (!outcome.replyDelivered) {
          // Both supported hosts return created:true after onReplyError and
          // retain the pending record until their TTL. Do not burn an account
          // slot for the reply that was never sent; later already-pending
          // attempts coalesce without charging too.
          releaseReservation();
          resolveShared({ issued: false, coalesced: false, reason: "delivery-failed" });
          return;
        }
        resolveShared({ issued: true, coalesced: false });
      },
      reject,
    );
  } catch (error) {
    reject(error);
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
