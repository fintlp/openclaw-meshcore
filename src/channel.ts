import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createAllowlistProviderOpenWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listMeshcoreAccountIds,
  resolveDefaultMeshcoreAccountId,
  resolveMeshcoreAccount,
  type ResolvedMeshcoreAccount,
} from "./accounts.js";
import {
  buildBaseChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "./channel-api.js";
import { MeshcoreChannelConfigSchema } from "./config-schema.js";
import { startMeshcoreGatewayAccount } from "./gateway.js";
import { meshcoreMessageAdapter } from "./message-adapter.js";
import {
  isMeshcoreGroupTarget,
  looksLikeMeshcoreTargetId,
  normalizeMeshcoreAllowEntry,
  normalizeMeshcoreMessagingTarget,
} from "./normalize.js";
import { meshcoreOutboundBaseAdapter } from "./outbound-base.js";
import {
  resolveMeshcoreEffectiveGroupMatch,
  resolveMeshcoreEffectiveGroups,
  resolveMeshcoreGroupToolPolicy,
  resolveMeshcoreRequireMention,
} from "./policy.js";
import { probeMeshcore } from "./probe.js";
import { resolveMeshcoreOutboundSessionRoute } from "./session-route.js";
import { meshcoreSetupAdapter, meshcoreSetupWizard } from "./setup-surface.js";
import type { CoreConfig, MeshcoreGroupConfig, MeshcoreProbe } from "./types.js";

const meta = {
  id: "meshcore",
  label: "MeshCore",
  selectionLabel: "MeshCore (TCP)",
  docsPath: "/channels/meshcore",
  docsLabel: "meshcore",
  blurb: "LoRa mesh messaging via MeshCore Companion Protocol over TCP.",
  order: 69,
  detailLabel: "MeshCore",
  systemImage: "antenna.radiowaves.left.and.right",
};

type MeshcoreChannelRuntimeModule = typeof import("./channel-runtime.js");

let meshcoreChannelRuntimePromise: Promise<MeshcoreChannelRuntimeModule> | undefined;

async function loadMeshcoreChannelRuntime(): Promise<MeshcoreChannelRuntimeModule> {
  meshcoreChannelRuntimePromise ??= import("./channel-runtime.js");
  return await meshcoreChannelRuntimePromise;
}

/**
 * Directory listers show the groups the account effectively uses (the same
 * host-aware map admission, mention and tool policy resolve against, #90): a
 * single named account with groups:{} inherits root groups. Display only;
 * nothing here decides admission or policy.
 */
type MeshcoreDirectoryAccount = {
  account: ResolvedMeshcoreAccount;
  groups: Record<string, MeshcoreGroupConfig>;
};

function resolveMeshcoreDirectoryAccount(
  cfg: unknown,
  accountId?: string | null,
): MeshcoreDirectoryAccount {
  const account = resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId });
  return {
    account,
    groups: resolveMeshcoreEffectiveGroups({ cfg: cfg as CoreConfig, account }) ?? {},
  };
}

const listMeshcoreDirectoryPeersFromConfig =
  createResolvedDirectoryEntriesLister<MeshcoreDirectoryAccount>({
    kind: "user",
    resolveAccount: resolveMeshcoreDirectoryAccount,
    resolveSources: ({ account, groups }) => [
      account.config.allowFrom ?? [],
      account.config.groupAllowFrom ?? [],
      ...Object.values(groups).map((group) => group.allowFrom ?? []),
    ],
    normalizeId: (entry) => normalizeMeshcoreAllowEntry(entry) || null,
  });

const listMeshcoreDirectoryGroupsFromConfig =
  createResolvedDirectoryEntriesLister<MeshcoreDirectoryAccount>({
    kind: "group",
    resolveAccount: resolveMeshcoreDirectoryAccount,
    resolveSources: ({ account, groups }) => [
      ...(account.config.channels ?? []).map((channelIndex) => `channel:${channelIndex}`),
      Object.keys(groups),
    ],
    normalizeId: (entry) => {
      const normalized = normalizeMeshcoreMessagingTarget(String(entry));
      return normalized && isMeshcoreGroupTarget(normalized) ? normalized : null;
    },
  });

const meshcoreConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedMeshcoreAccount,
  ResolvedMeshcoreAccount
>({
  sectionKey: "meshcore",
  listAccountIds: listMeshcoreAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMeshcoreAccount),
  defaultAccountId: resolveDefaultMeshcoreAccountId,
  clearBaseFields: ["name", "host", "port"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeMeshcoreAllowEntry,
    }),
  resolveDefaultTo: (account) => account.config.defaultTo,
});

const resolveMeshcoreDmPolicy = createScopedDmSecurityResolver<ResolvedMeshcoreAccount>({
  channelKey: "meshcore",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (entry) => normalizeMeshcoreAllowEntry(entry),
});

const collectMeshcoreGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedMeshcoreAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.meshcore !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "MeshCore broadcast channels",
      openBehavior: "allows all configured mesh channels and senders",
      remediation:
        'Prefer channels.meshcore.groupPolicy="allowlist" with channels.meshcore.groups',
    },
  });

