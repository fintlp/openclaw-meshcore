import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { bytesToHex, hexToBytes, MESHCORE_PUBKEY_LENGTH } from "./protocol.js";
import { pluginStateDir } from "./state-dir.js";
import { resolveContactByPrefix } from "./contact-book.js";

/**
 * SignedPlain (txtType === 2) direct-message payload layout, verified against
 * @liamcottle/meshcore.js 1.15.0 and the companion-protocol firmware frame:
 *
 *   [4 sender_prefix bytes][UTF-8 text]
 *
 * The library's readString() decodes the ENTIRE remaining payload, so the
 * sender prefix and the text are returned as one string. Only 4 bytes of
 * signature material are present on the wire; full Ed25519 DM verification is
 * impossible from the companion side (issue #31 design pivot).
 *
 * The DM frame header already carries the first 6 bytes of the sender pubkey.
 * A payload sender_prefix equal to pubkey[0..3] adds no new identity bits;
 * pubkey[28..31] (last4) adds 32 bits. A constant per-contact prefix that is
 * not a pubkey slice still has binding value because it lives inside the
 * pairwise-encrypted payload: a blind injector cannot observe it.
 *
 * @liamcottle/meshcore.js uses a non-fatal TextDecoder. Prefix bytes that are
 * not valid UTF-8 (e.g. >= 0x80 standing alone) become U+FFFD. U+FFFD re-
 * encodes to 3 bytes (EF BF BD), which breaks a naive re-encode->slice(4)
 * strip. The parser below detects U+FFFD in the prefix region and marks the
 * result lossy.
 */

const SIGNED_PLAIN_PREFIX_LENGTH = 4;
const UFFFD_BYTES = new Uint8Array([0xef, 0xbf, 0xbd]);

export type SignedPlainParseResult = {
  text: string;
  senderPrefixHex: string;
  lossy: boolean;
};

function startsWithUfffd(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === UFFFD_BYTES[0] &&
    bytes[offset + 1] === UFFFD_BYTES[1] &&
    bytes[offset + 2] === UFFFD_BYTES[2]
  );
}

/**
 * Parse a SignedPlain DM payload that has already been decoded by meshcore.js
 * as a single string. Returns the message text, the best-effort hex of the
 * 4-byte sender prefix, and whether the prefix region was corrupted by the
 * library's lossy TextDecoder.
 *
 * For clean inputs the output text is byte-identical to the legacy
 * stripSignedPlainPrefix() behaviour.
 */
export function parseSignedPlainPayload(decoded: string): SignedPlainParseResult {
  const fullBytes = new TextEncoder().encode(decoded);
  let lossy = false;
  let pos = 0;
  let prefixBytesConsumed = 0;

  // Consume exactly 4 wire-prefix bytes. U+FFFD replacements are 3 encoded
  // bytes but represent only 1 original prefix byte.
  while (prefixBytesConsumed < SIGNED_PLAIN_PREFIX_LENGTH && pos < fullBytes.length) {
    if (startsWithUfffd(fullBytes, pos)) {
      lossy = true;
      pos += UFFFD_BYTES.length;
    } else {
      pos += 1;
    }
    prefixBytesConsumed += 1;
  }

  // Best-effort sender prefix: the first 4 encoded bytes, or fewer if the
  // payload is shorter. For lossy prefixes this is intentionally approximate.
  const prefixByteCount = Math.min(SIGNED_PLAIN_PREFIX_LENGTH, fullBytes.length);
  const senderPrefixHex = bytesToHex(fullBytes.slice(0, prefixByteCount)).toLowerCase();

  const textBytes = fullBytes.slice(pos);
  const text = new TextDecoder().decode(textBytes);

  return { text, senderPrefixHex, lossy };
}

export type PrefixMatch = "pubkey-first4" | "pubkey-last4" | "none" | "unresolved";

/**
 * Classify a 4-byte SignedPlain sender prefix against a resolved 32-byte
 * public key.
 */
export function classifySignedPlainPrefix(params: {
  senderPrefixHex: string;
  publicKey: Uint8Array;
  lossy: boolean;
}): PrefixMatch {
  if (params.lossy) {
    return "unresolved";
  }
  if (params.publicKey.length !== MESHCORE_PUBKEY_LENGTH) {
    return "unresolved";
  }
  const hex = bytesToHex(params.publicKey).toLowerCase();
  const first4 = hex.slice(0, 8);
  const last4 = hex.slice(-8);
  const prefix = params.senderPrefixHex.toLowerCase();
  if (prefix === first4) return "pubkey-first4";
  if (prefix === last4) return "pubkey-last4";
  return "none";
}

