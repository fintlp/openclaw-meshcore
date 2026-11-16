/**
 * Inbound policy & routing DECISIONS for handleMeshcoreInbound (issue #80, PR 1).
 *
 * Pure functions only: they decide whether an inbound frame is admitted,
 * refused, or routed, and leave every side effect (logging, durability
 * dead-letters / claims, replies, dispatch) to the orchestrator in inbound.ts.
 */
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";
import {
  canonicalMeshcoreNodeId,
  dmIdentityDigestsEqual,
  fullKeySha256,
  parseDmIdentityEvidence,
} from "./dm-identity.js";
import { normalizeMeshcoreAllowEntry } from "./normalize.js";
import { resolveMeshcoreRequireMention, type MeshcoreGroupMatch } from "./policy.js";

export type MeshcoreGroupPolicy = "open" | "allowlist" | "disabled";

export function hasEntries(entries: Array<string | number> | undefined): boolean {
  return normalizeStringEntries(entries).some((entry) => normalizeMeshcoreAllowEntry(entry));
}

export type MeshcoreGroupAccess = {
  requireMention: boolean;
  routeGroupAllowFrom: string[];
  accessGroupPolicy: MeshcoreGroupPolicy;
};

/**
 * Group access policy: mention requirement, per-route sender allowlist, and
 * the effective group policy handed to the ingress resolver (an allowlisted
 * channel with no sender filter is open; an open policy with sender filters
 * becomes an allowlist).
 */
export function resolveMeshcoreGroupAccess(params: {
  isGroup: boolean;
  groupPolicy: MeshcoreGroupPolicy;
  groupMatch: MeshcoreGroupMatch;
  groupAllowFrom: Array<string | number> | undefined;
}): MeshcoreGroupAccess {
  const { groupPolicy, groupMatch } = params;
  const requireMention = params.isGroup
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
    params.isGroup &&
    groupMatch.allowed &&
    groupMatch.hasConfiguredGroups &&
    !hasEntries(params.groupAllowFrom) &&
    !hasEntries(routeGroupAllowFrom);
  const accessGroupPolicy: MeshcoreGroupPolicy = channelAllowlistedWithoutSenderFilter
    ? "open"
    : groupPolicy === "open" &&
        (hasEntries(params.groupAllowFrom) || hasEntries(routeGroupAllowFrom))
      ? "allowlist"
      : groupPolicy;
  return { requireMention, routeGroupAllowFrom, accessGroupPolicy };
}

export type MeshcoreDmAdmissionDecision =
  | { kind: "admit" }
  | {
      kind: "refuse";
      /** logInboundSecurity reason. */
      securityReason: "dm-identity-refused" | "mesh-owner-unverified";
      /** Dead-letter reason applied when the frame is a replay. */
      replayDeadLetterReason:
        | "dm-identity-no-evidence"
        | "dm-identity-ambiguous"
        | "dm-identity-stale";
    };

/**
 * DM identity admission: the frame must carry a unique, canonical, evidence-
 * backed identity, and must not claim the configured mesh owner route.
 * Only meaningful for direct messages (callers skip it for groups).
 */
export function decideMeshcoreDmAdmission(params: {
  message: MeshcoreInboundMessage;
  config: CoreConfig;
}): MeshcoreDmAdmissionDecision {
  const { message, config } = params;
  const identity = message.dmIdentity;
  const canonical = identity?.status === "unique"
    ? canonicalMeshcoreNodeId(identity.fullKey)
    : undefined;
  const evidence = parseDmIdentityEvidence(message);
  const validIdentity =
    identity?.status === "unique" &&
    canonical !== undefined &&
    identity.nodeId === canonical &&
    message.senderNodeId === canonical &&
    message.target === canonical &&
    evidence !== undefined &&
    evidence.wirePrefixHex === identity.fullKey.slice(0, 12) &&
    dmIdentityDigestsEqual(evidence.fullKeySha256, fullKeySha256(identity.fullKey));
  if (!validIdentity || message.meshSecurity.identityBinding === "mismatch") {
    const reason = !evidence
      ? "dm-identity-no-evidence"
      : identity?.status === "ambiguous"
        ? "dm-identity-ambiguous"
        : "dm-identity-stale";
    return {
      kind: "refuse",
      securityReason: "dm-identity-refused",
      replayDeadLetterReason: reason,
    };
  }
  if (
    identity?.status === "unique" &&
    matchesConfiguredMeshOwner({ config, fullKey: identity.fullKey })
  ) {
    // The host exposes owner-only tools from senderIsOwner independently of
    // CommandAuthorized. Refuse the whole unverified owner route BEFORE a
    // session can be created; flags alone are not a complete tool gate.
    return {
      kind: "refuse",
      securityReason: "mesh-owner-unverified",
      replayDeadLetterReason: "dm-identity-stale",
    };
  }
  return { kind: "admit" };
}

function matchesConfiguredMeshOwner(params: {
  config: CoreConfig;
  fullKey: string;
}): boolean {
  const commands = (params.config as { commands?: { ownerAllowFrom?: unknown } }).commands;
  const entries = Array.isArray(commands?.ownerAllowFrom) ? commands.ownerAllowFrom : [];
  for (const raw of entries) {
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    let entry = String(raw).trim();
    if (!entry) continue;
    // Mirror resolveOwnerAllowFromList on 2026.10.5 and 2026.11.3: strip ONE
    // recognized provider prefix, then run the plugin's formatAllowFrom
    // normalization. Thus meshcore:meshcore:!<key> normalizes exactly as the
    // host sees it instead of bypassing this fail-closed owner-route refusal.
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex > 0) {
      // The host trims the prefix before the channel lookup
      // (resolveOwnerAllowFromList → normalizeNullableString .trim()); mirror
      // it so "meshcore :!key" / tab variants cannot bypass this refusal.
      if (entry.slice(0, separatorIndex).trim().toLowerCase() !== "meshcore") continue;
      entry = entry.slice(separatorIndex + 1).trim();
      if (!entry) continue;
    }
    const normalized = normalizeMeshcoreAllowEntry(entry);
    const hex = normalized.startsWith("!") ? normalized.slice(1) : "";
    // Bare IDs, ! prefixes and explicit meshcore: entries all match only
    // against the CURRENT validated full key. Short prefixes stay conservative
    // refusals; names and other unmatchable aliases never establish a match.
    if (/^[0-9a-f]{1,64}$/u.test(hex) && params.fullKey.startsWith(hex)) return true;
  }
  return false;
}
