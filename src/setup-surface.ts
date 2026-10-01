import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createSetupTranslator,
  createStandardChannelSetupStatus,
  formatDocsLink,
  mergeAllowFromEntries,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultMeshcoreAccountId, resolveMeshcoreAccount } from "./accounts.js";
import {
  formatMeshcoreChannelTarget,
  normalizeMeshcoreAllowEntry,
  normalizeMeshcoreMessagingTarget,
} from "./normalize.js";
import { formatMeshcoreEndpoint } from "./transport.js";
import {
  meshcoreSetupAdapter,
  parsePort,
  setMeshcoreGroupAccess,
  updateMeshcoreAccountConfig,
} from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const t = createSetupTranslator();
const channel = "meshcore" as const;

function normalizeGroupEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return normalizeMeshcoreMessagingTarget(trimmed) ?? trimmed;
}

function resolveMeshcoreConfigKeys(accountId?: string): { policyKey: string; allowFromKey: string } {
  if (accountId && accountId !== DEFAULT_ACCOUNT_ID) {
    return {
      policyKey: `channels.meshcore.accounts.${accountId}.dmPolicy`,
      allowFromKey: `channels.meshcore.accounts.${accountId}.allowFrom`,
    };
  }
  return {
    policyKey: "channels.meshcore.dmPolicy",
    allowFromKey: "channels.meshcore.allowFrom",
  };
}

export { meshcoreSetupAdapter };

export const meshcoreSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "MeshCore",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: "Needs connection",
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: "Set channels.meshcore.host for the MeshCore device.",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).configured,
    resolveExtraStatusLines: ({ cfg, accountId }) => {
      const account = resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId });
      if (!account.configured) {
        return [];
      }
      return [`tcp: ${formatMeshcoreEndpoint(account)}`];
    },
  }),
  introNote: {
    title: "MeshCore setup",
    lines: [
      "Connect via Companion TCP protocol (port 5000).",
      `Docs: ${formatDocsLink("/channels/meshcore", "channels/meshcore")}`,
    ],
  },
  credentials: [],
  finalize: async ({ cfg, prompter, accountId }) => {
    const resolvedAccountId = accountId ?? resolveDefaultMeshcoreAccountId(cfg as CoreConfig);
    const account = resolveMeshcoreAccount({
      cfg: cfg as CoreConfig,
      accountId: resolvedAccountId,
    });

    const host = normalizeOptionalString(
      await prompter.text({
        message: "MeshCore node host or IP",
        initialValue: account.host || process.env.MESHCORE_HOST || "",
        validate: (value: string) => (normalizeOptionalString(value) ? undefined : "Required"),
      }),
    );
    const portRaw = await prompter.text({
      message: "TCP port",
      initialValue: String(account.port || 5000),
    });
    const channelsRaw = await prompter.text({
      message: "Mesh channel indices to listen (comma-separated, 0-7)",
      initialValue: (account.config.channels ?? [0]).join(","),
    });
    const channels = channelsRaw
      .split(/[,;\s]+/)
      .map((entry: string) => Number.parseInt(entry.trim(), 10))
      .filter((value: number) => Number.isFinite(value) && value >= 0 && value <= 7);

    const next = setSetupChannelEnabled(
      updateMeshcoreAccountConfig(cfg as CoreConfig, resolvedAccountId, {
        host,
        port: parsePort(String(portRaw), 5000),
        channels: channels.length ? channels : [0],
      }),
      channel,
      true,
    ) as CoreConfig;

    return { cfg: next };
  },
  dmPolicy: {
    label: "MeshCore",
    channel,
    policyKey: "channels.meshcore.dmPolicy",
    allowFromKey: "channels.meshcore.allowFrom",
    resolveConfigKeys: (_cfg, accountId) => resolveMeshcoreConfigKeys(accountId),
    getCurrent: (cfg, accountId) =>
      resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).config.dmPolicy ?? "pairing",
    setPolicy: (cfg, policy, accountId) =>
      updateMeshcoreAccountConfig(
        cfg as CoreConfig,
        accountId ?? resolveDefaultMeshcoreAccountId(cfg as CoreConfig),
        { dmPolicy: policy },
      ),
    promptAllowFrom: createPromptParsedAllowFromForAccount({
      defaultAccountId: resolveDefaultMeshcoreAccountId,
      message: "Allowed MeshCore node ids",
      placeholder: "!aabbccdd1122..., advert-name, *",
      parseEntries: (raw: string) => ({
        entries: mergeAllowFromEntries(undefined, splitSetupEntries(raw)),
      }),
      getExistingAllowFrom: ({ cfg, accountId }) =>
        resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? [],
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        updateMeshcoreAccountConfig(cfg as CoreConfig, accountId, { allowFrom }),
    }),
  },
  allowFrom: createAllowFromSection({
    message: "Allowed MeshCore node ids",
    placeholder: "!aabbccdd1122..., advert-name, *",
    invalidWithoutCredentialNote:
      "Entries that are not valid MeshCore node ids or names will be ignored.",
    parseId: normalizeMeshcoreAllowEntry,
    apply: ({ cfg, accountId, allowFrom }) =>
      updateMeshcoreAccountConfig(cfg as CoreConfig, accountId, { allowFrom }),
  }),
  groupAccess: {
    label: "MeshCore broadcast channels",
    placeholder: formatMeshcoreChannelTarget(0),
    currentPolicy: ({ cfg, accountId }) =>
      resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).config.groupPolicy ??
      "disabled",
    currentEntries: ({ cfg, accountId }) =>
      Object.keys(resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).config.groups ?? {}),
    updatePrompt: () => true,
    setPolicy: ({ cfg, accountId, policy }) =>
      setMeshcoreGroupAccess(cfg as CoreConfig, accountId, policy, [], normalizeGroupEntry),
    resolveAllowlist: async ({ entries }) => entries,
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setMeshcoreGroupAccess(
        cfg as CoreConfig,
        accountId,
        "allowlist",
        Array.isArray(resolved) ? resolved.filter((entry): entry is string => typeof entry === "string") : [],
        normalizeGroupEntry,
      ),
  },
};
