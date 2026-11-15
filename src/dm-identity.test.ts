import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DM_IDENTITY_EVIDENCE_VERSION,
  authorizeDmCommand,
  canonicalMeshcoreNodeId,
  createDmIdentityEvidence,
  decideDmIdentity,
  dmIdentityDigestsEqual,
  fullKeySha256,
  isCanonicalMeshcoreApproval,
  parseDmIdentityEvidence,
  validateDmApprovalEntries,
  type DmIdentityContact,
  type DmIdentityDecision,
} from "./dm-identity.js";

const PREFIX_HEX = "001122334455";
const OTHER_PREFIX_HEX = "665544332211";
const KEY_A = `${PREFIX_HEX}${"aa".repeat(26)}`;
const KEY_B = `${PREFIX_HEX}${"bb".repeat(26)}`;
const KEY_C = `${PREFIX_HEX}${"cc".repeat(26)}`;
const KEY_D = `${OTHER_PREFIX_HEX}${"dd".repeat(26)}`;
const NODE_A = `!${KEY_A}`;
const NODE_B = `!${KEY_B}`;

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function contact(fullKey: string, advName?: string): DmIdentityContact {
  return { publicKey: bytes(fullKey), ...(advName === undefined ? {} : { advName }) };
}

function uniqueIdentity(overrides: Partial<Extract<DmIdentityDecision, { status: "unique" }>> = {}) {
  return {
    status: "unique" as const,
    fullKey: KEY_A,
    nodeId: NODE_A,
    name: "Alice",
    ...overrides,
  };
}

function decide(overrides: Partial<Parameters<typeof decideDmIdentity>[0]> = {}) {
  return decideDmIdentity({
    accountId: "account-a",
    wirePrefix: bytes(PREFIX_HEX),
    radioContacts: [contact(KEY_A, "Alice")],
    ...overrides,
  });
}

