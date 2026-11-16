import { createHash, timingSafeEqual } from "node:crypto";

const WIRE_PREFIX_BYTES = 6;
const FULL_KEY_BYTES = 32;
const FULL_KEY_HEX = /^[0-9a-fA-F]{64}$/u;
const CANONICAL_APPROVAL = /^![0-9a-fA-F]{64}$/u;
const LOWER_DIGEST_HEX = /^[0-9a-f]{64}$/u;
const LOWER_PREFIX_HEX = /^[0-9a-f]{12}$/u;

/** A live synchronized radio contact, or an account-contact-book row. */
export type DmIdentityContact = {
  publicKey: Uint8Array | readonly number[];
  advName?: string;
  name?: string;
};

/**
 * Contact-book rows are normally pre-filtered to the receiving account. The
 * optional accountId lets callers pass a mixed snapshot safely: mismatches are
 * ignored. An omitted accountId means "already scoped by the caller"; such a
 * legacy row can conflict, but can never establish a live mapping by itself.
 */
export type DmIdentityAccountContact = DmIdentityContact & {
  accountId?: string;
};

export type DmIdentityDecision =
  | { status: "invalid" }
  | { status: "unresolved" }
  | { status: "ambiguous" }
  | {
      status: "unique";
      /** Full 32-byte public key as 64 lowercase hex characters, without !. */
      fullKey: string;
      /** Canonical route/approval ID: ! followed by fullKey. */
      nodeId: string;
      /** Display metadata only; never an identity or authorization input. */
      name?: string;
    };

export type DecideDmIdentityInput = {
  accountId?: string;
  wirePrefix: Uint8Array | readonly number[];
  /** Synchronized radio contacts for the receiving account (the only live source). */
  radioContacts: readonly DmIdentityContact[];
  /** Optional account-scoped persisted rows; used only to detect conflicts. */
  accountContacts?: readonly DmIdentityAccountContact[];
};

export type DmIdentityFullKey = string | Uint8Array | readonly number[];

/** Validate before constructing a Uint8Array so invalid numbers cannot wrap/truncate. */
function validBytes(value: unknown, expectedLength: number): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value.length === expectedLength ? value : undefined;
  }
  if (!Array.isArray(value) || value.length !== expectedLength) {
    return undefined;
  }
  for (const byte of value) {
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    ) {
      return undefined;
    }
  }
  return Uint8Array.from(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function normalizeFullKeyHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.startsWith("!") ? value.slice(1) : value;
  return FULL_KEY_HEX.test(hex) ? hex.toLowerCase() : undefined;
}

function fullKeyBytes(value: unknown): Uint8Array | undefined {
  if (typeof value === "string") {
    const hex = normalizeFullKeyHex(value);
    return hex === undefined ? undefined : hexToBytes(hex);
  }
  return validBytes(value, FULL_KEY_BYTES);
}

