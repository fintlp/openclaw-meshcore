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
import { randomInt } from "node:crypto";
import { getContactByPubkey, getContactBookEntries, resolveContactByPrefix } from "./contact-book.js";
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

export type RepeaterOpsKind = "neighbours" | "rstatus" | "trace";

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

export type RemoteNodeStatus = {
  batteryMv: number;
  txQueueLen: number;
  noiseFloorDbm: number;
  lastRssiDbm: number;
  packetsRecv: number;
  packetsSent: number;
  airtimeSecs: number;
  uptimeSecs: number;
  sentFlood: number;
  sentDirect: number;
  recvFlood: number;
  recvDirect: number;
  errEvents: number;
  lastSnrDb: number;
  directDups: number;
  floodDups: number;
};

export type TraceHop = {
  /** Path hash of the hop as reported in the TraceData frame, hex (1-4 bytes). */
  hashHex: string;
  snrDb: number;
  /**
   * Contact-book advert name, only when exactly one known contact carries
   * this hash prefix (short hashes collide easily; ambiguous = unnamed).
   */
  name?: string;
};

export type TracePathResult = {
  hops: TraceHop[];
  /** SNR of the final link back to us, dB. */
  lastSnrDb: number;
  /** True when the route was just [target] — no relay was involved. */
  direct: boolean;
};

export const NEIGHBOURS_QUERY_TIMEOUT_MS = 30_000;
export const STATUS_REQUEST_TIMEOUT_MS = 30_000;
// Multi-hop round trips stack per-relay airtime, so the trace budget is the
// largest of the three.
export const TRACE_PATH_TIMEOUT_MS = 45_000;

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

/**
 * Pull a remote node's status frame: repeater-class stack/radio health
 * counters. Issue #34. ON AIR: the request is a SendStatusReq frame to the
 * target node.
 */
export async function queryRemoteNodeStatus(params: {
  account: ResolvedMeshcoreAccount;
  targetArg: string;
  deviceHandle?: MeshcoreDeviceHandle;
  /** Test hook: override the outer timeout budget. */
  timeoutMs?: number;
}): Promise<{ targetLabel: string; result: RemoteNodeStatus }> {
  const accountId = params.account.accountId;
  const pubkey = resolveTargetPubkey(params.targetArg, accountId);
  const handle = requireConnectedHandle(accountId, params.deviceHandle);
  assertOpsRateLimit(params.account, "status request");

  const raw = await withOpsTimeout(
    handle.connection.getStatus(pubkey),
    params.timeoutMs ?? STATUS_REQUEST_TIMEOUT_MS,
    "status request",
  );

  return {
    targetLabel: targetLabelFor(pubkey, accountId),
    result: {
      batteryMv: raw.batt_milli_volts,
      txQueueLen: raw.curr_tx_queue_len,
      noiseFloorDbm: raw.noise_floor,
      lastRssiDbm: raw.last_rssi,
      packetsRecv: raw.n_packets_recv,
      packetsSent: raw.n_packets_sent,
      airtimeSecs: raw.total_air_time_secs,
      uptimeSecs: raw.total_up_time_secs,
      sentFlood: raw.n_sent_flood,
      sentDirect: raw.n_sent_direct,
      recvFlood: raw.n_recv_flood,
      recvDirect: raw.n_recv_direct,
      errEvents: raw.err_events,
      // Every other SNR field in the companion protocol is quarter-dB; the
      // repeater status frame follows the same convention (verify against
      // live firmware when a repeater contact exists, issue #24).
      lastSnrDb: raw.last_snr / 4,
      directDups: raw.n_direct_dups,
      floodDups: raw.n_flood_dups,
    },
  };
}

export function formatRemoteStatusReply(targetLabel: string, result: RemoteNodeStatus): string {
  return (
    `${targetLabel} bat:${(result.batteryMv / 1000).toFixed(2)}V ` +
    `txq:${result.txQueueLen} nf:${result.noiseFloorDbm} rssi:${result.lastRssiDbm} ` +
    `rx:${result.packetsRecv} tx:${result.packetsSent} ` +
    `air:${formatHeardAge(result.airtimeSecs)} up:${formatHeardAge(result.uptimeSecs)} ` +
    `err:${result.errEvents} snr:${formatSnrDb(result.lastSnrDb)} ` +
    `dup:${result.directDups}/${result.floodDups}`
  );
}

/** Reinterpret an unsigned byte as signed int8. */
function int8(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}

function resolveHopName(hashHex: string, accountId: string): string | undefined {
  const matches = getContactBookEntries(accountId).filter((entry) =>
    bytesToHex(entry.publicKey).startsWith(hashHex),
  );
  if (matches.length !== 1) {
    return undefined;
  }
  return matches[0].advName || undefined;
}

