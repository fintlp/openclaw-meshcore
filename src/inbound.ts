import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import {
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedMeshcoreAccount } from "./accounts.js";
import {
  buildMeshcoreAllowlistCandidates,
  formatMeshcoreNodeId,
  normalizeMeshcoreAllowEntry,
} from "./normalize.js";
import { resolveMeshcoreGroupMatch, resolveMeshcoreRequireMention } from "./policy.js";
import { readNodeStatusSnapshot } from "./node-status.js";
import { getMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";

const CHANNEL_ID = "meshcore" as const;
type MeshcoreGroupPolicy = "open" | "allowlist" | "disabled";

const meshcoreIngressIdentity = defineStableChannelIngressIdentity({
  key: "meshcore-node",
  normalizeEntry: normalizeMeshcoreAllowEntry,
  normalizeSubject: normalizeMeshcoreAllowEntry,
  sensitivity: "pii",
  isWildcardEntry: (entry) => normalizeMeshcoreAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex }) => `meshcore-entry-${entryIndex + 1}:node`,
});

function hasEntries(entries: Array<string | number> | undefined): boolean {
  return normalizeStringEntries(entries).some((entry) => normalizeMeshcoreAllowEntry(entry));
}

function createMeshcoreIngressSubject(message: MeshcoreInboundMessage) {
  const candidates = buildMeshcoreAllowlistCandidates({
    senderNodeId: message.senderNodeId,
    senderName: message.senderName,
  });
  return {
    stableId: candidates[0] ?? message.senderNodeId,
    aliases: {
      "meshcore-node": formatMeshcoreNodeId(message.senderNodeId),
    },
  };
}

function routeDescriptorsForMeshcoreGroup(params: {
  isGroup: boolean;
  groupPolicy: MeshcoreGroupPolicy;
  groupAllowed: boolean;
  hasConfiguredGroups: boolean;
  groupEnabled: boolean;
  routeGroupAllowFrom: string[];
}) {
  if (!params.isGroup) {
    return [];
  }
  return channelIngressRoutes(
    params.groupPolicy === "allowlist" && {
      id: "meshcore:channel",
      allowed: params.hasConfiguredGroups && params.groupAllowed,
      precedence: 0,
      matchId: "meshcore-channel",
      blockReason: "channel_not_allowlisted",
    },
    !params.groupEnabled && {
      id: "meshcore:channel-enabled",
      enabled: false,
      precedence: 10,
      blockReason: "channel_disabled",
    },
    hasEntries(params.routeGroupAllowFrom) && {
      id: "meshcore:channel-sender",
      precedence: 20,
      senderPolicy: "replace",
      senderAllowFrom: params.routeGroupAllowFrom,
    },
  );
}