export type PrefixConsistency =
  | "pubkey-first4"
  | "pubkey-last4"
  | "constant-unknown"
  | "varying"
  | "insufficient";

const MAX_PREFIX_OBSERVATIONS = 8;
const MIN_OBSERVATIONS_FOR_CONSISTENCY = 3;

type ContactObservationState = {
  observations: string[];
};

type IdentityBindingFileV1 = {
  version: 1;
  observations: Record<string, ContactObservationState>;
};

const observations = new Map<string, ContactObservationState>();
let stateLoaded = false;
let testIdentityBindingPath: string | undefined;

/** @internal Test-only path override; avoids env-var races across parallel test files. */
export function setIdentityBindingPathForTests(path: string | undefined): void {
  testIdentityBindingPath = path;
}

function getIdentityBindingPath(): string {
  return (
    testIdentityBindingPath ??
    process.env.MESHCORE_IDENTITY_BINDING_PATH ??
    `${pluginStateDir()}/meshcore-identity-bindings.json`
  );
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmpPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, path);
}

function ensureLoaded(): void {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(getIdentityBindingPath(), "utf8")) as unknown;
    if (
      raw &&
      typeof raw === "object" &&
      (raw as Record<string, unknown>).version === 1 &&
      typeof (raw as Record<string, unknown>).observations === "object"
    ) {
      const data = raw as IdentityBindingFileV1;
      for (const [pubkeyHex, state] of Object.entries(data.observations)) {
        if (
          state &&
          Array.isArray(state.observations) &&
          state.observations.every((o) => typeof o === "string" && /^[0-9a-f]{8}$/iu.test(o))
        ) {
          observations.set(pubkeyHex.toLowerCase(), {
            observations: state.observations.slice(-MAX_PREFIX_OBSERVATIONS),
          });
        }
      }
    }
  } catch {
    // Missing or unreadable state file is fine — observations rebuild from
    // incoming SignedPlain traffic.
  }
}

function persistObservations(): void {
  try {
    const payload: IdentityBindingFileV1 = {
      version: 1,
      observations: {},
    };
    for (const [pubkeyHex, state] of observations) {
      payload.observations[pubkeyHex] = { observations: state.observations };
    }
    atomicWriteJson(getIdentityBindingPath(), payload);
  } catch {
    // best-effort persistence
  }
}

function pubkeyHexForState(publicKey: Uint8Array): string | undefined {
  const hex = bytesToHex(publicKey).toLowerCase();
  return hex.length === MESHCORE_PUBKEY_LENGTH * 2 ? hex : undefined;
}

/**
 * Derive the consistency classification for the last 8 prefix observations
 * stored for a contact.
 */
export function derivePrefixConsistency(params: {
  observations: string[];
  publicKey: Uint8Array;
}): PrefixConsistency {
  const obs = params.observations;
  if (obs.length < MIN_OBSERVATIONS_FOR_CONSISTENCY) {
    return "insufficient";
  }
  const first = obs[0];
  if (!obs.every((o) => o === first)) {
    return "varying";
  }
  const match = classifySignedPlainPrefix({
    senderPrefixHex: first,
    publicKey: params.publicKey,
    lossy: false,
  });
  if (match === "pubkey-first4" || match === "pubkey-last4") {
    return match;
  }
  return "constant-unknown";
}

/**
 * Record a valid SignedPlain prefix observation for a contact and return the
 * updated consistency classification. Only observations that carry binding
 * value are tracked: a prefix that matches a pubkey slice (first4/last4) or a
 * non-slice constant. "none" (contact resolved but prefix is neither slice nor
 * constant yet) is not stored.
 */
export function recordPrefixObservation(params: {
  publicKey: Uint8Array;
  senderPrefixHex: string;
  prefixMatch: PrefixMatch;
}): PrefixConsistency {
  ensureLoaded();

  if (params.prefixMatch === "unresolved") {
    return readConsistency(params.publicKey);
  }

  const hex = pubkeyHexForState(params.publicKey);
  if (!hex) {
    return "insufficient";
  }

  let state = observations.get(hex);
  if (!state) {
    state = { observations: [] };
    observations.set(hex, state);
  }

  const normalizedPrefix = params.senderPrefixHex.toLowerCase();

  // Store every observation that is not unresolved. Observations that match a
  // pubkey slice are always bound to that contact; "none" observations may
  // converge to constant-unknown if the sender uses a stable per-contact
  // prefix, or may reveal a varying/spoofing sender.
  state.observations.push(normalizedPrefix);
  if (state.observations.length > MAX_PREFIX_OBSERVATIONS) {
    state.observations = state.observations.slice(-MAX_PREFIX_OBSERVATIONS);
  }
  persistObservations();

  return derivePrefixConsistency({ observations: state.observations, publicKey: params.publicKey });
}

