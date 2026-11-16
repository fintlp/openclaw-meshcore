import { describe, expect, it } from "vitest";
import { createDmIdentityEvidence } from "./dm-identity.js";
import {
  classifyMeshcoreAdmissionDrop,
  decideMeshcoreDmAdmission,
  resolveMeshcoreGroupAccess,
  type MeshcoreGroupPolicy,
} from "./inbound-decisions.js";
import type { MeshcoreGroupMatch } from "./policy.js";
import { hexToBytes } from "./protocol.js";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";

// Pinning tests for the pure decision module (issue #84; mutation table from
// the #83 adversarial review). No mocks: every function is called directly.

const KEY = "aabbccdd1122" + "0".repeat(52);
const NODE = "!" + KEY;
const OTHER_KEY = "22".repeat(32);
const NODE_A = "!" + "aa".repeat(32);
const NODE_B = "!" + "bb".repeat(32);
const CONFIG = { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig;

function evidenceFor(fullKey: string) {
  return createDmIdentityEvidence({ wirePrefix: hexToBytes(fullKey.slice(0, 12)), fullKey });
}

function dm(overrides: Partial<MeshcoreInboundMessage> = {}): MeshcoreInboundMessage {
  return {
    messageId: "mc-dm-1",
    target: NODE,
    senderNodeId: NODE,
    text: "hello",
    timestamp: 1_700_000_000_000,
    isGroup: false,
    meshChannel: 0,
    dmIdentity: { status: "unique", fullKey: KEY, nodeId: NODE },
    dmIdentityEvidence: evidenceFor(KEY),
    meshSecurity: { txtType: 0, signedPlain: false, identityBinding: "prefix-only" },
    ...overrides,
  };
}

describe("decideMeshcoreDmAdmission", () => {
  it("admits a unique, canonical, evidence-backed identity (positive control)", () => {
    expect(decideMeshcoreDmAdmission({ message: dm(), config: CONFIG })).toEqual({ kind: "admit" });
  });

  it("missing evidence outranks an ambiguous identity: dm-identity-no-evidence", () => {
    const decision = decideMeshcoreDmAdmission({
      message: dm({ dmIdentity: { status: "ambiguous" }, dmIdentityEvidence: undefined }),
      config: CONFIG,
    });
    expect(decision).toEqual({
      kind: "refuse",
      securityReason: "dm-identity-refused",
      replayDeadLetterReason: "dm-identity-no-evidence",
    });
  });

  it("an ambiguous identity WITH evidence dead-letters as dm-identity-ambiguous", () => {
    const decision = decideMeshcoreDmAdmission({
      message: dm({ dmIdentity: { status: "ambiguous" } }),
      config: CONFIG,
    });
    expect(decision).toEqual({
      kind: "refuse",
      securityReason: "dm-identity-refused",
      replayDeadLetterReason: "dm-identity-ambiguous",
    });
  });

  it("a unique identity whose evidence names another key is dm-identity-stale", () => {
    const decision = decideMeshcoreDmAdmission({
      message: dm({ dmIdentityEvidence: evidenceFor(OTHER_KEY) }),
      config: CONFIG,
    });
    expect(decision).toEqual({
      kind: "refuse",
      securityReason: "dm-identity-refused",
      replayDeadLetterReason: "dm-identity-stale",
    });
  });

  it("refuses an otherwise valid identity when identityBinding is mismatch", () => {
    const decision = decideMeshcoreDmAdmission({
      message: dm({
        meshSecurity: { txtType: 2, signedPlain: true, identityBinding: "mismatch" },
      }),
      config: CONFIG,
    });
    expect(decision).toEqual({
      kind: "refuse",
      securityReason: "dm-identity-refused",
      replayDeadLetterReason: "dm-identity-stale",
    });
  });

  it("refuses the configured mesh owner with mesh-owner-unverified / dm-identity-stale", () => {
    const decision = decideMeshcoreDmAdmission({
      message: dm(),
      config: { ...CONFIG, commands: { ownerAllowFrom: [NODE] } } as unknown as CoreConfig,
    });
    expect(decision).toEqual({
      kind: "refuse",
      securityReason: "mesh-owner-unverified",
      replayDeadLetterReason: "dm-identity-stale",
    });
  });

  it("admits a valid identity that is not the configured owner", () => {
    const decision = decideMeshcoreDmAdmission({
      message: dm(),
      config: { ...CONFIG, commands: { ownerAllowFrom: ["!" + OTHER_KEY] } } as unknown as CoreConfig,
    });
    expect(decision).toEqual({ kind: "admit" });
  });
});

function match(overrides: Partial<MeshcoreGroupMatch> = {}): MeshcoreGroupMatch {
  return {
    allowed: true,
    groupConfig: { requireMention: false },
    hasConfiguredGroups: true,
    ...overrides,
  };
}

function access(params: {
  groupPolicy: MeshcoreGroupPolicy;
  groupMatch?: MeshcoreGroupMatch;
  groupAllowFrom?: Array<string | number>;
  isGroup?: boolean;
}) {
  return resolveMeshcoreGroupAccess({
    isGroup: params.isGroup ?? true,
    groupPolicy: params.groupPolicy,
    groupMatch: params.groupMatch ?? match(),
    groupAllowFrom: params.groupAllowFrom ?? [],
  });
}

describe("resolveMeshcoreGroupAccess: allowlist -> open normalization", () => {
  it("opens an allowlisted, configured, matched channel with no sender filter", () => {
    expect(access({ groupPolicy: "allowlist" }).accessGroupPolicy).toBe("open");
  });

  it("stays allowlist when the matched group has a route sender allowFrom", () => {
    const r = access({
      groupPolicy: "allowlist",
      groupMatch: match({ groupConfig: { requireMention: false, allowFrom: [NODE_A] } }),
    });
    expect(r.accessGroupPolicy).toBe("allowlist");
  });

  it("stays allowlist when the account has a groupAllowFrom sender filter", () => {
    expect(access({ groupPolicy: "allowlist", groupAllowFrom: [NODE_A] }).accessGroupPolicy).toBe(
      "allowlist",
    );
  });

  it("stays allowlist when the channel is not matched", () => {
    const r = access({
      groupPolicy: "allowlist",
      groupMatch: { allowed: false, hasConfiguredGroups: true },
    });
    expect(r.accessGroupPolicy).toBe("allowlist");
  });

  it("stays allowlist when no groups are configured", () => {
    const r = access({ groupPolicy: "allowlist", groupMatch: match({ hasConfiguredGroups: false }) });
    expect(r.accessGroupPolicy).toBe("allowlist");
  });

  it("stays allowlist for a direct message", () => {
    expect(access({ groupPolicy: "allowlist", isGroup: false }).accessGroupPolicy).toBe("allowlist");
  });
});

describe("resolveMeshcoreGroupAccess: open -> allowlist normalization", () => {
  it("narrows open to allowlist when only the account groupAllowFrom has entries", () => {
    expect(access({ groupPolicy: "open", groupAllowFrom: [NODE_A] }).accessGroupPolicy).toBe(
      "allowlist",
    );
  });

  it("narrows open to allowlist when only the route allowFrom has entries", () => {
    const r = access({
      groupPolicy: "open",
      groupMatch: match({ groupConfig: { requireMention: false, allowFrom: [NODE_A] } }),
    });
    expect(r.accessGroupPolicy).toBe("allowlist");
  });

  it("keeps open when neither sender filter has entries", () => {
    expect(access({ groupPolicy: "open" }).accessGroupPolicy).toBe("open");
  });

  it("passes disabled through unchanged", () => {
    expect(access({ groupPolicy: "disabled", groupAllowFrom: [NODE_A] }).accessGroupPolicy).toBe(
      "disabled",
    );
  });
});

describe("resolveMeshcoreGroupAccess: route allowFrom precedence", () => {
  it("prefers the exact group's allowFrom over the wildcard's", () => {
    const r = access({
      groupPolicy: "allowlist",
      groupMatch: match({
        groupConfig: { requireMention: false, allowFrom: [NODE_A] },
        wildcardConfig: { requireMention: false, allowFrom: [NODE_B] },
      }),
    });
    expect(r.routeGroupAllowFrom).toEqual([NODE_A]);
  });

  it("falls back to the wildcard allowFrom when the group has none", () => {
    const r = access({
      groupPolicy: "allowlist",
      groupMatch: match({
        groupConfig: { requireMention: false, allowFrom: [] },
        wildcardConfig: { requireMention: false, allowFrom: [NODE_B] },
      }),
    });
    expect(r.routeGroupAllowFrom).toEqual([NODE_B]);
  });

  it("resolves requireMention for groups and forces false for DMs", () => {
    const m = match({ groupConfig: { requireMention: true } });
    expect(access({ groupPolicy: "open", groupMatch: m }).requireMention).toBe(true);
    expect(access({ groupPolicy: "open", groupMatch: m, isGroup: false }).requireMention).toBe(false);
  });
});

function verdict(params: {
  admission?: string;
  decisiveGateId?: string;
  shouldBlockControlCommand?: boolean;
  reason?: string;
}) {
  return {
    ingress: { admission: params.admission ?? "drop", decisiveGateId: params.decisiveGateId },
    commandAccess: { shouldBlockControlCommand: params.shouldBlockControlCommand ?? false },
    routeAccess: { reason: params.reason },
  };
}

describe("classifyMeshcoreAdmissionDrop", () => {
  it("classifies skip as missing-mention (group and DM)", () => {
    expect(classifyMeshcoreAdmissionDrop({ isGroup: true, access: verdict({ admission: "skip" }) }))
      .toBe("missing-mention");
    expect(classifyMeshcoreAdmissionDrop({ isGroup: false, access: verdict({ admission: "skip" }) }))
      .toBe("missing-mention");
  });

  it("classifies a blocked group control command, ahead of any route reason", () => {
    expect(
      classifyMeshcoreAdmissionDrop({
        isGroup: true,
        access: verdict({
          decisiveGateId: "command",
          shouldBlockControlCommand: true,
          reason: "channel_not_allowlisted",
        }),
      }),
    ).toBe("unauthorized-control-command");
  });

  it("does not classify the command gate without shouldBlockControlCommand", () => {
    expect(
      classifyMeshcoreAdmissionDrop({
        isGroup: true,
        access: verdict({ decisiveGateId: "command", shouldBlockControlCommand: false }),
      }),
    ).toBe("group-sender-policy");
  });

  it("classifies channel_not_allowlisted", () => {
    expect(
      classifyMeshcoreAdmissionDrop({ isGroup: true, access: verdict({ reason: "channel_not_allowlisted" }) }),
    ).toBe("channel-not-allowlisted");
  });

  it("classifies channel_disabled", () => {
    expect(
      classifyMeshcoreAdmissionDrop({ isGroup: true, access: verdict({ reason: "channel_disabled" }) }),
    ).toBe("channel-disabled");
  });

  it("falls back to group-sender-policy for other group drops", () => {
    expect(classifyMeshcoreAdmissionDrop({ isGroup: true, access: verdict({}) })).toBe(
      "group-sender-policy",
    );
  });

  it("classifies every non-skip DM drop as dm-policy, even with group-only signals", () => {
    expect(
      classifyMeshcoreAdmissionDrop({
        isGroup: false,
        access: verdict({
          decisiveGateId: "command",
          shouldBlockControlCommand: true,
          reason: "channel_disabled",
        }),
      }),
    ).toBe("dm-policy");
  });
});
