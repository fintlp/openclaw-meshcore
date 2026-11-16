/**
 * Durability / persistent-message concern for handleMeshcoreInbound
 * (issue #80, PR 3).
 *
 * Deliberately THIN: each function wraps the existing DurabilityStore calls
 * as-is (same order, same reasons, same log lines) so the orchestrator reads
 * as a sequence of steps. Issue #51 (host durable ingress queue) may replace
 * this flow later; keep it free of new abstractions.
 */
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  dmIdentityDigestsEqual,
  parseDmIdentityEvidence,
  type DmCommandAuthorization,
} from "./dm-identity.js";
import type { ResolvedMeshcoreAccount } from "./accounts.js";
import {
  DEFAULT_DURABILITY_CONFIG,
  meshcoreDedupeKey,
  type DurabilityStore,
} from "./durability.js";
import { COMMAND_REPLIES, parseRepeaterOpsInvocation } from "./inbound-commands.js";
import type { MeshcoreInboundMessage } from "./types.js";

/**
 * Native-command marker rows intentionally have rawJson "{}" and no DM
 * identity evidence. Dead-letter a replayed DM native command as
 * not-replayable (before the evidence gate). Returns true when the caller
 * must stop.
 */
export function deadLetterNativeCommandReplay(params: {
  isGroup: boolean;
  replayOf: number | undefined;
  nativeCommand: string | undefined;
  durability: DurabilityStore | null | undefined;
  accountId: string;
}): boolean {
  if (!params.isGroup && params.replayOf !== undefined && params.nativeCommand) {
    params.durability?.deadLetter(params.accountId, params.replayOf, "not-replayable");
    return true;
  }
  return false;
}

/**
 * Replay path: admission flipped while we were down (config changed). The
 * attempt was already counted at claim time; release the claim — the event
 * goes back to pending and dead-letters at maxDispatchAttempts. Returns true
 * when the caller must stop.
 */
export function releaseReplayClaimIfAdmissionFlipped(params: {
  replayOf: number | undefined;
  access: { ingress: { admission: string } };
  durability: DurabilityStore | null | undefined;
  accountId: string;
  runtime: RuntimeEnv;
}): boolean {
  const { access, runtime } = params;
  if (params.replayOf !== undefined && access.ingress.admission !== "dispatch") {
    params.durability?.releaseClaim(
      params.accountId,
      params.replayOf,
      `admission flipped on replay (${access.ingress.admission})`,
    );
    runtime.log?.(
      `meshcore: replay event ${params.replayOf} no longer admitted (${access.ingress.admission}) — claim released`,
    );
    return true;
  }
  return false;
}

export type InboundDuplicateProbe =
  | { kind: "drop" }
  | {
      kind: "continue";
      dedupeKey: string;
      duplicateNativeCommand: boolean;
      redeliverEventId: number | undefined;
    };

/**
 * Durability duplicate probe (#48) plus the DM duplicate-evidence check.
 * Returns "drop" when the caller must stop (complete duplicate, or a DM
 * duplicate dead-lettered for missing/stale identity evidence).
 */
