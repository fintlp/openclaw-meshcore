import type { ChannelSetupAdapter, ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  applyAccountNameToChannelSection,
  createSetupInputPresenceValidator,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicySetter,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import type { CoreConfig, MeshcoreAccountConfig } from "./types.js";

const channel = "meshcore" as const;
const setMeshcoreTopLevelDmPolicy = createTopLevelChannelDmPolicySetter({ channel });
const setMeshcoreTopLevelAllowFrom = createTopLevelChannelAllowFromSetter({ channel });

type MeshcoreSetupInput = ChannelSetupInput & {
  host?: string;
  port?: number | string;
};

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

export function setMeshcoreGroupAccess(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
  entries: string[],
  normalizeGroupEntry: (raw: string) => string | null,
): CoreConfig {
  if (policy !== "allowlist") {
    return updateMeshcoreAccountConfig(cfg, accountId, { enabled: true, groupPolicy: policy });
  }
  const normalizedEntries = [
    ...new Set(entries.map((entry) => normalizeGroupEntry(entry)).filter(Boolean)),
  ];
  const groups = Object.fromEntries(normalizedEntries.map((entry) => [entry, {}]));
  return updateMeshcoreAccountConfig(cfg, accountId, {
    enabled: true,
    groupPolicy: "allowlist",
    groups,
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
    const patch: Partial<MeshcoreAccountConfig> = {
      enabled: true,
      host: setupInput.host?.trim(),
      port: portInput ? parsePort(portInput, 5000) : undefined,
    };
    return updateMeshcoreAccountConfig(namedConfig as CoreConfig, accountId, patch);
  },
};
