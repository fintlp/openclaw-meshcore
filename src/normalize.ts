import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const CHANNEL_PREFIX = "channel:";
const CH_PREFIX = "ch:";
const NODE_ID_PREFIX = "!";
const MESHCORE_PREFIX = "meshcore:";

/** Full public key is 32 bytes = 64 hex characters. */
export const MESHCORE_PUBKEY_HEX_LENGTH = 64;
/** Contact messages only carry a 6-byte = 12-hex public-key prefix. */
export const MESHCORE_PUBKEY_PREFIX_HEX_LENGTH = 12;

function isHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

function isFullPubkeyHex(value: string): boolean {
  return value.length === MESHCORE_PUBKEY_HEX_LENGTH && isHex(value);
}

function isPubkeyPrefixHex(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MESHCORE_PUBKEY_PREFIX_HEX_LENGTH &&
    isHex(value)
  );
}

export function formatMeshcoreNodeId(nodeId: string): string {
  const hex = nodeId.replace(/^!/u, "").toLowerCase();
  if (!isHex(hex)) {
    return nodeId.toLowerCase();
  }
  return `${NODE_ID_PREFIX}${hex}`;
}

export function formatMeshcoreChannelTarget(channelIndex: number): string {
  return `${CHANNEL_PREFIX}${channelIndex}`;
}

export function stripMeshcorePrefix(value: string): string {
  const lowered = normalizeLowercaseStringOrEmpty(value);
  if (lowered.startsWith(MESHCORE_PREFIX)) {
    return value.slice(MESHCORE_PREFIX.length).trim();
  }
  return value.trim();
}

export function normalizeMeshcoreMessagingTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) {
    return undefined;
  }
  const value = stripMeshcorePrefix(trimmed);
  const lowered = value.toLowerCase();

  if (lowered === "broadcast") {
    return formatMeshcoreChannelTarget(0);
  }

  const channelIndex = parseMeshcoreChannelIndex(value);
  if (channelIndex !== undefined) {
    return formatMeshcoreChannelTarget(channelIndex);
  }

  const nodeId = parseMeshcoreNodeId(value);
  if (nodeId !== undefined) {
    return formatMeshcoreNodeId(nodeId);
  }

  return undefined;
}

export function parseMeshcoreChannelIndex(target: string): number | undefined {
  const value = stripMeshcorePrefix(target).toLowerCase();
  if (value === "broadcast") {
    return 0;
  }
  let numericPart = value;
  if (numericPart.startsWith(CHANNEL_PREFIX)) {
    numericPart = numericPart.slice(CHANNEL_PREFIX.length);
  } else if (numericPart.startsWith(CH_PREFIX)) {
    numericPart = numericPart.slice(CH_PREFIX.length);
  } else {
    return undefined;
  }
  const parsed = Number.parseInt(numericPart.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 7) {
    return undefined;
  }
  return parsed;
}

export function parseMeshcoreNodeId(target: string): string | undefined {
  const value = stripMeshcorePrefix(target);
  if (value.startsWith(NODE_ID_PREFIX)) {
    const hex = value.slice(1).trim().toLowerCase();
    if (isHex(hex) && hex.length <= MESHCORE_PUBKEY_HEX_LENGTH) {
      return hex;
    }
    return undefined;
  }
  if (isHex(value) && value.length <= MESHCORE_PUBKEY_HEX_LENGTH) {
    return value.toLowerCase();
  }
  return undefined;
}

export function isMeshcoreGroupTarget(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const lowered = normalizeLowercaseStringOrEmpty(stripMeshcorePrefix(trimmed));
  return (
    lowered === "broadcast" ||
    lowered.startsWith(CHANNEL_PREFIX) ||
    lowered.startsWith(CH_PREFIX)
  );
}

export function looksLikeMeshcoreTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return normalizeMeshcoreMessagingTarget(trimmed) !== undefined;
}

