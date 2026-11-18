/**
 * Pre-delivery, per-session outbound flood guard (#46).
 *
 * The trusted host session key is the identity boundary. Payload text, target
 * and sender-supplied metadata never participate in bucket identity. Accepted
 * payloads are charged synchronously, so concurrent bursts cannot race past
 * the cap. Refusals return cancel=true; this module never relies on a throw
 * (the host fails open when a message_sending hook throws).
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { resolveMeshcoreAccount } from "./accounts.js";
import { chunkMeshcoreOutboundText } from "./send.js";
import type { CoreConfig } from "./types.js";

export type SessionSendRateLimitConfig = {
  enabled: boolean;
  /** Maximum estimated radio packets per canonical session and rolling window. */
  maxSends: number;
  /** Maximum UTF-8 bytes of trimmed outbound text per session and window. */
  maxBytes: number;
  windowMs: number;
};

export const SESSION_SEND_RATE_LIMIT_DEFAULTS: SessionSendRateLimitConfig = {
  enabled: true,
  maxSends: 8,
  maxBytes: 768,
  windowMs: 600_000,
};

export function resolveSessionSendRateLimitConfig(
  raw: Record<string, unknown> | undefined,
): SessionSendRateLimitConfig {
  const value = raw ?? {};
  return {
    enabled: typeof value.enabled === "boolean"
      ? value.enabled
      : SESSION_SEND_RATE_LIMIT_DEFAULTS.enabled,
    maxSends: typeof value.maxSends === "number" &&
        Number.isInteger(value.maxSends) && value.maxSends >= 1
      ? value.maxSends
      : SESSION_SEND_RATE_LIMIT_DEFAULTS.maxSends,
    maxBytes: typeof value.maxBytes === "number" &&
        Number.isInteger(value.maxBytes) && value.maxBytes >= 1
      ? value.maxBytes
      : SESSION_SEND_RATE_LIMIT_DEFAULTS.maxBytes,
    windowMs: typeof value.windowMs === "number" &&
        Number.isInteger(value.windowMs) && value.windowMs >= 1_000
      ? value.windowMs
      : SESSION_SEND_RATE_LIMIT_DEFAULTS.windowMs,
  };
}

type Usage = { at: number; packets: number; bytes: number };
type Bucket = { windowMs: number; events: Usage[] };
const buckets = new Map<string, Bucket>();
let lastSweepAt: number | undefined;

export function clearSessionSendRateLimitState(): void {
  buckets.clear();
  lastSweepAt = undefined;
}

function sweepStaleBuckets(now: number): void {
  if (
    lastSweepAt !== undefined &&
    now >= lastSweepAt &&
    now - lastSweepAt < 60_000
  ) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    const cutoff = now - bucket.windowMs;
    bucket.events = bucket.events.filter((event) => event.at > cutoff);
    if (bucket.events.length === 0) buckets.delete(key);
  }
}

export type SessionSendRateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; cancelReason: string };

function retryDelay(
  events: Usage[],
  packets: number,
  bytes: number,
  config: SessionSendRateLimitConfig,
  now: number,
): number {
  let usedPackets = events.reduce((sum, event) => sum + event.packets, 0);
  let usedBytes = events.reduce((sum, event) => sum + event.bytes, 0);
  for (let index = 0; index <= events.length; index += 1) {
    if (usedPackets + packets <= config.maxSends && usedBytes + bytes <= config.maxBytes) {
      const releaseAt = index === 0 ? now : events[index - 1]!.at + config.windowMs;
      return Math.max(1_000, releaseAt - now);
    }
    const event = events[index];
    if (!event) break;
    usedPackets -= event.packets;
    usedBytes -= event.bytes;
  }
  // The payload alone is oversized. Report when the current bucket clears,
  // while cancelReason tells the caller to split it or raise the configured cap.
  const latest = events.at(-1)?.at ?? now;
  return Math.max(1_000, latest + config.windowMs - now);
}