export const meshcorePlugin: ChannelPlugin<ResolvedMeshcoreAccount, MeshcoreProbe> =
  createChatChannelPlugin({
    base: {
      id: "meshcore",
      meta: {
        ...meta,
        quickstartAllowFrom: true,
      },
      setup: meshcoreSetupAdapter,
      setupWizard: meshcoreSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group"],
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.meshcore"] },
      configSchema: MeshcoreChannelConfigSchema,
      config: {
        ...meshcoreConfigAdapter,
        hasConfiguredState: ({ env }) =>
          typeof env?.MESHCORE_HOST === "string" && env.MESHCORE_HOST.trim().length > 0,
        isConfigured: (account) => account.configured,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
            extra: {
              host: account.host,
              port: account.port,
            },
          }),
      },
      groups: {
        resolveRequireMention: ({ cfg, accountId, groupId }) => {
          const account = resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId });
          if (!groupId) {
            return false;
          }
          const match = resolveMeshcoreEffectiveGroupMatch({
            cfg: cfg as CoreConfig,
            account,
            target: groupId,
          });
          return resolveMeshcoreRequireMention({
            groupConfig: match.groupConfig,
            wildcardConfig: match.wildcardConfig,
          });
        },
        resolveToolPolicy: ({ cfg, accountId, groupId }) =>
          resolveMeshcoreGroupToolPolicy({
            cfg: cfg as CoreConfig,
            accountId,
            target: groupId,
          }),
      },
      messaging: {
        targetPrefixes: ["meshcore"],
        normalizeTarget: normalizeMeshcoreMessagingTarget,
        targetResolver: {
          looksLikeId: looksLikeMeshcoreTargetId,
          hint: "<!nodeId|node:ABCDEF12|channel:0|broadcast>",
        },
        resolveOutboundSessionRoute: (params) => resolveMeshcoreOutboundSessionRoute(params),
      },
      message: meshcoreMessageAdapter,
      resolver: {
        resolveTargets: async ({ inputs, kind }) => {
          return inputs.map((input) => {
            const normalized = normalizeMeshcoreMessagingTarget(input);
            if (!normalized) {
              return {
                input,
                resolved: false,
                note: "invalid MeshCore target",
              };
            }
            if (kind === "group") {
              if (!isMeshcoreGroupTarget(normalized)) {
                return {
                  input,
                  resolved: false,
                  note: "expected group target",
                };
              }
              return {
                input,
                resolved: true,
                id: normalized,
                name: normalized,
              };
            }
            if (isMeshcoreGroupTarget(normalized)) {
              return {
                input,
                resolved: false,
                note: "expected direct target",
              };
            }
            return {
              input,
              resolved: true,
              id: normalized,
              name: normalized,
            };
          });
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async (params) => listMeshcoreDirectoryPeersFromConfig(params),
        listGroups: async (params) => {
          const entries = await listMeshcoreDirectoryGroupsFromConfig(params);
          return entries.map((entry) => Object.assign({}, entry, { name: entry.id }));
        },
      }),
      status: createComputedAccountStatusAdapter<ResolvedMeshcoreAccount, MeshcoreProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        buildChannelSummary: ({ account, snapshot }) => ({
          ...buildBaseChannelStatusSummary(snapshot),
          host: account.host,
          port: snapshot.port,
          probe: snapshot.probe,
          lastProbeAt: snapshot.lastProbeAt ?? null,
        }),
        probeAccount: async ({ cfg, account, timeoutMs }) =>
          probeMeshcore(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            host: account.host,
            port: account.port,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) =>
          await startMeshcoreGatewayAccount({
            ...ctx,
            cfg: ctx.cfg as CoreConfig,
          }),
      },
    },
    pairing: {
      text: {
        idLabel: "meshcoreNodeId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^meshcore:|^node:/i, (entry) =>
          normalizeMeshcoreAllowEntry(entry),
        ),
        notify: async ({ cfg, id, message }) => {
          const target = normalizeMeshcoreAllowEntry(id);
          if (!target) {
            throw new Error(`invalid MeshCore pairing id: ${id}`);
          }
          const { sendMessageMeshcore } = await loadMeshcoreChannelRuntime();
          await sendMessageMeshcore(target, message, {
            cfg: cfg as CoreConfig,
          });
        },
      },
    },
    security: {
      resolveDmPolicy: resolveMeshcoreDmPolicy,
      collectWarnings: collectMeshcoreGroupPolicyWarnings,
    },
    outbound: {
      base: meshcoreOutboundBaseAdapter,
      attachedResults: {
        channel: "meshcore",
        sendText: async (ctx) => {
          const { cfg, to, text, accountId, replyToId } = ctx;
          const sessionKey = (ctx as unknown as { sessionKey?: string }).sessionKey;
          const { sendMessageMeshcore } = await loadMeshcoreChannelRuntime();
          const result = await sendMessageMeshcore(to, text, {
            cfg: cfg as CoreConfig,
            accountId: accountId ?? undefined,
            sessionKey,
            replyTo: replyToId ?? undefined,
          });
          return {
            messageId: result.messageId,
            target: {
              kind: "conversation" as const,
              id: result.target,
            },
            receipt: result.receipt,
          };
        },
      },
    },
  });
