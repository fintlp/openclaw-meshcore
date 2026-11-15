import type { GroupToolPolicyConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMeshcoreAccount } from "./accounts.js";
import type { CoreConfig, MeshcoreGroupConfig } from "./types.js";

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
 * Resolve only group-wide tools. MeshCore group frames do not identify their
 * radio authors, so sender-scoped policy is neither meaningful nor supported.
 * A supplied group id always gets an account-owned policy: neutral when no
 * exact/wildcard tools apply, preventing generic host fallback into another
 * account's group map.
 */
export function resolveMeshcoreGroupToolPolicy(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  target?: string | null;
}): GroupToolPolicyConfig | undefined {
  if (!params.target?.trim()) {
    return undefined;
  }
  const account = resolveMeshcoreAccount({ cfg: params.cfg, accountId: params.accountId });
  const match = resolveMeshcoreGroupMatch({
    groups: account.config.groups,
    target: params.target,
  });
  return match.groupConfig?.tools ?? match.wildcardConfig?.tools ?? { deny: [] };
}
