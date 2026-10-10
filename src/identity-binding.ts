import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import {
  bytesToHex,
  hexToBytes,
  MESHCORE_PUBKEY_LENGTH,
} from "./protocol.js";
import { pluginStateDir } from "./state-dir.js";
import {
  getContactBookEntries,
  onContactBookChange,
  resolveContactByPrefix,
} from "./contact-book.js";

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
 * @liamcottle/meshcore.js uses a non-fatal TextDecoder. Invalid prefix byte
 * sequences are replaced with U+FFFD using WHATWG "maximal subpart" rules:
 * a single U+FFFD can collapse up to 3 raw prefix bytes. U+FFFD re-encodes
 * to 3 bytes (EF BF BD), which breaks a naive re-encode->slice(4) strip.
 *
 * The parser below detects U+FFFD in the prefix region and marks the result
 * lossy. To guarantee real text is never dropped, each U+FFFD is counted as
 * 3 raw prefix bytes. This may leave 1-2 spurious prefix-residue characters
 * at the start of the returned text; callers must consult meshSecurity.lossy
 * and must NOT promote lossy prefixes to extended identity.
 */

const SIGNED_PLAIN_PREFIX_LENGTH = 4;
const UFFFD_BYTES = new Uint8Array([0xef, 0xbf, 0xbd]);

