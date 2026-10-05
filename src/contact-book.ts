import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  bytesToHex,
  hexToBytes,
  MESHCORE_PUBKEY_LENGTH,
  MESHCORE_PUBKEY_PREFIX_LENGTH,
} from "./protocol.js";
import { pluginStateDir } from "./state-dir.js";

/**
 * MeshCore advert/contact metadata persisted as a local contact book.
 *
 * The NewAdvert push frame (0x8A) exposes the full set of fields captured here.
 * Lat/Lon are stored as the raw Int32 values emitted by the firmware. Per the
 * MeshCore Companion Protocol documentation, the wire values are fixed-point
 * coordinates scaled by 1e6 (i.e. degrees = raw / 1e6):
 * https://docs.meshcore.io/companion_protocol/
 *
 * The persisted v2 file also includes `lat` and `lon` in decimal degrees so
 * consumers can read coordinates without knowing the fixed-point scaling.
 *
 * Issue #11: contact book: capture full advert metadata.
 * Issue #12: contact book: decimal-degree coordinates.
 */
export type ContactBookEntry = {
  publicKey: Uint8Array;
  type: number;
  flags: number;
  outPathLen: number;
  outPath: Uint8Array;
  advName: string;
  lastAdvert: number;
  advLat: number;
  advLon: number;
  /** Latitude in decimal degrees (advLat / 1e6). Not persisted separately; derived on write. */
  lat?: number;
  /** Longitude in decimal degrees (advLon / 1e6). Not persisted separately; derived on write. */
  lon?: number;
  lastMod: number;
  lastHeardAt: number;
};

/** Contacts keyed by accountId, then by full 64-character pubkey hex. */
const contactBooks = new Map<string, Map<string, ContactBookEntry>>();
/**
 * Legacy rows loaded from pre-accountId state files. They are adopted by the
 * first account that looks them up or remembers them, so a single-account
 * production file migrates seamlessly into the per-account model.
 */
const legacyContacts = new Map<string, ContactBookEntry>();
let cacheLoaded = false;

let testContactBookPath: string | undefined;

function getAccountMap(accountId: string): Map<string, ContactBookEntry> {
  let map = contactBooks.get(accountId);
  if (!map) {
    map = new Map();
    contactBooks.set(accountId, map);
  }
  return map;
}

function getContactBookPath(): string {
  return (
    testContactBookPath ??
    process.env.MESHCORE_ADVERT_CACHE_PATH ??
    `${pluginStateDir()}/meshcore-advert-contacts.json`
  );
}

/** @internal Test-only path override; avoids env-var races across parallel test files. */
export function setContactBookPathForTests(path: string | undefined): void {
  testContactBookPath = path;
}

const EMPTY_PATH = new Uint8Array(64);

function convertToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }
  if (value && typeof value === "object" && "buffer" in value) {
    return new Uint8Array((value as ArrayBufferView).buffer);
  }
  return new Uint8Array(0);
}

function normalizeOutPath(value: unknown): Uint8Array {
  const bytes = convertToUint8Array(value);
  if (bytes.length === 64) {
    return bytes;
  }
  const padded = new Uint8Array(64);
  padded.set(bytes.slice(0, 64));
  return padded;
}

function publicKeyHexFromBytes(publicKey: Uint8Array): string | undefined {
  const hex = bytesToHex(publicKey).toLowerCase();
  return hex.length === MESHCORE_PUBKEY_LENGTH * 2 ? hex : undefined;
}

type PersistedContactV2 = {
  publicKeyHex: string;
  accountId?: string;
  type: number;
  flags: number;
  outPathLen: number;
  outPathHex: string;
  advName: string;
  lastAdvert: number;
  advLat: number;
  advLon: number;
  /** Latitude in decimal degrees (advLat / 1e6). */
  lat: number;
  /** Longitude in decimal degrees (advLon / 1e6). */
  lon: number;
  lastMod: number;
  lastHeardAt: number;
};

type ContactBookFileV2 = {
  version: 2;
  contacts: PersistedContactV2[];
};

