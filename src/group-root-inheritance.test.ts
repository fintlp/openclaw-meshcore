import { describe, expect, it } from "vitest";
import { resolveMeshcoreAccount } from "./accounts.js";
import { meshcorePlugin } from "./channel.js";
import {
  resolveMeshcoreEffectiveGroupMatch,
  resolveMeshcoreEffectiveGroups,
  resolveMeshcoreGroupMatch,
  resolveMeshcoreGroupToolPolicyResolution,
} from "./policy.js";
import type { CoreConfig } from "./types.js";

// Issue #77: a single named account with an explicit groups:{} inherits root
// channels.meshcore.groups (host inheritEmptyKeys). Admission/mention,
// requireMention, systemPrompt and skills must see that map, exactly like
// tool policy (#76). Every other config shape must resolve as before.

const ROOT_GROUPS = {
  "channel:0": { requireMention: true, systemPrompt: "Root prompt", skills: ["weather"] },
};

function inheritingConfig(): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        groupPolicy: "allowlist",
        groups: ROOT_GROUPS,
        accounts: { ops: { host: "192.0.2.11", groups: {} } },
      },
    },
  } as CoreConfig;
}

function multiAccountConfig(): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        groupPolicy: "allowlist",
        groups: ROOT_GROUPS,
        accounts: {
          ops: { host: "192.0.2.11", groups: {} },
          lab: { host: "192.0.2.12" },
        },
      },
    },
  } as CoreConfig;
}

function explicitGroupsConfig(): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        groupPolicy: "allowlist",
        groups: ROOT_GROUPS,
        accounts: {
          ops: { host: "192.0.2.11", groups: { "channel:1": { requireMention: false } } },
        },
      },
    },
  } as CoreConfig;
}

function requireMention(cfg: CoreConfig, accountId: string, groupId: string): unknown {
  const resolver = meshcorePlugin.groups?.resolveRequireMention as unknown as (params: {
    cfg: CoreConfig;
    accountId?: string | null;
    groupId?: string | null;
  }) => unknown;
  return resolver({ cfg, accountId, groupId });
}

describe("#77 single named account with groups:{} inherits root groups", () => {
  it("the account's own map is empty (precondition of the bug)", () => {
    const account = resolveMeshcoreAccount({ cfg: inheritingConfig(), accountId: "ops" });
    expect(account.config.groups).toEqual({});
  });

  it("effective group match resolves the inherited root channel", () => {
    const cfg = inheritingConfig();
    const account = resolveMeshcoreAccount({ cfg, accountId: "ops" });
    const match = resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:0" });
    expect(match.allowed).toBe(true);
    expect(match.hasConfiguredGroups).toBe(true);
    expect(match.groupConfig?.requireMention).toBe(true);
    expect(match.groupConfig?.systemPrompt).toBe("Root prompt");
    expect(match.groupConfig?.skills).toEqual(["weather"]);
  });

  it("channel adapter resolveRequireMention honors the inherited root group", () => {
    expect(requireMention(inheritingConfig(), "ops", "channel:0")).toBe(true);
  });
});

