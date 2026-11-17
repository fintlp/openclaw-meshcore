import { describe, expect, it } from "vitest";
import { resolveMeshcoreAccount } from "./accounts.js";
import { resolveMeshcoreEffectiveGroups } from "./policy.js";
import { meshcoreSetupWizard, withDefaultRequireMention } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

// #94: the setup wizard's group-access step used to rewrite the whole groups
// map as { <entry>: {} }, dropping per-group settings and freezing inherited
// root groups. The host flow is setPolicy("allowlist") THEN applyAllowlist.

const groupAccess = meshcoreSetupWizard.groupAccess!;

type Ctx = { cfg: CoreConfig; accountId: string };

/** Mirror of the host: configureChannelAccessWithAllowlist (setPolicy, then apply). */
function confirmAllowlist(
  cfg: CoreConfig,
  accountId: string,
  edit: (current: string[]) => string[] = (current) => current,
): CoreConfig {
  const current = groupAccess.currentEntries({ cfg, accountId } as Ctx as never) as string[];
  const entries = edit(current);
  const afterPolicy = groupAccess.setPolicy({ cfg, accountId, policy: "allowlist" } as never) as CoreConfig;
  return groupAccess.applyAllowlist!({ cfg: afterPolicy, accountId, resolved: entries } as never) as CoreConfig;
}

const RICH = {
  "channel:0": {
    requireMention: false,
    tools: { allow: ["web_search"] },
    allowFrom: ["!aabbccdd1122"],
    systemPrompt: "Be brief.",
    skills: ["weather"],
  },
  "channel:1": { requireMention: true, tools: { deny: ["exec"] } },
};

const ROOT_GROUPS = {
  "channel:2": { requireMention: true, systemPrompt: "Root prompt" },
  "channel:3": { skills: ["weather"] },
};

function rootGroupsConfig(): CoreConfig {
  return {
    channels: {
      meshcore: { host: "192.0.2.10", enabled: true, groupPolicy: "allowlist", groups: structuredClone(RICH) },
    },
  } as CoreConfig;
}

function namedGroupsConfig(accountKey: string): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        accounts: {
          [accountKey]: {
            host: "192.0.2.11",
            enabled: true,
            groupPolicy: "allowlist",
            groups: structuredClone(RICH),
          },
        },
      },
    },
  } as CoreConfig;
}

function inheritingConfig(accountKey: string, ownGroups?: Record<string, unknown>): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        groupPolicy: "allowlist",
        groups: structuredClone(ROOT_GROUPS),
        accounts: {
          [accountKey]: {
            host: "192.0.2.11",
            enabled: true,
            groupPolicy: "allowlist",
            ...(ownGroups ? { groups: ownGroups } : {}),
          },
        },
      },
    },
  } as CoreConfig;
}

describe("#94 unchanged confirm leaves the config byte-identical", () => {
  it("default account (root groups) keeps every per-group setting", () => {
    const cfg = rootGroupsConfig();
    const next = confirmAllowlist(cfg, "default");
    expect(JSON.stringify(next)).toBe(JSON.stringify(cfg));
    expect(next.channels?.meshcore?.groups?.["channel:0"]).toEqual(RICH["channel:0"]);
  });

  it("named account keeps tools / allowFrom / systemPrompt / skills / requireMention", () => {
    const cfg = namedGroupsConfig("ops");
    const next = confirmAllowlist(cfg, "ops");
    expect(JSON.stringify(next)).toBe(JSON.stringify(cfg));
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual(RICH);
  });

  it("is order-independent: re-entered in another order still byte-identical", () => {
    const cfg = namedGroupsConfig("ops");
    const next = confirmAllowlist(cfg, "ops", (current) => [...current].reverse());
    expect(JSON.stringify(next)).toBe(JSON.stringify(cfg));
  });

  it("retains an object stored under a non-normalized key spelling (ch:0)", () => {
    const cfg = namedGroupsConfig("ops");
    const groups = cfg.channels!.meshcore!.accounts!.ops!.groups as Record<string, unknown>;
    groups["ch:5"] = { requireMention: false, systemPrompt: "five" };
    const next = confirmAllowlist(cfg, "ops");
    expect(JSON.stringify(next)).toBe(JSON.stringify(cfg));
    expect(next.channels?.meshcore?.accounts?.ops?.groups?.["ch:5"]).toEqual({
      requireMention: false,
      systemPrompt: "five",
    });
  });
});