function displayName(contact: DmIdentityContact): string | undefined {
  for (const candidate of [contact.advName, contact.name]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Resolve a DM wire prefix using live radio state plus cache conflicts.
 *
 * - Exactly one deduplicated live full key and no account-book conflict => unique.
 * - More than one live key, or any different cached key with the prefix => ambiguous.
 * - No live key => unresolved, even if the cache contains an exact match.
 * - Invalid account/prefix/live-key input => invalid.
 *
 * Account-book rows are deliberately never promoted to live evidence. Rows
 * carrying another accountId are ignored. Duplicate live names are selected
 * deterministically so contact order cannot change the decision.
 */
export function decideDmIdentity(input: DecideDmIdentityInput): DmIdentityDecision {
  if (
    !input ||
    typeof input.accountId !== "string" ||
    input.accountId.trim().length === 0
  ) {
    return { status: "invalid" };
  }
  const wirePrefix = validBytes(input.wirePrefix, WIRE_PREFIX_BYTES);
  if (!wirePrefix || !Array.isArray(input.radioContacts)) {
    return { status: "invalid" };
  }
  const wirePrefixHex = bytesToHex(wirePrefix);

  // Validate every live row, including non-matches. A malformed synchronized
  // snapshot is not safe evidence for a unique identity.
  const liveKeys = new Map<string, string[]>();
  for (const contact of input.radioContacts) {
    if (!contact || typeof contact !== "object") return { status: "invalid" };
    const publicKey = validBytes(contact.publicKey, FULL_KEY_BYTES);
    if (!publicKey) return { status: "invalid" };
    const fullKey = bytesToHex(publicKey);
    if (!fullKey.startsWith(wirePrefixHex)) continue;
    const names = liveKeys.get(fullKey) ?? [];
    const name = displayName(contact);
    if (name !== undefined) names.push(name);
    liveKeys.set(fullKey, names);
  }

  if (liveKeys.size === 0) return { status: "unresolved" };
  if (liveKeys.size !== 1) return { status: "ambiguous" };

  const [fullKey, names] = Array.from(liveKeys.entries())[0];
  if (input.accountContacts !== undefined) {
    if (!Array.isArray(input.accountContacts)) return { status: "invalid" };
    for (const cached of input.accountContacts) {
      if (!cached || typeof cached !== "object") continue;
      if (cached.accountId !== undefined && cached.accountId !== input.accountId) {
        continue;
      }
      // Malformed/stale cache rows cannot form a full-key conflict. They also
      // cannot establish identity, so ignoring them cannot grant authority.
      const cachedKeyBytes = validBytes(cached.publicKey, FULL_KEY_BYTES);
      if (!cachedKeyBytes) continue;
      const cachedKey = bytesToHex(cachedKeyBytes);
      if (cachedKey !== fullKey && cachedKey.startsWith(wirePrefixHex)) {
        return { status: "ambiguous" };
      }
    }
  }

  const uniqueNames = Array.from(new Set(names)).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return {
    status: "unique",
    fullKey,
    nodeId: `!${fullKey}`,
    ...(uniqueNames.length > 0 ? { name: uniqueNames[0] } : {}),
  };
}

/** Return ! + 64 lowercase hex only for a full key, with an optional input !. */
export function canonicalMeshcoreNodeId(value: unknown): string | undefined {
  const fullKey = normalizeFullKeyHex(value);
  return fullKey === undefined ? undefined : `!${fullKey}`;
}

/**
 * Strict approval shape: ! plus exactly 64 hex characters, without whitespace.
 * Uppercase hex is accepted, but consumers must normalize through
 * canonicalMeshcoreNodeId; the canonical persisted/compared form is lowercase.
 */
export function isCanonicalMeshcoreApproval(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_APPROVAL.test(value);
}

export type DmApprovalPartition = {
  /** Deduplicated canonical lowercase !+64hex approvals, in first-seen order. */
  canonical: string[];
  /** Original names, prefixes, bare keys, malformed values, and other legacy rows. */
  legacyOrInvalid: unknown[];
};

/** Partition approvals without promoting names, prefixes, or bare full keys. */
export function validateDmApprovalEntries(entries: readonly unknown[]): DmApprovalPartition {
  const canonical: string[] = [];
  const seen = new Set<string>();
  const legacyOrInvalid: unknown[] = [];
  if (!Array.isArray(entries)) {
    return { canonical, legacyOrInvalid: [entries] };
  }
  for (const entry of entries) {
    if (!isCanonicalMeshcoreApproval(entry)) {
      legacyOrInvalid.push(entry);
      continue;
    }
    const nodeId = canonicalMeshcoreNodeId(entry);
    // isCanonicalMeshcoreApproval guarantees this normalization cannot fail.
    if (nodeId === undefined) {
      legacyOrInvalid.push(entry);
    } else if (!seen.has(nodeId)) {
      seen.add(nodeId);
      canonical.push(nodeId);
    }
  }
  return { canonical, legacyOrInvalid };
}

export const DM_IDENTITY_EVIDENCE_VERSION = 1 as const;

export type DmIdentityEvidence = {
  version: typeof DM_IDENTITY_EVIDENCE_VERSION;
  /** Exact six-byte wire prefix as 12 lowercase hex characters. */
  wirePrefixHex: string;
  /** SHA-256 of the raw 32-byte selected public key, as lowercase hex. */
  fullKeySha256: string;
};

/** SHA-256 of the raw public-key bytes (not of its human-readable hex form). */
export function fullKeySha256(fullKey: DmIdentityFullKey): string {
  const publicKey = fullKeyBytes(fullKey);
  if (!publicKey) throw new TypeError("MeshCore full key must be exactly 32 valid bytes");
  return createHash("sha256").update(publicKey).digest("hex");
}

export function createDmIdentityEvidence(input: {
  wirePrefix: Uint8Array | readonly number[];
  fullKey: DmIdentityFullKey;
}): DmIdentityEvidence {
  const wirePrefix = validBytes(input.wirePrefix, WIRE_PREFIX_BYTES);
  if (!wirePrefix) throw new TypeError("MeshCore wire prefix must be exactly 6 valid bytes");
  return {
    version: DM_IDENTITY_EVIDENCE_VERSION,
    wirePrefixHex: bytesToHex(wirePrefix),
    fullKeySha256: fullKeySha256(input.fullKey),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse evidence from persisted rawJson. The chosen storage shape is:
 *
 *   { ...otherRawJsonFields, dmIdentityEvidence: { version, wirePrefixHex, fullKeySha256 } }
 *
 * rawJson may be a JSON string or its already-parsed top-level object. A bare
 * evidence object and alternative nesting properties are intentionally not
 * accepted. The evidence object itself is strict: exactly three own fields,
 * version 1, and canonical lowercase hex. Unrelated wrapper fields are allowed.
 */
export function parseDmIdentityEvidence(rawJson: unknown): DmIdentityEvidence | undefined {
  let decoded = rawJson;
  if (typeof rawJson === "string") {
    try {
      decoded = JSON.parse(rawJson) as unknown;
    } catch {
      return undefined;
    }
  }
  const wrapper = objectRecord(decoded);
  if (!wrapper) return undefined;
  const evidence = objectRecord(wrapper.dmIdentityEvidence);
  if (!evidence) return undefined;

  const requiredKeys = ["version", "wirePrefixHex", "fullKeySha256"] as const;
  const ownKeys = Reflect.ownKeys(evidence);
  if (
    ownKeys.length !== requiredKeys.length ||
    !requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(evidence, key))
  ) {
    return undefined;
  }
  if (
    evidence.version !== DM_IDENTITY_EVIDENCE_VERSION ||
    typeof evidence.wirePrefixHex !== "string" ||
    !LOWER_PREFIX_HEX.test(evidence.wirePrefixHex) ||
    typeof evidence.fullKeySha256 !== "string" ||
    !LOWER_DIGEST_HEX.test(evidence.fullKeySha256)
  ) {
    return undefined;
  }
  return {
    version: DM_IDENTITY_EVIDENCE_VERSION,
    wirePrefixHex: evidence.wirePrefixHex,
    fullKeySha256: evidence.fullKeySha256,
  };
}

/** Fixed-length timing-safe comparison after strict lowercase-digest validation. */
export function dmIdentityDigestsEqual(left: unknown, right: unknown): boolean {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    !LOWER_DIGEST_HEX.test(left) ||
    !LOWER_DIGEST_HEX.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(hexToBytes(left), hexToBytes(right));
}

export type DmCommandAuthorization = {
  hostCommandAuthorized: false;
  commandInterpretationSuppressed: true;
  nativeAuthorized: boolean;
  reason: string;
};

const NATIVE_COMMANDS = new Set(["!ping", "!status", "!neighbours", "!rstatus", "!trace"]);

function validatedUniqueFullKey(identity: DmIdentityDecision): string | undefined {
  if (identity.status !== "unique") return undefined;
  const fullKey = normalizeFullKeyHex(identity.fullKey);
  // decideDmIdentity always emits lowercase fullKey and the matching nodeId.
  // Revalidate at this security boundary rather than trusting a forged union.
  if (fullKey === undefined || identity.fullKey !== fullKey || identity.nodeId !== `!${fullKey}`) {
    return undefined;
  }
  return fullKey;
}

/**
 * One fail-closed command decision for stock prefix-addressed DM peers.
 *
 * Host command interpretation is always suppressed here: a unique radio
 * mapping is routing evidence, not independent command proof. Native commands
 * are also denied except for an explicitly configured !ping compatibility
 * exception requiring a validated unique identity, a canonical !+64hex
 * allowlist entry for that exact full key, and enabled command replies.
 */
export function authorizeDmCommand(input: {
  identity: DmIdentityDecision;
  nativeCommand?: string;
  nativePingAllowFrom?: Array<string | number>;
  commandRepliesEnabled?: boolean;
}): DmCommandAuthorization {
  const fullKey = validatedUniqueFullKey(input.identity);
  let nativeAuthorized = false;
  let reason: string;

  if (input.nativeCommand === undefined) {
    reason = fullKey
      ? "host-commands-require-independent-proof"
      : input.identity.status === "unique"
        ? "dm-identity-invalid"
        : `dm-identity-${input.identity.status}`;
  } else if (!fullKey) {
    reason = input.identity.status === "unique"
      ? "dm-identity-invalid"
      : `dm-identity-${input.identity.status}`;
  } else if (!NATIVE_COMMANDS.has(input.nativeCommand)) {
    reason = "unrecognized-native-command";
  } else if (input.commandRepliesEnabled === false) {
    reason = "native-command-replies-disabled";
  } else if (input.nativeCommand !== "!ping") {
    reason = "native-command-default-deny";
  } else {
    const expectedNodeId = `!${fullKey}`;
    const allowed = (Array.isArray(input.nativePingAllowFrom) ? input.nativePingAllowFrom : []).some(
      (entry) =>
        isCanonicalMeshcoreApproval(entry) &&
        canonicalMeshcoreNodeId(entry) === expectedNodeId,
    );
    nativeAuthorized = allowed;
    reason = allowed ? "unique-full-key-ping-allowlisted" : "native-ping-not-allowlisted";
  }

  return {
    hostCommandAuthorized: false,
    commandInterpretationSuppressed: true,
    nativeAuthorized,
    reason,
  };
}
