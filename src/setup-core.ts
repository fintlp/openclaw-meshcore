import type { ChannelSetupAdapter, ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  applyAccountNameToChannelSection,
  createSetupInputPresenceValidator,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicySetter,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import { resolveMeshcoreAccount, resolveMeshcoreAccountKey } from "./accounts.js";
import { resolveMeshcoreEffectiveGroups } from "./policy.js";
import { splitHostPort } from "./setup-detect.js";
import type { CoreConfig, MeshcoreAccountConfig, MeshcoreGroupConfig } from "./types.js";

const channel = "meshcore" as const;
const setMeshcoreTopLevelDmPolicy = createTopLevelChannelDmPolicySetter({ channel });
const setMeshcoreTopLevelAllowFrom = createTopLevelChannelAllowFromSetter({ channel });

type MeshcoreSetupInput = ChannelSetupInput & {
  host?: string;
  port?: number | string;
  dmPolicy?: string;
};

const DM_POLICIES: readonly string[] = ["pairing", "allowlist", "open", "disabled"];

function normalizeDmPolicyInput(raw?: string): DmPolicy | undefined {
  const value = raw?.trim().toLowerCase();
  return value && DM_POLICIES.includes(value) ? (value as DmPolicy) : undefined;
}

export function parsePort(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

export function updateMeshcoreAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<MeshcoreAccountConfig>,
): CoreConfig {
  const normalizedId = normalizeAccountId(accountId);
  // The SDK patch helper writes accounts[<normalized id>] and does not find an
  // account stored under a non-canonical key ("Ops Team"): it would add a
  // second "ops-team" section next to it. Patch the stored section in place.
  const storedKey =
    normalizedId === DEFAULT_ACCOUNT_ID ? undefined : resolveMeshcoreAccountKey(cfg, normalizedId);
  const section = cfg.channels?.meshcore;
  if (storedKey !== undefined && storedKey !== normalizedId && section) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        meshcore: {
          ...section,
          accounts: {
            ...section.accounts,
            [storedKey]: { ...section.accounts?.[storedKey], ...patch },
          },
        },
      },
    } as CoreConfig;
  }
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch,
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  }) as CoreConfig;
}

export function setMeshcoreDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  return setMeshcoreTopLevelDmPolicy(cfg, dmPolicy) as CoreConfig;
}

export function setMeshcoreAllowFrom(cfg: CoreConfig, allowFrom: string[]): CoreConfig {
  return setMeshcoreTopLevelAllowFrom(cfg, allowFrom) as CoreConfig;
}

/**
 * Policy-only group step. Never touches `groups`: the host wizard calls
 * setPolicy("allowlist") and then applyAllowlist(entries), so the policy step
 * must not clear the map before the entries are merged (#94).
 */
export function setMeshcoreGroupPolicy(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
): CoreConfig {
  return updateMeshcoreAccountConfig(cfg, accountId, { enabled: true, groupPolicy: policy });
}

function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/**
 * Merge entered group entries into the existing group objects. Retained keys
 * keep their object (and position) exactly; new keys get {}; removed keys are
 * dropped.
 */
function mergeMeshcoreGroupEntries(
  base: Record<string, MeshcoreGroupConfig>,
  entries: readonly string[],
  normalizeGroupEntry: (raw: string) => string | null,
): Record<string, MeshcoreGroupConfig> {
  const wanted = new Set(entries);
  const merged: Record<string, MeshcoreGroupConfig> = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(base)) {
    // The prefill shows stored keys; entries come back normalized.
    const normalizedKey = normalizeGroupEntry(key) ?? key;
    if (wanted.has(key) || wanted.has(normalizedKey)) {
      merged[key] = value;
      seen.add(key);
      seen.add(normalizedKey);
    }
  }
  for (const entry of entries) {
    if (!seen.has(entry)) {
      merged[entry] = {};
      seen.add(entry);
    }
  }
  return merged;
}

export function setMeshcoreGroupAccess(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
  entries: string[],
  normalizeGroupEntry: (raw: string) => string | null,
): CoreConfig {
  if (policy !== "allowlist") {
    return setMeshcoreGroupPolicy(cfg, accountId, policy);
  }
  const normalizedEntries = [
    ...new Set(
      entries.map((entry) => normalizeGroupEntry(entry)).filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  const account = resolveMeshcoreAccount({ cfg, accountId });
  const storedKey = resolveMeshcoreAccountKey(cfg, accountId);
  const ownGroups =
    normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID
      ? cfg.channels?.meshcore?.groups
      : storedKey === undefined
        ? undefined
        : cfg.channels?.meshcore?.accounts?.[storedKey]?.groups;
  const effectiveKeys = Object.keys(resolveMeshcoreEffectiveGroups({ cfg, account }) ?? {}).map(
    (key) => normalizeGroupEntry(key) ?? key,
  );
  // No own groups and the operator kept what is effectively in force: do not
  // freeze inherited root groups into the account (later root edits must keep
  // applying). Policy/enabled are still applied.
  if (Object.keys(ownGroups ?? {}).length === 0 && sameKeySet(normalizedEntries, effectiveKeys)) {
    return updateMeshcoreAccountConfig(cfg, accountId, { enabled: true, groupPolicy: "allowlist" });
  }
  return updateMeshcoreAccountConfig(cfg, accountId, {
    enabled: true,
    groupPolicy: "allowlist",
    groups: mergeMeshcoreGroupEntries(account.config.groups ?? {}, normalizedEntries, normalizeGroupEntry),
  });
}

export const meshcoreSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name,
    }),
  validateInput: createSetupInputPresenceValidator({
    whenNotUseEnv: [{ someOf: ["host"], message: "MeshCore requires host." }],
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as MeshcoreSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: setupInput.name,
    });
    const portInput =
      typeof setupInput.port === "number" ? String(setupInput.port) : (setupInput.port ?? "");
    const hostParts = setupInput.host?.trim() ? splitHostPort(setupInput.host) : undefined;
    const patch: Partial<MeshcoreAccountConfig> = {
      enabled: true,
      host: hostParts?.host || undefined,
      port: parsePort(portInput, hostParts?.port ?? 5000),
      dmPolicy: normalizeDmPolicyInput(setupInput.dmPolicy),
    };
    return updateMeshcoreAccountConfig(namedConfig as CoreConfig, accountId, patch);
  },
};
