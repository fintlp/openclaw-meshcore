import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getContactBookEntries,
  rememberContact,
  rememberSelfInfo,
  resetContactBookForTests,
  setContactBookPathForTests,
} from "./contact-book.js";
import {
  ensureDiscoverySummarySync,
  readDiscoverySummary,
  resetDiscoverySummaryStateForTests,
  setDiscoverySummaryPathForTests,
  setDiscoverySummaryThrottleMsForTests,
  writeDiscoverySummary,
} from "./discovery-summary.js";
import { hexToBytes } from "./protocol.js";
import { pluginStateDir } from "./state-dir.js";

function cleanupPerAccountDiscoveryFiles(): void {
  for (const accountId of ["account-a", "account-b"]) {
    const path = `${pluginStateDir()}/meshcore-discovery.${accountId}.json`;
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

describe("discovery summary", () => {
  let contactBookPath: string;
  let discoverySummaryPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-discovery-"));
    contactBookPath = join(dir, "contacts.json");
    discoverySummaryPath = join(dir, "discovery.json");
    resetContactBookForTests();
    resetDiscoverySummaryStateForTests();
    setContactBookPathForTests(contactBookPath);
    setDiscoverySummaryPathForTests(discoverySummaryPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetContactBookForTests();
    resetDiscoverySummaryStateForTests();
    setContactBookPathForTests(undefined);
    setDiscoverySummaryPathForTests(undefined);
  });

  const accountId = "test-account";

  const samplePublicKey = hexToBytes(
    "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
  );

  const otherPublicKey = hexToBytes(
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  );

  function makeAdvert(publicKey: Uint8Array, overrides: Record<string, unknown> = {}) {
    return {
      publicKey,
      type: 1,
      flags: 2,
      outPathLen: 0,
      outPath: new Uint8Array(64),
      advName: "TestNode",
      lastAdvert: 1234567890,
      advLat: 48858900,
      advLon: 2294500,
      lastMod: 1234567000,
      identityBasis: "firmware-advert-verified",
      ...overrides,
    };
  }

  it("writes a summary with per-contact fields and totals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);

    rememberContact(makeAdvert(samplePublicKey), accountId);
    writeDiscoverySummary();

    const summary = readDiscoverySummary()!;
    expect(summary.totalContacts).toBe(1);
    expect(summary.totalsBySource).toEqual({ advert: 1, "contact-sync": 0 });
    expect(summary.totalsByIdentityBasis).toEqual({
      "firmware-advert-verified": 1,
      unknown: 0,
    });
    expect(summary.contacts).toHaveLength(1);
    expect(summary.contacts[0]).toEqual({
      prefix: "aabbccdd1122",
      name: "TestNode",
      source: "advert",
      discoveredAt: 1_000_000,
      lastAdvert: 1234567890,
      hasPosition: true,
    });
  });

  it("tracks source totals and sorts by discoveredAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    rememberContact(makeAdvert(samplePublicKey), accountId);

    vi.setSystemTime(2_000_000_000);
    rememberSelfInfo(
      {
        publicKey: otherPublicKey,
        name: "MyNode",
        advLat: 0,
        advLon: 0,
      },
      accountId,
    );

    writeDiscoverySummary();

    const summary = readDiscoverySummary()!;
    expect(summary.totalContacts).toBe(2);
    expect(summary.totalsBySource).toEqual({ advert: 1, "contact-sync": 1 });
    expect(summary.totalsByIdentityBasis).toEqual({
      "firmware-advert-verified": 1,
      unknown: 1,
    });
    expect(summary.contacts[0].prefix).toBe("aabbccdd1122");
    expect(summary.contacts[1].prefix).toBe("001122334455");
    expect(summary.contacts[0].discoveredAt).toBeLessThan(summary.contacts[1].discoveredAt);
  });

  it("reports hasPosition=false for zero coordinates", () => {
    rememberContact(
      makeAdvert(samplePublicKey, { advLat: 0, advLon: 0 }),
      accountId,
    );
    writeDiscoverySummary();

    const summary = readDiscoverySummary()!;
    expect(summary.contacts[0].hasPosition).toBe(false);
  });

  it("auto-syncs with the contact book after ensureDiscoverySummarySync", () => {
    vi.useFakeTimers();
    setDiscoverySummaryThrottleMsForTests(100);
    ensureDiscoverySummarySync();

    rememberContact(makeAdvert(samplePublicKey), accountId);
    vi.advanceTimersByTime(100);

    const summary = readDiscoverySummary()!;
    expect(summary.totalContacts).toBe(1);
    expect(summary.contacts[0].prefix).toBe("aabbccdd1122");
  });

  it("is idempotent when ensureDiscoverySummarySync is called multiple times", () => {
    vi.useFakeTimers();
    setDiscoverySummaryThrottleMsForTests(100);
    ensureDiscoverySummarySync();
    ensureDiscoverySummarySync();

    rememberContact(makeAdvert(samplePublicKey), accountId);
    rememberContact(makeAdvert(otherPublicKey), accountId);
    vi.advanceTimersByTime(100);

    const summary = readDiscoverySummary()!;
    expect(summary.totalContacts).toBe(2);
  });

  it("writes atomically (tmp + rename)", () => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-discovery-atomic-"));
    setDiscoverySummaryPathForTests(join(dir, "discovery.json"));

    rememberContact(makeAdvert(samplePublicKey), accountId);
    writeDiscoverySummary();

    const files = new Set(
      readdirSync(dir).filter((f: string) => f.startsWith("discovery")),
    );
    expect(files).toEqual(new Set(["discovery.json"]));
  });

  it("returns undefined when no summary has been written", () => {
    expect(readDiscoverySummary()).toBeUndefined();
  });

  it("does not expose raw pubkeys, only 12-hex prefixes", () => {
    rememberContact(makeAdvert(samplePublicKey), accountId);
    writeDiscoverySummary();

    const raw = JSON.parse(readFileSync(discoverySummaryPath, "utf8"));
    expect(raw.contacts[0].prefix).toBe("aabbccdd1122");
    expect(raw.contacts[0]).not.toHaveProperty("publicKey");
    expect(raw.contacts[0]).not.toHaveProperty("publicKeyHex");
  });

  it("scopes summaries per account so contacts from different accounts are not merged", () => {
    setDiscoverySummaryPathForTests(undefined);
    cleanupPerAccountDiscoveryFiles();

    const accountA = "account-a";
    const accountB = "account-b";

    rememberContact(makeAdvert(samplePublicKey, { advName: "NodeA" }), accountA);
    rememberContact(makeAdvert(otherPublicKey, { advName: "NodeB" }), accountB);

    writeDiscoverySummary(accountA);
    writeDiscoverySummary(accountB);

    const summaryA = readDiscoverySummary(accountA)!;
    const summaryB = readDiscoverySummary(accountB)!;

    expect(summaryA.accountId).toBe(accountA);
    expect(summaryA.totalContacts).toBe(1);
    expect(summaryA.contacts[0].name).toBe("NodeA");

    expect(summaryB.accountId).toBe(accountB);
    expect(summaryB.totalContacts).toBe(1);
    expect(summaryB.contacts[0].name).toBe("NodeB");

    cleanupPerAccountDiscoveryFiles();
  });

  it("builds per-account summaries on demand without writing", () => {
    const accountA = "account-a";
    const accountB = "account-b";

    rememberContact(makeAdvert(samplePublicKey), accountA);
    rememberContact(makeAdvert(otherPublicKey), accountB);

    const entriesA = getContactBookEntries(accountA);
    const entriesB = getContactBookEntries(accountB);

    expect(entriesA).toHaveLength(1);
    expect(entriesB).toHaveLength(1);
    expect(entriesA[0].publicKey).toEqual(samplePublicKey);
    expect(entriesB[0].publicKey).toEqual(otherPublicKey);
  });

  it("auto-syncs per account using the accountId from the contact-book change", () => {
    vi.useFakeTimers();
    setDiscoverySummaryPathForTests(undefined);
    cleanupPerAccountDiscoveryFiles();
    setDiscoverySummaryThrottleMsForTests(100);
    ensureDiscoverySummarySync();

    rememberContact(makeAdvert(samplePublicKey, { advName: "NodeA" }), "account-a");
    rememberContact(makeAdvert(otherPublicKey, { advName: "NodeB" }), "account-b");
    vi.advanceTimersByTime(100);

    const summaryA = readDiscoverySummary("account-a")!;
    const summaryB = readDiscoverySummary("account-b")!;

    expect(summaryA.totalContacts).toBe(1);
    expect(summaryA.contacts[0].name).toBe("NodeA");
    expect(summaryB.totalContacts).toBe(1);
    expect(summaryB.contacts[0].name).toBe("NodeB");

    cleanupPerAccountDiscoveryFiles();
  });

  it("throttles contact-book-driven writes", () => {
    vi.useFakeTimers();
    setDiscoverySummaryThrottleMsForTests(1_000);
    ensureDiscoverySummarySync();

    rememberContact(makeAdvert(samplePublicKey), accountId);
    rememberContact(makeAdvert(otherPublicKey), accountId);
    rememberContact(
      makeAdvert(hexToBytes("11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff"), {
        advName: "NodeC",
      }),
      accountId,
    );

    // Nothing should be written until the throttle window expires.
    vi.advanceTimersByTime(500);
    expect(readDiscoverySummary()).toBeUndefined();

    vi.advanceTimersByTime(600);
    const summary = readDiscoverySummary()!;
    expect(summary.totalContacts).toBe(3);
  });
});