describe("decideDmIdentity", () => {
  it("resolves one live six-byte prefix match to a canonical full-key identity", () => {
    expect(decide()).toEqual({
      status: "unique",
      fullKey: KEY_A,
      nodeId: NODE_A,
      name: "Alice",
    });
  });

  it("uses name as a display-name fallback, never as identity evidence", () => {
    expect(decide({ radioContacts: [{ publicKey: bytes(KEY_A), name: "Radio name" }] })).toEqual({
      status: "unique",
      fullKey: KEY_A,
      nodeId: NODE_A,
      name: "Radio name",
    });
  });

  it("deduplicates repeated live rows for the same full key", () => {
    expect(
      decide({
        radioContacts: [contact(KEY_A, "Alice"), contact(KEY_A, "Alice")],
        accountContacts: [{ publicKey: bytes(KEY_A), accountId: "account-a" }],
      }),
    ).toEqual({ status: "unique", fullKey: KEY_A, nodeId: NODE_A, name: "Alice" });
  });

  it("chooses duplicate-row display names deterministically", () => {
    const first = decide({ radioContacts: [contact(KEY_A, "Zulu"), contact(KEY_A, "Alpha")] });
    const second = decide({ radioContacts: [contact(KEY_A, "Alpha"), contact(KEY_A, "Zulu")] });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "unique", name: "Alpha" });
  });

  it.each([
    ["live B then A", [contact(KEY_B), contact(KEY_A)]],
    ["live A then B", [contact(KEY_A), contact(KEY_B)]],
  ])("rejects ambiguous live keys regardless of order: %s", (_label, radioContacts) => {
    expect(decide({ radioContacts })).toEqual({ status: "ambiguous" });
  });

  it("rejects a stale cached conflicting key even with one live match", () => {
    expect(
      decide({
        accountContacts: [
          { publicKey: bytes(KEY_A), accountId: "account-a" },
          { publicKey: bytes(KEY_B), accountId: "account-a" },
        ],
      }),
    ).toEqual({ status: "ambiguous" });
  });

  it("finds cached conflicts independent of account-book row order", () => {
    const rows = [
      { publicKey: bytes(KEY_C), accountId: "account-a" },
      { publicKey: bytes(KEY_A), accountId: "account-a" },
    ];
    expect(decide({ accountContacts: rows })).toEqual({ status: "ambiguous" });
    expect(decide({ accountContacts: rows.reverse() })).toEqual({ status: "ambiguous" });
  });

  it("ignores another account's cached rows", () => {
    expect(
      decide({
        accountContacts: [
          { publicKey: bytes(KEY_B), accountId: "account-b" },
          { publicKey: bytes(KEY_A), accountId: "account-a" },
        ],
      }),
    ).toMatchObject({ status: "unique", fullKey: KEY_A });
  });

  it("never establishes a live mapping from cache-only rows", () => {
    expect(
      decide({
        radioContacts: [],
        accountContacts: [{ publicKey: bytes(KEY_A), accountId: "account-a" }],
      }),
    ).toEqual({ status: "unresolved" });
  });

  it("never establishes a live mapping from an unscoped legacy cache row", () => {
    expect(
      decide({
        radioContacts: [],
        accountContacts: [{ publicKey: bytes(KEY_A), name: "Legacy" }],
      }),
    ).toEqual({ status: "unresolved" });
  });

  it("fails closed when an already-scoped legacy row conflicts with live state", () => {
    expect(
      decide({ accountContacts: [{ publicKey: bytes(KEY_B), name: "Legacy" }] }),
    ).toEqual({ status: "ambiguous" });
  });

  it.each(["", "   ", undefined])("rejects a missing/empty receiving account: %j", (accountId) => {
    expect(decide({ accountId })).toEqual({ status: "invalid" });
  });

  it("returns unresolved for an unknown prefix", () => {
    expect(decide({ wirePrefix: bytes(OTHER_PREFIX_HEX) })).toEqual({ status: "unresolved" });
  });

  it("returns unresolved when there are no live or cached contacts", () => {
    expect(decide({ radioContacts: [] })).toEqual({ status: "unresolved" });
  });

  it.each([
    ["empty", []],
    ["short", [0, 1, 2, 3, 4]],
    ["long", [0, 1, 2, 3, 4, 5, 6]],
    ["full key", Array.from(bytes(KEY_A))],
  ])("rejects a %s wire prefix", (_label, wirePrefix) => {
    expect(decide({ wirePrefix })).toEqual({ status: "invalid" });
  });

  it("rejects empty and short Uint8Array prefixes", () => {
    expect(decide({ wirePrefix: new Uint8Array() })).toEqual({ status: "invalid" });
    expect(decide({ wirePrefix: new Uint8Array(5) })).toEqual({ status: "invalid" });
  });

  it.each([
    ["negative", [-1, 1, 2, 3, 4, 5]],
    ["above byte range", [0, 1, 2, 3, 4, 256]],
    ["fractional", [0, 1, 2, 3, 4, 5.5]],
    ["NaN", [0, 1, 2, 3, 4, Number.NaN]],
    ["infinity", [0, 1, 2, 3, 4, Number.POSITIVE_INFINITY]],
    ["non-number", [0, 1, 2, 3, 4, "5"]],
  ])("rejects invalid plain-array bytes instead of coercing them: %s", (_label, wirePrefix) => {
    expect(
      decide({ wirePrefix: wirePrefix as unknown as readonly number[] }),
    ).toEqual({ status: "invalid" });
  });

  it("handles a Uint8Array view with a non-zero byte offset", () => {
    const wrapped = new Uint8Array([9, 9, ...bytes(PREFIX_HEX), 9]);
    expect(decide({ wirePrefix: wrapped.subarray(2, 8) })).toMatchObject({
      status: "unique",
      fullKey: KEY_A,
    });
  });

  it.each([31, 33])("rejects a %s-byte live candidate key", (length) => {
    expect(
      decide({ radioContacts: [{ publicKey: new Uint8Array(length) }] }),
    ).toEqual({ status: "invalid" });
  });

  it("rejects invalid plain-array bytes in a live candidate key", () => {
    const publicKey = [...Array.from(bytes(KEY_A).slice(0, 31)), 256];
    expect(
      decide({ radioContacts: [{ publicKey: publicKey as unknown as Uint8Array }] }),
    ).toEqual({ status: "invalid" });
  });

  it("rejects a malformed live row even when another row would match", () => {
    expect(
      decide({ radioContacts: [contact(KEY_A), { publicKey: new Uint8Array(31) }] }),
    ).toEqual({ status: "invalid" });
  });

  it("does not let malformed cache rows establish or conflict with identity", () => {
    expect(
      decide({ accountContacts: [{ publicKey: new Uint8Array(31), accountId: "account-a" }] }),
    ).toMatchObject({ status: "unique", fullKey: KEY_A });
  });
});