export function consumeMeshcoreSessionSendRateLimit(params: {
  accountId: string;
  sessionKey: string;
  packets: number;
  bytes: number;
  config: SessionSendRateLimitConfig;
  nowMs?: number;
}): SessionSendRateLimitDecision {
  if (!params.config.enabled || (params.packets <= 0 && params.bytes <= 0)) {
    return { allowed: true };
  }
  const now = params.nowMs ?? Date.now();
  sweepStaleBuckets(now);
  // JSON tuple encoding is collision-proof even when canonical keys contain
  // separators. Channel and account are trusted host/account-resolution data.
  const key = JSON.stringify(["meshcore", params.accountId, params.sessionKey]);
  const cutoff = now - params.config.windowMs;
  const events = (buckets.get(key)?.events ?? []).filter((event) => event.at > cutoff);
  const usedPackets = events.reduce((sum, event) => sum + event.packets, 0);
  const usedBytes = events.reduce((sum, event) => sum + event.bytes, 0);
  const overPackets = usedPackets + params.packets > params.config.maxSends;
  const overBytes = usedBytes + params.bytes > params.config.maxBytes;
  if (overPackets || overBytes) {
    if (events.length === 0) buckets.delete(key);
    else buckets.set(key, { windowMs: params.config.windowMs, events });
    const retryAfterMs = retryDelay(
      events,
      params.packets,
      params.bytes,
      params.config,
      now,
    );
    const exceeded = [
      overPackets
        ? `estimated radio packets ${usedPackets}+${params.packets}/${params.config.maxSends}`
        : undefined,
      overBytes
        ? `UTF-8 text bytes ${usedBytes}+${params.bytes}/${params.config.maxBytes}`
        : undefined,
    ].filter(Boolean).join(", ");
    const oversized = params.packets > params.config.maxSends || params.bytes > params.config.maxBytes;
    return {
      allowed: false,
      retryAfterMs,
      cancelReason:
        `MeshCore per-session flood guard refused the whole payload before any radio send: ` +
        `${exceeded} in the rolling ${Math.round(params.config.windowMs / 60_000)}m window. ` +
        `Retry in ~${Math.ceil(retryAfterMs / 1_000)}s (retryAfterMs=${retryAfterMs}). ` +
        (oversized
          ? "This payload alone exceeds the per-session budget; split it or tune channels.meshcore.sessionSendRateLimit. "
          : "") +
        "Nothing was queued. The independent channels.meshcore.sendRateLimit account guard remains active.",
    };
  }
  events.push({ at: now, packets: params.packets, bytes: params.bytes });
  buckets.set(key, { windowMs: params.config.windowMs, events });
  return { allowed: true };
}

export function registerMeshcoreSessionSendRateLimit(api: OpenClawPluginApi): void {
  // api.registerHook is the legacy event bus and ignores typed message_sending
  // registrations on this host. api.on is the invoked, cancellation-capable API.
  api.on("message_sending", (event, ctx) => {
    if (ctx.channelId !== "meshcore") return;
    const sessionKey = typeof ctx.sessionKey === "string" && ctx.sessionKey.length > 0
      ? ctx.sessionKey
      : undefined;
    // Internal/no-session sends intentionally remain account-guard-only. Never
    // collapse them into a shared synthetic session bucket.
    if (!sessionKey) return;
    const account = resolveMeshcoreAccount({
      cfg: api.config as CoreConfig,
      accountId: ctx.accountId,
    });
    const chunks = chunkMeshcoreOutboundText(event.content, account.config);
    const bytes = new TextEncoder().encode(event.content.trim()).length;
    const decision = consumeMeshcoreSessionSendRateLimit({
      accountId: account.accountId,
      sessionKey,
      packets: chunks.length,
      bytes,
      config: resolveSessionSendRateLimitConfig(
        account.config.sessionSendRateLimit as Record<string, unknown> | undefined,
      ),
    });
    if (!decision.allowed) {
      return { cancel: true, cancelReason: decision.cancelReason };
    }
  });
}