export function probeInboundDuplicate(params: {
  store: DurabilityStore | null;
  replayOf: number | undefined;
  accountId: string;
  message: MeshcoreInboundMessage;
  rawBody: string;
  commandDecision: DmCommandAuthorization;
  access: { ingress: { admission: string } };
  runtime: RuntimeEnv;
}): InboundDuplicateProbe {
  const { store, message, rawBody, commandDecision, access, runtime } = params;
  const dedupeKey = meshcoreDedupeKey({
    senderNodeId: message.senderNodeId,
    timestamp: message.timestamp,
    body: message.text ?? rawBody,
  });
  // m7: a duplicate hit on a COMPLETE row is a drop; a hit on a pending /
  // inflight row is a redelivery we must dispatch (its first attempt failed).
  const existingDupe =
    store && params.replayOf === undefined
      ? store.findDuplicate(params.accountId, dedupeKey)
      : null;
  if (existingDupe && (existingDupe.state === "dispatched" || existingDupe.state === "dead")) {
    runtime.log?.(
      `meshcore: drop duplicate inbound (sender ${message.senderNodeId} ts ${message.timestamp})`,
    );
    return { kind: "drop" };
  }
  // A native-command marker is already running (or ran) and deliberately has
  // no evidence payload. Drop its duplicate BEFORE inspecting evidence; the
  // marker must stay pending for the original commandMark, not become a dead
  // dm-identity-no-evidence row that a later mark could write to.
  const duplicateNativeCommand = Boolean(
    existingDupe &&
    !message.isGroup &&
    commandDecision.nativeAuthorized &&
    access.ingress.admission === "dispatch" &&
    (COMMAND_REPLIES.has(rawBody) || parseRepeaterOpsInvocation(rawBody)),
  );
  if (existingDupe && !message.isGroup && !duplicateNativeCommand) {
    const previousRaw = store?.rawJsonOf(existingDupe.id) ?? null;
    const previousEvidence = parseDmIdentityEvidence(previousRaw);
    let previousMessageId: unknown;
    try {
      previousMessageId = previousRaw
        ? (JSON.parse(previousRaw) as { messageId?: unknown }).messageId
        : undefined;
    } catch {
      previousMessageId = undefined;
    }
    if (!previousEvidence) {
      store?.deadLetter(params.accountId, existingDupe.id, "dm-identity-no-evidence");
      return { kind: "drop" };
    }
    const currentEvidence = parseDmIdentityEvidence(message);
    if (
      !currentEvidence ||
      previousMessageId !== message.messageId ||
      previousEvidence.wirePrefixHex !== currentEvidence.wirePrefixHex ||
      !dmIdentityDigestsEqual(previousEvidence.fullKeySha256, currentEvidence.fullKeySha256)
    ) {
      // Same-prefix/timestamp/body collisions are not redeliveries of a
      // different attribution. Stop before the pending row can be reused.
      store?.deadLetter(params.accountId, existingDupe.id, "dm-identity-stale");
      return { kind: "drop" };
    }
  }
  const redeliverEventId = existingDupe?.id;
  return { kind: "continue", dedupeKey, duplicateNativeCommand, redeliverEventId };
}

/**
 * Round-4 minor 1: COMMANDS drop on any duplicate hit — a pending command
 * row means the command is already running (or ran), never re-air it.
 * Returns true when the caller must stop.
 */
export function dropDuplicateNativeCommand(params: {
  duplicateNativeCommand: boolean;
  rawBody: string;
  senderNodeId: string;
  runtime: RuntimeEnv;
}): boolean {
  if (params.duplicateNativeCommand) {
    params.runtime.log?.(
      `meshcore: drop duplicate command ${params.rawBody} (sender ${params.senderNodeId})`,
    );
    return true;
  }
  return false;
}

/**
 * m4: durability hooks for native-command execution. The command frame is
 * recorded (intake, rawJson "{}") BEFORE the run, marked dispatched after the
 * reply, and released when the run throws.
 */
