import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatContactPrefix,
  getContactBookEntries,
  rememberContact,
  rememberSelfInfo,
  resetContactBookForTests,
  resolveContactByPrefix,
  resolveContactPubkeyByPrefix,
} from "./contact-book.js";
import { bytesToHex, hexToBytes } from "./protocol.js";

describe("contact book", () => {
  const originalEnv = process.env.MESHCORE_ADVERT_CACHE_PATH;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-contact-book-"));
    process.env.MESHCORE_ADVERT_CACHE_PATH = join(dir, "contacts.json");
    resetContactBookForTests();
  });

  afterEach(() => {
    resetContactBookForTests();
    if (originalEnv === undefined) {
      delete process.env.MESHCORE_ADVERT_CACHE_PATH;
    } else {
      process.env.MESHCORE_ADVERT_CACHE_PATH = originalEnv;
    }
  });

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
    rememberContact(makeFullAdvert());

    const entries = getContactBookEntries();
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
    rememberContact(makeFullAdvert());

    const prefix = bytesToHex(samplePublicKey.slice(0, 6)).toLowerCase();
    const resolved = resolveContactPubkeyByPrefix(prefix);
    expect(resolved).toEqual(samplePublicKey);
  });

  it("merges partial advert updates without dropping existing fields", () => {
    rememberContact(makeFullAdvert());
    rememberContact({
      publicKey: samplePublicKey,
      advName: "UpdatedName",
      advLat: 50000000,
    });

    const entry = resolveContactByPrefix(bytesToHex(samplePublicKey.slice(0, 6)).toLowerCase())!;
    expect(entry.advName).toBe("UpdatedName");
    expect(entry.advLat).toBe(50000000);
    expect(entry.advLon).toBe(2294500);
    expect(entry.type).toBe(1);
  });

  it("loads a v1 file and migrates it to v2", () => {
    const path = process.env.MESHCORE_ADVERT_CACHE_PATH!;
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

  it("round-trips a v2 file with all fields intact", () => {
    rememberContact(makeFullAdvert());

    // Reset clears memory; the next access should reload from disk.
    resetContactBookForTests();
    const entries = getContactBookEntries();
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
    rememberSelfInfo({
      publicKey: samplePublicKey,
      name: "MyNode",
      advLat: 12345000,
      advLon: -54321000,
    });

    const entry = resolveContactByPrefix(bytesToHex(samplePublicKey.slice(0, 6)).toLowerCase())!;
    expect(entry.publicKey).toEqual(samplePublicKey);
    expect(entry.advName).toBe("MyNode");
    expect(entry.advLat).toBe(12345000);
    expect(entry.advLon).toBe(-54321000);
    expect(entry.type).toBe(0);
    expect(entry.outPathLen).toBe(0);
  });

  it("returns undefined for an unknown prefix", () => {
    rememberContact(makeFullAdvert());
    expect(resolveContactPubkeyByPrefix("000000000000")).toBeUndefined();
  });
});