// --- Trace route building (issue #52) ---------------------------------------
//
// A MeshCore trace is source-routed: CMD_SEND_TRACE_PATH takes the route as a
// list of hop hashes, and a hop hash is the first N bytes of a node's pubkey
// (firmware Identity.copyHashTo). The route must go out AND back, because the
// node that receives the packet after the last hop is the one that reports
// (Mesh.cpp onRecvPacket -> onTraceRecv): [R] for a direct neighbour,
// [A, R, A] behind one repeater. The route comes from the contact book's
// out-path (the path adverts/DMs arrive on), never from the bare pubkey —
// passing the 32-byte key made the firmware try 32 one-byte hops and every
// trace timed out.

const OUT_PATH_UNKNOWN = 0xff;
/** Firmware bound: (route bytes >> pathSz) must be <= MAX_PATH_SIZE (64). */
const TRACE_MAX_ROUTE_ELEMENTS = 64;
// The command-frame cap (route bytes < MAX_PACKET_PAYLOAD(184) - 15) can never
// bite first: a valid contact path holds at most 64 bytes, so a route is at
// most 2*64 + 4 = 132 bytes. Only the element cap is enforced.

export type TraceRoutePlan = {
  ok: true;
  /** Route bytes: out-path hops + target hash + hops reversed, each `width` bytes. */
  route: Uint8Array;
  /** flags low 2 bits for CMD_SEND_TRACE_PATH: log2(width). */
  pathSz: number;
  /** Bytes per hop hash: 1, 2 or 4. */
  width: number;
  /** True when the route is just [target]. */
  direct: boolean;
  /** Relay hops each way: (route elements - 1) / 2. */
  hopCount: number;
};

export type TraceRouteRefusal = {
  ok: false;
  code: "unknown-path" | "route-too-long";
  hopCount?: number;
};

/**
 * Build the out-and-back trace route from a contact-book entry.
 * Contact out_path_len uses the packet path encoding: low 6 bits = hop count,
 * top 2 bits = hash size - 1, 0xFF = unknown, 0 = direct. The book stores the
 * library's signed int8, so decode with & 0xFF first.
 */
export function buildTraceRoute(contact: {
  publicKey: Uint8Array;
  outPathLen: number;
  outPath: Uint8Array;
}): TraceRoutePlan | TraceRouteRefusal {
  const stored = contact.outPathLen & 0xff;
  if (stored === OUT_PATH_UNKNOWN) {
    return { ok: false, code: "unknown-path" };
  }
  const hopCount = stored & 63;
  const contactWidth = (stored >> 6) + 1;
  if (hopCount * contactWidth > 64) {
    // Inconsistent with firmware Packet.isValidPathLen — no usable path.
    return { ok: false, code: "unknown-path" };
  }
  // Trace hash widths are 1/2/4 (1 << pathSz); a 3-byte prefix still matches
  // when truncated to 2 (firmware isHashMatch compares prefix bytes only).
  const width = contactWidth === 3 ? 2 : contactWidth;
  const elements = 2 * hopCount + 1;
  if (elements > TRACE_MAX_ROUTE_ELEMENTS) {
    return { ok: false, code: "route-too-long", hopCount };
  }
  const route = new Uint8Array(elements * width);
  for (let i = 0; i < hopCount; i += 1) {
    route.set(contact.outPath.subarray(i * contactWidth, i * contactWidth + width), i * width);
  }
  route.set(contact.publicKey.subarray(0, width), hopCount * width);
  for (let i = 0; i < hopCount; i += 1) {
    const hop = hopCount - 1 - i;
    route.set(
      contact.outPath.subarray(hop * contactWidth, hop * contactWidth + width),
      (hopCount + 1 + i) * width,
    );
  }
  const pathSz = width === 1 ? 0 : width === 2 ? 1 : 2;
  return { ok: true, route, pathSz, width, direct: hopCount === 0, hopCount };
}

// --- Trace request/response wire I/O (issue #52) ----------------------------
// meshcore.js 1.15.0 cannot drive this exchange: sendCommandSendTracePath
// hardcodes flags=0, and its 0x89 parser reads path_len SNR bytes where the
// firmware sends path_len >> path_sz plus a final SNR. So the request frame
// is written here and the push is parsed from the raw "rx" stream.

const CMD_SEND_TRACE_PATH = 36;
const RESP_CODE_ERR = 1;
const RESP_CODE_SENT = 6;
const PUSH_CODE_TRACE_DATA = 0x89;

/** Margin on top of the firmware's est_timeout while waiting for trace data. */
export const TRACE_EST_TIMEOUT_MARGIN_MS = 1_000;

