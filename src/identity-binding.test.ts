import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifySignedPlainPrefix,
  derivePrefixConsistency,
  ensureIdentityBindingEvictionListener,
  formatSignedPlainLogLine,
  getPrefixObservationsForTests,
  getTrackedConstantPrefix,
  parseSignedPlainPayload,
  readPrefixConsistency,
  recordPrefixObservation,
  resetIdentityBindingEvictionListenerForTests,
  resetIdentityBindingStateForTests,
  resolveIdentityBinding,
  resolvePubkeyFromDmPrefix,
  setIdentityBindingPathForTests,
} from "./identity-binding.js";
import { hexToBytes } from "./protocol.js";
import {
  rememberContact,
  resetContactBookForTests,
  setContactBookPathForTests,
} from "./contact-book.js";

describe("identity binding", () => {
  let identityBindingPath: string;
  let contactBookPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-identity-"));
    identityBindingPath = join(dir, "identity-bindings.json");
    contactBookPath = join(dir, "contacts.json");
    setIdentityBindingPathForTests(identityBindingPath);
    setContactBookPathForTests(contactBookPath);
    resetIdentityBindingStateForTests();
    resetContactBookForTests();
    resetIdentityBindingEvictionListenerForTests();
  });

  afterEach(() => {
    resetIdentityBindingStateForTests();
    resetContactBookForTests();
    setIdentityBindingPathForTests(undefined);
    setContactBookPathForTests(undefined);
  });

  const accountId = "test-account";

  const samplePublicKey = hexToBytes(
    "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
  );

  const first4 = "aabbccdd";
  const last4 = "8899aabb";
  const unknownPrefix = "deadbeef";

  describe("parseSignedPlainPayload", () => {
    it("strips a clean ASCII prefix and returns lossy=false", () => {
      const result = parseSignedPlainPayload("SIGMhello from signed peer");
      expect(result.text).toBe("hello from signed peer");
      expect(result.senderPrefixHex).toBe("5349474d");
      expect(result.lossy).toBe(false);
    });

    it("preserves multibyte UTF-8 text after the prefix", () => {
      // Prefix "ABCD" + héllo + world
      const result = parseSignedPlainPayload("ABCDhéllo world");
      expect(result.text).toBe("héllo world");
      expect(result.senderPrefixHex).toBe("41424344");
      expect(result.lossy).toBe(false);
    });

    it("detects a lossy prefix with bytes >= 0x80 and never drops real text", () => {
      // 4 invalid standalone bytes followed by ASCII text.
      const decoded = "\uFFFD\uFFFD\uFFFD\uFFFDhello";
      const result = parseSignedPlainPayload(decoded);
      expect(result.lossy).toBe(true);
      expect(result.senderPrefixHex).toBeNull();
      // WHATWG maximal-subpart collapse may leave 1-2 spurious prefix-residue
      // replacement characters, but the real ASCII text is never dropped.
      expect(result.text).toMatch(/hello$/);
    });

    it("detects a partially lossy prefix and never drops real text", () => {
      // "AB" + invalid + invalid + "hello"
      const decoded = "AB\uFFFD\uFFFDhello";
      const result = parseSignedPlainPayload(decoded);
      expect(result.lossy).toBe(true);
      expect(result.senderPrefixHex).toBeNull();
      expect(result.text).toMatch(/hello$/);
    });

    it("collapses E0 A0 41 42 prefix and preserves adjacent real text", () => {
      // E0 A0 is an incomplete 3-byte UTF-8 sequence; TextDecoder replaces it
      // with U+FFFD and leaves 0x41 0x42 ('AB') as real text bytes. The parser
      // counts the replacement as 3 raw prefix bytes and consumes one real text
      // byte to reach 4, leaving a single prefix-residue character.
      const raw = new Uint8Array([
        0xe0, 0xa0, 0x41, 0x42, ...Array.from("hello").map((c) => c.charCodeAt(0)),
      ]);
      const decoded = new TextDecoder().decode(raw);
      const result = parseSignedPlainPayload(decoded);
      expect(result.lossy).toBe(true);
      expect(result.senderPrefixHex).toBeNull();
      expect(result.text).toMatch(/hello$/);
    });

    it("collapses F0 90 80 41 prefix and preserves adjacent real text", () => {
      // F0 90 80 is an incomplete 4-byte UTF-8 sequence; TextDecoder replaces
      // the first 3 bytes with U+FFFD and leaves 0x41 ('A') as an ASCII byte.
      // The parser consumes the replacement (3 raw bytes) plus A (1 byte) to
      // reach the 4-prefix boundary, so the real text starts intact.
      const raw = new Uint8Array([
        0xf0, 0x90, 0x80, 0x41, ...Array.from("realtext").map((c) => c.charCodeAt(0)),
      ]);
      const decoded = new TextDecoder().decode(raw);
      const result = parseSignedPlainPayload(decoded);
      expect(result.lossy).toBe(true);
      expect(result.senderPrefixHex).toBeNull();
      expect(result.text).toBe("realtext");
    });

    it("handles a payload shorter than 4 bytes", () => {
      const result = parseSignedPlainPayload("AB");
      expect(result.lossy).toBe(false);
      expect(result.text).toBe("");
      expect(result.senderPrefixHex).toBe("4142");
    });

    it("handles an empty payload", () => {
      const result = parseSignedPlainPayload("");
      expect(result.lossy).toBe(false);
      expect(result.text).toBe("");
      expect(result.senderPrefixHex).toBe("");
    });
  });

  describe("classifySignedPlainPrefix", () => {
    it("classifies a first-4 pubkey match", () => {
      expect(
        classifySignedPlainPrefix({
          senderPrefixHex: first4,
          publicKey: samplePublicKey,
          lossy: false,
        }),
      ).toBe("pubkey-first4");
    });

    it("classifies a last-4 pubkey match", () => {
      expect(
        classifySignedPlainPrefix({
          senderPrefixHex: last4,
          publicKey: samplePublicKey,
          lossy: false,
        }),
      ).toBe("pubkey-last4");
    });

    it("classifies a non-slice prefix as none", () => {
      expect(
        classifySignedPlainPrefix({
          senderPrefixHex: unknownPrefix,
          publicKey: samplePublicKey,
          lossy: false,
        }),
      ).toBe("none");
    });

    it("classifies a lossy prefix as lossy", () => {
      expect(
        classifySignedPlainPrefix({
          senderPrefixHex: null,
          publicKey: samplePublicKey,
          lossy: true,
        }),
      ).toBe("lossy");
    });

    it("classifies an invalid public key length as unresolved", () => {
      expect(
        classifySignedPlainPrefix({
          senderPrefixHex: first4,
          publicKey: new Uint8Array(16),
          lossy: false,
        }),
      ).toBe("unresolved");
    });
  });

  describe("derivePrefixConsistency", () => {
    it("returns insufficient for fewer than 3 observations", () => {
      expect(
        derivePrefixConsistency({
          observations: [first4, first4],
          publicKey: samplePublicKey,
        }),
      ).toBe("insufficient");
    });

    it("returns pubkey-first4 when all observations match first4", () => {
      expect(
        derivePrefixConsistency({
          observations: [first4, first4, first4],
          publicKey: samplePublicKey,
        }),
      ).toBe("pubkey-first4");
    });

    it("returns pubkey-last4 when all observations match last4", () => {
      expect(
        derivePrefixConsistency({
          observations: [last4, last4, last4, last4],
          publicKey: samplePublicKey,
        }),
      ).toBe("pubkey-last4");
    });

    it("returns constant-unknown for a constant non-slice prefix", () => {
      expect(
        derivePrefixConsistency({
          observations: [unknownPrefix, unknownPrefix, unknownPrefix],
          publicKey: samplePublicKey,
        }),
      ).toBe("constant-unknown");
    });

    it("returns varying when observations differ", () => {
      expect(
        derivePrefixConsistency({
          observations: [first4, last4, first4],
          publicKey: samplePublicKey,
        }),
      ).toBe("varying");
    });

    it("uses only the last 8 observations", () => {
      const obs = Array.from({ length: 10 }, () => first4);
      obs[8] = last4;
      obs[9] = last4;
      expect(
        derivePrefixConsistency({
          observations: obs,
          publicKey: samplePublicKey,
        }),
      ).toBe("varying");
    });
  });

  describe("recordPrefixObservation", () => {
    it("records first4 observations and derives pubkey-first4", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
          accountId,
        });
      }
      expect(getPrefixObservationsForTests(samplePublicKey, accountId)).toEqual([
        first4,
        first4,
        first4,
      ]);
      expect(readPrefixConsistency(samplePublicKey, accountId)).toBe("pubkey-first4");
    });

    it("records last4 observations and derives pubkey-last4", () => {
      for (let i = 0; i < 4; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
          accountId,
        });
      }
      expect(readPrefixConsistency(samplePublicKey, accountId)).toBe("pubkey-last4");
    });

    it("records a constant-unknown prefix after 3 identical none observations", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
          accountId,
        });
      }
      expect(readPrefixConsistency(samplePublicKey, accountId)).toBe("constant-unknown");
    });

    it("records none observations and converges to constant-unknown", () => {
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: unknownPrefix,
        prefixMatch: "none",
        accountId,
      });
      expect(getPrefixObservationsForTests(samplePublicKey, accountId)).toEqual([unknownPrefix]);
    });

    it("records a repeated none observation once constant-unknown is established", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
          accountId,
        });
      }
      expect(getPrefixObservationsForTests(samplePublicKey, accountId)).toHaveLength(3);
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: unknownPrefix,
        prefixMatch: "none",
        accountId,
      });
      expect(getPrefixObservationsForTests(samplePublicKey, accountId)).toHaveLength(4);
    });

    it("does not record unresolved observations", () => {
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: "efbfbd",
        prefixMatch: "unresolved",
        accountId,
      });
      expect(getPrefixObservationsForTests(samplePublicKey, accountId)).toEqual([]);
    });

    it("does not record lossy observations", () => {
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: null,
        prefixMatch: "lossy",
        accountId,
      });
      expect(getPrefixObservationsForTests(samplePublicKey, accountId)).toEqual([]);
      expect(readPrefixConsistency(samplePublicKey, accountId)).toBe("insufficient");
    });

    it("transitions from insufficient to constant-unknown to varying", () => {
      expect(
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
          accountId,
        }),
      ).toBe("insufficient");
      expect(
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
          accountId,
        }),
      ).toBe("insufficient");
      expect(
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
          accountId,
        }),
      ).toBe("constant-unknown");
      expect(
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
          accountId,
        }),
      ).toBe("varying");
    });

    it("caps observations at 8 entries", () => {
      for (let i = 0; i < 10; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
          accountId,
        });
      }
      expect(getPrefixObservationsForTests(samplePublicKey, accountId)).toHaveLength(8);
    });

    it("persists observations to disk and reloads them", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
          accountId,
        });
      }
      resetIdentityBindingStateForTests();
      expect(readPrefixConsistency(samplePublicKey, accountId)).toBe("pubkey-last4");
      const raw = JSON.parse(readFileSync(identityBindingPath, "utf8"));
      expect(raw.version).toBe(2);
      const pubkeyHex = bytesToHex(samplePublicKey).toLowerCase();
      expect(raw.observations[accountId][pubkeyHex].observations).toEqual([
        last4,
        last4,
        last4,
      ]);
    });

    it("keeps per-account histories isolated", () => {
      const accountA = "account-a";
      const accountB = "account-b";
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
          accountId: accountA,
        });
      }
      expect(readPrefixConsistency(samplePublicKey, accountA)).toBe("pubkey-last4");
      expect(readPrefixConsistency(samplePublicKey, accountB)).toBe("insufficient");
      expect(getPrefixObservationsForTests(samplePublicKey, accountB)).toEqual([]);

      resetIdentityBindingStateForTests();
      const raw = JSON.parse(readFileSync(identityBindingPath, "utf8"));
      const pubkeyHex = bytesToHex(samplePublicKey).toLowerCase();
      expect(raw.observations[accountA][pubkeyHex].observations).toEqual([
        last4,
        last4,
        last4,
      ]);
      expect(raw.observations[accountB]).toBeUndefined();
    });
  });

  describe("resolveIdentityBinding", () => {
    it("returns prefix-only for non-signed-plain messages", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: false,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
          consistency: "pubkey-first4",
        }),
      ).toBe("prefix-only");
    });

    it("returns prefix-only for unresolved signed-plain prefixes", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: "efbfbd",
          prefixMatch: "unresolved",
          consistency: "insufficient",
        }),
      ).toBe("prefix-only");
    });

    it("returns prefix-only for lossy signed-plain prefixes", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: null,
          prefixMatch: "lossy",
          consistency: "insufficient",
        }),
      ).toBe("prefix-only");
    });

    it("returns extended for a last4 match", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
          consistency: "pubkey-last4",
        }),
      ).toBe("extended");
    });

    it("returns extended for constant-unknown consistency", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
          consistency: "constant-unknown",
          trackedConstantPrefix: unknownPrefix,
        }),
      ).toBe("extended");
    });

    it("returns prefix-only for first4 match (down-classify)", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
          consistency: "pubkey-first4",
        }),
      ).toBe("prefix-only");
    });

    it("returns extended for a last4 match even when consistency is insufficient", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
          consistency: "insufficient",
        }),
      ).toBe("extended");
    });

    it("returns mismatch when current prefix contradicts tracked constant", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
          consistency: "constant-unknown",
          trackedConstantPrefix: unknownPrefix,
        }),
      ).toBe("mismatch");
    });

    it("returns mismatch when none prefix differs from constant-unknown", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: "cafebabe",
          prefixMatch: "none",
          consistency: "constant-unknown",
          trackedConstantPrefix: unknownPrefix,
        }),
      ).toBe("mismatch");
    });

    it("does not mismatch when there is no tracked constant", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: "cafebabe",
          prefixMatch: "none",
          consistency: "insufficient",
        }),
      ).toBe("prefix-only");
    });

    it("does not mismatch when consistency is varying", () => {
      expect(
        resolveIdentityBinding({
          signedPlain: true,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
          consistency: "varying",
        }),
      ).toBe("prefix-only");
    });
  });

  describe("resolvePubkeyFromDmPrefix", () => {
    it("resolves the full pubkey from a 6-byte DM header prefix", () => {
      rememberContact(
        {
          publicKey: samplePublicKey,
          advName: "TestNode",
          lastAdvert: 1000,
          identityBasis: "firmware-advert-verified",
        },
        accountId,
      );
      const prefix = "aabbccdd1122";
      const resolved = resolvePubkeyFromDmPrefix(prefix, accountId);
      expect(resolved).toEqual(samplePublicKey);
    });

    it("returns undefined for an unknown prefix", () => {
      expect(resolvePubkeyFromDmPrefix("000000000000", accountId)).toBeUndefined();
    });
  });

  describe("formatSignedPlainLogLine", () => {
    it("formats the one-line summary", () => {
      const line = formatSignedPlainLogLine({
        timestamp: "2026-10-10T20:00:00.000Z",
        accountId: "default",
        prefixHex: "8899aabb",
        prefixMatch: "pubkey-last4",
        consistency: "pubkey-last4",
        binding: "extended",
        lossy: false,
      });
      expect(line).toBe(
        "[2026-10-10T20:00:00.000Z] [meshcore] [default] signedplain prefix=8899aabb lossy=false match=pubkey-last4 consistency=pubkey-last4 binding=extended",
      );
    });
  });

  describe("getTrackedConstantPrefix", () => {
    it("returns the constant prefix when consistency is constant-unknown", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
          accountId,
        });
      }
      expect(getTrackedConstantPrefix(samplePublicKey, accountId)).toBe(unknownPrefix);
    });

    it("returns the constant prefix when consistency is pubkey-first4", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
          accountId,
        });
      }
      expect(getTrackedConstantPrefix(samplePublicKey, accountId)).toBe(first4);
    });

    it("returns undefined when consistency is insufficient", () => {
      expect(getTrackedConstantPrefix(samplePublicKey, accountId)).toBeUndefined();
    });

    it("returns undefined when consistency is varying", () => {
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: first4,
        prefixMatch: "pubkey-first4",
        accountId,
      });
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: last4,
        prefixMatch: "pubkey-last4",
        accountId,
      });
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: first4,
        prefixMatch: "pubkey-first4",
        accountId,
      });
      expect(getTrackedConstantPrefix(samplePublicKey, accountId)).toBeUndefined();
    });
  });

  describe("ensureIdentityBindingEvictionListener", () => {
    it("prunes identity-binding observations when their advert contact is evicted", () => {
      ensureIdentityBindingEvictionListener();

      const pubkeyA = samplePublicKey;
      const pubkeyB = hexToBytes(
        "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      );
      const pubkeyC = hexToBytes(
        "11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff",
      );
      const first4B = bytesToHex(pubkeyB.slice(0, 4)).toLowerCase();

      rememberContact(
        {
          publicKey: pubkeyA,
          advName: "A",
          lastAdvert: 1000,
          source: "advert",
          identityBasis: "firmware-advert-verified",
        },
        accountId,
      );
      rememberContact(
        {
          publicKey: pubkeyB,
          advName: "B",
          lastAdvert: 2000,
          source: "advert",
          identityBasis: "firmware-advert-verified",
        },
        accountId,
      );

      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: pubkeyA,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
          accountId,
        });
        recordPrefixObservation({
          publicKey: pubkeyB,
          senderPrefixHex: first4B,
          prefixMatch: "pubkey-first4",
          accountId,
        });
      }
      expect(readPrefixConsistency(pubkeyA, accountId)).toBe("pubkey-last4");
      expect(readPrefixConsistency(pubkeyB, accountId)).toBe("pubkey-first4");

      // Adding C with maxEntries=1 evicts the older advert contacts A and B.
      rememberContact(
        {
          publicKey: pubkeyC,
          advName: "C",
          lastAdvert: 3000,
          source: "advert",
          identityBasis: "firmware-advert-verified",
        },
        accountId,
        1,
      );

      // Force a reload from disk to prove the eviction was persisted.
      resetIdentityBindingStateForTests();
      expect(readPrefixConsistency(pubkeyA, accountId)).toBe("insufficient");
      expect(readPrefixConsistency(pubkeyB, accountId)).toBe("insufficient");
      const raw = JSON.parse(readFileSync(identityBindingPath, "utf8"));
      const hexA = bytesToHex(pubkeyA).toLowerCase();
      const hexB = bytesToHex(pubkeyB).toLowerCase();
      expect(raw.observations[accountId][hexA]).toBeUndefined();
      expect(raw.observations[accountId][hexB]).toBeUndefined();
    });
  });

  describe("legacy v1 identity-binding migration", () => {
    it("migrates pre-accountId v1 rows to the default account", () => {
      const pubkeyHex = bytesToHex(samplePublicKey).toLowerCase();
      const legacy = {
        version: 1,
        observations: {
          [pubkeyHex]: { observations: [last4, last4, last4] },
        },
      };
      writeFileSync(identityBindingPath, JSON.stringify(legacy));
      resetIdentityBindingStateForTests();

      expect(readPrefixConsistency(samplePublicKey, "default")).toBe("pubkey-last4");

      // A subsequent write re-persists in the v2 per-account format.
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: last4,
        prefixMatch: "pubkey-last4",
        accountId: "default",
      });
      const rewritten = JSON.parse(readFileSync(identityBindingPath, "utf8"));
      expect(rewritten.version).toBe(2);
      expect(rewritten.observations.default[pubkeyHex].observations).toHaveLength(4);
    });
  });
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
