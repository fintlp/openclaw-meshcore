import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifySignedPlainPrefix,
  derivePrefixConsistency,
  formatSignedPlainLogLine,
  getPrefixObservationsForTests,
  getTrackedConstantPrefix,
  parseSignedPlainPayload,
  readPrefixConsistency,
  recordPrefixObservation,
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

    it("detects a lossy prefix with bytes >= 0x80 and recovers best-effort text", () => {
      // 4 invalid standalone bytes followed by ASCII text.
      const decoded = "\uFFFD\uFFFD\uFFFD\uFFFDhello";
      const result = parseSignedPlainPayload(decoded);
      expect(result.lossy).toBe(true);
      expect(result.text).toBe("hello");
      // Best-effort prefix is the first 4 encoded bytes; each U+FFFD encodes
      // to 3 bytes, so the snapshot is partial.
      expect(result.senderPrefixHex).toBe("efbfbdef");
    });

    it("detects a partially lossy prefix", () => {
      // "AB" + invalid + invalid + "hello"
      const decoded = "AB\uFFFD\uFFFDhello";
      const result = parseSignedPlainPayload(decoded);
      expect(result.lossy).toBe(true);
      expect(result.text).toBe("hello");
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

    it("classifies a lossy prefix as unresolved", () => {
      expect(
        classifySignedPlainPrefix({
          senderPrefixHex: "efbfbd",
          publicKey: samplePublicKey,
          lossy: true,
        }),
      ).toBe("unresolved");
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
        });
      }
      expect(getPrefixObservationsForTests(samplePublicKey)).toEqual([
        first4,
        first4,
        first4,
      ]);
      expect(readPrefixConsistency(samplePublicKey)).toBe("pubkey-first4");
    });

    it("records last4 observations and derives pubkey-last4", () => {
      for (let i = 0; i < 4; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
        });
      }
      expect(readPrefixConsistency(samplePublicKey)).toBe("pubkey-last4");
    });

    it("records a constant-unknown prefix after 3 identical none observations", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
        });
      }
      expect(readPrefixConsistency(samplePublicKey)).toBe("constant-unknown");
    });

    it("records none observations and converges to constant-unknown", () => {
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: unknownPrefix,
        prefixMatch: "none",
      });
      expect(getPrefixObservationsForTests(samplePublicKey)).toEqual([unknownPrefix]);
    });

    it("records a repeated none observation once constant-unknown is established", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
        });
      }
      expect(getPrefixObservationsForTests(samplePublicKey)).toHaveLength(3);
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: unknownPrefix,
        prefixMatch: "none",
      });
      expect(getPrefixObservationsForTests(samplePublicKey)).toHaveLength(4);
    });

    it("does not record unresolved observations", () => {
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: "efbfbd",
        prefixMatch: "unresolved",
      });
      expect(getPrefixObservationsForTests(samplePublicKey)).toEqual([]);
    });

    it("transitions from insufficient to constant-unknown to varying", () => {
      expect(
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
        }),
      ).toBe("insufficient");
      expect(
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
        }),
      ).toBe("insufficient");
      expect(
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: unknownPrefix,
          prefixMatch: "none",
        }),
      ).toBe("constant-unknown");
      expect(
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
        }),
      ).toBe("varying");
    });

    it("caps observations at 8 entries", () => {
      for (let i = 0; i < 10; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
        });
      }
      expect(getPrefixObservationsForTests(samplePublicKey)).toHaveLength(8);
    });

    it("persists observations to disk and reloads them", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: last4,
          prefixMatch: "pubkey-last4",
        });
      }
      resetIdentityBindingStateForTests();
      expect(readPrefixConsistency(samplePublicKey)).toBe("pubkey-last4");
      const raw = JSON.parse(readFileSync(identityBindingPath, "utf8"));
      expect(raw.version).toBe(1);
      expect(raw.observations[bytesToHex(samplePublicKey).toLowerCase()].observations).toEqual([
        last4,
        last4,
        last4,
      ]);
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
        prefixHex: "8899aabb",
        prefixMatch: "pubkey-last4",
        consistency: "pubkey-last4",
        binding: "extended",
      });
      expect(line).toBe(
        "[meshcore] signedplain prefix=8899aabb match=pubkey-last4 consistency=pubkey-last4 binding=extended",
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
        });
      }
      expect(getTrackedConstantPrefix(samplePublicKey)).toBe(unknownPrefix);
    });

    it("returns the constant prefix when consistency is pubkey-first4", () => {
      for (let i = 0; i < 3; i++) {
        recordPrefixObservation({
          publicKey: samplePublicKey,
          senderPrefixHex: first4,
          prefixMatch: "pubkey-first4",
        });
      }
      expect(getTrackedConstantPrefix(samplePublicKey)).toBe(first4);
    });

    it("returns undefined when consistency is insufficient", () => {
      expect(getTrackedConstantPrefix(samplePublicKey)).toBeUndefined();
    });

    it("returns undefined when consistency is varying", () => {
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: first4,
        prefixMatch: "pubkey-first4",
      });
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: last4,
        prefixMatch: "pubkey-last4",
      });
      recordPrefixObservation({
        publicKey: samplePublicKey,
        senderPrefixHex: first4,
        prefixMatch: "pubkey-first4",
      });
      expect(getTrackedConstantPrefix(samplePublicKey)).toBeUndefined();
    });
  });
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
