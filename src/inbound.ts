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
import type { ResolvedMeshcoreAccount } from "./accounts.js";
import {
  buildMeshcoreAllowlistCandidates,
  formatMeshcoreNodeId,
  normalizeMeshcoreAllowEntry,
} from "./normalize.js";
import { resolveMeshcoreGroupMatch } from "./policy.js";
import {
  COMMAND_REPLIES,
  isBlockedNativeCommand,
  parseRepeaterOpsInvocation,
  resolveMeshcoreCommandAuthorized,
  resolveMeshcoreCommandDecision,
  resolveMeshcoreHostCommandFacts,
  runMeshcoreNativeCommand,
} from "./inbound-commands.js";
import {
  deadLetterNativeCommandReplay,
  releaseReplayClaimIfAdmissionFlipped,
} from "./inbound-durability.js";
import { getMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";
import {
  dmIdentityDigestsEqual,
  parseDmIdentityEvidence,
  validateDmApprovalEntries,
} from "./dm-identity.js";
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
  // A native-command marker is already running (or ran) and deliberately has
  // no evidence payload. Drop its duplicate BEFORE inspecting evidence; the
  // marker must stay pending for the original commandMark, not become a dead
  // dm-identity-no-evidence row that a later mark could write to.
  const duplicateNativeCommand = Boolean(
    existingDupe &&
    !message.isGroup &&
    commandDecision.nativeAuthorized &&
    access.ingress.admission === "dispatch" &&
    (COMMAND_REPLIES.has(rawBody) || parseRepeaterOpsInvocation(rawBody)),
  );
  if (existingDupe && !message.isGroup && !duplicateNativeCommand) {
    const previousRaw = store?.rawJsonOf(existingDupe.id) ?? null;
    const previousEvidence = parseDmIdentityEvidence(previousRaw);
    let previousMessageId: unknown;
    try {
      previousMessageId = previousRaw
        ? (JSON.parse(previousRaw) as { messageId?: unknown }).messageId
        : undefined;
    } catch {
      previousMessageId = undefined;
    }
    if (!previousEvidence) {
      store?.deadLetter(account.accountId, existingDupe.id, "dm-identity-no-evidence");
      return;
    }
    const currentEvidence = parseDmIdentityEvidence(message);
    if (
      !currentEvidence ||
      previousMessageId !== message.messageId ||
      previousEvidence.wirePrefixHex !== currentEvidence.wirePrefixHex ||
      !dmIdentityDigestsEqual(previousEvidence.fullKeySha256, currentEvidence.fullKeySha256)
    ) {
      // Same-prefix/timestamp/body collisions are not redeliveries of a
      // different attribution. Stop before the pending row can be reused.
      store?.deadLetter(account.accountId, existingDupe.id, "dm-identity-stale");
      return;
    }
  }
  const redeliverEventId = existingDupe?.id;

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
    if (duplicateNativeCommand) {
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
    const commandRelease = (cid: number | undefined, err: unknown) => {
      if (store && cid !== undefined) {
        store.releaseClaim(
          account.accountId,
          cid,
          err instanceof Error ? err.message : String(err),
        );
      }
    };
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

  const releaseIfAborted = (reason: string): boolean => {
    if (!params.abortSignal?.aborted) {
      return false;
    }
    if (store && durabilityEventId !== undefined) {
      store.releaseClaim(account.accountId, durabilityEventId, reason);
    }
    return true;
  };

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
      onFinalize: (result: {
        dispatched: boolean;
        admission?: { kind?: string };
        dispatchResult?: { deferredToActiveRun?: "steer" | "followup" } | null;
      }) => {
        if (!store || durabilityEventId === undefined) {
          return;
        }
        if (releaseIfAborted("replay aborted before finalize")) {
          // The monitor stopped waiting for this replay. Do not record a
          // successful dispatch after disconnect/timeout; leave it retryable.
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