/** Build the request frame: [36][tag u32 LE][auth 0 u32 LE][flags = pathSz][route]. */
export function buildTraceRequestFrame(
  tag: number,
  pathSz: number,
  route: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(10 + route.length);
  const view = new DataView(frame.buffer);
  frame[0] = CMD_SEND_TRACE_PATH;
  view.setUint32(1, tag, true);
  // auth: 0 — the firmware echoes it in the push; no use today.
  view.setUint32(5, 0, true);
  frame[9] = pathSz & 0x03;
  frame.set(route, 10);
  return frame;
}

export type TraceDataPush = {
  tag: number;
  authCode: number;
  flags: number;
  pathSz: number;
  /** Bytes per hop hash in this frame: 1 << pathSz. */
  width: number;
  /** Route elements traversed (= hashes.length / width = SNR byte count). */
  hopCount: number;
  /** Route hashes, hopCount * width bytes, in traversed order. */
  hashes: Uint8Array;
  /** One raw quarter-dB byte per hop (unsigned on the wire, signed value). */
  snrBytes: Uint8Array;
  /** Final-link SNR, signed quarter-dB (firmware writes SNR * 4 as int8). */
  finalSnrByte: number;
};

/**
 * Parse a PUSH_CODE_TRACE_DATA (0x89) frame:
 * [0x89][reserved][path_len][flags][tag u32 LE][auth u32 LE]
 * [path_hashes: path_len][path_snrs: path_len >> path_sz][final SNR int8].
 * Returns undefined for anything that is not a well-formed 0x89 frame — wire
 * input is untrusted.
 */
export function parseTraceDataPushFrame(frame: Uint8Array): TraceDataPush | undefined {
  if (frame.length < 13 || frame[0] !== PUSH_CODE_TRACE_DATA) {
    return undefined;
  }
  const pathLen = frame[2];
  const flags = frame[3];
  const pathSz = flags & 0x03;
  const width = 1 << pathSz;
  if (pathLen === 0 || pathLen % width !== 0) {
    return undefined;
  }
  const hopCount = pathLen >> pathSz;
  if (frame.length !== 12 + pathLen + hopCount + 1) {
    return undefined;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    tag: view.getUint32(4, true),
    authCode: view.getUint32(8, true),
    flags,
    pathSz,
    width,
    hopCount,
    hashes: frame.slice(12, 12 + pathLen),
    snrBytes: frame.slice(12 + pathLen, 12 + pathLen + hopCount),
    finalSnrByte: view.getInt8(12 + pathLen + hopCount),
  };
}

/**
 * Send the trace request and wait for its 0x89 push, correlated by a random
 * tag. Stage 1 waits for RESP_CODE_SENT; its est_timeout + margin becomes the
 * stage-2 budget (the outer timeout in tracePathToNode stays the cap). Stage
 * 2 ignores 0x89 frames with other tags — a late push from an earlier,
 * timed-out trace must not resolve this one.
 */
