import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  formatContactPrefix,
  getContactBookEntries,
  onContactBookChange,
} from "./contact-book.js";
import { pluginStateDir } from "./state-dir.js";

/**
 * Agent-readable discovery surface derived from the contact book.
 *
 * This file is rewritten automatically whenever the contact book changes.
 * It contains no new data — only a stable, summarised view of what the
 * gateway already learned from passive advert monitoring and contact-sync.
 *
 * The file is scoped per account: the default account uses
 * `meshcore-discovery.json`; named accounts use
 * `meshcore-discovery.<accountId>.json`.
 */
export type DiscoveryContact = {
  /** 12-character hex prefix (first 6 bytes of the pubkey). */
  prefix: string;
  /** Advertised name, or empty string if none is known. */
  name: string;
  /** How this contact was first discovered. */
  source: "advert" | "contact-sync";
  /** Epoch seconds when this contact was first seen by this gateway. */
  discoveredAt: number;
  /** Firmware advert timestamp (epoch seconds) when known, else 0. */
  lastAdvert: number;
  /** True when non-zero coordinates are known. */
  hasPosition: boolean;
};

export type DiscoverySummary = {
  /** ISO 8601 timestamp when the summary was generated. */
  generatedAt: string;
  /** Account this summary belongs to (omitted for the default account). */
  accountId?: string;
  /** Total number of known contacts across all accounts. */
  totalContacts: number;
  /** Contacts grouped by discovery source. */
  totalsBySource: {
    advert: number;
    "contact-sync": number;
  };
  /** Per-contact discovery record, sorted by discoveredAt ascending. */
  contacts: DiscoveryContact[];
};

let testDiscoverySummaryPath: string | undefined;

/** @internal Test-only path override; avoids env-var races across parallel test files. */
export function setDiscoverySummaryPathForTests(path: string | undefined): void {
  testDiscoverySummaryPath = path;
}

const DEFAULT_THROTTLE_MS = 60_000;
let throttleMs = DEFAULT_THROTTLE_MS;

/** @internal Test-only throttle override. */
export function setDiscoverySummaryThrottleMsForTests(ms: number): void {
  throttleMs = ms;
}

function getDiscoverySummaryPath(accountId?: string): string {
  if (testDiscoverySummaryPath) {
    return testDiscoverySummaryPath;
  }
  const base = `${pluginStateDir()}/meshcore-discovery`;
  // Default account keeps the plain filename for backwards compatibility;
  // named accounts get a scoped file.
  return accountId && accountId !== "default"
    ? `${base}.${accountId}.json`
    : `${base}.json`;
}

function hasPosition(entry: { advLat: number; advLon: number }): boolean {
  return entry.advLat !== 0 || entry.advLon !== 0;
}

function buildDiscoverySummary(accountId?: string): DiscoverySummary {
  const entries = getContactBookEntries(accountId);
  const contacts: DiscoveryContact[] = entries
    .map((entry) => ({
      prefix: formatContactPrefix(entry),
      name: entry.advName,
      source: entry.source,
      discoveredAt: entry.discoveredAt,
      lastAdvert: entry.lastAdvert,
      hasPosition: hasPosition(entry),
    }))
    .sort((a, b) => a.discoveredAt - b.discoveredAt);

  return {
    generatedAt: new Date().toISOString(),
    accountId,
    totalContacts: contacts.length,
    totalsBySource: {
      advert: contacts.filter((c) => c.source === "advert").length,
      "contact-sync": contacts.filter((c) => c.source === "contact-sync").length,
    },
    contacts,
  };
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmpPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmpPath, path);
}

/** Rewrite the discovery summary from the current contact-book state. */
export function writeDiscoverySummary(accountId?: string): void {
  atomicWriteJson(getDiscoverySummaryPath(accountId), buildDiscoverySummary(accountId));
}

/** Read the persisted discovery summary, if one exists. */
export function readDiscoverySummary(accountId?: string): DiscoverySummary | undefined {
  try {
    return JSON.parse(readFileSync(getDiscoverySummaryPath(accountId), "utf8")) as DiscoverySummary;
  } catch {
    return undefined;
  }
}

let listenerInstalled = false;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
const pendingAccountIds = new Set<string | undefined>();

function flushThrottledWrites(): void {
  throttleTimer = null;
  for (const accountId of pendingAccountIds) {
    try {
      writeDiscoverySummary(accountId);
    } catch {
      // best-effort: a failed write must not break other accounts
    }
  }
  pendingAccountIds.clear();
}

function scheduleThrottledWrite(accountId?: string): void {
  pendingAccountIds.add(accountId);
  if (throttleTimer) {
    return;
  }
  throttleTimer = setTimeout(flushThrottledWrites, throttleMs);
}

/**
 * Ensure the discovery summary is rewritten on every contact-book change.
 * Safe to call repeatedly; installs at most one listener.
 *
 * Writes are throttled (default 60s) so a burst of passive adverts does not
 * rewrite the summary file on every packet.
 */
export function ensureDiscoverySummarySync(): void {
  if (listenerInstalled) {
    return;
  }
  listenerInstalled = true;
  onContactBookChange((accountId) => {
    scheduleThrottledWrite(accountId);
  });
}

/** @internal Reset the test path only; does not delete the persisted file. */
export function resetDiscoverySummaryStateForTests(): void {
  testDiscoverySummaryPath = undefined;
  listenerInstalled = false;
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  pendingAccountIds.clear();
  throttleMs = DEFAULT_THROTTLE_MS;
}
