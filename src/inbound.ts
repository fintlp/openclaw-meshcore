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
import type { DurabilityStore } from "./durability.js";
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
import type { ResolvedMeshcoreAccount } from "./accounts.js";
import {
  buildMeshcoreAllowlistCandidates,
  formatMeshcoreNodeId,
  normalizeMeshcoreAllowEntry,
} from "./normalize.js";
import { resolveMeshcoreGroupMatch } from "./policy.js";
import {
  isBlockedNativeCommand,
  resolveMeshcoreCommandAuthorized,
  resolveMeshcoreCommandDecision,
  resolveMeshcoreHostCommandFacts,
  runMeshcoreNativeCommand,
} from "./inbound-commands.js";
import {
  createCommandDurabilityHooks,
  createDispatchDurability,
  deadLetterNativeCommandReplay,
  dropDuplicateNativeCommand,
  intakeAndClaimInboundEvent,
  probeInboundDuplicate,
  releaseReplayClaimIfAdmissionFlipped,
} from "./inbound-durability.js";
import { getMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";
import { validateDmApprovalEntries } from "./dm-identity.js";
import {
  classifyMeshcoreAdmissionDrop,
  decideMeshcoreDmAdmission,
  hasEntries,
  resolveMeshcoreGroupAccess,
  shouldRefuseMainScopedGroupRoute,
  type MeshcoreGroupPolicy,
} from "./inbound-decisions.js";
import { resolveSendRateLimitConfig } from "./rate-limit.js";
import { runPairingChallenge } from "./pairing-budget.js";
import {
  buildMeshcorePairingReplyText,
  countMeshcorePairingReplyPackets,
} from "./pairing-reply.js";

const CHANNEL_ID = "meshcore" as const;

const meshcoreIngressIdentity = defineStableChannelIngressIdentity({
  key: "meshcore-node",
  normalizeEntry: normalizeMeshcoreAllowEntry,
  normalizeSubject: normalizeMeshcoreAllowEntry,
  sensitivity: "pii",
  isWildcardEntry: (entry) => normalizeMeshcoreAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex }) => `meshcore-entry-${entryIndex + 1}:node`,
});

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
  sendReply?: (
    target: string,
    text: string,
    replyToId?: string,
    purpose?: "dm" | "pairing",
  ) => Promise<void>;
  purpose?: "dm" | "pairing";
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  await deliverFormattedTextWithAttachments({
    payload: params.payload,
    send: async ({ text, replyToId }) => {
      if (params.sendReply) {
        if (params.purpose) {
          await params.sendReply(params.target, text, replyToId, params.purpose);
        } else {
          await params.sendReply(params.target, text, replyToId);
        }
      }
      params.statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

const securityLogState = new Map<string, { at: number; suppressed: number }>();

function logInboundSecurity(params: {
  runtime: RuntimeEnv;
  accountId: string;
  reason: string;
  detail?: string;
}): void {
  const now = Date.now();
  const key = params.accountId + ":" + params.reason;
  const prior = securityLogState.get(key);
  if (prior && now - prior.at < 60_000) {
    prior.suppressed += 1;
    return;
  }
  const suppressed = prior?.suppressed ?? 0;
  securityLogState.set(key, { at: now, suppressed: 0 });
  params.runtime.log?.(
    "meshcore: " + params.reason + " account=" + params.accountId +
      (params.detail ? " " + params.detail : "") + " suppressed=" + suppressed,
  );
}

function fingerprintNodeId(nodeId: string): string {
  return nodeId.startsWith("!") ? nodeId.slice(0, 13) : "unknown";
}


function validDmApprovals(params: {
  entries: readonly unknown[] | undefined;
  allowWildcard: boolean;
  runtime: RuntimeEnv;
  accountId: string;
  source: "config" | "pairing-store";
}): Array<string | number> {
  const entries = Array.isArray(params.entries) ? params.entries : [];
  const partition = validateDmApprovalEntries(entries);
  const wildcard = params.allowWildcard && entries.some(
    (entry) => typeof entry === "string" && normalizeMeshcoreAllowEntry(entry) === "*",
  );
  const ignored = partition.legacyOrInvalid.filter(
    (entry) => !(typeof entry === "string" && normalizeMeshcoreAllowEntry(entry) === "*" && params.allowWildcard),
  );
  if (ignored.length > 0) {
    logInboundSecurity({
      runtime: params.runtime,
      accountId: params.accountId,
      reason: "legacy-dm-approvals-ignored",
      detail: "source=" + params.source + " count=" + ignored.length,
    });
  }
  return [...partition.canonical, ...(wildcard ? ["*"] : [])];
}

export async function handleMeshcoreInbound(params: {
  message: MeshcoreInboundMessage;
  account: ResolvedMeshcoreAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  sendReply?: (
    target: string,
    text: string,
    replyToId?: string,
    purpose?: "dm" | "pairing",
  ) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** If provided for group messages, called after admission succeeds and then normal session dispatch is skipped. */
  onAdmittedGroup?: (message: MeshcoreInboundMessage) => void | Promise<void>;
  /** Inbound durability store (#48). When present, session-bound frames are logged before dispatch and the cursor advances after the host accepts the turn. */
  durability?: DurabilityStore | null;
  /** Set when dispatching from the startup replay path: skips intake logging and binds dispatch marks to the stored event id. */
  replayOf?: number;
  /** The stored LOCAL receive time of a replayed event (for the agent-visible replay tag). */
  replayReceivedAt?: number;
  /** Abort replay finalization when the monitor disconnects, aborts, or times out. */
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { message, account, config, runtime } = params;
  const core = getMeshcoreRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) return;

  // Compute ONE command decision before host command facts or native replies.
  const { nativeCommand, commandDecision } = resolveMeshcoreCommandDecision({
    message,
    rawBody,
    account,
  });

  // Native-command marker rows intentionally have rawJson "{}" and no DM
  // identity evidence. Classify them as non-replayable BEFORE the evidence
  // gate so they cannot be mislabeled dm-identity-no-evidence.
  if (
    deadLetterNativeCommandReplay({
      isGroup: message.isGroup,
      replayOf: params.replayOf,
      nativeCommand,
      durability: params.durability,
      accountId: account.accountId,
    })
  ) {
    return;
  }

  if (!message.isGroup) {
    const dmAdmission = decideMeshcoreDmAdmission({ message, config });
    if (dmAdmission.kind === "refuse") {
      if (params.replayOf !== undefined) {
        params.durability?.deadLetter(
          account.accountId,
          params.replayOf,
          dmAdmission.replayDeadLetterReason,
        );
      }
      logInboundSecurity({
        runtime,
        accountId: account.accountId,
        reason: dmAdmission.securityReason,
        detail: "fingerprint=" + fingerprintNodeId(message.senderNodeId),
      });
      return;
    }
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

  const { ingressAllowTextCommands, hasControlCommand } = resolveMeshcoreHostCommandFacts({
    core,
    config,
    isGroup: message.isGroup,
    rawBody,
    commandDecision,
  });
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes);
  const { requireMention, routeGroupAllowFrom, accessGroupPolicy } =
    resolveMeshcoreGroupAccess({
      isGroup: message.isGroup,
      groupPolicy,
      groupMatch,
      groupAllowFrom: account.config.groupAllowFrom,
    });

  const dmConfigAllowFrom = message.isGroup
    ? account.config.allowFrom
    : validDmApprovals({
        entries: account.config.allowFrom,
        allowWildcard: true,
        runtime,
        accountId: account.accountId,
        source: "config",
      });

  const access = await createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: meshcoreIngressIdentity,
    cfg: config as OpenClawConfig,
    readStoreAllowFrom: async () => {
      const stored = await pairing.readAllowFromStore();
      return message.isGroup
        ? stored
        : validDmApprovals({
            entries: stored,
            allowWildcard: false,
            runtime,
            accountId: account.accountId,
            source: "pairing-store",
          });
    },
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
        allowTextCommands: ingressAllowTextCommands,
      },
    },
    allowFrom: dmConfigAllowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    command: message.isGroup
      ? false
      : {
          allowTextCommands: ingressAllowTextCommands,
          hasControlCommand,
        },
  });
  const commandAuthorized = resolveMeshcoreCommandAuthorized({
    isGroup: message.isGroup,
    access,
    commandDecision,
  });

  // Replay path: admission flipped while we were down (config changed).
  // The attempt was already counted at claim time; release the claim — the
  // event goes back to pending and dead-letters at maxDispatchAttempts.
  if (
    releaseReplayClaimIfAdmissionFlipped({
      replayOf: params.replayOf,
      access,
      durability: params.durability,
      accountId: account.accountId,
      runtime,
    })
  ) {
    return;
  }

  // A recognized native command is terminal when blocked. It never becomes a
  // pairing request, durable row, radio reply, or model turn.
  if (isBlockedNativeCommand({ nativeCommand, commandDecision, access })) {
    return;
  }

  // Durability duplicate probe (#48): persistent dedupe collapses sender
  // retries and reconnect re-deliveries BEFORE any dispatch work, including
  // command replies (a re-aired !trace costs real airtime).
  const store = params.durability ?? null;
  const probe = probeInboundDuplicate({
    store,
    replayOf: params.replayOf,
    accountId: account.accountId,
    message,
    rawBody,
    commandDecision,
    access,
    runtime,
  });
  if (probe.kind === "drop") {
    return;
  }
  const { dedupeKey, duplicateNativeCommand, redeliverEventId } = probe;

  // Plugin-level command replies: answered directly for DMs that pass
  // the same admission gate as a normal dispatch. Unknown/pairing-required
  // senders fall through to the normal pairing flow so we never leak gateway
  // internals to strangers. Covers !ping/!status (exact match) and the
  // repeater-ops commands (!neighbours <node>, ...) which put frames on air.
  if (
    commandDecision.nativeAuthorized &&
    !message.isGroup &&
    access.ingress.admission === "dispatch"
  ) {
    // Round-4 minor 1: COMMANDS drop on any duplicate hit — a pending command
    // row means the command is already running (or ran), never re-air it. But
    // this must only fire for real commands: a plain DM retry belongs to the
    // m7 redelivery path below (re-check regression).
    if (
      dropDuplicateNativeCommand({
        duplicateNativeCommand,
        rawBody,
        senderNodeId: message.senderNodeId,
        runtime,
      })
    ) {
      return;
    }
    // m4: the command frame is recorded BEFORE the (possibly slow) run, so a
    // sender retry during it is dropped by the probe instead of re-airing.
    const { commandIntake, commandMark, commandRelease } = createCommandDurabilityHooks({
      store,
      replayOf: params.replayOf,
      accountId: account.accountId,
      dedupeKey,
      message,
      rawBody,
    });
    const handled = await runMeshcoreNativeCommand({
      rawBody,
      account,
      durability: params.durability,
      deliverReply: async (text) => {
        await deliverMeshcoreReply({
          payload: { text },
          cfg: config,
          target: message.senderNodeId,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink: params.statusSink,
        });
      },
      onPingBudgetRefused: () => {
        logInboundSecurity({
          runtime,
          accountId: account.accountId,
          reason: "native-ping-budget-refused",
          detail: "fingerprint=" + fingerprintNodeId(message.senderNodeId),
        });
      },
      commandIntake,
      commandMark,
      commandRelease,
    });
    if (handled) {
      return;
    }
  }

  if (access.ingress.admission === "pairing-required") {
    const sendRateLimit = resolveSendRateLimitConfig(
      account.config.sendRateLimit as Record<string, unknown> | undefined,
    );
    const senderIdLine = "Your MeshCore node id: " + message.senderNodeId;
    const requiredPackets = countMeshcorePairingReplyPackets({
      senderIdLine,
      textChunkLimit: account.config.textChunkLimit,
      chunkNumbering: account.config.chunkNumbering,
      outboundSignedPlain: account.config.outboundSignedPlain,
    });
    const result = await runPairingChallenge({
      accountId: account.accountId,
      nodeId: message.senderNodeId,
      maxSends: sendRateLimit.maxSends,
      requiredPackets,
      issue: async () => {
        let replyFailed = false;
        const challenge = await pairing.issueChallenge({
          senderId: message.senderNodeId,
          senderIdLine,
          meta: { name: message.senderName ?? message.senderNodeId },
          buildReplyText: buildMeshcorePairingReplyText,
          sendPairingReply: async (text) => {
            await deliverMeshcoreReply({
              payload: { text },
              cfg: config,
              target: message.senderNodeId,
              accountId: account.accountId,
              sendReply: params.sendReply,
              purpose: "pairing",
              statusSink: params.statusSink,
            });
          },
          onReplyError: () => {
            // The real 2026.10.5/2026.11.3 host logs through this callback,
            // keeps the pending record until its TTL, then returns created:true.
            replyFailed = true;
            runtime.error?.(
              "meshcore: pairing reply failed account=" + account.accountId +
                " fingerprint=" + fingerprintNodeId(message.senderNodeId),
            );
          },
        });
        return {
          created: challenge.created,
          replyDelivered: challenge.created && !replyFailed,
        };
      },
    });
    if (!result.issued) {
      logInboundSecurity({
        runtime,
        accountId: account.accountId,
        reason: "pairing-request-refused",
        detail: "cause=" + (result.reason ?? "unknown") +
          " fingerprint=" + fingerprintNodeId(message.senderNodeId),
      });
    } else {
      runtime.log?.(
        "meshcore: pairing challenge completed account=" + account.accountId +
          " fingerprint=" + fingerprintNodeId(message.senderNodeId) +
          " coalesced=" + result.coalesced,
      );
    }
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    const drop = classifyMeshcoreAdmissionDrop({ isGroup: message.isGroup, access });
    if (drop === "missing-mention") {
      runtime.log?.(`meshcore: drop channel ${message.target} (missing-mention)`);
    } else if (drop === "unauthorized-control-command") {
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: message.senderNodeId,
      });
    } else if (drop === "channel-not-allowlisted") {
      runtime.log?.(`meshcore: drop channel ${message.target} (not allowlisted)`);
    } else if (drop === "channel-disabled") {
      runtime.log?.(`meshcore: drop channel ${message.target} (disabled)`);
    } else if (drop === "group-sender-policy") {
      runtime.log?.(`meshcore: drop group sender ${message.senderNodeId} (policy=${groupPolicy})`);
    } else {
      runtime.log?.(
        "meshcore: drop DM account=" + account.accountId +
          " fingerprint=" + fingerprintNodeId(message.senderNodeId) +
          " dmPolicy=" + dmPolicy,
      );
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

  // Main-scoped group sessions drop the group id before OpenClaw calls the
  // channel policy adapter, silently shedding group-wide tools. Check the
  // effective route (including binding overrides), before durability intake.
  if (
    shouldRefuseMainScopedGroupRoute({
      isGroup: message.isGroup,
      route,
      config,
      account,
      target: message.target,
    })
  ) {
    runtime.log?.(
      `meshcore: refuse group ${message.target} (account=${account.accountId}; groupScope="main" would shed its tool policy; set session.groupScope="per-group" or the effective binding's session.groupScope="per-group")`,
    );
    if (params.replayOf !== undefined) {
      params.durability?.deadLetter(account.accountId, params.replayOf, "group-scope-main");
    }
    return;
  }

  // Durability intake + claim (#48): session-bound frames are logged as
  // admitted (admission is decided above) and claimed with a lease BEFORE any
  // dispatch work. Attempts count at claim, so process deaths and crash loops
  // are bounded by maxDispatchAttempts.
  const claim = intakeAndClaimInboundEvent({
    store,
    replayOf: params.replayOf,
    redeliverEventId,
    account,
    dedupeKey,
    message,
    rawBody,
    runtime,
  });
  if (claim.kind === "stop") {
    return;
  }
  const durabilityEventId = claim.durabilityEventId;

  const { releaseIfAborted, onFinalize, releaseOnError } = createDispatchDurability({
    store,
    durabilityEventId,
    accountId: account.accountId,
    abortSignal: params.abortSignal,
    runtime,
  });

  if (releaseIfAborted("replay aborted before dispatch")) {
    return;
  }

  try {
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
    CommandInterpretationSuppressed:
      message.isGroup || commandDecision.commandInterpretationSuppressed ? true : undefined,
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

  // Envelope setup awaits above can outlive the monitor. Re-check at the
  // last possible point so an aborted replay never starts a new host turn.
  if (releaseIfAborted("replay aborted before host dispatch")) {
    return;
  }

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
      onFinalize,
    },
  });
  } catch (err) {
    releaseOnError(err);
    throw err;
  }
}