describe("canonical MeshCore approvals", () => {
  it("canonicalizes a full key with or without a bang and normalizes case", () => {
    expect(canonicalMeshcoreNodeId(KEY_A)).toBe(NODE_A);
    expect(canonicalMeshcoreNodeId(NODE_A)).toBe(NODE_A);
    expect(canonicalMeshcoreNodeId(`!${KEY_A.toUpperCase()}`)).toBe(NODE_A);
  });

  it.each([
    "Alice",
    "!001122334455",
    PREFIX_HEX,
    "",
    "!",
    `!!${KEY_A}`,
    ` ${NODE_A}`,
    `${NODE_A} `,
    `!${"g".repeat(64)}`,
    `!${"a".repeat(65)}`,
    undefined,
    null,
    42,
  ])("returns undefined for a non-full-key input: %j", (value) => {
    expect(canonicalMeshcoreNodeId(value)).toBeUndefined();
  });

  it("requires a bang and exactly 64 hex chars; hex case is accepted for normalization", () => {
    expect(isCanonicalMeshcoreApproval(NODE_A)).toBe(true);
    expect(isCanonicalMeshcoreApproval(`!${KEY_A.toUpperCase()}`)).toBe(true);
    expect(isCanonicalMeshcoreApproval(KEY_A)).toBe(false);
    expect(isCanonicalMeshcoreApproval("!001122334455")).toBe(false);
    expect(isCanonicalMeshcoreApproval("Alice")).toBe(false);
    expect(isCanonicalMeshcoreApproval(` ${NODE_A}`)).toBe(false);
  });

  it("partitions and deduplicates canonical approvals without promoting legacy entries", () => {
    const legacyOrInvalid = [KEY_A, "!001122334455", "Alice", 42, "", null];
    const result = validateDmApprovalEntries([
      NODE_A,
      `!${KEY_B.toUpperCase()}`,
      NODE_A,
      ...legacyOrInvalid,
    ]);
    expect(result).toEqual({ canonical: [NODE_A, NODE_B], legacyOrInvalid });
  });
});