async function deliverMeshcoreReply(params: {
  payload: OutboundReplyPayload;
  cfg: CoreConfig;
  target: string;
  accountId: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  await deliverFormattedTextWithAttachments({
    payload: params.payload,
    send: async ({ text, replyToId }) => {
      if (params.sendReply) {
        await params.sendReply(params.target, text, replyToId);
      }
      params.statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

const COMMAND_REPLIES = new Set(["!ping", "!status"]);

function formatStatusReply(snapshot: ReturnType<typeof readNodeStatusSnapshot>): string {
  if (!snapshot) {
    return "status unavailable";
  }
  const parts: string[] = [];
  parts.push(snapshot.connectionState ?? "unknown");
  if (snapshot.name) {
    parts.push(`name:${snapshot.name}`);
  }
  if (snapshot.batteryMv) {
    parts.push(`bat:${(snapshot.batteryMv / 1000).toFixed(2)}V`);
  }
  if (snapshot.position?.lat !== undefined && snapshot.position?.lon !== undefined) {
    parts.push(`pos:${snapshot.position.lat.toFixed(4)},${snapshot.position.lon.toFixed(4)}`);
  }
  if (snapshot.lastAdvertAt) {
    const ageMin = Math.floor((Date.now() - new Date(snapshot.lastAdvertAt).getTime()) / 60000);
    parts.push(`adv:${ageMin}m`);
  }
  if (snapshot.reconnectCount !== undefined) {
    parts.push(`reconnects:${snapshot.reconnectCount}`);
  }
  return parts.join(" ");
}

function buildCommandReply(command: string, accountId: string): string | undefined {
  if (command === "!ping") {
    const snapshot = readNodeStatusSnapshot(accountId);
    const name = snapshot?.name;
    return name ? `pong ${name}` : "pong";
  }
  if (command === "!status") {
    return formatStatusReply(readNodeStatusSnapshot(accountId));
  }
  return undefined;
}

export async function handleMeshcoreInbound(params: {
  message: MeshcoreInboundMessage;
  account: ResolvedMeshcoreAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** If provided for group messages, called after admission succeeds and then normal session dispatch is skipped. */
  onAdmittedGroup?: (message: MeshcoreInboundMessage) => void | Promise<void>;
}): Promise<void> {
  const { message, account, config, runtime } = params;
  const core = getMeshcoreRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  params.statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.meshcore !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "meshcore",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (line) => runtime.log?.(line),
  });

  const groupMatch = resolveMeshcoreGroupMatch({
    groups: account.config.groups,
    target: message.target,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes);
  const requireMention = message.isGroup
    ? resolveMeshcoreRequireMention({
        groupConfig: groupMatch.groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;
  const routeGroupAllowFrom = normalizeStringEntries(
    groupMatch.groupConfig?.allowFrom?.length
      ? groupMatch.groupConfig.allowFrom
      : groupMatch.wildcardConfig?.allowFrom,
  );
  const channelAllowlistedWithoutSenderFilter =
    groupPolicy === "allowlist" &&
    message.isGroup &&
    groupMatch.allowed &&
    groupMatch.hasConfiguredGroups &&
    !hasEntries(account.config.groupAllowFrom) &&
    !hasEntries(routeGroupAllowFrom);
  const accessGroupPolicy: MeshcoreGroupPolicy = channelAllowlistedWithoutSenderFilter
    ? "open"
    : groupPolicy === "open" &&
        (hasEntries(account.config.groupAllowFrom) || hasEntries(routeGroupAllowFrom))
      ? "allowlist"
      : groupPolicy;

  const access = await createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: meshcoreIngressIdentity,
    cfg: config as OpenClawConfig,
    readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
  }).message({
    subject: createMeshcoreIngressSubject(message),
    conversation: {
      kind: message.isGroup ? "group" : "direct",
      id: message.target,
    },
    route: routeDescriptorsForMeshcoreGroup({
      isGroup: message.isGroup,
      groupPolicy,
      groupAllowed: groupMatch.allowed,
      hasConfiguredGroups: groupMatch.hasConfiguredGroups,
      groupEnabled:
        groupMatch.groupConfig?.enabled !== false && groupMatch.wildcardConfig?.enabled !== false,
      routeGroupAllowFrom,
    }),
    mentionFacts: message.isGroup
      ? {
          canDetectMention: true,
          wasMentioned,
          hasAnyMention: wasMentioned,
        }
      : undefined,
    dmPolicy,
    groupPolicy: accessGroupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      activation: {
        requireMention: message.isGroup && requireMention,
        allowTextCommands,
      },
    },
    allowFrom: account.config.allowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    command: {
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAccess.authorized;

  // Plugin-level !ping / !status replies: answered directly for DMs that pass
  // the same admission gate as a normal dispatch. Unknown/pairing-required
  // senders fall through to the normal pairing flow so we never leak gateway
  // internals to strangers.
  const commandRepliesEnabled = account.config.commandRepliesEnabled ?? true;
  if (
    commandRepliesEnabled &&
    !message.isGroup &&
    access.ingress.admission === "dispatch" &&
    COMMAND_REPLIES.has(rawBody)
  ) {
    const replyText = buildCommandReply(rawBody, account.accountId);
    if (replyText !== undefined) {
      await deliverMeshcoreReply({
        payload: { text: replyText },
        cfg: config,
        target: message.senderNodeId,
        accountId: account.accountId,
        sendReply: params.sendReply,
        statusSink: params.statusSink,
      });
      return;
    }
  }

  if (access.ingress.admission === "pairing-required") {
    await pairing.issueChallenge({
      senderId: message.senderNodeId,
      senderIdLine: `Your MeshCore node id: ${message.senderNodeId}`,
      meta: { name: message.senderName ?? message.senderNodeId },
      sendPairingReply: async (text) => {
        await deliverMeshcoreReply({
          payload: { text },
          cfg: config,
          target: message.senderNodeId,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink: params.statusSink,
        });
      },
      onReplyError: (err) => {
        runtime.error?.(`meshcore: pairing reply failed for ${message.senderNodeId}: ${String(err)}`);
      },
    });
    runtime.log?.(`meshcore: drop DM sender ${message.senderNodeId} (dmPolicy=${dmPolicy})`);
    return;
  }
  if (access.ingress.admission === "skip") {
    runtime.log?.(`meshcore: drop channel ${message.target} (missing-mention)`);
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    if (
      message.isGroup &&
      access.ingress.decisiveGateId === "command" &&
      access.commandAccess.shouldBlockControlCommand
    ) {
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: message.senderNodeId,
      });
      return;
    }
    if (message.isGroup) {
      if (access.routeAccess.reason === "channel_not_allowlisted") {
        runtime.log?.(`meshcore: drop channel ${message.target} (not allowlisted)`);
      } else if (access.routeAccess.reason === "channel_disabled") {
        runtime.log?.(`meshcore: drop channel ${message.target} (disabled)`);
      } else {
        runtime.log?.(`meshcore: drop group sender ${message.senderNodeId} (policy=${groupPolicy})`);
      }
    } else {
      runtime.log?.(`meshcore: drop DM sender ${message.senderNodeId} (dmPolicy=${dmPolicy})`);
    }
    return;
  }

  // Digest mode hook: admitted group message, but do not wake a session.
  if (message.isGroup && params.onAdmittedGroup) {
    await params.onAdmittedGroup(message);
    return;
  }

  const peerId = message.isGroup ? message.target : message.senderNodeId;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  const fromLabel = message.isGroup ? message.target : message.senderNodeId;
  const { storePath, body } = buildEnvelope({
    channel: "MeshCore",
    from: fromLabel,
    timestamp: message.timestamp,
    body: rawBody,
  });

  const groupSystemPrompt = groupMatch.groupConfig?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: message.isGroup
      ? `meshcore:channel:${message.target}`
      : `meshcore:${message.senderNodeId}`,
    To: `meshcore:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderName ?? message.senderNodeId,
    SenderId: message.senderNodeId,
    GroupSubject: message.isGroup ? message.target : undefined,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `meshcore:${peerId}`,
    CommandAuthorized: commandAuthorized,
    ReplyToId: message.replyToId,
    ChannelStructuredContext: [
      {
        label: "MeshCore Message Security",
        source: "meshcore",
        type: "mesh_security",
        payload: message.meshSecurity,
      },
    ],
  });

  await core.channel.inbound.run({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    raw: message,
    adapter: {
      ingest: () => ({
        id: message.messageId,
        timestamp: message.timestamp,
        rawText: rawBody,
        raw: message,
      }),
      classify: () => ({
        canStartAgentTurn: true,
        kind: "message" as const,
      }),
      resolveTurn: () => ({
        cfg: config as OpenClawConfig,
        channel: CHANNEL_ID,
        accountId: account.accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: core.channel.session.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher:
          core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        delivery: {
          deliver: async (payload: OutboundReplyPayload) => {
            await deliverMeshcoreReply({
              payload,
              cfg: config,
              target: peerId,
              accountId: account.accountId,
              sendReply: params.sendReply,
              statusSink: params.statusSink,
            });
          },
          onError: (err: unknown, info: { kind: string }) => {
            runtime.error?.(`meshcore ${info.kind} reply failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
          },
        },
        replyPipeline: {},
        replyOptions: {
          sourceReplyDeliveryMode: "automatic",
          skillFilter: groupMatch.groupConfig?.skills,
          disableBlockStreaming:
            typeof account.config.blockStreaming === "boolean"
              ? !account.config.blockStreaming
              : undefined,
        },
        record: {
          onRecordError: (err: unknown) => {
            runtime.error?.(`meshcore: failed updating session meta: ${String(err)}`);
          },
        },
      }),
    },
  });
}
