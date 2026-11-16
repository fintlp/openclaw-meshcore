import {
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { GroupToolPolicyConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMeshcoreAccount, type ResolvedMeshcoreAccount } from "./accounts.js";
import type { CoreConfig, MeshcoreAccountConfig, MeshcoreGroupConfig } from "./types.js";

export type MeshcoreGroupMatch = {
  allowed: boolean;
  groupConfig?: MeshcoreGroupConfig;
  wildcardConfig?: MeshcoreGroupConfig;
  hasConfiguredGroups: boolean;
};

export function resolveMeshcoreGroupMatch(params: {
  groups?: Record<string, MeshcoreGroupConfig>;
  target: string;
}): MeshcoreGroupMatch {
  const groups = params.groups ?? {};
  const hasConfiguredGroups = Object.keys(groups).length > 0;
  const direct = groups[params.target];
  if (direct) {
    return {
      allowed: true,
      groupConfig: direct,
      wildcardConfig: groups["*"],
      hasConfiguredGroups,
    };
  }

  const targetLower = params.target.toLowerCase();
  const directKey = Object.keys(groups).find((key) => key.toLowerCase() === targetLower);
  if (directKey) {
    const matched = groups[directKey];
    if (matched) {
      return {
        allowed: true,
        groupConfig: matched,
        wildcardConfig: groups["*"],
        hasConfiguredGroups,
      };
    }
  }

  const wildcard = groups["*"];
  if (wildcard) {
    return {
      allowed: true,
      wildcardConfig: wildcard,
      hasConfiguredGroups,
    };
  }

  return {
    allowed: false,
    hasConfiguredGroups,
  };
}

export function resolveMeshcoreRequireMention(params: {
  groupConfig?: MeshcoreGroupConfig;
  wildcardConfig?: MeshcoreGroupConfig;
}): boolean {
  if (params.groupConfig?.requireMention !== undefined) {
    return params.groupConfig.requireMention;
  }
  if (params.wildcardConfig?.requireMention !== undefined) {
    return params.wildcardConfig.requireMention;
  }
  return false;
}

/** True only when the exact-or-wildcard group has an authored tool policy. */
export function hasMeshcoreGroupToolPolicy(
  match: Pick<MeshcoreGroupMatch, "groupConfig" | "wildcardConfig">,
): boolean {
  return match.groupConfig?.tools !== undefined || match.wildcardConfig?.tools !== undefined;
}

/**
 * The group map an account effectively uses, applying the host's empty-map
 * inheritance: a single named account with an explicit `groups: {}` inherits
 * root `channels.meshcore.groups` (host `inheritEmptyKeys`). Introduced for
 * tool policy in #76 and shared by every group lookup (#77): admission and
 * mention, requireMention, systemPrompt and skills.
 *
 * The captured account is authoritative for this dispatch. The host merge
 * only fills an empty captured map (notably groups:{} inheriting root); in
 * normal adapter resolution both come from the same config and agree.
 */
export function resolveMeshcoreEffectiveGroups(params: {
  cfg: CoreConfig;
  account: ResolvedMeshcoreAccount;
}): Record<string, MeshcoreGroupConfig> | undefined {
  const { account } = params;
  const channelConfig = params.cfg.channels?.meshcore;
  const hostGroups = channelConfig
    ? resolveMergedAccountConfig<MeshcoreAccountConfig>({
        channelConfig,
        channelId: "meshcore",
        accounts: channelConfig.accounts as
          | Record<string, Partial<MeshcoreAccountConfig>>
          | undefined,
        accountId: normalizeAccountId(account.accountId),
        // Same key matching as accounts.ts: without it the SDK falls back to
        // lowercase-only key lookup, misses non-canonical keys ("ops.team",
        // "Ops Team") and returns the bare root config, root groups included.
        normalizeAccountId,
        inheritEmptyKeys:
          Object.keys(channelConfig.accounts ?? {}).length > 1 ? {} : { groups: "object" },
      }).groups
    : undefined;
  return Object.keys(account.config.groups ?? {}).length > 0
    ? account.config.groups
    : hostGroups;
}

/** resolveMeshcoreGroupMatch over the host-aware effective group map. */
export function resolveMeshcoreEffectiveGroupMatch(params: {
  cfg: CoreConfig;
  account: ResolvedMeshcoreAccount;
  target: string;
}): MeshcoreGroupMatch {
  return resolveMeshcoreGroupMatch({
    groups: resolveMeshcoreEffectiveGroups({ cfg: params.cfg, account: params.account }),
    target: params.target,
  });
}

type ResolveMeshcoreGroupToolPolicyParams = {
  cfg: CoreConfig;
  accountId?: string | null;
  target: string;
  /** Use the inbound-captured account instead of re-resolving a potentially newer config. */
  account?: ResolvedMeshcoreAccount;
};

export type MeshcoreGroupToolPolicyResolution = {
  match: MeshcoreGroupMatch;
  policy: GroupToolPolicyConfig | undefined;
};

/** Resolve the group map with the host fallback's empty-map inheritance rules. */
export function resolveMeshcoreGroupToolPolicyResolution(
  params: ResolveMeshcoreGroupToolPolicyParams,
): MeshcoreGroupToolPolicyResolution {
  const account =
    params.account ?? resolveMeshcoreAccount({ cfg: params.cfg, accountId: params.accountId });
  const match = resolveMeshcoreEffectiveGroupMatch({
    cfg: params.cfg,
    account,
    target: params.target,
  });
  const authoredPolicy = match.groupConfig?.tools ?? match.wildcardConfig?.tools;

  return {
    match,
    // A single named account's explicit groups:{} inherits root groups in the
    // host. Return that inherited policy directly: it is this same account's
    // map (no cross-account risk — the host fallback resolves the same
    // accountId, group-policy-*.mjs:255-269), and deferring would lose it
    // when the authored key's case differs from the wire target: this
    // resolver matches case-insensitively while the host fallback is
    // case-sensitive (group-policy-*.mjs:187-196, reached from
    // agent-tools.policy-*.mjs:420-428).
    policy: authoredPolicy ?? { deny: [] },
  };
}

/**
 * Resolve only group-wide tools. MeshCore group frames do not identify their
 * radio authors, so sender-scoped policy is neither meaningful nor supported.
 * Exact/wildcard tools win. With no matching tools, return an explicit neutral
 * policy. The host fallback resolves this same accountId, never another
 * account's group map; neutrality is therefore not a cross-account safeguard.
 */
export function resolveMeshcoreGroupToolPolicy(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  target?: string | null;
  account?: ResolvedMeshcoreAccount;
}): GroupToolPolicyConfig | undefined {
  if (!params.target?.trim()) {
    return undefined;
  }
  return resolveMeshcoreGroupToolPolicyResolution({
    ...params,
    target: params.target,
  }).policy;
}