export function createCommandDurabilityHooks(params: {
  store: DurabilityStore | null;
  replayOf: number | undefined;
  accountId: string;
  dedupeKey: string;
  message: MeshcoreInboundMessage;
  rawBody: string;
}): {
  commandIntake: () => number | undefined;
  commandMark: (id: number | undefined) => void;
  commandRelease: (cid: number | undefined, err: unknown) => void;
} {
  const { store, message, rawBody, dedupeKey } = params;
  const commandIntake = (): number | undefined => {
    if (!store || params.replayOf !== undefined) {
      return params.replayOf;
    }
    const r = store.intake({
      accountId: params.accountId,
      dedupeKey,
      kind: "direct",
      peerId: message.senderNodeId,
      senderLabel: message.senderName ?? message.senderNodeId,
      senderTs: message.timestamp,
      body: rawBody,
      rawJson: "{}",
    });
    return !r.duplicate && r.id >= 0 ? r.id : undefined;
  };
  const commandMark = (id: number | undefined) => {
    if (store && id !== undefined) {
      store.markDispatched(params.accountId, id);
    }
  };
  const commandRelease = (cid: number | undefined, err: unknown) => {
    if (store && cid !== undefined) {
      store.releaseClaim(
        params.accountId,
        cid,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  return { commandIntake, commandMark, commandRelease };
}

/**
 * Durability intake + claim (#48): session-bound frames are logged as
 * admitted (admission is decided before this point) and claimed with a lease
 * BEFORE any dispatch work. Attempts count at claim, so process deaths and
 * crash loops are bounded by maxDispatchAttempts. Returns "stop" when the
 * caller must not dispatch.
 */
export function intakeAndClaimInboundEvent(params: {
  store: DurabilityStore | null;
  replayOf: number | undefined;
  redeliverEventId: number | undefined;
  account: ResolvedMeshcoreAccount;
  dedupeKey: string;
  message: MeshcoreInboundMessage;
  rawBody: string;
  runtime: RuntimeEnv;
}): { kind: "stop" } | { kind: "proceed"; durabilityEventId: number | undefined } {
  const { store, account, message, rawBody, runtime } = params;
  let durabilityEventId: number | undefined = params.replayOf ?? params.redeliverEventId;
  if (store && durabilityEventId === undefined) {
    const res = store.intake({
      accountId: account.accountId,
      dedupeKey: params.dedupeKey,
      kind: message.isGroup ? "group" : "direct",
      peerId: message.isGroup ? message.target : message.senderNodeId,
      senderLabel: message.senderName ?? message.senderNodeId,
      senderTs: message.timestamp,
      body: rawBody,
      rawJson: JSON.stringify(message),
    });
    if (res.duplicate) {
      runtime.log?.(
        `meshcore: drop duplicate inbound (sender ${message.senderNodeId} ts ${message.timestamp})`,
      );
      return { kind: "stop" };
    }
    if (res.id >= 0) {
      durabilityEventId = res.id;
    } else {
      // Partial store failure (review M-2): dispatch WITHOUT durability rather
      // than drop — persistence must never be a single point of failure.
      runtime.log?.("meshcore: durability intake degraded — dispatching without persistence");
    }
  }
  // Live path claims its event (replay arrives pre-claimed by claimNext —
  // claiming twice would double-count the attempt).
  const durCfg = { ...DEFAULT_DURABILITY_CONFIG, ...account.config.durability };
  if (store && durabilityEventId !== undefined && params.replayOf === undefined) {
    const verdict = store.claim(
      account.accountId,
      durabilityEventId,
      durCfg.maxDispatchAttempts,
      durCfg.leaseMs,
    );
    if (verdict !== "claimed") {
      runtime.log?.(
        `meshcore: inbound event ${durabilityEventId} not dispatched (claim: ${verdict})`,
      );
      return { kind: "stop" };
    }
  }
  return { kind: "proceed", durabilityEventId };
}

/**
 * Per-dispatch durability callbacks for the claimed event: abort release
 * (re-checked at each await boundary), host-turn finalization, and claim
 * release when dispatch setup throws.
 */
export function createDispatchDurability(params: {
  store: DurabilityStore | null;
  durabilityEventId: number | undefined;
  accountId: string;
  abortSignal: AbortSignal | undefined;
  runtime: RuntimeEnv;
}): {
  releaseIfAborted: (reason: string) => boolean;
  onFinalize: (result: {
    dispatched: boolean;
    admission?: { kind?: string };
    dispatchResult?: { deferredToActiveRun?: "steer" | "followup" } | null;
  }) => void;
  releaseOnError: (err: unknown) => void;
} {
  const { store, durabilityEventId, accountId, runtime } = params;
  const releaseIfAborted = (reason: string): boolean => {
    if (!params.abortSignal?.aborted) {
      return false;
    }
    if (store && durabilityEventId !== undefined) {
      store.releaseClaim(accountId, durabilityEventId, reason);
    }
    return true;
  };
  const onFinalize = (result: {
    dispatched: boolean;
    admission?: { kind?: string };
    dispatchResult?: { deferredToActiveRun?: "steer" | "followup" } | null;
  }) => {
    if (!store || durabilityEventId === undefined) {
      return;
    }
    if (releaseIfAborted("replay aborted before finalize")) {
      // The monitor stopped waiting for this replay. Do not record a
      // successful dispatch after disconnect/timeout; leave it retryable.
      return;
    }
    if (result.dispatchResult?.deferredToActiveRun === "followup") {
      // Queued behind a busy session: the host has ACCEPTED it into its
      // follow-up queue (review round-3 m6) — mark dispatched. Residual,
      // documented: the queue is in-memory, so a host crash before the
      // drain loses that one follow-up; no plugin can close that gap.
      runtime.log?.(
        `meshcore: event ${durabilityEventId} accepted into the host follow-up queue`,
      );
      store.markDispatched(accountId, durabilityEventId);
      return;
    }
    if (result.dispatched && result.admission?.kind === "dispatch") {
      store.markDispatched(accountId, durabilityEventId);
    } else {
      store.releaseClaim(
        accountId,
        durabilityEventId,
        `turn not dispatched (${result.admission?.kind ?? "unknown"})`,
      );
    }
  };
  const releaseOnError = (err: unknown) => {
    if (store && durabilityEventId !== undefined) {
      store.releaseClaim(
        accountId,
        durabilityEventId,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  return { releaseIfAborted, onFinalize, releaseOnError };
}
