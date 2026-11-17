import { describe, expect, it } from "vitest";
import { resolveMeshcoreAccount } from "./accounts.js";
import { meshcorePlugin } from "./channel.js";
import {
  resolveMeshcoreEffectiveGroupMatch,
  resolveMeshcoreGroupToolPolicyResolution,
} from "./policy.js";
import { meshcoreSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

// NOTE: configured mesh channel indices (account.config.channels) are not part
// of these expectations: the pre-existing group lister spreads them as bare
// strings into the sources array, where each string is iterated per character
// and never normalizes to a target. Separate, pre-existing, untouched here.

// #90: directory listers must show the groups an account EFFECTIVELY uses (the
// same host-aware map as admission/mention/tool policy), including the empty-map
// inheritance of a single named account. Setup prefill stays own-map only.

const PEER = "!aabbccdd1122";
const ROOT_GROUPS = {
  "channel:2": { requireMention: true, allowFrom: [PEER], tools: { deny: ["root-tool"] } },
  "channel:3": { systemPrompt: "Root prompt" },
};

type DirParams = { cfg: CoreConfig; accountId?: string; query?: string | null; limit?: number | null };

async function listGroups(cfg: CoreConfig, accountId: string): Promise<string[]> {
  const entries = await meshcorePlugin.directory!.listGroups!({ cfg, accountId } as DirParams as never);
  return entries.map((entry) => entry.id).sort();
}

async function listPeers(cfg: CoreConfig, accountId: string): Promise<string[]> {
  const entries = await meshcorePlugin.directory!.listPeers!({ cfg, accountId } as DirParams as never);
  return entries.map((entry) => entry.id).sort();
}

function single(key: string, ownGroups?: Record<string, unknown>): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        groupPolicy: "allowlist",
        groups: ROOT_GROUPS,
        accounts: { [key]: { host: "192.0.2.11", ...(ownGroups ? { groups: ownGroups } : {}) } },
      },
    },
  } as unknown as CoreConfig;
}

function multi(key: string): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        groupPolicy: "allowlist",
        groups: ROOT_GROUPS,
        accounts: { [key]: { host: "192.0.2.11", groups: {} }, lab: { host: "192.0.2.12" } },
      },
    },
  } as unknown as CoreConfig;
}

describe("#90 directory shows effective groups", () => {
  it.each(["ops", "Ops Team"])(
    "single named account %j with groups:{} lists the inherited root groups and their allowFrom peers",
    async (key) => {
      const cfg = single(key, {});
      const id = key === "ops" ? "ops" : "ops-team";
      // precondition: the account's own map is empty
      expect(resolveMeshcoreAccount({ cfg, accountId: id }).config.groups).toEqual({});
      expect(await listGroups(cfg, id)).toEqual(["channel:2", "channel:3"]);
      expect(await listPeers(cfg, id)).toContain(PEER);
    },
  );

  it.each(["ops", "Ops Team"])(
    "multi-account %j with groups:{} lists no inherited groups or peers",
    async (key) => {
      const cfg = multi(key);
      const id = key === "ops" ? "ops" : "ops-team";
      expect(await listGroups(cfg, id)).toEqual([]);
      expect(await listPeers(cfg, id)).not.toContain(PEER);
    },
  );

  it.each(["ops", "Ops Team"])(
    "non-empty own groups win over root groups (key %j)",
    async (key) => {
      const own = { "channel:5": { allowFrom: ["!112233445566"] } };
      const cfg = single(key, own);
      const id = key === "ops" ? "ops" : "ops-team";
      expect(await listGroups(cfg, id)).toEqual(["channel:5"]);
      const peers = await listPeers(cfg, id);
      expect(peers).toContain("!112233445566");
      expect(peers).not.toContain(PEER);
    },
  );

  it("a single named account WITHOUT a groups key still lists the merged root groups (as before)", async () => {
    const cfg = single("ops");
    expect(await listGroups(cfg, "ops")).toEqual(["channel:2", "channel:3"]);
    expect(await listPeers(cfg, "ops")).toContain(PEER);
  });

  it("the default account lists its own root groups (as before)", async () => {
    const cfg = { channels: { meshcore: { host: "192.0.2.10", groups: ROOT_GROUPS } } } as unknown as CoreConfig;
    expect(await listGroups(cfg, "default")).toEqual(["channel:2", "channel:3"]);
    expect(await listPeers(cfg, "default")).toContain(PEER);
  });

  it("query and limit still apply to the effective list", async () => {
    const cfg = single("ops", {});
    const entries = await meshcorePlugin.directory!.listGroups!({
      cfg,
      accountId: "ops",
      query: "channel:2",
      limit: 5,
    } as never);
    expect(entries.map((entry) => entry.id)).toEqual(["channel:2"]);
  });
});

describe("#90 setup prefill stays own-map only", () => {
  const currentEntries = (cfg: CoreConfig, accountId: string) =>
    meshcoreSetupWizard.groupAccess!.currentEntries({ cfg, accountId } as never);

  it("single account with groups:{} prefills nothing even though root groups are effective", () => {
    expect(currentEntries(single("ops", {}), "ops")).toEqual([]);
  });

  it("explicit own groups prefill exactly those keys", () => {
    expect(currentEntries(single("ops", { "channel:5": {} }), "ops")).toEqual(["channel:5"]);
  });

  it("multi-account groups:{} prefills nothing", () => {
    expect(currentEntries(multi("ops"), "ops")).toEqual([]);
  });
});

describe("#90 admission, mention and tool policy are unchanged by the directory change", () => {
  it("effective match, requireMention and tool policy resolve exactly as before", async () => {
    const cfg = single("ops", {});
    const before = JSON.stringify(cfg);
    const account = resolveMeshcoreAccount({ cfg, accountId: "ops" });
    // listing must not mutate or influence anything
    await listGroups(cfg, "ops");
    await listPeers(cfg, "ops");
    expect(JSON.stringify(cfg)).toBe(before);
    const match = resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:2" });
    expect(match.allowed).toBe(true);
    expect(match.groupConfig?.requireMention).toBe(true);
    expect(JSON.stringify(resolveMeshcoreGroupToolPolicyResolution({ cfg, account, target: "channel:2" }).policy)).toContain(
      "root-tool",
    );
    // a group that is listed nowhere stays denied
    expect(resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:7" }).allowed).toBe(false);
  });

  it("multi-account admission stays closed regardless of the directory", async () => {
    const cfg = multi("ops");
    const account = resolveMeshcoreAccount({ cfg, accountId: "ops" });
    await listGroups(cfg, "ops");
    expect(resolveMeshcoreEffectiveGroupMatch({ cfg, account, target: "channel:2" }).allowed).toBe(false);
  });
});