describe("#77 negative controls: no inheritance leakage", () => {
  it("multi-account: an empty account map stays empty", () => {
    const cfg = multiAccountConfig();
    const account = resolveMeshcoreAccount({ cfg, accountId: "ops" });
    expect(resolveMeshcoreEffectiveGroups({ cfg, account })).toEqual({});
    const match = resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:0" });
    expect(match).toEqual(resolveMeshcoreGroupMatch({ groups: account.config.groups, target: "channel:0" }));
    expect(match.allowed).toBe(false);
    expect(match.hasConfiguredGroups).toBe(false);
    expect(requireMention(cfg, "ops", "channel:0")).toBe(false);
  });

  it("explicit non-empty account groups win over root groups", () => {
    const cfg = explicitGroupsConfig();
    const account = resolveMeshcoreAccount({ cfg, accountId: "ops" });
    expect(resolveMeshcoreEffectiveGroups({ cfg, account })).toBe(account.config.groups);
    expect(resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:0" }).allowed).toBe(false);
    expect(requireMention(cfg, "ops", "channel:0")).toBe(false);
    expect(requireMention(cfg, "ops", "channel:1")).toBe(false);
  });

  it("a single named account WITHOUT a groups key keeps its ordinary root merge", () => {
    const cfg = {
      channels: {
        meshcore: {
          host: "192.0.2.10",
          groups: ROOT_GROUPS,
          accounts: { ops: { host: "192.0.2.11" } },
        },
      },
    } as CoreConfig;
    const account = resolveMeshcoreAccount({ cfg, accountId: "ops" });
    expect(resolveMeshcoreEffectiveGroups({ cfg, account })).toBe(account.config.groups);
    expect(requireMention(cfg, "ops", "channel:0")).toBe(true);
  });

  it("the default account (no accounts map) resolves root groups as before", () => {
    const cfg = {
      channels: { meshcore: { host: "192.0.2.10", groups: ROOT_GROUPS } },
    } as CoreConfig;
    const account = resolveMeshcoreAccount({ cfg });
    expect(resolveMeshcoreEffectiveGroups({ cfg, account })).toBe(account.config.groups);
    expect(requireMention(cfg, "default", "channel:0")).toBe(true);
    expect(requireMention(cfg, "default", "channel:9")).toBe(false);
  });

  it("an empty root map with an empty single account still resolves nothing", () => {
    const cfg = {
      channels: {
        meshcore: { host: "192.0.2.10", groups: {}, accounts: { ops: { host: "192.0.2.11", groups: {} } } },
      },
    } as CoreConfig;
    const account = resolveMeshcoreAccount({ cfg, accountId: "ops" });
    const match = resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:0" });
    expect(match.allowed).toBe(false);
    expect(match.hasConfiguredGroups).toBe(false);
    expect(requireMention(cfg, "ops", "channel:0")).toBe(false);
  });
});


// #77 review (PR #89) finding 1: non-canonical account keys must be matched
// with normalizeAccountId in the host merge. Before the fix the SDK fell back
// to lowercase-only lookup, missed "ops.team" / "Ops Team" and returned the
// bare root config, leaking root groups (and root tool policy, #76) into a
// multi-account setup. Finding 2: a literal accounts.default key is a named
// account for host counting, so a lone default with groups:{} inherits.
describe("#77 review: account-key normalization and accounts.default", () => {
  const ROOT_WITH_TOOLS = {
    "channel:0": { requireMention: true, tools: { deny: ["root-tool"] } },
  };

  function multi(key: string): CoreConfig {
    return {
      channels: {
        meshcore: {
          host: "192.0.2.10",
          groupPolicy: "allowlist",
          groups: ROOT_WITH_TOOLS,
          accounts: { [key]: { host: "192.0.2.11", groups: {} }, lab: { host: "192.0.2.12" } },
        },
      },
    } as unknown as CoreConfig;
  }

  it.each(["ops.team", "Ops Team"])(
    "multi-account key %j with groups:{} does NOT inherit root groups",
    (key) => {
      const cfg = multi(key);
      const account = resolveMeshcoreAccount({ cfg, accountId: key });
      expect(account.accountId).toBe("ops-team");
      expect(account.config.groups).toEqual({});
      expect(resolveMeshcoreEffectiveGroups({ cfg, account })).toEqual({});
      const match = resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:0" });
      expect(match.allowed).toBe(false);
      expect(match.hasConfiguredGroups).toBe(false);
      expect(requireMention(cfg, key, "channel:0")).toBe(false);
    },
  );

  it.each(["ops.team", "Ops Team"])(
    "multi-account key %j does NOT receive the root group tool policy (#76 surface)",
    (key) => {
      const cfg = multi(key);
      const account = resolveMeshcoreAccount({ cfg, accountId: key });
      const resolution = resolveMeshcoreGroupToolPolicyResolution({
        cfg,
        account,
        target: "channel:0",
      });
      expect(JSON.stringify(resolution.policy ?? null)).not.toContain("root-tool");
    },
  );

  it("a canonical multi-account key still does not inherit (control)", () => {
    const cfg = multi("ops");
    const account = resolveMeshcoreAccount({ cfg, accountId: "ops" });
    expect(resolveMeshcoreEffectiveGroups({ cfg, account })).toEqual({});
  });

  it("a lone accounts.default with groups:{} DOES inherit (intended, host counting)", () => {
    const cfg = {
      channels: {
        meshcore: {
          host: "192.0.2.10",
          groupPolicy: "allowlist",
          groups: ROOT_WITH_TOOLS,
          accounts: { default: { host: "192.0.2.11", groups: {} } },
        },
      },
    } as unknown as CoreConfig;
    const account = resolveMeshcoreAccount({ cfg, accountId: "default" });
    expect(account.config.groups).toEqual({});
    const match = resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:0" });
    expect(match.allowed).toBe(true);
    expect(requireMention(cfg, "default", "channel:0")).toBe(true);
    const resolution = resolveMeshcoreGroupToolPolicyResolution({ cfg, account, target: "channel:0" });
    expect(JSON.stringify(resolution.policy ?? null)).toContain("root-tool");
  });
});