describe("versioned DM identity evidence", () => {
  it("hashes the raw 32-byte public key, not its hex display string", () => {
    const expected = createHash("sha256").update(bytes(KEY_A)).digest("hex");
    expect(fullKeySha256(bytes(KEY_A))).toBe(expected);
    expect(fullKeySha256(KEY_A)).toBe(expected);
    expect(fullKeySha256(NODE_A)).toBe(expected);
    expect(fullKeySha256(KEY_A.toUpperCase())).toBe(expected);
  });

  it.each(["!001122334455", "Alice", "", "not-hex"])("rejects an invalid digest key: %j", (key) => {
    expect(() => fullKeySha256(key)).toThrow(TypeError);
  });

  it("rejects invalid byte-array digest keys", () => {
    expect(() => fullKeySha256(new Uint8Array(31))).toThrow(TypeError);
    expect(() => fullKeySha256([...Array(31).fill(0), 256])).toThrow(TypeError);
  });

  it("creates version 1 evidence with an exact lowercase six-byte prefix", () => {
    const evidence = createDmIdentityEvidence({
      wirePrefix: [0x00, 0x11, 0x22, 0x33, 0x44, 0x55],
      fullKey: bytes(KEY_A),
    });
    expect(evidence).toEqual({
      version: DM_IDENTITY_EVIDENCE_VERSION,
      wirePrefixHex: PREFIX_HEX,
      fullKeySha256: fullKeySha256(KEY_A),
    });
    expect(evidence.version).toBe(1);
    expect(evidence.wirePrefixHex).toMatch(/^[0-9a-f]{12}$/);
  });

  it.each([
    ["short", [0, 1, 2]],
    ["invalid byte", [0, 1, 2, 3, 4, 256]],
  ])("rejects evidence creation with a %s prefix", (_label, wirePrefix) => {
    expect(() => createDmIdentityEvidence({ wirePrefix, fullKey: KEY_A })).toThrow(TypeError);
  });

  it("round-trips the chosen rawJson.dmIdentityEvidence wrapper from a JSON string", () => {
    const evidence = createDmIdentityEvidence({ wirePrefix: bytes(PREFIX_HEX), fullKey: KEY_A });
    const rawJson = JSON.stringify({ messageId: "message-1", dmIdentityEvidence: evidence });
    expect(parseDmIdentityEvidence(rawJson)).toEqual(evidence);
  });

  it("round-trips an already-parsed rawJson object and preserves unrelated wrapper fields", () => {
    const evidence = createDmIdentityEvidence({ wirePrefix: bytes(PREFIX_HEX), fullKey: KEY_A });
    expect(parseDmIdentityEvidence({ other: true, dmIdentityEvidence: evidence })).toEqual(evidence);
  });

  it("returns undefined for missing evidence, bare evidence, malformed JSON, and non-objects", () => {
    const evidence = createDmIdentityEvidence({ wirePrefix: bytes(PREFIX_HEX), fullKey: KEY_A });
    expect(parseDmIdentityEvidence("{}")).toBeUndefined();
    expect(parseDmIdentityEvidence({})).toBeUndefined();
    expect(parseDmIdentityEvidence(evidence)).toBeUndefined();
    expect(parseDmIdentityEvidence("{broken")).toBeUndefined();
    expect(parseDmIdentityEvidence(null)).toBeUndefined();
    expect(parseDmIdentityEvidence([])).toBeUndefined();
    expect(parseDmIdentityEvidence(42)).toBeUndefined();
  });

  it.each([
    ["null evidence", null],
    ["wrong version", { version: 2, wirePrefixHex: PREFIX_HEX, fullKeySha256: "a".repeat(64) }],
    ["string version", { version: "1", wirePrefixHex: PREFIX_HEX, fullKeySha256: "a".repeat(64) }],
    ["short prefix", { version: 1, wirePrefixHex: "0011", fullKeySha256: "a".repeat(64) }],
    ["uppercase prefix", { version: 1, wirePrefixHex: "AABBCCDDEEFF", fullKeySha256: "a".repeat(64) }],
    ["non-hex prefix", { version: 1, wirePrefixHex: "g01122334455", fullKeySha256: "a".repeat(64) }],
    ["short digest", { version: 1, wirePrefixHex: PREFIX_HEX, fullKeySha256: "a".repeat(63) }],
    ["uppercase digest", { version: 1, wirePrefixHex: PREFIX_HEX, fullKeySha256: "A".repeat(64) }],
    ["non-hex digest", { version: 1, wirePrefixHex: PREFIX_HEX, fullKeySha256: `g${"a".repeat(63)}` }],
    ["missing digest", { version: 1, wirePrefixHex: PREFIX_HEX }],
    ["extra evidence field", { version: 1, wirePrefixHex: PREFIX_HEX, fullKeySha256: "a".repeat(64), name: "Alice" }],
  ])("strictly rejects %s", (_label, dmIdentityEvidence) => {
    expect(parseDmIdentityEvidence({ dmIdentityEvidence })).toBeUndefined();
    expect(parseDmIdentityEvidence(JSON.stringify({ dmIdentityEvidence }))).toBeUndefined();
  });

  it("compares validated digests with a fixed-length timing-safe helper", () => {
    const digestA = fullKeySha256(KEY_A);
    const digestCopy = `${digestA}`;
    expect(dmIdentityDigestsEqual(digestA, digestCopy)).toBe(true);
    expect(dmIdentityDigestsEqual(digestA, fullKeySha256(KEY_B))).toBe(false);
    expect(dmIdentityDigestsEqual(digestA, digestA.toUpperCase())).toBe(false);
    expect(dmIdentityDigestsEqual(digestA, digestA.slice(1))).toBe(false);
    expect(dmIdentityDigestsEqual(digestA, undefined)).toBe(false);
  });
});

