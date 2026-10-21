import {
  createChannelInboundEnvelopeBuilderAsync,
  logInboundDrop,
  resolveInboundSessionEnvelopeContextAsync,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  DEFAULT_DURABILITY_CONFIG,
  meshcoreDedupeKey,
  type DurabilityStore,
} from "./durability.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
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
import { runRepeaterOpsCommand, type RepeaterOpsKind } from "./repeater-ops.js";
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

/**
 * Repeater-ops commands take a node argument (!neighbours <node>, ...), so
 * they cannot live in the exact-match COMMAND_REPLIES set. They share the
 * same gate: DM-only, admission === "dispatch", commandRepliesEnabled.
 */
const REPEATER_OPS_COMMANDS: ReadonlyArray<{ command: string; op: RepeaterOpsKind }> = [
  { command: "!neighbours", op: "neighbours" },
  { command: "!rstatus", op: "rstatus" },
  { command: "!trace", op: "trace" },
];

function parseRepeaterOpsInvocation(
  rawBody: string,
): { op: RepeaterOpsKind; arg: string } | undefined {
  for (const { command, op } of REPEATER_OPS_COMMANDS) {
    if (rawBody === command) {
      return { op, arg: "" };
    }
    if (rawBody.startsWith(`${command} `)) {
      return { op, arg: rawBody.slice(command.length + 1).trim() };
    }
  }
  return undefined;
}

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

