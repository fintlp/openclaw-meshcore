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

function getDiscoverySummaryPath(): string {
  return testDiscoverySummaryPath ?? `${pluginStateDir()}/meshcore-discovery.json`;
}

function hasPosition(entry: { advLat: number; advLon: number }): boolean {
  return entry.advLat !== 0 || entry.advLon !== 0;
}

function buildDiscoverySummary(): DiscoverySummary {
  const entries = getContactBookEntries();
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
export function writeDiscoverySummary(): void {
  atomicWriteJson(getDiscoverySummaryPath(), buildDiscoverySummary());
}

/** Read the persisted discovery summary, if one exists. */
export function readDiscoverySummary(): DiscoverySummary | undefined {
  try {
    return JSON.parse(readFileSync(getDiscoverySummaryPath(), "utf8")) as DiscoverySummary;
  } catch {
    return undefined;
  }
}

let listenerInstalled = false;

/**
 * Ensure the discovery summary is rewritten on every contact-book change.
 * Safe to call repeatedly; installs at most one listener.
 */
export function ensureDiscoverySummarySync(): void {
  if (listenerInstalled) {
    return;
  }
  listenerInstalled = true;
  onContactBookChange(() => {
    writeDiscoverySummary();
  });
}

/** @internal Reset the test path only; does not delete the persisted file. */
export function resetDiscoverySummaryStateForTests(): void {
  testDiscoverySummaryPath = undefined;
  listenerInstalled = false;
}