describe("#94 an edit merges instead of replacing", () => {
  it("adding one key preserves the settings of the others; the new key gets {}", () => {
    const cfg = namedGroupsConfig("ops");
    const next = confirmAllowlist(cfg, "ops", (current) => [...current, "channel:4"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({ ...RICH, "channel:4": {} });
  });

  it("adding a key by its short spelling normalizes it and keeps the rest", () => {
    const cfg = rootGroupsConfig();
    const next = confirmAllowlist(cfg, "default", (current) => [...current, "ch:6"]);
    expect(next.channels?.meshcore?.groups).toEqual({ ...RICH, "channel:6": {} });
  });

  it("removing a key drops only that key", () => {
    const cfg = namedGroupsConfig("ops");
    const next = confirmAllowlist(cfg, "ops", () => ["channel:1"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({ "channel:1": RICH["channel:1"] });
  });

  it("does not mutate the input config", () => {
    const cfg = namedGroupsConfig("ops");
    const before = JSON.stringify(cfg);
    confirmAllowlist(cfg, "ops", (current) => [...current, "channel:4"]);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

describe("#94 a policy-only step leaves groups alone", () => {
  for (const policy of ["allowlist", "open", "disabled"] as const) {
    it("setPolicy(" + policy + ") does not touch an own groups map", () => {
      const cfg = namedGroupsConfig("ops");
      const next = groupAccess.setPolicy({ cfg, accountId: "ops", policy } as never) as CoreConfig;
      expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual(RICH);
      expect(next.channels?.meshcore?.accounts?.ops?.groupPolicy).toBe(policy);
    });
  }

  it("setPolicy(allowlist) does not write groups:{} on an account without groups", () => {
    const cfg = inheritingConfig("ops");
    const next = groupAccess.setPolicy({ cfg, accountId: "ops", policy: "allowlist" } as never) as CoreConfig;
    expect(next.channels?.meshcore?.accounts?.ops).not.toHaveProperty("groups");
  });

  it("setPolicy(allowlist) does not touch root groups for the default account", () => {
    const cfg = rootGroupsConfig();
    const next = groupAccess.setPolicy({ cfg, accountId: "default", policy: "allowlist" } as never) as CoreConfig;
    expect(next.channels?.meshcore?.groups).toEqual(RICH);
  });
});

describe("#94 inheritance is not frozen into the account", () => {
  it("account without a groups key: unchanged confirm writes no explicit groups", () => {
    const cfg = inheritingConfig("ops");
    const next = confirmAllowlist(cfg, "ops");
    expect(next.channels?.meshcore?.accounts?.ops).not.toHaveProperty("groups");
    expect(next.channels?.meshcore?.groups).toEqual(ROOT_GROUPS);
  });

  it("a later root edit still applies after the unchanged confirm", () => {
    const next = confirmAllowlist(inheritingConfig("ops"), "ops");
    next.channels!.meshcore!.groups = { "channel:7": { requireMention: false } };
    const account = resolveMeshcoreAccount({ cfg: next, accountId: "ops" });
    expect(Object.keys(resolveMeshcoreEffectiveGroups({ cfg: next, account }) ?? {})).toEqual(["channel:7"]);
  });

  it("single account with groups:{} (host inherits root): unchanged confirm keeps {} and root alone", () => {
    const cfg = inheritingConfig("ops", {});
    const confirmed = groupAccess.applyAllowlist!({
      cfg: groupAccess.setPolicy({ cfg, accountId: "ops", policy: "allowlist" } as never),
      accountId: "ops",
      resolved: ["channel:2", "channel:3"],
    } as never) as CoreConfig;
    expect(confirmed.channels?.meshcore?.accounts?.ops?.groups).toEqual({});
    expect(confirmed.channels?.meshcore?.groups).toEqual(ROOT_GROUPS);
  });

  it("still applies groupPolicy/enabled when it skips the groups write", () => {
    const cfg = inheritingConfig("ops");
    const ops = cfg.channels!.meshcore!.accounts!.ops!;
    ops.groupPolicy = "open";
    ops.enabled = false;
    const next = confirmAllowlist(cfg, "ops");
    expect(next.channels?.meshcore?.accounts?.ops?.groupPolicy).toBe("allowlist");
    expect(next.channels?.meshcore?.accounts?.ops?.enabled).toBe(true);
    expect(next.channels?.meshcore?.accounts?.ops).not.toHaveProperty("groups");
  });

  it("deliberately editing an inherited list creates an explicit override that keeps root settings of retained keys", () => {
    const cfg = inheritingConfig("ops");
    const next = confirmAllowlist(cfg, "ops", (current) => [...current, "channel:4"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({ ...ROOT_GROUPS, "channel:4": {} });
    expect(next.channels?.meshcore?.groups).toEqual(ROOT_GROUPS);
  });

  it("entries entered on an empty own map (no inheritance to keep) are written as {}", () => {
    const cfg = namedGroupsConfig("ops");
    cfg.channels!.meshcore!.accounts!.ops!.groups = undefined;
    const next = confirmAllowlist(cfg, "ops", () => ["channel:4"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({ "channel:4": {} });
  });
});

describe("#94 same cases under a non-canonical account key (Ops Team)", () => {
  const KEY = "Ops Team";
  const ID = "ops-team";

  it("unchanged confirm is byte-identical and creates no duplicate account", () => {
    const cfg = namedGroupsConfig(KEY);
    const next = confirmAllowlist(cfg, ID);
    expect(JSON.stringify(next)).toBe(JSON.stringify(cfg));
    expect(Object.keys(next.channels?.meshcore?.accounts ?? {})).toEqual([KEY]);
  });

  it("adding one key preserves the others, in place under the stored key", () => {
    const next = confirmAllowlist(namedGroupsConfig(KEY), ID, (current) => [...current, "channel:4"]);
    expect(Object.keys(next.channels?.meshcore?.accounts ?? {})).toEqual([KEY]);
    expect(next.channels?.meshcore?.accounts?.[KEY]?.groups).toEqual({ ...RICH, "channel:4": {} });
  });

  it("account without own groups: unchanged confirm writes no groups, no duplicate account", () => {
    const next = confirmAllowlist(inheritingConfig(KEY), ID);
    expect(Object.keys(next.channels?.meshcore?.accounts ?? {})).toEqual([KEY]);
    expect(next.channels?.meshcore?.accounts?.[KEY]).not.toHaveProperty("groups");
    expect(next.channels?.meshcore?.groups).toEqual(ROOT_GROUPS);
  });

  it("policy-only step patches the stored section and leaves groups alone", () => {
    const cfg = namedGroupsConfig(KEY);
    const next = groupAccess.setPolicy({ cfg, accountId: ID, policy: "disabled" } as never) as CoreConfig;
    expect(Object.keys(next.channels?.meshcore?.accounts ?? {})).toEqual([KEY]);
    expect(next.channels?.meshcore?.accounts?.[KEY]?.groups).toEqual(RICH);
    expect(next.channels?.meshcore?.accounts?.[KEY]?.groupPolicy).toBe("disabled");
  });
});

describe("#94 default requireMention under a non-canonical key", () => {
  it("fills requireMention on new group entries of an account stored as Ops Team", () => {
    const cfg = {
      channels: {
        meshcore: {
          host: "192.0.2.10",
          accounts: { "Ops Team": { host: "192.0.2.11", groups: { "channel:4": {}, "channel:5": { requireMention: false } } } },
        },
      },
    } as CoreConfig;
    const next = withDefaultRequireMention(cfg, "ops-team");
    expect(Object.keys(next.channels?.meshcore?.accounts ?? {})).toEqual(["Ops Team"]);
    expect(next.channels?.meshcore?.accounts?.["Ops Team"]?.groups).toEqual({
      "channel:4": { requireMention: true },
      "channel:5": { requireMention: false },
    });
  });

  it("is unchanged for canonical keys and the default account", () => {
    const named = {
      channels: { meshcore: { host: "h", accounts: { ops: { host: "x", groups: { "channel:4": {} } } } } },
    } as CoreConfig;
    expect(withDefaultRequireMention(named, "ops").channels?.meshcore?.accounts?.ops?.groups).toEqual({
      "channel:4": { requireMention: true },
    });
    const root = { channels: { meshcore: { host: "h", groups: { "channel:4": {} } } } } as CoreConfig;
    expect(withDefaultRequireMention(root, "default").channels?.meshcore?.groups).toEqual({
      "channel:4": { requireMention: true },
    });
  });
});