describe("authorizeDmCommand", () => {
  it("allows only the explicit unique-full-key !ping compatibility exception", () => {
    for (const commandRepliesEnabled of [undefined, true]) {
      expect(
        authorizeDmCommand({
          identity: uniqueIdentity(),
          nativeCommand: "!ping",
          nativePingAllowFrom: [NODE_A],
          commandRepliesEnabled,
        }),
      ).toEqual({
        hostCommandAuthorized: false,
        commandInterpretationSuppressed: true,
        nativeAuthorized: true,
        reason: "unique-full-key-ping-allowlisted",
      });
    }
  });

  it("normalizes hex case in a canonical allowlist entry", () => {
    expect(
      authorizeDmCommand({
        identity: uniqueIdentity(),
        nativeCommand: "!ping",
        nativePingAllowFrom: [`!${KEY_A.toUpperCase()}`],
      }).nativeAuthorized,
    ).toBe(true);
  });

  it("still disables feature toggles when the ping exception is otherwise valid", () => {
    const result = authorizeDmCommand({
      identity: uniqueIdentity(),
      nativeCommand: "!ping",
      nativePingAllowFrom: [NODE_A],
      commandRepliesEnabled: false,
    });
    expect(result.nativeAuthorized).toBe(false);
    expect(result.hostCommandAuthorized).toBe(false);
    expect(result.commandInterpretationSuppressed).toBe(true);
  });

  it.each(["!ping", "!status", "!neighbours", "!rstatus", "!trace"])(
    "default-denies native %s for a stock prefix peer",
    (nativeCommand) => {
      const result = authorizeDmCommand({ identity: uniqueIdentity(), nativeCommand });
      expect(result).toMatchObject({
        hostCommandAuthorized: false,
        commandInterpretationSuppressed: true,
        nativeAuthorized: false,
      });
      expect(result.reason).not.toBe("");
    },
  );

  it.each(["!status", "!neighbours", "!rstatus", "!trace"])(
    "does not extend the full-key ping allowlist to %s",
    (nativeCommand) => {
      expect(
        authorizeDmCommand({
          identity: uniqueIdentity(),
          nativeCommand,
          nativePingAllowFrom: [NODE_A],
        }).nativeAuthorized,
      ).toBe(false);
    },
  );

  it.each(["invalid", "unresolved", "ambiguous"] as const)(
    "does not let an allowlist rescue %s identity",
    (status) => {
      expect(
        authorizeDmCommand({
          identity: { status },
          nativeCommand: "!ping",
          nativePingAllowFrom: [NODE_A],
        }),
      ).toMatchObject({
        hostCommandAuthorized: false,
        commandInterpretationSuppressed: true,
        nativeAuthorized: false,
      });
    },
  );

  it.each([
    ["bare full key", KEY_A],
    ["six-byte prefix", `!${PREFIX_HEX}`],
    ["short prefix", "!0011"],
    ["display name", "Alice"],
    ["wildcard", "*"],
    ["different full key", NODE_B],
    ["malformed full key", `!${"g".repeat(64)}`],
    ["numeric legacy entry", 12345],
  ])("rejects malformed/legacy native allowlist entry: %s", (_label, entry) => {
    expect(
      authorizeDmCommand({
        identity: uniqueIdentity(),
        nativeCommand: "!ping",
        nativePingAllowFrom: [entry as string],
      }).nativeAuthorized,
    ).toBe(false);
  });

  it("ignores malformed entries but accepts a later valid canonical full key", () => {
    expect(
      authorizeDmCommand({
        identity: uniqueIdentity(),
        nativeCommand: "!ping",
        nativePingAllowFrom: ["Alice", `!${PREFIX_HEX}`, NODE_A],
      }).nativeAuthorized,
    ).toBe(true);
  });

  it.each(["!PING", "!ping ", " !ping", "!unknown", "!neighbours !0011"])(
    "denies non-exact or unrecognized native command input: %j",
    (nativeCommand) => {
      expect(
        authorizeDmCommand({
          identity: uniqueIdentity(),
          nativeCommand,
          nativePingAllowFrom: [NODE_A],
        }).nativeAuthorized,
      ).toBe(false);
    },
  );

  it("never grants host command interpretation, including when native ping is allowed", () => {
    for (const nativeAuthorized of [false, true]) {
      const result = authorizeDmCommand({
        identity: uniqueIdentity(),
        nativeCommand: "!ping",
        nativePingAllowFrom: nativeAuthorized ? [NODE_A] : [],
      });
      expect(result.nativeAuthorized).toBe(nativeAuthorized);
      expect(result.hostCommandAuthorized).toBe(false);
      expect(result.commandInterpretationSuppressed).toBe(true);
    }
  });

  it.each(["prefix-only", "extended", "missing", "mismatch"])(
    "does not treat diagnostic grade %s as command authority",
    (grade) => {
      const identity = { ...uniqueIdentity(), grade } as DmIdentityDecision;
      const result = authorizeDmCommand({
        identity,
        nativeCommand: "!status",
        nativePingAllowFrom: [NODE_A],
      });
      expect(result.hostCommandAuthorized).toBe(false);
      expect(result.commandInterpretationSuppressed).toBe(true);
      expect(result.nativeAuthorized).toBe(false);
    },
  );

  it("denies a forged unique decision whose fullKey/nodeId pair is not canonical", () => {
    for (const identity of [
      uniqueIdentity({ fullKey: KEY_A.toUpperCase() }),
      uniqueIdentity({ nodeId: NODE_B }),
      uniqueIdentity({ fullKey: PREFIX_HEX, nodeId: `!${PREFIX_HEX}` }),
    ]) {
      expect(
        authorizeDmCommand({
          identity,
          nativeCommand: "!ping",
          nativePingAllowFrom: [NODE_A, NODE_B],
        }).nativeAuthorized,
      ).toBe(false);
    }
  });

  it("returns a denied decision for non-command helper calls", () => {
    expect(authorizeDmCommand({ identity: uniqueIdentity() })).toEqual({
      hostCommandAuthorized: false,
      commandInterpretationSuppressed: true,
      nativeAuthorized: false,
      reason: "host-commands-require-independent-proof",
    });
  });
});
