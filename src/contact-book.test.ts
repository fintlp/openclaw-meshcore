import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatContactPrefix,
  getContactBookEntries,
  getContactByPubkey,
  rememberContact,
  rememberSelfInfo,
  resetContactBookForTests,
  resolveContactByPrefix,
  resolveContactPubkeyByPrefix,
  setContactBookPathForTests,
} from "./contact-book.js";
import { bytesToHex, hexToBytes } from "./protocol.js";

describe("contact book", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-contact-book-"));
    setContactBookPathForTests(join(dir, "contacts.json"));
    resetContactBookForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetContactBookForTests();
    setContactBookPathForTests(undefined);
  });

  const accountId = "test-account";

  const samplePublicKey = hexToBytes(
    "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
  );

  function makeFullAdvert(publicKey: Uint8Array = samplePublicKey) {
    const outPath = new Uint8Array(64);
    outPath[0] = 0x01;
    outPath[1] = 0x02;
    return {
      publicKey,
      type: 1,
      flags: 2,
      outPathLen: 2,
      outPath,
      advName: "TestNode",
      lastAdvert: 1234567890,
      advLat: 48858900, // ~48.8589° N (degrees * 1e6)
      advLon: 2294500, // ~2.2945° E
      lastMod: 1234567000,
    };
  }

  it("stores every field from a NewAdvert push", () => {
    rememberContact(makeFullAdvert(), accountId);

    const entries = getContactBookEntries(accountId);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.publicKey).toEqual(samplePublicKey);
    expect(entry.type).toBe(1);
    expect(entry.flags).toBe(2);
    expect(entry.outPathLen).toBe(2);
    expect(bytesToHex(entry.outPath)).toBe(
      "0102" + "00".repeat(62),
    );
    expect(entry.advName).toBe("TestNode");
    expect(entry.lastAdvert).toBe(1234567890);
    expect(entry.advLat).toBe(48858900);
    expect(entry.advLon).toBe(2294500);
    expect(entry.lastMod).toBe(1234567000);
  });

  it("resolves a full public key from a 12-hex prefix after an advert", () => {
    rememberContact(makeFullAdvert(), accountId);

    const prefix = bytesToHex(samplePublicKey.slice(0, 6)).toLowerCase();
    const resolved = resolveContactPubkeyByPrefix(prefix, accountId);
    expect(resolved).toEqual(samplePublicKey);
  });

  it("merges partial advert updates without dropping existing fields", () => {
    rememberContact(makeFullAdvert(), accountId);
    rememberContact(
      {
        publicKey: samplePublicKey,
        advName: "UpdatedName",
        advLat: 50000000,
      },
      accountId,
    );

    const entry = resolveContactByPrefix(
      bytesToHex(samplePublicKey.slice(0, 6)).toLowerCase(),
      accountId,
    )!;
    expect(entry.advName).toBe("UpdatedName");
    expect(entry.advLat).toBe(50000000);
    expect(entry.advLon).toBe(2294500);
    expect(entry.type).toBe(1);
  });

  it("keeps fresh fields when an older lastAdvert arrives", () => {
    const freshOutPath = new Uint8Array(64);
    freshOutPath[0] = 0xab;

    rememberContact(
      {
        publicKey: samplePublicKey,
        type: 1,
        flags: 2,
        outPathLen: 3,
        outPath: freshOutPath,
        advName: "FreshNode",
        lastAdvert: 2_000_000_000,
        advLat: 48858900,
        advLon: 2294500,
        lastMod: 1111111111,
      },
      accountId,
    );

    rememberContact(
      {
        publicKey: samplePublicKey,
        type: 9,
        flags: 9,
        outPathLen: 0,
        outPath: undefined,
        advName: "OldNode",
        lastAdvert: 1_000_000_000,
        advLat: 0,
        advLon: 0,
        lastMod: 0,
      },
      accountId,
    );

    const entry = getContactByPubkey(samplePublicKey, accountId)!;
    // Non-freshness fields merge normally.
    expect(entry.type).toBe(9);
    expect(entry.flags).toBe(9);
    expect(entry.advName).toBe("OldNode");
    // Freshness-dependent fields stay with the fresher advert.
    expect(entry.lastAdvert).toBe(2_000_000_000);
    expect(entry.advLat).toBe(48858900);
    expect(entry.advLon).toBe(2294500);
    expect(entry.outPathLen).toBe(3);
    expect(entry.outPath[0]).toBe(0xab);
    expect(entry.lastMod).toBe(1111111111);
  });

  it("merges normally when a newer lastAdvert arrives", () => {
    rememberContact(
      {
        publicKey: samplePublicKey,
        advName: "OldNode",
        lastAdvert: 1_000_000_000,
        advLat: 10000000,
        advLon: 20000000,
      },
      accountId,
    );

    rememberContact(
      {
        publicKey: samplePublicKey,
        advName: "NewNode",
        lastAdvert: 2_000_000_000,
        advLat: 48858900,
        advLon: 2294500,
      },
      accountId,
    );

    const entry = getContactByPubkey(samplePublicKey, accountId)!;
    expect(entry.advName).toBe("NewNode");
    expect(entry.lastAdvert).toBe(2_000_000_000);
    expect(entry.advLat).toBe(48858900);
    expect(entry.advLon).toBe(2294500);
  });

  it("preserves an existing name when a merge carries an empty advName", () => {
    rememberContact(makeFullAdvert(), accountId);
    rememberContact(
      {
        publicKey: samplePublicKey,
        advName: "",
      },
      accountId,
    );

    const entry = getContactByPubkey(samplePublicKey, accountId)!;
    expect(entry.advName).toBe("TestNode");
  });

  it("stores outPathLen -1 (unknown) without crashing", () => {
    rememberContact(
      {
        publicKey: samplePublicKey,
        outPathLen: -1,
      },
      accountId,
    );

    const entry = getContactByPubkey(samplePublicKey, accountId)!;
    expect(entry.outPathLen).toBe(-1);
  });

  it("isolates entries between accounts", () => {
    const accountA = "account-a";
    const accountB = "account-b";

    rememberContact(
      {
        publicKey: samplePublicKey,
        advName: "AccountA-Node",
        lastAdvert: 1000,
        advLat: 11111111,
      },
      accountA,
    );

    rememberContact(
      {
        publicKey: samplePublicKey,
        advName: "AccountB-Node",
        lastAdvert: 2000,
        advLat: 22222222,
      },
      accountB,
    );

    const entryA = getContactByPubkey(samplePublicKey, accountA)!;
    expect(entryA.advName).toBe("AccountA-Node");
    expect(entryA.advLat).toBe(11111111);

    const entryB = getContactByPubkey(samplePublicKey, accountB)!;
    expect(entryB.advName).toBe("AccountB-Node");
    expect(entryB.advLat).toBe(22222222);

    expect(getContactBookEntries(accountA)).toHaveLength(1);
    expect(getContactBookEntries(accountB)).toHaveLength(1);
  });

  it("loads a v1 file and migrates it to v2", () => {
    const path = join(tmpdir(), "meshcore-contact-book-migration.json");
    setContactBookPathForTests(path);
    writeFileSync(
      path,
      JSON.stringify([
        { publicKeyHex: bytesToHex(samplePublicKey), name: "LegacyNode" },
        { publicKeyHex: "notahex", name: "BadEntry" },
      ]),
    );

    // Force a fresh load by resetting (the file is already written).
    resetContactBookForTests();

    const entries = getContactBookEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.publicKey).toEqual(samplePublicKey);
    expect(entry.advName).toBe("LegacyNode");
    expect(entry.type).toBe(0);
    expect(entry.flags).toBe(0);
    expect(entry.outPathLen).toBe(0);
    expect(entry.advLat).toBe(0);
    expect(entry.advLon).toBe(0);
    expect(entry.lastAdvert).toBe(0);
    expect(entry.lastMod).toBe(0);
  });

  it("adopts legacy rows lazily on first remember or lookup", () => {
    const path = join(tmpdir(), "meshcore-contact-book-legacy-adopt.json");
    setContactBookPathForTests(path);
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        contacts: [
          {
            publicKeyHex: bytesToHex(samplePublicKey),
            type: 1,
            flags: 2,
            outPathLen: 2,
            outPathHex: "00".repeat(64),
            advName: "LegacyAdopted",
            lastAdvert: 100,
            advLat: 33333333,
            advLon: 44444444,
            lastMod: 99,
          },
        ],
      }),
    );

    resetContactBookForTests();

    // Legacy rows are adopted by the first account that touches them (lookup
    // or remember). Once adopted, they are isolated from other accounts.
    const otherAccount = "other-account";
    const entry = getContactByPubkey(samplePublicKey, accountId)!;
    expect(entry.advName).toBe("LegacyAdopted");
    expect(getContactByPubkey(samplePublicKey, otherAccount)).toBeUndefined();
    expect(getContactBookEntries(accountId)).toHaveLength(1);

    // Adoption also happens on remember; the legacy row is merged into the
    // target account without affecting others.
    const rememberKey = hexToBytes(
      "223344556677889900aabbccddeeff00112233445566778899aabbccddeeff00",
    );
    rememberContact(
      {
        publicKey: rememberKey,
        advName: "RememberedNode",
      },
      otherAccount,
    );
    expect(getContactByPubkey(rememberKey, otherAccount)).toBeDefined();
    expect(getContactBookEntries(otherAccount)).toHaveLength(1);
  });

  it("round-trips a v2 file with all fields intact", () => {
    rememberContact(makeFullAdvert(), accountId);

    // Reset clears memory; the next access should reload from disk.
    resetContactBookForTests();
    const entries = getContactBookEntries(accountId);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.publicKey).toEqual(samplePublicKey);
    expect(entry.type).toBe(1);
    expect(entry.flags).toBe(2);
    expect(entry.outPathLen).toBe(2);
    expect(bytesToHex(entry.outPath)).toBe("0102" + "00".repeat(62));
    expect(entry.advName).toBe("TestNode");
    expect(entry.lastAdvert).toBe(1234567890);
    expect(entry.advLat).toBe(48858900);
    expect(entry.advLon).toBe(2294500);
    expect(entry.lastMod).toBe(1234567000);
  });

  it("captures SelfInfo lat/lon/name for the local node", () => {
    rememberSelfInfo(
      {
        publicKey: samplePublicKey,
        name: "MyNode",
        advLat: 12345000,
        advLon: -54321000,
      },
      accountId,
    );

    const entry = resolveContactByPrefix(
      bytesToHex(samplePublicKey.slice(0, 6)).toLowerCase(),
      accountId,
    )!;
    expect(entry.publicKey).toEqual(samplePublicKey);
    expect(entry.advName).toBe("MyNode");
    expect(entry.advLat).toBe(12345000);
    expect(entry.advLon).toBe(-54321000);
    expect(entry.type).toBe(0);
    expect(entry.outPathLen).toBe(0);
  });

  it("returns undefined for an unknown prefix", () => {
    rememberContact(makeFullAdvert(), accountId);
    expect(resolveContactPubkeyByPrefix("000000000000", accountId)).toBeUndefined();
  });

  it("sets lastHeardAt on a 0x80 push for a metadata-complete contact without changing metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    rememberContact(makeFullAdvert(), accountId);
    vi.setSystemTime(2000);
    rememberContact({ publicKey: samplePublicKey }, accountId);

    const entry = getContactByPubkey(samplePublicKey, accountId)!;
    expect(entry.lastHeardAt).toBe(2);
    expect(entry.lastAdvert).toBe(1234567890);
    expect(entry.advName).toBe("TestNode");
    expect(entry.advLat).toBe(48858900);
    expect(entry.advLon).toBe(2294500);
    expect(entry.type).toBe(1);
    expect(entry.flags).toBe(2);
    expect(entry.outPathLen).toBe(2);
    expect(entry.outPath[0]).toBe(0x01);
  });

  it("advances lastHeardAt on a stale merge while preserving fresh fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    rememberContact(makeFullAdvert(), accountId);
    vi.setSystemTime(2000);
    rememberContact(
      {
        publicKey: samplePublicKey,
        advName: "OldNode",
        lastAdvert: 1,
        advLat: 0,
        advLon: 0,
      },
      accountId,
    );

    const entry = getContactByPubkey(samplePublicKey, accountId)!;
    expect(entry.lastHeardAt).toBe(2);
    // Freshness-dependent fields from the original, newer advert are preserved.
    expect(entry.lastAdvert).toBe(1234567890);
    expect(entry.advLat).toBe(48858900);
    expect(entry.advLon).toBe(2294500);
    expect(entry.outPathLen).toBe(2);
    expect(entry.outPath[0]).toBe(0x01);
    // Non-freshness fields still merge.
    expect(entry.advName).toBe("OldNode");
  });

  it("round-trips lastHeardAt through persistence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_234_567_001);

    rememberContact(makeFullAdvert(), accountId);
    vi.useRealTimers();

    resetContactBookForTests();
    const entries = getContactBookEntries(accountId);
    expect(entries).toHaveLength(1);
    expect(entries[0].lastHeardAt).toBe(1_234_567);
  });

  it("loads a v2 row without lastHeardAt as 0 and advances it on next remember", () => {
    const path = join(tmpdir(), "meshcore-contact-book-missing-last-heard.json");
    setContactBookPathForTests(path);
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        contacts: [
          {
            publicKeyHex: bytesToHex(samplePublicKey),
            type: 1,
            flags: 2,
            outPathLen: 2,
            outPathHex: "00".repeat(64),
            advName: "NoLastHeard",
            lastAdvert: 100,
            advLat: 11111111,
            advLon: 22222222,
            lastMod: 99,
            // lastHeardAt deliberately omitted.
          },
        ],
      }),
    );

    resetContactBookForTests();

    const loaded = getContactByPubkey(samplePublicKey, accountId)!;
    expect(loaded.lastHeardAt).toBe(0);
    expect(loaded.advName).toBe("NoLastHeard");

    vi.useFakeTimers();
    vi.setSystemTime(3000);
    rememberContact({ publicKey: samplePublicKey }, accountId);

    expect(getContactByPubkey(samplePublicKey, accountId)!.lastHeardAt).toBe(3);
  });

  it("formats the 12-hex contact prefix", () => {
    const entry = makeFullAdvert();
    expect(formatContactPrefix(entry)).toBe(
      bytesToHex(samplePublicKey.slice(0, 6)).toLowerCase(),
    );
  });

  it("survives a v2 row with malformed outPathHex without losing the pubkey", () => {
    const goodKey = hexToBytes(
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    );
    const badKey = hexToBytes(
      "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff",
    );
    const goodOutPath = new Uint8Array(64);
    goodOutPath[0] = 0xab;

    const path = join(tmpdir(), "meshcore-contact-book-bad-outpath.json");
    setContactBookPathForTests(path);
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        contacts: [
          {
            publicKeyHex: bytesToHex(goodKey),
            type: 1,
            flags: 2,
            outPathLen: 1,
            outPathHex: bytesToHex(goodOutPath),
            advName: "GoodNode",
            lastAdvert: 100,
            advLat: 11111111,
            advLon: 22222222,
            lastMod: 99,
          },
          {
            publicKeyHex: bytesToHex(badKey),
            type: 1,
            flags: 2,
            outPathLen: 1,
            outPathHex: "not-even-hex!", // malformed
            advName: "BadPathNode",
            lastAdvert: 200,
            advLat: 33333333,
            advLon: 44444444,
            lastMod: 88,
          },
        ],
      }),
    );

    resetContactBookForTests();

    const entries = getContactBookEntries();
    expect(entries).toHaveLength(2);

    const goodEntry = resolveContactByPrefix(
      bytesToHex(goodKey.slice(0, 6)).toLowerCase(),
      accountId,
    )!;
    expect(goodEntry.publicKey).toEqual(goodKey);
    expect(goodEntry.outPath[0]).toBe(0xab);
    expect(goodEntry.advName).toBe("GoodNode");

    const badEntry = resolveContactByPrefix(
      bytesToHex(badKey.slice(0, 6)).toLowerCase(),
      accountId,
    )!;
    expect(badEntry.publicKey).toEqual(badKey);
    expect(badEntry.outPath).toEqual(new Uint8Array(64));
    expect(badEntry.advName).toBe("BadPathNode");
    expect(badEntry.advLat).toBe(33333333);
  });
});
