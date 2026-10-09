import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bytesToHex } from "./protocol.js";
import { pluginStateDir } from "./state-dir.js";
import type { MeshcoreSelfInfo } from "./types.js";

/**
 * Live-ish node status snapshot persisted to disk so external agents can read
 * the gateway node's identity, radio parameters, and connection state without
 * probing the MeshCore node directly.
 *
 * Written at connect/handshake after SelfInfo is received and updated on
 * connect/disconnect/health-monitor-restart.
 */
export type NodeStatusSnapshot = {
  /** Advertised node name from SelfInfo. */
  name: string;
  /** Full 32-byte public key as 64 lowercase hex characters. */
  pubkey: string;
  /** Node type byte from SelfInfo. */
  type: number;
  /** Live radio parameters reported by the node. */
  radio: {
    freq: number;
    bw: number;
    sf: number;
    /** Coding rate. `raw` is the denominator as stored by firmware (e.g. 8).
     *  `resolved` is the human-readable fraction (e.g. "4/8"). */
    cr: { raw: number; resolved: string };
  };
  /** Current TX power. */
  txPower: number;
  /** Maximum TX power supported by the node. */
  maxTxPower: number;
  /** Whether the node requires manual contact addition. */
  manualAddContacts: number;
  /** Advertised position in decimal degrees. */
  position: { lat: number; lon: number };
  /** ISO 8601 timestamp when the snapshot was last fully refreshed from SelfInfo. */
  capturedAt: string;
  /** Current connection state. */
  connectionState: "connected" | "disconnected";
  /** ISO 8601 timestamp when the current connectionState began. */
  since: string;
  /** How many times the gateway monitor has been (re)started for this node. */
  reconnectCount: number;
  /** Reason for the most recent monitor restart, if known. */
  lastRestartReason?: string;
  /** ISO 8601 timestamp of the most recent monitor restart. */
  lastRestartAt?: string;
  /** Account this snapshot belongs to (omitted for the default account). */
  accountId?: string;
  /** ISO 8601 timestamp of the most recent self-advert sent by the gateway. */
  lastAdvertAt?: string;
  /** Scope of the most recent self-advert ("zero-hop" or "flood"). */
  advertScope?: "zero-hop" | "flood";
};

let testNodeStatusPath: string | undefined;

/** @internal Test-only path override; avoids env-var races across parallel test files. */
export function setNodeStatusPathForTests(path: string | undefined): void {
  testNodeStatusPath = path;
}

function getNodeStatusPath(accountId?: string): string {
  if (testNodeStatusPath) {
    return testNodeStatusPath;
  }
  const base = `${pluginStateDir()}/meshcore-node-status`;
  // Default account keeps the plain filename for backwards compatibility;
  // named accounts get a scoped file.
  return accountId && accountId !== "default"
    ? `${base}.${accountId}.json`
    : `${base}.json`;
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmpPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmpPath, path);
}

function readSnapshot(accountId?: string): Partial<NodeStatusSnapshot> {
  try {
    return JSON.parse(
      readFileSync(getNodeStatusPath(accountId), "utf8"),
    ) as Partial<NodeStatusSnapshot>;
  } catch {
    return {};
  }
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/** Build a fresh snapshot from SelfInfo plus live operational fields. */
export function buildNodeStatusSnapshot(
  selfInfo: MeshcoreSelfInfo,
  ops: {
    connectionState: "connected" | "disconnected";
    since: number;
    reconnectCount: number;
    lastRestartReason?: string;
    lastRestartAt?: number;
  },
  accountId?: string,
): NodeStatusSnapshot {
  const crDenominator = selfInfo.radioCr;
  return {
    name: selfInfo.name,
    pubkey: bytesToHex(selfInfo.publicKey).toLowerCase(),
    type: selfInfo.type,
    radio: {
      freq: selfInfo.radioFreq,
      bw: selfInfo.radioBw,
      sf: selfInfo.radioSf,
      cr: {
        raw: crDenominator,
        resolved: crDenominator > 0 ? `4/${crDenominator}` : "4/8",
      },
    },
    txPower: selfInfo.txPower,
    maxTxPower: selfInfo.maxTxPower,
    manualAddContacts: selfInfo.manualAddContacts,
    position: {
      lat: selfInfo.advLat / 1e6,
      lon: selfInfo.advLon / 1e6,
    },
    capturedAt: toIso(Date.now()),
    connectionState: ops.connectionState,
    since: toIso(ops.since),
    reconnectCount: ops.reconnectCount,
    lastRestartReason: ops.lastRestartReason,
    lastRestartAt: ops.lastRestartAt !== undefined ? toIso(ops.lastRestartAt) : undefined,
    accountId,
  };
}

/** Persist a full snapshot from SelfInfo. */
export function writeNodeStatusSnapshot(
  selfInfo: MeshcoreSelfInfo,
  ops: {
    connectionState: "connected" | "disconnected";
    since: number;
    reconnectCount: number;
    lastRestartReason?: string;
    lastRestartAt?: number;
  },
  accountId?: string,
): void {
  atomicWriteJson(
    getNodeStatusPath(accountId),
    buildNodeStatusSnapshot(selfInfo, ops, accountId),
  );
}

/** Update only the live operational fields, preserving SelfInfo data. */
export function updateNodeStatusOps(
  ops: Partial<
    Pick<
      NodeStatusSnapshot,
      | "connectionState"
      | "since"
      | "reconnectCount"
      | "lastRestartReason"
      | "lastRestartAt"
      | "lastAdvertAt"
      | "advertScope"
    >
  >,
  accountId?: string,
): void {
  const current = readSnapshot(accountId);
  const next: Partial<NodeStatusSnapshot> = { ...current };
  if (ops.connectionState !== undefined) next.connectionState = ops.connectionState;
  if (ops.since !== undefined) next.since = ops.since;
  if (ops.reconnectCount !== undefined) next.reconnectCount = ops.reconnectCount;
  if (ops.lastRestartReason !== undefined) next.lastRestartReason = ops.lastRestartReason;
  if (ops.lastRestartAt !== undefined) next.lastRestartAt = ops.lastRestartAt;
  if (ops.lastAdvertAt !== undefined) next.lastAdvertAt = ops.lastAdvertAt;
  if (ops.advertScope !== undefined) next.advertScope = ops.advertScope;
  atomicWriteJson(getNodeStatusPath(accountId), next);
}

/** @internal Read the persisted snapshot for tests/debugging. */
export function readNodeStatusSnapshot(accountId?: string): NodeStatusSnapshot | undefined {
  const data = readSnapshot(accountId);
  if (data.pubkey === undefined) {
    return undefined;
  }
  return data as NodeStatusSnapshot;
}

/** @internal Reset the test path only; does not delete the persisted file. */
export function resetNodeStatusStateForTests(): void {
  testNodeStatusPath = undefined;
}
