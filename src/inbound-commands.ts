/**
 * Native-command concern for handleMeshcoreInbound (issue #80, PR 2).
 *
 * Parsing and authorization stay pure; command execution keeps its side
 * effects (rate limit, repeater-ops, reply delivery via the injected
 * callback) but runs as a self-contained function the orchestrator calls.
 * Durability bookkeeping is injected by the caller, not owned here.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedMeshcoreAccount } from "./accounts.js";
import { authorizeDmCommand, type DmCommandAuthorization } from "./dm-identity.js";
import type { DurabilityStore } from "./durability.js";
import { readNodeStatusSnapshot } from "./node-status.js";
import type { RepeaterOpsKind } from "./repeater-ops.js";
import type { getMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";

const CHANNEL_ID = "meshcore" as const;

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

/**
 * The ONE command decision for an inbound frame: which native command (DMs
 * only) it invokes, and the fail-closed DM command authorization.
 */
export function resolveMeshcoreCommandDecision(params: {
  message: MeshcoreInboundMessage;
  rawBody: string;
  account: ResolvedMeshcoreAccount;
}): { nativeCommand: string | undefined; commandDecision: DmCommandAuthorization } {
  const { message, rawBody, account } = params;
  const nativeCommand = message.isGroup ? undefined : parseNativeCommand(rawBody);
  const commandRepliesEnabled = account.config.commandRepliesEnabled ?? true;
  const commandDecision = authorizeDmCommand({
    identity: message.dmIdentity ?? { status: "invalid" },
    nativeCommand,
    nativePingAllowFrom: account.config.commandPingAllowFrom,
    commandRepliesEnabled,
  });
  return { nativeCommand, commandDecision };
}

/** Host text/control command facts handed to the ingress resolver. */
export function resolveMeshcoreHostCommandFacts(params: {
  core: ReturnType<typeof getMeshcoreRuntime>;
  config: CoreConfig;
  isGroup: boolean;
  rawBody: string;
  commandDecision: DmCommandAuthorization;
}): { ingressAllowTextCommands: boolean; hasControlCommand: boolean } {
  const { core, config, rawBody, commandDecision } = params;
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  // Group commands are plain text: never let command authorization bypass
  // requireMention. DM host commands additionally require independent proof.
  const dmHostCommandsAuthorized =
    !params.isGroup && commandDecision.hostCommandAuthorized;
  const ingressAllowTextCommands = dmHostCommandsAuthorized ? allowTextCommands : false;
  const hasControlCommand = dmHostCommandsAuthorized
    ? core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig)
    : false;
  return { ingressAllowTextCommands, hasControlCommand };
}

/** CommandAuthorized for the agent turn: never for groups; DMs need both gates. */
export function resolveMeshcoreCommandAuthorized(params: {
  isGroup: boolean;
  access: { commandAccess: { authorized: boolean } };
  commandDecision: DmCommandAuthorization;
}): boolean {
  return params.isGroup
    ? false
    : params.access.commandAccess.authorized && params.commandDecision.hostCommandAuthorized;
}

/**
 * A recognized native command is terminal when blocked: not natively
 * authorized, or not admitted for dispatch.
 */
export function isBlockedNativeCommand(params: {
  nativeCommand: string | undefined;
  commandDecision: DmCommandAuthorization;
  access: { ingress: { admission: string } };
}): boolean {
  return Boolean(
    params.nativeCommand &&
    (!params.commandDecision.nativeAuthorized || params.access.ingress.admission !== "dispatch"),
  );
}
