/**
 * Repeater operations: on-demand diagnostic queries a DM correspondent can
 * fire at remote mesh nodes (primarily repeaters) through the connected
 * companion node.
 *
 * AIRTIME HONESTY: every op in this module transmits request frames onto the
 * LoRa mesh. The neighbours query rides the SendBinaryReq command (meshcore.js
 * getNeighbours -> sendBinaryRequest -> sendCommandSendBinaryReq), so despite
 * the read-only semantics it is NOT a local node query. Each op therefore
 * counts against the account's outbound send rate limit before its request is
 * allowed on air, and the command surface is DM-admission-gated and
 * group-silent exactly like !ping/!status.
 *
 * Ops are on-demand diagnostics only: never scheduled, never polled.
 */
import { getContactByPubkey, resolveContactByPrefix } from "./contact-book.js";
import {
  getMeshcoreDevice,
  nodeIdToPubkey,
  type MeshcoreDeviceHandle,
} from "./device-client.js";
import { bytesToHex } from "./protocol.js";
import {
  assertSendRateLimit,
  resolveSendRateLimitConfig,
  SendRateLimitExceededError,
} from "./rate-limit.js";
import type { ResolvedMeshcoreAccount } from "./accounts.js";

export type RepeaterOpsKind = "neighbours";

/** The target argument did not resolve to a node we can address. */
export class RepeaterOpsTargetError extends Error {}

/** The gateway has no live connection to the companion node. */
export class RepeaterOpsUnavailableError extends Error {}

/** The remote node did not answer within the outer timeout budget. */
export class RepeaterOpsTimeoutError extends Error {}

export type RepeaterNeighbour = {
  /** Hex of the neighbour pubkey prefix as reported by the queried node. */
  prefixHex: string;
  heardSecondsAgo: number;
  snrDb: number;
  /** Contact-book advert name when the prefix resolves, else undefined. */
  name?: string;
};

export type RepeaterNeighboursResult = {
  totalNeighboursCount: number;
  neighbours: RepeaterNeighbour[];
};

export const NEIGHBOURS_QUERY_TIMEOUT_MS = 30_000;

// Airtime of the response scales with the requested count (the repeater's
// frames, our shared frequency), so keep the page small; 8 entries fit the
// reply comfortably inside two 127-byte wire chunks.
const NEIGHBOURS_REQUEST_COUNT = 8;
const NEIGHBOURS_OFFSET = 0;
const NEIGHBOURS_ORDER_BY_NEWEST_FIRST = 0;
const NEIGHBOURS_PUBKEY_PREFIX_LENGTH = 8;

function isTimeoutLike(error: unknown): boolean {
  // meshcore.js rejects its request helpers with the bare string "timeout"
  // (not an Error) when the estimated round-trip expires.
  return error === "timeout" || error instanceof RepeaterOpsTimeoutError;
}

