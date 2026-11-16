/**
 * Native-command concern for handleMeshcoreInbound (issue #80, PR 2).
 *
 * Parsing and authorization stay pure; command execution keeps its side
 * effects (rate limit, repeater-ops, reply delivery via the injected
 * callback) but runs as a self-contained function the orchestrator calls.
 * Durability bookkeeping is injected by the caller, not owned here.
 */
import type { DurabilityStore } from "./durability.js";
import { readNodeStatusSnapshot } from "./node-status.js";
import type { RepeaterOpsKind } from "./repeater-ops.js";

export const COMMAND_REPLIES = new Set(["!ping", "!status"]);

/**
 * Repeater-ops commands take a node argument (!neighbours <node>, ...), so
 * they cannot live in the exact-match COMMAND_REPLIES set. They share the
 * same gate: DM-only, admission === "dispatch", commandRepliesEnabled.
 */
const REPEATER_OPS_COMMANDS: ReadonlyArray<{ command: string; op: RepeaterOpsKind }> = [
  { command: "!neighbours", op: "neighbours" },
  { command: "!rstatus", op: "rstatus" },
  { command: "!trace", op: "trace" },
];

export function parseRepeaterOpsInvocation(
  rawBody: string,
): { op: RepeaterOpsKind; arg: string } | undefined {
  for (const { command, op } of REPEATER_OPS_COMMANDS) {
    if (rawBody === command) {
      return { op, arg: "" };
    }
    if (rawBody.startsWith(`${command} `)) {
      return { op, arg: rawBody.slice(command.length + 1).trim() };
    }
  }
  return undefined;
}

export function parseNativeCommand(rawBody: string): string | undefined {
  if (COMMAND_REPLIES.has(rawBody)) return rawBody;
  const invocation = parseRepeaterOpsInvocation(rawBody);
  return invocation ? "!" + invocation.op : undefined;
}

function formatStatusReply(snapshot: ReturnType<typeof readNodeStatusSnapshot>): string {
  if (!snapshot) {
    return "status unavailable";
  }
  const parts: string[] = [];
  parts.push(snapshot.connectionState ?? "unknown");
  if (snapshot.name) {
    parts.push(`name:${snapshot.name}`);
  }
  if (snapshot.batteryMv) {
    parts.push(`bat:${(snapshot.batteryMv / 1000).toFixed(2)}V`);
  }
  if (snapshot.position?.lat !== undefined && snapshot.position?.lon !== undefined) {
    parts.push(`pos:${snapshot.position.lat.toFixed(4)},${snapshot.position.lon.toFixed(4)}`);
  }
  if (snapshot.lastAdvertAt) {
    const ageMin = Math.floor((Date.now() - new Date(snapshot.lastAdvertAt).getTime()) / 60000);
    parts.push(`adv:${ageMin}m`);
  }
  if (snapshot.reconnectCount !== undefined) {
    parts.push(`reconnects:${snapshot.reconnectCount}`);
  }
  return parts.join(" ");
}

export function buildCommandReply(
  command: string,
  accountId: string,
  durability?: DurabilityStore | null,
): string | undefined {
  if (command === "!ping") {
    const snapshot = readNodeStatusSnapshot(accountId);
    const name = snapshot?.name;
    return name ? `pong ${name}` : "pong";
  }
  if (command === "!status") {
    const base = formatStatusReply(readNodeStatusSnapshot(accountId));
    if (!durability) {
      return base;
    }
    const m = durability.metrics(accountId);
    if (m.degraded) {
      return `${base} queue:DEGRADED`;
    }
    const oldest = m.oldestPendingAt
      ? ` oldest ${Math.max(0, Math.round((Date.now() - m.oldestPendingAt) / 1000))}s`
      : "";
    return `${base} queue:${m.pending} dead:${m.dead} dup:${m.duplicates}${oldest}`;
  }
  return undefined;
}