type ContactBookFileV1 = Array<{
  publicKeyHex?: string;
  name?: string;
}>;

function isV1File(data: unknown): data is ContactBookFileV1 {
  return Array.isArray(data);
}

function isV2File(data: Record<string, unknown>): data is ContactBookFileV2 {
  // Strict version check: any malformed version (non-number, != 2) is treated
  // as unrecoverable rather than partially parsed.
  return data.version === 2 && Array.isArray(data.contacts);
}

function migrateV1Row(row: { publicKeyHex?: string; name?: string }): ContactBookEntry | undefined {
  const hex =
    typeof row?.publicKeyHex === "string" ? row.publicKeyHex.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return undefined;
  }
  return {
    publicKey: hexToBytes(hex),
    type: 0,
    flags: 0,
    outPathLen: 0,
    outPath: new Uint8Array(64),
    advName: typeof row.name === "string" ? row.name : "",
    lastAdvert: 0,
    advLat: 0,
    advLon: 0,
    lastMod: 0,
    lastHeardAt: 0,
  };
}

function parseOutPathHex(outPathHex: unknown): Uint8Array {
  if (typeof outPathHex !== "string" || !/^[0-9a-f]{128}$/iu.test(outPathHex)) {
    return EMPTY_PATH;
  }
  try {
    return normalizeOutPath(hexToBytes(outPathHex));
  } catch (error) {
    console.error(`[meshcore contact-book] discarding malformed outPathHex: ${String(error)}`);
    return EMPTY_PATH;
  }
}

function rowToEntry(row: PersistedContactV2): ContactBookEntry | undefined {
  const hex =
    typeof row?.publicKeyHex === "string" ? row.publicKeyHex.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return undefined;
  }
  try {
    return {
      publicKey: hexToBytes(hex),
      type: Number(row.type ?? 0),
      flags: Number(row.flags ?? 0),
      outPathLen: Number(row.outPathLen ?? 0),
      outPath: parseOutPathHex(row.outPathHex),
      advName: String(row.advName ?? ""),
      lastAdvert: Number(row.lastAdvert ?? 0),
      advLat: Number(row.advLat ?? 0),
      advLon: Number(row.advLon ?? 0),
      lastMod: Number(row.lastMod ?? 0),
      lastHeardAt: Number(row.lastHeardAt ?? 0),
    };
  } catch (error) {
    console.error(`[meshcore contact-book] skipping corrupt contact row ${hex}: ${String(error)}`);
    return undefined;
  }
}

function toDecimalDegrees(raw: number): number {
  return raw / 1e6;
}

function loadV2File(file: ContactBookFileV2): void {
  for (const row of file.contacts) {
    const entry = rowToEntry(row);
    if (!entry) {
      continue;
    }
    const hex = bytesToHex(entry.publicKey).toLowerCase();
    if (typeof row.accountId === "string" && row.accountId !== "") {
      getAccountMap(row.accountId).set(hex, entry);
    } else {
      // Rows without an accountId belong to the legacy bucket and will be
      // adopted by the first account that touches them.
      legacyContacts.set(hex, entry);
    }
  }
}

/**
 * Move a legacy entry into the given account's contact book. This is the lazy
 * migration path for pre-accountId state files.
 */
function adoptLegacyEntry(
  hex: string,
  accountId: string,
): ContactBookEntry | undefined {
  const legacy = legacyContacts.get(hex);
  if (!legacy) {
    return undefined;
  }
  legacyContacts.delete(hex);
  getAccountMap(accountId).set(hex, legacy);
  return legacy;
}

function loadContacts(): void {
  try {
    const data = JSON.parse(readFileSync(getContactBookPath(), "utf8")) as unknown;
    if (isV1File(data)) {
      for (const row of data) {
        const entry = migrateV1Row(row);
        if (entry) {
          legacyContacts.set(bytesToHex(entry.publicKey).toLowerCase(), entry);
        }
      }
      // Persist the migrated data immediately so we don't re-migrate next run.
      persistContacts();
      return;
    }
    if (data && typeof data === "object" && isV2File(data as Record<string, unknown>)) {
      loadV2File(data as ContactBookFileV2);
    }
  } catch {
    // Missing or unreadable cache file is fine — it refills from adverts.
  }
}