function readConsistency(publicKey: Uint8Array): PrefixConsistency {
  ensureLoaded();
  const hex = pubkeyHexForState(publicKey);
  if (!hex) return "insufficient";
  return derivePrefixConsistency({
    observations: observations.get(hex)?.observations ?? [],
    publicKey,
  });
}

/**
 * Return the currently tracked constant prefix for a contact, if any.
 */
export function getTrackedConstantPrefix(publicKey: Uint8Array): string | undefined {
  ensureLoaded();
  const hex = pubkeyHexForState(publicKey);
  if (!hex) return undefined;
  const state = observations.get(hex);
  if (!state) return undefined;
  const consistency = derivePrefixConsistency({
    observations: state.observations,
    publicKey,
  });
  if (
    consistency === "constant-unknown" ||
    consistency === "pubkey-first4" ||
    consistency === "pubkey-last4"
  ) {
    return state.observations[0];
  }
  return undefined;
}

/**
 * Read the current consistency classification for a contact without mutating
 * state.
 */
export function readPrefixConsistency(publicKey: Uint8Array): PrefixConsistency {
  return readConsistency(publicKey);
}

/**
 * Read the stored observations for a contact without mutating state.
 */
export function getPrefixObservationsForTests(publicKey: Uint8Array): string[] {
  ensureLoaded();
  const hex = pubkeyHexForState(publicKey);
  if (!hex) return [];
  return [...(observations.get(hex)?.observations ?? [])];
}

/** @internal Reset in-memory state for tests; does not delete the persisted file. */
export function resetIdentityBindingStateForTests(): void {
  observations.clear();
  stateLoaded = false;
}

/**
 * Resolve the full public key for a 6-byte DM header prefix using the contact
 * book.
 */
export function resolvePubkeyFromDmPrefix(
  prefixHex: string,
  accountId: string,
): Uint8Array | undefined {
  const contact = resolveContactByPrefix(prefixHex.toLowerCase(), accountId);
  return contact?.publicKey;
}

export type IdentityBinding = "extended" | "prefix-only" | "mismatch";

/**
 * Decide the identityBinding value for an inbound DM.
 *
 * Rules (classify DOWN when in doubt):
 * - "mismatch": signedPlain, contact resolved, and the current prefix
 *   contradicts a previously consistent prefix for that contact.
 * - "extended": signedPlain AND (prefixMatch is pubkey-last4 OR the tracked
 *   consistency is constant-unknown with >= 3 observations).
 * - "prefix-only": everything else.
 */
export function resolveIdentityBinding(params: {
  signedPlain: boolean;
  senderPrefixHex: string;
  prefixMatch: PrefixMatch;
  consistency: PrefixConsistency;
  trackedConstantPrefix?: string;
}): IdentityBinding {
  if (!params.signedPlain) {
    return "prefix-only";
  }

  if (params.prefixMatch === "unresolved") {
    return "prefix-only";
  }

  const hasConstant =
    params.consistency === "pubkey-first4" ||
    params.consistency === "pubkey-last4" ||
    params.consistency === "constant-unknown";

  if (hasConstant && params.trackedConstantPrefix !== undefined) {
    if (params.senderPrefixHex.toLowerCase() !== params.trackedConstantPrefix.toLowerCase()) {
      return "mismatch";
    }
  }

  if (
    params.prefixMatch === "pubkey-last4" ||
    params.consistency === "constant-unknown"
  ) {
    return "extended";
  }

  return "prefix-only";
}

/**
 * Format the concise one-line console summary emitted for every SignedPlain DM.
 */
export function formatSignedPlainLogLine(params: {
  prefixHex: string;
  prefixMatch: PrefixMatch;
  consistency: PrefixConsistency;
  binding: IdentityBinding;
}): string {
  return `[meshcore] signedplain prefix=${params.prefixHex} match=${params.prefixMatch} consistency=${params.consistency} binding=${params.binding}`;
}
