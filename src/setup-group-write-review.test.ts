import { describe, expect, it } from "vitest";
import { meshcoreSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

// #94 review round: the skip-write ("do not freeze inheritance") must fire only
// when something is actually inherited AND the typed entries equal the
// effective inherited keys as a set (order-insensitive, no subset, no superset).

const groupAccess = meshcoreSetupWizard.groupAccess!;

/** Host flow with explicitly typed entries: setPolicy("allowlist") then applyAllowlist. */
function applyEntries(cfg: CoreConfig, accountId: string, entries: string[]): CoreConfig {
  const afterPolicy = groupAccess.setPolicy({ cfg, accountId, policy: "allowlist" } as never) as CoreConfig;
  return groupAccess.applyAllowlist!({ cfg: afterPolicy, accountId, resolved: entries } as never) as CoreConfig;
}

const ROOT_GROUPS = {
  "channel:2": { requireMention: true, systemPrompt: "Root prompt" },
  "channel:3": { skills: ["weather"] },
};

/** Single named account with its own explicit groups:{} (host inherits root). */
function inheritingEmpty(): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        groupPolicy: "allowlist",
        groups: structuredClone(ROOT_GROUPS),
        accounts: { ops: { host: "192.0.2.11", enabled: true, groupPolicy: "allowlist", groups: {} } },
      },
    },
  } as CoreConfig;
}

/** Single named account without a groups key (plain root merge). */
function inheritingNoKey(): CoreConfig {
  const cfg = inheritingEmpty();
  delete (cfg.channels!.meshcore!.accounts!.ops as { groups?: unknown }).groups;
  return cfg;
}

describe("#94 review: empty list on an account that inherits nothing writes groups:{}", () => {
  it("multi-account, no root groups: an empty allowlist writes groups:{} (allow nothing)", () => {
    const cfg = {
      channels: {
        meshcore: {
          host: "192.0.2.10",
          accounts: { ops: { host: "192.0.2.11" }, lab: { host: "192.0.2.12" } },
        },
      },
    } as CoreConfig;
    const next = applyEntries(cfg, "lab", []);
    expect(next.channels?.meshcore?.accounts?.lab?.groups).toEqual({});
    expect(next.channels?.meshcore?.accounts?.lab?.groupPolicy).toBe("allowlist");
    expect(next.channels?.meshcore?.accounts?.ops).not.toHaveProperty("groups");
  });

  it("a brand-new account id in a multi-account config also gets groups:{}", () => {
    const cfg = {
      channels: {
        meshcore: { host: "192.0.2.10", accounts: { ops: { host: "192.0.2.11" }, lab: { host: "192.0.2.12" } } },
      },
    } as CoreConfig;
    const next = applyEntries(cfg, "fresh", []);
    expect(next.channels?.meshcore?.accounts?.fresh?.groups).toEqual({});
  });

  it("multi-account with root groups: an empty list still writes groups:{} (nothing is effectively inherited)", () => {
    const cfg = {
      channels: {
        meshcore: {
          host: "192.0.2.10",
          groups: structuredClone(ROOT_GROUPS),
          accounts: { ops: { host: "192.0.2.11", groups: {} }, lab: { host: "192.0.2.12", groups: {} } },
        },
      },
    } as CoreConfig;
    const next = applyEntries(cfg, "lab", []);
    expect(next.channels?.meshcore?.accounts?.lab?.groups).toEqual({});
  });

  it("default account without any groups: an empty list writes groups:{}", () => {
    const cfg = { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig;
    const next = applyEntries(cfg, "default", []);
    expect(next.channels?.meshcore?.groups).toEqual({});
  });

  it("a later root edit does not silently admit root groups for that allow-nothing account", () => {
    const cfg = {
      channels: {
        meshcore: { host: "192.0.2.10", accounts: { ops: { host: "192.0.2.11" }, lab: { host: "192.0.2.12" } } },
      },
    } as CoreConfig;
    const next = applyEntries(cfg, "lab", []);
    next.channels!.meshcore!.groups = structuredClone(ROOT_GROUPS);
    // multi-account: the explicit empty map blocks root groups
    expect(next.channels?.meshcore?.accounts?.lab?.groups).toEqual({});
  });
});

describe("#94 review: the skip is a set comparison against the inherited keys", () => {
  it("reordered entries equal to the inherited set still skip (groups:{} account)", () => {
    const next = applyEntries(inheritingEmpty(), "ops", ["channel:3", "channel:2"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({});
    expect(next.channels?.meshcore?.groups).toEqual(ROOT_GROUPS);
  });

  it("reordered entries equal to the inherited set still skip (no-groups-key account)", () => {
    const next = applyEntries(inheritingNoKey(), "ops", ["channel:3", "channel:2"]);
    expect(next.channels?.meshcore?.accounts?.ops).not.toHaveProperty("groups");
  });

  it("a different spelling of the same inherited keys (ch:3, channel:2) still skips", () => {
    const next = applyEntries(inheritingNoKey(), "ops", ["ch:3", "channel:2"]);
    expect(next.channels?.meshcore?.accounts?.ops).not.toHaveProperty("groups");
  });

  it("a strict subset of the inherited keys does NOT skip: it writes an explicit override", () => {
    const next = applyEntries(inheritingEmpty(), "ops", ["channel:2"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({ "channel:2": {} });
    expect(next.channels?.meshcore?.groups).toEqual(ROOT_GROUPS);
  });

  it("a strict subset on a no-groups-key account writes an override that keeps the root settings of the retained key", () => {
    const next = applyEntries(inheritingNoKey(), "ops", ["channel:2"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({ "channel:2": ROOT_GROUPS["channel:2"] });
  });

  it("a superset of the inherited keys does NOT skip: it writes an explicit override", () => {
    const next = applyEntries(inheritingEmpty(), "ops", ["channel:2", "channel:3", "channel:4"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({
      "channel:2": {},
      "channel:3": {},
      "channel:4": {},
    });
  });

  it("a disjoint set does NOT skip", () => {
    const next = applyEntries(inheritingEmpty(), "ops", ["channel:6"]);
    expect(next.channels?.meshcore?.accounts?.ops?.groups).toEqual({ "channel:6": {} });
  });
});

