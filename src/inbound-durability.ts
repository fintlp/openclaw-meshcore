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
import type { DurabilityStore } from "./durability.js";

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