function ensureLoaded(): void {
  if (cacheLoaded) {
    return;
  }
  cacheLoaded = true;
  loadContacts();
}

function persistContacts(): void {
  const path = getContactBookPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: ContactBookFileV2 = {
      version: 2,
      contacts: [],
    };
    for (const [accountId, map] of contactBooks) {
      for (const [, entry] of map) {
        payload.contacts.push({
          publicKeyHex: bytesToHex(entry.publicKey).toLowerCase(),
          accountId,
          type: entry.type,
          flags: entry.flags,
          outPathLen: entry.outPathLen,
          outPathHex: bytesToHex(entry.outPath).toLowerCase(),
          advName: entry.advName,
          lastAdvert: entry.lastAdvert,
          advLat: entry.advLat,
          advLon: entry.advLon,
          lat: toDecimalDegrees(entry.advLat),
          lon: toDecimalDegrees(entry.advLon),
          lastMod: entry.lastMod,
          lastHeardAt: entry.lastHeardAt,
        });
      }
    }
    for (const [, entry] of legacyContacts) {
      payload.contacts.push({
        publicKeyHex: bytesToHex(entry.publicKey).toLowerCase(),
        type: entry.type,
        flags: entry.flags,
        outPathLen: entry.outPathLen,
        outPathHex: bytesToHex(entry.outPath).toLowerCase(),
        advName: entry.advName,
        lastAdvert: entry.lastAdvert,
        advLat: entry.advLat,
        advLon: entry.advLon,
        lat: toDecimalDegrees(entry.advLat),
        lon: toDecimalDegrees(entry.advLon),
        lastMod: entry.lastMod,
        lastHeardAt: entry.lastHeardAt,
      });
    }
    writeFileSync(path, JSON.stringify(payload));
  } catch {
    // best-effort persistence
  }
}

export function rememberContact(
  entry: Partial<Omit<ContactBookEntry, "publicKey">> & { publicKey: Uint8Array },
  accountId: string,
): void {
  ensureLoaded();
  const hex = publicKeyHexFromBytes(entry.publicKey);
  if (!hex) {
    return;
  }

  const map = getAccountMap(accountId);
  // Lazy migration: a legacy row belongs to the first account that touches it.
  let existing = map.get(hex) ?? adoptLegacyEntry(hex, accountId);

  const incomingLastAdvert = entry.lastAdvert;
  const existingLastAdvert = existing?.lastAdvert ?? 0;

  // lastAdvert is the freshness clock. An incoming advert that is older than
  // the stored one must not downgrade the freshness-dependent fields.
  const stale =
    incomingLastAdvert !== undefined &&
    existingLastAdvert !== 0 &&
    incomingLastAdvert < existingLastAdvert;

  // Liveness stamp: local gateway receive time, updated on every contact
  // interaction regardless of whether the advert payload itself is fresh.
  const nowSeconds = Math.floor(Date.now() / 1000);

  const merged: ContactBookEntry = {
    publicKey: entry.publicKey,
    type: entry.type ?? existing?.type ?? 0,
    flags: entry.flags ?? existing?.flags ?? 0,
    outPathLen: stale
      ? existing!.outPathLen
      : (entry.outPathLen ?? existing?.outPathLen ?? 0),
    outPath: stale
      ? existing!.outPath
      : entry.outPath
        ? normalizeOutPath(entry.outPath)
        : existing?.outPath ?? new Uint8Array(64),
    advName:
      entry.advName !== undefined && entry.advName !== ""
        ? entry.advName
        : existing?.advName ?? "",
    lastAdvert: stale
      ? existing!.lastAdvert
      : (entry.lastAdvert ?? existing?.lastAdvert ?? 0),
    advLat: stale
      ? existing!.advLat
      : (entry.advLat ?? existing?.advLat ?? 0),
    advLon: stale
      ? existing!.advLon
      : (entry.advLon ?? existing?.advLon ?? 0),
    lastMod: stale
      ? existing!.lastMod
      : (entry.lastMod ?? existing?.lastMod ?? 0),
    lastHeardAt: nowSeconds,
  };

  map.set(hex, merged);
  persistContacts();
}