async function withOpsTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RepeaterOpsTimeoutError(`${label} timed out (${timeoutMs}ms)`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function requireConnectedHandle(
  accountId: string,
  deviceHandle?: MeshcoreDeviceHandle,
): MeshcoreDeviceHandle {
  const handle = deviceHandle ?? getMeshcoreDevice(accountId);
  if (!handle || !handle.connected) {
    throw new RepeaterOpsUnavailableError("node not connected");
  }
  return handle;
}

/**
 * Resolve a command argument to a full 32-byte pubkey. Accepts a full
 * !nodeId, bare hex, or any contact-book prefix (same addressing as DM sends).
 */
function resolveTargetPubkey(targetArg: string, accountId: string): Uint8Array {
  const trimmed = targetArg.trim();
  if (!trimmed) {
    throw new RepeaterOpsTargetError("missing node argument");
  }
  try {
    return nodeIdToPubkey(trimmed, accountId);
  } catch {
    throw new RepeaterOpsTargetError(
      `unknown node "${trimmed}" (use a full !nodeId or a known contact prefix)`,
    );
  }
}

function targetLabelFor(pubkey: Uint8Array, accountId: string): string {
  const contact = getContactByPubkey(pubkey, accountId);
  if (contact?.advName) {
    return contact.advName;
  }
  return `!${bytesToHex(pubkey.slice(0, 6))}`;
}

function assertOpsRateLimit(account: ResolvedMeshcoreAccount, scope: string): void {
  assertSendRateLimit({
    accountId: account.accountId,
    packets: 1,
    config: resolveSendRateLimitConfig(
      account.config.sendRateLimit as Record<string, unknown> | undefined,
    ),
    scope,
  });
}

/** Format seconds-since-last-heard compactly: 45s, 12m, 3h, 2d. */
export function formatHeardAge(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  if (clamped < 60) {
    return `${clamped}s`;
  }
  const minutes = Math.floor(clamped / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function formatSnrDb(snrDb: number): string {
  return snrDb.toFixed(1);
}

/**
 * Ask a (repeater-class) contact which nodes it currently hears.
 * Issue #35. ON AIR: the request is a SendBinaryReq frame to the target node.
 */
export async function queryNodeNeighbours(params: {
  account: ResolvedMeshcoreAccount;
  targetArg: string;
  deviceHandle?: MeshcoreDeviceHandle;
  /** Test hook: override the outer timeout budget. */
  timeoutMs?: number;
}): Promise<{ targetLabel: string; result: RepeaterNeighboursResult }> {
  const accountId = params.account.accountId;
  const pubkey = resolveTargetPubkey(params.targetArg, accountId);
  const handle = requireConnectedHandle(accountId, params.deviceHandle);
  assertOpsRateLimit(params.account, "neighbours query");

  const raw = await withOpsTimeout(
    handle.connection.getNeighbours(
      pubkey,
      NEIGHBOURS_REQUEST_COUNT,
      NEIGHBOURS_OFFSET,
      NEIGHBOURS_ORDER_BY_NEWEST_FIRST,
      NEIGHBOURS_PUBKEY_PREFIX_LENGTH,
    ),
    params.timeoutMs ?? NEIGHBOURS_QUERY_TIMEOUT_MS,
    "neighbours query",
  );

  const neighbours: RepeaterNeighbour[] = raw.neighbours.map((entry) => {
    const prefixHex = bytesToHex(entry.publicKeyPrefix);
    const contact = resolveContactByPrefix(prefixHex, accountId);
    return {
      prefixHex,
      heardSecondsAgo: entry.heardSecondsAgo,
      snrDb: entry.snr,
      name: contact?.advName || undefined,
    };
  });

  return {
    targetLabel: targetLabelFor(pubkey, accountId),
    result: {
      totalNeighboursCount: raw.totalNeighboursCount,
      neighbours,
    },
  };
}

export function formatNeighboursReply(
  targetLabel: string,
  result: RepeaterNeighboursResult,
): string {
  if (result.neighbours.length === 0) {
    return `${targetLabel} reports no neighbours`;
  }
  const entries = result.neighbours.map((neighbour) => {
    const prefix = neighbour.prefixHex.slice(0, 12);
    const name = neighbour.name ? `(${neighbour.name})` : "";
    return (
      `${prefix}${name} ` +
      `${formatHeardAge(neighbour.heardSecondsAgo)} ${formatSnrDb(neighbour.snrDb)}dB`
    );
  });
  const shownNote =
    result.totalNeighboursCount > result.neighbours.length
      ? `, showing ${result.neighbours.length}`
      : "";
  return `${targetLabel} hears ${result.totalNeighboursCount}${shownNote}: ${entries.join("; ")}`;
}

function usageFor(op: RepeaterOpsKind): string {
  switch (op) {
    case "neighbours":
      return "usage: !neighbours <node> — who does a repeater hear (full !nodeId or known contact prefix)";
  }
}

/**
 * Run one repeater-ops command and return the reply text. Never throws: all
 * failure modes (unknown node, gateway offline, rate-limited, no answer,
 * library error) are converted to a short soft reply so a DM correspondent
 * always gets a deterministic answer and never an agent session.
 */
export async function runRepeaterOpsCommand(params: {
  op: RepeaterOpsKind;
  targetArg: string;
  account: ResolvedMeshcoreAccount;
  deviceHandle?: MeshcoreDeviceHandle;
  timeoutMs?: number;
}): Promise<string> {
  const { op, account } = params;
  const targetArg = params.targetArg.trim();
  if (!targetArg) {
    return usageFor(op);
  }

  try {
    switch (op) {
      case "neighbours": {
        const { targetLabel, result } = await queryNodeNeighbours({
          account,
          targetArg,
          deviceHandle: params.deviceHandle,
          timeoutMs: params.timeoutMs,
        });
        return formatNeighboursReply(targetLabel, result);
      }
    }
  } catch (error) {
    if (error instanceof RepeaterOpsTargetError) {
      return error.message;
    }
    if (error instanceof RepeaterOpsUnavailableError) {
      return "node not connected (gateway offline?) — try again later";
    }
    if (error instanceof SendRateLimitExceededError) {
      const retrySecs = Math.ceil(error.retryAfterMs / 1_000);
      return `airtime budget exhausted — retry in ~${retrySecs}s (LoRa airtime rule)`;
    }
    if (isTimeoutLike(error)) {
      return (
        `no answer from ${targetArg} (timeout) — target may not be a ` +
        `repeater-class node, or out of range`
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return `query failed: ${message}`;
  }
}