function normalizeNodeIdOrName(raw: string | number): string | null {
  if (typeof raw === "number") {
    return formatMeshcoreNodeId(raw.toString(16).padStart(MESHCORE_PUBKEY_HEX_LENGTH, "0"));
  }
  const value = String(raw).trim();
  if (!value) {
    return null;
  }
  const stripped = stripMeshcorePrefix(value);
  const lowered = stripped.toLowerCase();

  if (lowered === "*") {
    return "*";
  }

  if (lowered.startsWith(NODE_ID_PREFIX)) {
    const hex = lowered.slice(1);
    if (isHex(hex) && hex.length <= MESHCORE_PUBKEY_HEX_LENGTH) {
      return `${NODE_ID_PREFIX}${hex}`;
    }
  }

  if (isHex(lowered) && lowered.length <= MESHCORE_PUBKEY_HEX_LENGTH) {
    return `${NODE_ID_PREFIX}${lowered}`;
  }

  // Treat anything else as a name allowlist entry (e.g. advert name).
  return stripped.toLowerCase();
}

export function normalizeMeshcoreAllowEntry(entry: string | number): string {
  const normalized = normalizeNodeIdOrName(entry);
  return normalized ?? "";
}

export function normalizeMeshcoreAllowlist(entries?: Array<string | number>): string[] {
  return (entries ?? [])
    .map((entry) => normalizeMeshcoreAllowEntry(entry))
    .filter((entry): entry is string => entry.length > 0);
}

export function buildMeshcoreAllowlistCandidates(params: {
  senderNodeId: string;
  senderName?: string;
}): string[] {
  const candidates = new Set<string>();
  const normalizedId = normalizeMeshcoreAllowEntry(params.senderNodeId);
  if (normalizedId) {
    candidates.add(normalizedId);
  }
  if (params.senderName) {
    const normalizedName = normalizeMeshcoreAllowEntry(params.senderName);
    if (normalizedName) {
      candidates.add(normalizedName);
    }
  }
  return Array.from(candidates);
}

export function resolveMeshcoreAllowlistMatch(params: {
  allowFrom: string[];
  senderNodeId: string;
  senderName?: string;
}): { allowed: boolean; source?: string } {
  const normalizedAllowFrom = new Set(
    params.allowFrom.map((entry) => normalizeMeshcoreAllowEntry(entry)).filter(Boolean),
  );
  if (normalizedAllowFrom.has("*")) {
    return { allowed: true, source: "wildcard" };
  }

  const senderNormalized = normalizeMeshcoreAllowEntry(params.senderNodeId);
  if (senderNormalized && normalizedAllowFrom.has(senderNormalized)) {
    return { allowed: true, source: senderNormalized };
  }

  if (params.senderName) {
    const nameNormalized = normalizeMeshcoreAllowEntry(params.senderName);
    if (nameNormalized && normalizedAllowFrom.has(nameNormalized)) {
      return { allowed: true, source: nameNormalized };
    }
  }

  // Prefix matching: an allowlist entry that is a pubkey prefix can match a
  // longer sender id, and a full sender pubkey can match an allowlist prefix.
  const senderHex = senderNormalized?.replace(/^!/u, "");
  if (senderHex) {
    for (const entry of normalizedAllowFrom) {
      if (entry === "*") continue;
      const entryHex = entry.replace(/^!/u, "");
      if (!isHex(entryHex)) continue;
      const shorter = entryHex.length <= senderHex.length ? entryHex : senderHex;
      const longer = entryHex.length <= senderHex.length ? senderHex : entryHex;
      if (longer.startsWith(shorter)) {
        return { allowed: true, source: entry };
      }
    }
  }

  return { allowed: false };
}

export function isMeshcoreNodeId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const hex = stripMeshcorePrefix(trimmed).replace(/^!/u, "");
  return isHex(hex) && hex.length <= MESHCORE_PUBKEY_HEX_LENGTH;
}