/**
 * Persist the local node's own coordinates/advert name from SelfInfo.
 * SelfInfo doesn't carry path/type/lastAdvert metadata, so those fields stay
 * at zero; the important piece is that the node's own lat/lon/name are in the
 * contact book alongside remote adverts.
 */
export function rememberSelfInfo(
  selfInfo: {
    publicKey: Uint8Array;
    name?: string;
    advLat: number;
    advLon: number;
  },
  accountId: string,
): void {
  rememberContact(
    {
      publicKey: selfInfo.publicKey,
      advName: selfInfo.name,
      advLat: selfInfo.advLat,
      advLon: selfInfo.advLon,
    },
    accountId,
  );
}

export function resolveContactByPrefix(
  prefixHex: string,
  accountId: string,
): ContactBookEntry | undefined {
  ensureLoaded();
  const p = prefixHex.toLowerCase();
  const map = getAccountMap(accountId);
  for (const [hex, entry] of map) {
    if (hex.startsWith(p)) {
      return entry;
    }
  }
  // A legacy row may be addressable by prefix even before it has been adopted
  // by a remember call.
  for (const [hex, entry] of legacyContacts) {
    if (hex.startsWith(p)) {
      return entry;
    }
  }
  return undefined;
}

export function resolveContactPubkeyByPrefix(
  prefixHex: string,
  accountId: string,
): Uint8Array | undefined {
  return resolveContactByPrefix(prefixHex, accountId)?.publicKey;
}

/**
 * Returns the 12-character hex prefix (first 6 bytes of the pubkey) used as
 * the DM sender identifier.
 */
export function formatContactPrefix(entry: ContactBookEntry): string {
  return bytesToHex(entry.publicKey.slice(0, MESHCORE_PUBKEY_PREFIX_LENGTH)).toLowerCase();
}

/**
 * Return all entries for a specific account, or all entries across every
 * account (and any not-yet-adopted legacy rows) when no accountId is given.
 * The no-argument form is intended for tests/debugging only.
 */
export function getContactBookEntries(accountId?: string): ContactBookEntry[] {
  ensureLoaded();
  if (accountId) {
    return Array.from(getAccountMap(accountId).values());
  }
  const all: ContactBookEntry[] = Array.from(legacyContacts.values());
  for (const map of contactBooks.values()) {
    all.push(...map.values());
  }
  return all;
}

/** Retrieve a stored contact by full 32-byte public key, or undefined if unknown. */
export function getContactByPubkey(
  publicKey: Uint8Array,
  accountId: string,
): ContactBookEntry | undefined {
  ensureLoaded();
  const hex = publicKeyHexFromBytes(publicKey);
  if (!hex) {
    return undefined;
  }
  return getAccountMap(accountId).get(hex) ?? adoptLegacyEntry(hex, accountId);
}

/**
 * True when a contact entry has no advert metadata yet. This happens when the
 * entry was created from an Advert push (0x80) for a known contact, which only
 * carries the pubkey; the full metadata must then be fetched from the node.
 */
export function contactHasMissingMetadata(entry: ContactBookEntry): boolean {
  return entry.advName === "" && entry.lastAdvert === 0;
}

/**
 * Re-sync a known contact's position/metadata from the node when a 0x80 push
 * arrives and the stored `lastAdvert` timestamp is older than this. The
 * firmware advertises its own `lastAdvert` in seconds since epoch; the stored
 * value is compared against the current gateway time.
 */
export const POSITION_RESYNC_AFTER_MS = 6 * 60 * 60 * 1000;

/** @internal Reset function for tests only. Does not delete the persisted file. */
export function resetContactBookForTests(): void {
  contactBooks.clear();
  legacyContacts.clear();
  cacheLoaded = false;
}
