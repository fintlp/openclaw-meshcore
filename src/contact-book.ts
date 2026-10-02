import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  bytesToHex,
  hexToBytes,
  MESHCORE_PUBKEY_LENGTH,
  MESHCORE_PUBKEY_PREFIX_LENGTH,
} from "./protocol.js";

/**
 * MeshCore advert/contact metadata persisted as a local contact book.
 *
 * The NewAdvert push frame (0x8A) exposes the full set of fields captured here.
 * Lat/Lon are stored as the raw Int32 values emitted by the firmware. Per the
 * MeshCore Companion Protocol documentation, the wire values are fixed-point
 * coordinates scaled by 1e6 (i.e. degrees = raw / 1e6):
 * https://docs.meshcore.io/companion_protocol/
 *
 * Issue #11: contact book: capture full advert metadata.
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
  lastMod: number;
};

/** In-memory contact book, keyed by full 64-character pubkey hex. */
const contacts = new Map<string, ContactBookEntry>();
let cacheLoaded = false;

function getContactBookPath(): string {
  return (
    process.env.MESHCORE_ADVERT_CACHE_PATH ??
    `${process.env.HOME ?? "~"}/.openclaw/state/meshcore-advert-contacts.json`
  );
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
  type: number;
  flags: number;
  outPathLen: number;
  outPathHex: string;
  advName: string;
  lastAdvert: number;
  advLat: number;
  advLon: number;
  lastMod: number;
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
  };
}

function loadV2File(file: ContactBookFileV2): void {
  for (const row of file.contacts) {
    const hex =
      typeof row?.publicKeyHex === "string" ? row.publicKeyHex.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      continue;
    }
    try {
      contacts.set(hex, {
        publicKey: hexToBytes(hex),
        type: Number(row.type ?? 0),
        flags: Number(row.flags ?? 0),
        outPathLen: Number(row.outPathLen ?? 0),
        outPath: normalizeOutPath(
          typeof row.outPathHex === "string" ? hexToBytes(row.outPathHex) : EMPTY_PATH,
        ),
        advName: String(row.advName ?? ""),
        lastAdvert: Number(row.lastAdvert ?? 0),
        advLat: Number(row.advLat ?? 0),
        advLon: Number(row.advLon ?? 0),
        lastMod: Number(row.lastMod ?? 0),
      });
    } catch {
      // Skip rows with unparseable data.
    }
  }
}

function loadContacts(): void {
  try {
    const data = JSON.parse(readFileSync(getContactBookPath(), "utf8")) as unknown;
    if (isV1File(data)) {
      for (const row of data) {
        const entry = migrateV1Row(row);
        if (entry) {
          contacts.set(bytesToHex(entry.publicKey).toLowerCase(), entry);
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
      contacts: Array.from(contacts.entries()).map(([, entry]) => ({
        publicKeyHex: bytesToHex(entry.publicKey).toLowerCase(),
        type: entry.type,
        flags: entry.flags,
        outPathLen: entry.outPathLen,
        outPathHex: bytesToHex(entry.outPath).toLowerCase(),
        advName: entry.advName,
        lastAdvert: entry.lastAdvert,
        advLat: entry.advLat,
        advLon: entry.advLon,
        lastMod: entry.lastMod,
      })),
    };
    writeFileSync(path, JSON.stringify(payload));
  } catch {
    // best-effort persistence
  }
}

export function rememberContact(
  entry: Partial<Omit<ContactBookEntry, "publicKey">> & { publicKey: Uint8Array },
): void {
  ensureLoaded();
  const hex = publicKeyHexFromBytes(entry.publicKey);
  if (!hex) {
    return;
  }
  const existing = contacts.get(hex);
  contacts.set(hex, {
    publicKey: entry.publicKey,
    type: entry.type ?? existing?.type ?? 0,
    flags: entry.flags ?? existing?.flags ?? 0,
    outPathLen: entry.outPathLen ?? existing?.outPathLen ?? 0,
    outPath: entry.outPath
      ? normalizeOutPath(entry.outPath)
      : existing?.outPath ?? new Uint8Array(64),
    advName:
      entry.advName !== undefined && entry.advName !== ""
        ? entry.advName
        : existing?.advName ?? "",
    lastAdvert: entry.lastAdvert ?? existing?.lastAdvert ?? 0,
    advLat: entry.advLat ?? existing?.advLat ?? 0,
    advLon: entry.advLon ?? existing?.advLon ?? 0,
    lastMod: entry.lastMod ?? existing?.lastMod ?? 0,
  });
  persistContacts();
}

/**
 * Persist the local node's own coordinates/advert name from SelfInfo.
 * SelfInfo doesn't carry path/type/lastAdvert metadata, so those fields stay
 * at zero; the important piece is that the node's own lat/lon/name are in the
 * contact book alongside remote adverts.
 */
export function rememberSelfInfo(selfInfo: {
  publicKey: Uint8Array;
  name?: string;
  advLat: number;
  advLon: number;
}): void {
  rememberContact({
    publicKey: selfInfo.publicKey,
    advName: selfInfo.name,
    advLat: selfInfo.advLat,
    advLon: selfInfo.advLon,
  });
}

export function resolveContactByPrefix(prefixHex: string): ContactBookEntry | undefined {
  ensureLoaded();
  const p = prefixHex.toLowerCase();
  for (const [hex, entry] of contacts) {
    if (hex.startsWith(p)) {
      return entry;
    }
  }
  return undefined;
}

export function resolveContactPubkeyByPrefix(prefixHex: string): Uint8Array | undefined {
  return resolveContactByPrefix(prefixHex)?.publicKey;
}

/**
 * Returns the 12-character hex prefix (first 6 bytes of the pubkey) used as
 * the DM sender identifier.
 */
export function formatContactPrefix(entry: ContactBookEntry): string {
  return bytesToHex(entry.publicKey.slice(0, MESHCORE_PUBKEY_PREFIX_LENGTH)).toLowerCase();
}

export function getContactBookEntries(): ContactBookEntry[] {
  ensureLoaded();
  return Array.from(contacts.values());
}

/** @internal Reset function for tests only. Does not delete the persisted file. */
export function resetContactBookForTests(): void {
  contacts.clear();
  cacheLoaded = false;
}