function buildCommandReply(
  command: string,
  accountId: string,
  durability?: DurabilityStore | null,
): string | undefined {
  if (command === "!ping") {
    const snapshot = readNodeStatusSnapshot(accountId);
    const name = snapshot?.name;
    return name ? `pong ${name}` : "pong";
  }
  if (command === "!status") {
    const base = formatStatusReply(readNodeStatusSnapshot(accountId));
    if (!durability) {
      return base;
    }
    const m = durability.metrics(accountId);
    if (m.degraded) {
      return `${base} queue:DEGRADED`;
    }
    const oldest = m.oldestPendingAt
      ? ` oldest ${Math.max(0, Math.round((Date.now() - m.oldestPendingAt) / 1000))}s`
      : "";
    return `${base} queue:${m.pending} dead:${m.dead} dup:${m.duplicates}${oldest}`;
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
  /** Inbound durability store (#48). When present, session-bound frames are logged before dispatch and the cursor advances after the host accepts the turn. */
  durability?: DurabilityStore | null;
  /** Set when dispatching from the startup replay path: skips intake logging and binds dispatch marks to the stored event id. */
  replayOf?: number;
  /** The stored LOCAL receive time of a replayed event (for the agent-visible replay tag). */
  replayReceivedAt?: number;
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

  params.statusSink?.({
    lastInboundAt: params.replayOf !== undefined ? Date.now() : message.timestamp,
  });

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

  // Replay path: admission flipped while we were down (config changed).
  // The attempt was already counted at claim time; release the claim — the
  // event goes back to pending and dead-letters at maxDispatchAttempts.
  if (params.replayOf !== undefined && access.ingress.admission !== "dispatch") {
    params.durability?.releaseClaim(
      account.accountId,
      params.replayOf,
      `admission flipped on replay (${access.ingress.admission})`,
    );
    runtime.log?.(
      `meshcore: replay event ${params.replayOf} no longer admitted (${access.ingress.admission}) — claim released`,
    );
    return;
  }

  // Durability duplicate probe (#48): persistent dedupe collapses sender
  // retries and reconnect re-deliveries BEFORE any dispatch work, including
  // command replies (a re-aired !trace costs real airtime).
  const store = params.durability ?? null;
  const dedupeKey = meshcoreDedupeKey({
    senderNodeId: message.senderNodeId,
    timestamp: message.timestamp,
    body: message.text ?? rawBody,
  });
  // m7: a duplicate hit on a COMPLETE row is a drop; a hit on a pending /
  // inflight row is a redelivery we must dispatch (its first attempt failed).
  const existingDupe =
    store && params.replayOf === undefined
      ? store.findDuplicate(account.accountId, dedupeKey)
      : null;
  if (existingDupe && (existingDupe.state === "dispatched" || existingDupe.state === "dead")) {
    runtime.log?.(
      `meshcore: drop duplicate inbound (sender ${message.senderNodeId} ts ${message.timestamp})`,
    );
    return;
  }
  const redeliverEventId = existingDupe?.id;

  // Plugin-level command replies: answered directly for DMs that pass
  // the same admission gate as a normal dispatch. Unknown/pairing-required
  // senders fall through to the normal pairing flow so we never leak gateway
  // internals to strangers. Covers !ping/!status (exact match) and the
  // repeater-ops commands (!neighbours <node>, ...) which put frames on air.
  const commandRepliesEnabled = account.config.commandRepliesEnabled ?? true;
  if (
    commandRepliesEnabled &&
    !message.isGroup &&
    access.ingress.admission === "dispatch"
  ) {
    // Round-4 minor 1: COMMANDS drop on any duplicate hit — a pending command
    // row means the command is already running (or ran), never re-air it. But
    // this must only fire for real commands: a plain DM retry belongs to the
    // m7 redelivery path below (re-check regression).
    if (existingDupe && (COMMAND_REPLIES.has(rawBody) || parseRepeaterOpsInvocation(rawBody))) {
      runtime.log?.(
        `meshcore: drop duplicate command ${rawBody} (sender ${message.senderNodeId})`,
      );
      return;
    }
    // m4: the command frame is recorded BEFORE the (possibly slow) run, so a
    // sender retry during it is dropped by the probe instead of re-airing.
    const commandIntake = (): number | undefined => {
      if (!store || params.replayOf !== undefined) {
        return params.replayOf;
      }
      const r = store.intake({
        accountId: account.accountId,
        dedupeKey,
        kind: "direct",
        peerId: message.senderNodeId,
        senderLabel: message.senderName ?? message.senderNodeId,
        senderTs: message.timestamp,
        body: rawBody,
        rawJson: "{}",
      });
      return !r.duplicate && r.id >= 0 ? r.id : undefined;
    };
    const commandMark = (id: number | undefined) => {
      if (store && id !== undefined) {
        store.markDispatched(account.accountId, id);
      }
    };
    if (COMMAND_REPLIES.has(rawBody)) {
      const replyText = buildCommandReply(rawBody, account.accountId, params.durability);
      if (replyText !== undefined) {
        const cid = commandIntake();
        await deliverMeshcoreReply({
          payload: { text: replyText },
          cfg: config,
          target: message.senderNodeId,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink: params.statusSink,
        });
        commandMark(cid);
        return;
      }
    }
    const opsInvocation = parseRepeaterOpsInvocation(rawBody);
    if (opsInvocation) {
      const cid = commandIntake();
      // nit 4: a throw mid-command releases the recorded row instead of
      // leaking it pending forever.
      try {
        const replyText = await runRepeaterOpsCommand({
          op: opsInvocation.op,
          targetArg: opsInvocation.arg,
          account,
        });
        await deliverMeshcoreReply({
          payload: { text: replyText },
          cfg: config,
          target: message.senderNodeId,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink: params.statusSink,
        });
        commandMark(cid);
      } catch (err) {
        if (store && cid !== undefined) {
          store.releaseClaim(
            account.accountId,
            cid,
            err instanceof Error ? err.message : String(err),
          );
        }
        throw err;
      }
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
  // Digest traffic is NOT durability-logged — the group-log jsonl is already
  // its durable record; storing it here too would double the write volume.
  if (message.isGroup && params.onAdmittedGroup) {
    await params.onAdmittedGroup(message);
    if (store && params.replayOf !== undefined) {
      store.markDispatched(account.accountId, params.replayOf);
    }
    return;
  }

  // Durability intake + claim (#48): session-bound frames are logged as
  // admitted (admission is decided above) and claimed with a lease BEFORE any
  // dispatch work. Attempts count at claim, so process deaths and crash loops
  // are bounded by maxDispatchAttempts.
  let durabilityEventId: number | undefined = params.replayOf ?? redeliverEventId;
  if (store && durabilityEventId === undefined) {
    const res = store.intake({
      accountId: account.accountId,
      dedupeKey,
      kind: message.isGroup ? "group" : "direct",
      peerId: message.isGroup ? message.target : message.senderNodeId,
      senderLabel: message.senderName ?? message.senderNodeId,
      senderTs: message.timestamp,
      body: rawBody,
      rawJson: JSON.stringify(message),
    });
    if (res.duplicate) {
      runtime.log?.(
        `meshcore: drop duplicate inbound (sender ${message.senderNodeId} ts ${message.timestamp})`,
      );
      return;
    }
    if (res.id >= 0) {
      durabilityEventId = res.id;
    } else {
      // Partial store failure (review M-2): dispatch WITHOUT durability rather
      // than drop — persistence must never be a single point of failure.
      runtime.log?.("meshcore: durability intake degraded — dispatching without persistence");
    }
  }
  // Live path claims its event (replay arrives pre-claimed by claimNext —
  // claiming twice would double-count the attempt).
  const durCfg = { ...DEFAULT_DURABILITY_CONFIG, ...account.config.durability };
  if (store && durabilityEventId !== undefined && params.replayOf === undefined) {
    const verdict = store.claim(
      account.accountId,
      durabilityEventId,
      durCfg.maxDispatchAttempts,
      durCfg.leaseMs,
    );
    if (verdict !== "claimed") {
      runtime.log?.(
        `meshcore: inbound event ${durabilityEventId} not dispatched (claim: ${verdict})`,
      );
      return;
    }
  }

  try {
  const peerId = message.isGroup ? message.target : message.senderNodeId;
  const peerKind = message.isGroup ? "group" : "direct";
  const route = resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: peerKind,
      id: peerId,
    },
  });

  const fromLabel = message.isGroup ? message.target : message.senderNodeId;
  const { storePath, envelopeOptions, previousTimestamp } =
    await resolveInboundSessionEnvelopeContextAsync({
      cfg: config as OpenClawConfig,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({
    cfg: config as OpenClawConfig,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
  });
  const body = buildEnvelope({
    channel: "MeshCore",
    from: fromLabel,
    timestamp: message.timestamp,
    body: rawBody,
    previousTimestamp,
    envelope: envelopeOptions,
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
      ...(params.replayOf !== undefined
        ? [
            {
              label: "MeshCore Replay",
              source: "meshcore",
              type: "mesh_replay",
              payload: {
                replayed: true,
                receivedAt: params.replayReceivedAt ?? message.timestamp,
                senderTs: message.timestamp,
                replayedAt: Date.now(),
              },
            },
          ]
        : []),
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
      onFinalize: (result: {
        dispatched: boolean;
        admission?: { kind?: string };
        dispatchResult?: { deferredToActiveRun?: "steer" | "followup" } | null;
      }) => {
        if (!store || durabilityEventId === undefined) {
          return;
        }
        if (result.dispatchResult?.deferredToActiveRun === "followup") {
          // Queued behind a busy session: the host has ACCEPTED it into its
          // follow-up queue (review round-3 m6) — mark dispatched. Residual,
          // documented: the queue is in-memory, so a host crash before the
          // drain loses that one follow-up; no plugin can close that gap.
          runtime.log?.(
            `meshcore: event ${durabilityEventId} accepted into the host follow-up queue`,
          );
          store.markDispatched(account.accountId, durabilityEventId);
          return;
        }
        if (result.dispatched && result.admission?.kind === "dispatch") {
          store.markDispatched(account.accountId, durabilityEventId);
        } else {
          store.releaseClaim(
            account.accountId,
            durabilityEventId,
            `turn not dispatched (${result.admission?.kind ?? "unknown"})`,
          );
        }
      },
    },
  });
  } catch (err) {
    if (store && durabilityEventId !== undefined) {
      store.releaseClaim(
        account.accountId,
        durabilityEventId,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
}