export type SignedPlainParseResult = {
  text: string;
  /** null when the prefix region was lossy; the artifacts are not a real prefix. */
  senderPrefixHex: string | null;
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
 * as a single string. Returns the message text, the sender prefix hex (null
 * when lossy), and whether the prefix region was corrupted by the library's
 * non-fatal TextDecoder.
 *
 * For clean inputs the output text is byte-identical to the legacy
 * stripSignedPlainPrefix() behaviour. For lossy inputs, real text is never
 * dropped, but 1-2 spurious prefix-residue characters may remain at the text
 * start.
 */
export function parseSignedPlainPayload(decoded: string): SignedPlainParseResult {
  const fullBytes = new TextEncoder().encode(decoded);
  let lossy = false;
  let pos = 0;
  let rawBytesConsumed = 0;

  // Consume exactly 4 raw prefix bytes. WHATWG maximal-subpart replacement
  // means one U+FFFD may collapse up to 3 raw bytes; counting each U+FFFD as
  // 3 raw bytes guarantees we never advance into the real text.
  while (rawBytesConsumed < SIGNED_PLAIN_PREFIX_LENGTH && pos < fullBytes.length) {
    if (startsWithUfffd(fullBytes, pos)) {
      lossy = true;
      pos += UFFFD_BYTES.length;
      rawBytesConsumed += UFFFD_BYTES.length;
    } else {
      pos += 1;
      rawBytesConsumed += 1;
    }
  }

  const textBytes = fullBytes.slice(pos);
  const text = new TextDecoder().decode(textBytes);

  if (lossy) {
    return { text, senderPrefixHex: null, lossy: true };
  }

  const prefixByteCount = Math.min(SIGNED_PLAIN_PREFIX_LENGTH, fullBytes.length);
  const senderPrefixHex = bytesToHex(fullBytes.slice(0, prefixByteCount)).toLowerCase();
  return { text, senderPrefixHex, lossy: false };
}

export type PrefixMatch =
  | "pubkey-first4"
  | "pubkey-last4"
  | "none"
  | "unresolved"
  | "lossy";

/**
 * Classify a 4-byte SignedPlain sender prefix against a resolved 32-byte
 * public key. Lossy prefixes are classified as "lossy" and never grant
 * extended identity.
 */
export function classifySignedPlainPrefix(params: {
  senderPrefixHex: string | null;
  publicKey: Uint8Array;
  lossy: boolean;
}): PrefixMatch {
  if (params.lossy || params.senderPrefixHex === null) {
    return "lossy";
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

const DEFAULT_ACCOUNT_ID = "default";

type ContactObservationState = {
  observations: string[];
};

type IdentityBindingFileV1 = {
  version: 1;
  observations: Record<string, Record<string, ContactObservationState>>;
};

// Per-account observation storage, mirroring contact-book.ts isolation.
const observationsByAccount = new Map<string, Map<string, ContactObservationState>>();
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

function getAccountMap(accountId: string): Map<string, ContactObservationState> {
  let map = observationsByAccount.get(accountId);
  if (!map) {
    map = new Map();
    observationsByAccount.set(accountId, map);
  }
  return map;
}

function pubkeyHexForState(publicKey: Uint8Array): string | undefined {
  const hex = bytesToHex(publicKey).toLowerCase();
  return hex.length === MESHCORE_PUBKEY_LENGTH * 2 ? hex : undefined;
}

function normalizeObservationEntry(entry: unknown): ContactObservationState | undefined {
  if (!entry || typeof entry !== "object" || !Array.isArray((entry as ContactObservationState).observations)) {
    return undefined;
  }
  const observations = (entry as ContactObservationState).observations.filter(
    (o): o is string => typeof o === "string" && /^[0-9a-f]{8}$/iu.test(o),
  );
  if (observations.length === 0) return undefined;
  return { observations: observations.slice(-MAX_PREFIX_OBSERVATIONS) };
}

function ensureLoaded(): void {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(getIdentityBindingPath(), "utf8")) as unknown;
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw as Record<string, unknown>).version !== 1 ||
      typeof (raw as Record<string, unknown>).observations !== "object"
    ) {
      return;
    }
    const data = raw as IdentityBindingFileV1;
    for (const [accountId, accountObservations] of Object.entries(data.observations)) {
      if (!accountObservations || typeof accountObservations !== "object") continue;
      const map = getAccountMap(accountId);
      for (const [pubkeyHex, entry] of Object.entries(accountObservations)) {
        const normalized = normalizeObservationEntry(entry);
        if (normalized) {
          map.set(pubkeyHex.toLowerCase(), normalized);
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
    for (const [accountId, map] of observationsByAccount) {
      payload.observations[accountId] = {};
      for (const [pubkeyHex, state] of map) {
        payload.observations[accountId]![pubkeyHex] = { observations: state.observations };
      }
    }
    atomicWriteJson(getIdentityBindingPath(), payload);
  } catch {
    // best-effort persistence
  }
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

function readConsistency(params: {
  publicKey: Uint8Array;
  accountId: string;
}): PrefixConsistency {
  ensureLoaded();
  const hex = pubkeyHexForState(params.publicKey);
  if (!hex) return "insufficient";
  return derivePrefixConsistency({
    observations: getAccountMap(params.accountId).get(hex)?.observations ?? [],
    publicKey: params.publicKey,
  });
}

/**
 * Return the currently tracked constant prefix for a contact, if any.
 * This reads the pre-observation window; call before recordPrefixObservation
 * when resolving identityBinding so a contradicting prefix is detected.
 */
export function getTrackedConstantPrefix(
  publicKey: Uint8Array,
  accountId: string,
): string | undefined {
  ensureLoaded();
  const hex = pubkeyHexForState(publicKey);
  if (!hex) return undefined;
  const state = getAccountMap(accountId).get(hex);
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
 * Record a valid SignedPlain prefix observation for a contact and return the
 * updated consistency classification. Lossy and unresolved observations are
 * ignored.
 */
export function recordPrefixObservation(params: {
  publicKey: Uint8Array;
  senderPrefixHex: string | null;
  prefixMatch: PrefixMatch;
  accountId: string;
}): PrefixConsistency {
  ensureLoaded();

  if (params.prefixMatch === "lossy" || params.prefixMatch === "unresolved") {
    return readConsistency({ publicKey: params.publicKey, accountId: params.accountId });
  }

  const hex = pubkeyHexForState(params.publicKey);
  if (!hex) {
    return "insufficient";
  }

  const map = getAccountMap(params.accountId);
  let state = map.get(hex);
  if (!state) {
    state = { observations: [] };
    map.set(hex, state);
  }

  const normalizedPrefix = params.senderPrefixHex?.toLowerCase() ?? "";

  state.observations.push(normalizedPrefix);
  if (state.observations.length > MAX_PREFIX_OBSERVATIONS) {
    state.observations = state.observations.slice(-MAX_PREFIX_OBSERVATIONS);
  }
  persistObservations();

  return derivePrefixConsistency({ observations: state.observations, publicKey: params.publicKey });
}

/**
 * Read the current consistency classification for a contact without mutating
 * state.
 */
export function readPrefixConsistency(
  publicKey: Uint8Array,
  accountId: string,
): PrefixConsistency {
  return readConsistency({ publicKey, accountId });
}

/**
 * Read the stored observations for a contact without mutating state.
 */
export function getPrefixObservationsForTests(
  publicKey: Uint8Array,
  accountId: string,
): string[] {
  ensureLoaded();
  const hex = pubkeyHexForState(publicKey);
  if (!hex) return [];
  return [...(getAccountMap(accountId).get(hex)?.observations ?? [])];
}

/** @internal Reset in-memory state for tests; does not delete the persisted file. */
export function resetIdentityBindingStateForTests(): void {
  observationsByAccount.clear();
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
 *
 * This function must be called with the PRE-observation tracked constant and
 * consistency so that a contradicting prefix is reported as mismatch before
 * it is recorded.
 */
export function resolveIdentityBinding(params: {
  signedPlain: boolean;
  senderPrefixHex: string | null;
  prefixMatch: PrefixMatch;
  consistency: PrefixConsistency;
  trackedConstantPrefix?: string;
}): IdentityBinding {
  if (!params.signedPlain) {
    return "prefix-only";
  }

  if (params.prefixMatch === "lossy" || params.prefixMatch === "unresolved") {
    return "prefix-only";
  }

  const hasConstant =
    params.consistency === "pubkey-first4" ||
    params.consistency === "pubkey-last4" ||
    params.consistency === "constant-unknown";

  if (hasConstant && params.trackedConstantPrefix !== undefined) {
    if ((params.senderPrefixHex?.toLowerCase() ?? "") !== params.trackedConstantPrefix.toLowerCase()) {
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
 * Uses console.log (not the plugin logger) because README documents that
 * logger.info is filtered from gateway.log; operators grep gateway.log for
 * these lines post-install.
 */
export function formatSignedPlainLogLine(params: {
  timestamp: string;
  accountId: string;
  prefixHex: string | null;
  prefixMatch: PrefixMatch;
  consistency: PrefixConsistency;
  binding: IdentityBinding;
  lossy: boolean;
}): string {
  const prefix = params.prefixHex ?? "lossy";
  return `[${params.timestamp}] [meshcore] [${params.accountId}] signedplain prefix=${prefix} lossy=${params.lossy} match=${params.prefixMatch} consistency=${params.consistency} binding=${params.binding}`;
}

/**
 * Subscribe to contact-book changes and evict identity-binding observations
 * when their contact is evicted. This keeps the binding store from growing
 * unbounded when contactBookMaxEntries prunes stale advert contacts.
 */
let evictionListenerInstalled = false;
export function ensureIdentityBindingEvictionListener(): void {
  if (evictionListenerInstalled) return;
  evictionListenerInstalled = true;
  onContactBookChange((accountId) => {
    ensureLoaded();
    if (!accountId) {
      // Without an account hint, evict any contact not present in any account.
      for (const [obsAccountId, map] of observationsByAccount) {
        const entries = getContactBookEntries(obsAccountId);
        const present = new Set(
          entries.map((e) => bytesToHex(e.publicKey).toLowerCase()),
        );
        for (const pubkeyHex of Array.from(map.keys())) {
          if (!present.has(pubkeyHex)) {
            map.delete(pubkeyHex);
          }
        }
      }
      persistObservations();
      return;
    }
    const map = observationsByAccount.get(accountId);
    if (!map) return;
    const entries = getContactBookEntries(accountId);
    const present = new Set(entries.map((e) => bytesToHex(e.publicKey).toLowerCase()));
    for (const pubkeyHex of Array.from(map.keys())) {
      if (!present.has(pubkeyHex)) {
        map.delete(pubkeyHex);
      }
    }
    persistObservations();
  });
}