async function runTraceRequest(params: {
  handle: MeshcoreDeviceHandle;
  plan: TraceRoutePlan;
  estMarginMs: number;
}): Promise<TraceDataPush> {
  const { handle, plan } = params;
  const connection = handle.connection;
  const tag = randomInt(0, 0x1_0000_0000);
  const requestFrame = buildTraceRequestFrame(tag, plan.pathSz, plan.route);

  return await new Promise<TraceDataPush>((resolve, reject) => {
    let awaitingSent = true;
    let innerTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      connection.off("rx", onRx);
      if (innerTimer) {
        clearTimeout(innerTimer);
      }
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onRx = (raw: Uint8Array) => {
      const frame = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (frame.length === 0) {
        return;
      }
      if (awaitingSent && frame[0] === RESP_CODE_SENT && frame.length >= 10) {
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        if (view.getUint32(2, true) !== tag) {
          return; // Sent for another in-flight request
        }
        const estTimeout = view.getUint32(6, true);
        awaitingSent = false;
        innerTimer = setTimeout(() => {
          fail(new RepeaterOpsTimeoutError(`trace data timed out (est ${estTimeout}ms + margin)`));
        }, estTimeout + params.estMarginMs);
        return;
      }
      if (awaitingSent && frame[0] === RESP_CODE_ERR) {
        const code = frame.length > 1 ? frame[1] : -1;
        fail(new Error(`trace request rejected by the node (err ${code})`));
        return;
      }
      if (frame[0] === PUSH_CODE_TRACE_DATA) {
        const push = parseTraceDataPushFrame(frame);
        if (!push || push.tag !== tag) {
          return;
        }
        cleanup();
        resolve(push);
      }
    };
    connection.on("rx", onRx);
    Promise.resolve(connection.sendToRadioFrame(requestFrame)).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * Map a parsed trace push to the reply's hop list: the route's hashes in
 * order with their SNRs, names only on a unique contact-prefix match, and the
 * final-link SNR from the trailing byte.
 */
export function normalizeTraceRouteResult(
  raw: TraceDataPush,
  opts: { direct: boolean },
  accountId: string,
): TracePathResult {
  const hops: TraceHop[] = [];
  for (let i = 0; i < raw.hopCount; i += 1) {
    const hashHex = bytesToHex(raw.hashes.subarray(i * raw.width, (i + 1) * raw.width));
    const snrRaw = i < raw.snrBytes.length ? int8(raw.snrBytes[i]) : 0;
    hops.push({
      hashHex,
      snrDb: snrRaw / 4,
      name: resolveHopName(hashHex, accountId),
    });
  }
  return { hops, lastSnrDb: raw.finalSnrByte / 4, direct: opts.direct };
}

/**
 * MeshCore traceroute toward a contact: the reply reports the route the
 * frame took through the mesh. Issue #33. ON AIR: a SendTracePath frame,
 * plus forwarding airtime on every relay along the path.
 */
export async function tracePathToNode(params: {
  account: ResolvedMeshcoreAccount;
  targetArg: string;
  deviceHandle?: MeshcoreDeviceHandle;
  /** Test hook: override the outer timeout budget. */
  timeoutMs?: number;
  /** Test hook: override the est-timeout margin for the data stage. */
  estMarginMs?: number;
}): Promise<{ targetLabel: string; result: TracePathResult }> {
  const accountId = params.account.accountId;
  const pubkey = resolveTargetPubkey(params.targetArg, accountId);
  const handle = requireConnectedHandle(accountId, params.deviceHandle);
  const targetLabel = targetLabelFor(pubkey, accountId);

  // Route before rate limit: a refusal never goes on air, so it must not
  // spend airtime budget either.
  const contact = getContactByPubkey(pubkey, accountId);
  const plan: TraceRoutePlan | TraceRouteRefusal = contact
    ? buildTraceRoute(contact)
    : { ok: false, code: "unknown-path" };
  if (!plan.ok) {
    throw new RepeaterOpsTargetError(
      plan.code === "route-too-long"
        ? `route to ${targetLabel} is too long to trace (${plan.hopCount} relay hops each way)`
        : `no known route to ${targetLabel} yet; wait for an advert or a DM`,
    );
  }
  assertOpsRateLimit(params.account, "path trace");

  const raw = await withOpsTimeout(
    runTraceRequest({
      handle,
      plan,
      estMarginMs: params.estMarginMs ?? TRACE_EST_TIMEOUT_MARGIN_MS,
    }),
    params.timeoutMs ?? TRACE_PATH_TIMEOUT_MS,
    "path trace",
  );

  return {
    targetLabel,
    result: normalizeTraceRouteResult(raw, { direct: plan.direct }, accountId),
  };
}

export function formatTraceReply(targetLabel: string, result: TracePathResult): string {
  if (result.direct) {
    // The single hop is the target itself: its SNR is the out leg measured at
    // the target, the final-link byte is the return leg measured at us.
    const out = result.hops[0];
    const outPart = out ? `out ${formatSnrDb(out.snrDb)}dB, ` : "";
    return `path to ${targetLabel}: direct (${outPart}final-link ${formatSnrDb(result.lastSnrDb)}dB)`;
  }
  const hops = result.hops
    .map((hop) => `${hop.hashHex}${hop.name ? `(${hop.name})` : ""} ${formatSnrDb(hop.snrDb)}dB`)
    .join(" > ");
  return (
    `path to ${targetLabel}: ${result.hops.length} hop${result.hops.length === 1 ? "" : "s"} ` +
    `${hops} (final-link ${formatSnrDb(result.lastSnrDb)}dB)`
  );
}

function usageFor(op: RepeaterOpsKind): string {
  switch (op) {
    case "neighbours":
      return "usage: !neighbours <node> — who does a repeater hear (full !nodeId or known contact prefix)";
    case "rstatus":
      return "usage: !rstatus <node> — pull a remote node's health frame (full !nodeId or known contact prefix)";
    case "trace":
      return "usage: !trace <node> — traceroute through the mesh (full !nodeId or known contact prefix)";
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
  estMarginMs?: number;
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
      case "rstatus": {
        const { targetLabel, result } = await queryRemoteNodeStatus({
          account,
          targetArg,
          deviceHandle: params.deviceHandle,
          timeoutMs: params.timeoutMs,
        });
        return formatRemoteStatusReply(targetLabel, result);
      }
      case "trace": {
        const { targetLabel, result } = await tracePathToNode({
          account,
          targetArg,
          deviceHandle: params.deviceHandle,
          timeoutMs: params.timeoutMs,
          estMarginMs: params.estMarginMs,
        });
        return formatTraceReply(targetLabel, result);
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
