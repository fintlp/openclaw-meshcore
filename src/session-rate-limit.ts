/**
 * Synchronous per-producing-session outbound flood guard (#46).
 *
 * Identity comes only from the resolved account and the host-produced session
 * key. Packet/byte costs are computed by the real send path before any device
 * I/O. Accepted sends are charged at admission and are not refunded on later
 * delivery failure. Missing keys deliberately remain account-guard-only.
 */
import { SendRateLimitExceededError } from "./rate-limit.js";

export type SessionSendRateLimitConfig = {
  enabled: boolean;
  maxSends: number;
  /** UTF-8 bytes of trimmed outbound text per canonical session and window. */
  maxBytes: number;
  windowMs: number;
};

export const SESSION_SEND_RATE_LIMIT_DEFAULTS: SessionSendRateLimitConfig = {
  enabled: true,
  maxSends: 10,
  maxBytes: 1_270,
  windowMs: 600_000,
};

export function resolveSessionSendRateLimitConfig(
  raw: Record<string, unknown> | undefined,
): SessionSendRateLimitConfig {
  const value = raw ?? {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : SESSION_SEND_RATE_LIMIT_DEFAULTS.enabled,
    maxSends: typeof value.maxSends === "number" && Number.isInteger(value.maxSends) && value.maxSends >= 1
      ? value.maxSends : SESSION_SEND_RATE_LIMIT_DEFAULTS.maxSends,
    maxBytes: typeof value.maxBytes === "number" && Number.isInteger(value.maxBytes) && value.maxBytes >= 1
      ? value.maxBytes : SESSION_SEND_RATE_LIMIT_DEFAULTS.maxBytes,
    windowMs: typeof value.windowMs === "number" && Number.isInteger(value.windowMs) && value.windowMs >= 1_000
      ? value.windowMs : SESSION_SEND_RATE_LIMIT_DEFAULTS.windowMs,
  };
}

export class SessionSendRateLimitExceededError extends SendRateLimitExceededError {
  constructor(message: string, retryAfterMs: number) {
    super(message, retryAfterMs);
    this.name = "SessionSendRateLimitExceededError";
  }
}

type Usage = { at: number; packets: number; bytes: number };
type Bucket = { windowMs: number; events: Usage[] };
const buckets = new Map<string, Bucket>();
let lastSweepAt: number | undefined;

export function clearSessionSendRateLimitState(): void {
  buckets.clear();
  lastSweepAt = undefined;
}

export function sessionSendRateLimitBucketCountForTests(): number {
  return buckets.size;
}

function sweepStaleBuckets(now: number): void {
  if (lastSweepAt !== undefined && now >= lastSweepAt && now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  for (const [key, bucket] of buckets) {
    bucket.events = bucket.events.filter((event) => event.at > now - bucket.windowMs);
    if (bucket.events.length === 0) buckets.delete(key);
  }
}

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
      return Math.max(1_000, (index === 0 ? now : events[index - 1]!.at + config.windowMs) - now);
    }
    const event = events[index];
    if (!event) break;
    usedPackets -= event.packets;
    usedBytes -= event.bytes;
  }
  const latest = events.at(-1)?.at ?? now;
  return Math.max(1_000, latest + config.windowMs - now);
}

/** Throws SessionSendRateLimitExceededError after exactly one metadata-only log. */
export function enforceMeshcoreSessionSendRateLimit(params: {
  accountId: string;
  sessionKey?: string;
  packets: number;
  bytes: number;
  config: SessionSendRateLimitConfig;
  nowMs?: number;
}): void {
  // 2026.10.5 and internal/no-session sends have no producing key: preserve
  // the old account-only behavior rather than creating a synthetic identity.
  if (
    !params.sessionKey ||
    params.sessionKey.trim().length === 0 ||
    !params.config.enabled ||
    (params.packets <= 0 && params.bytes <= 0)
  ) return;
  const now = params.nowMs ?? Date.now();
  sweepStaleBuckets(now);
  const key = JSON.stringify(["meshcore", params.accountId, params.sessionKey]);
  const events = (buckets.get(key)?.events ?? []).filter(
    (event) => event.at > now - params.config.windowMs,
  );
  const usedPackets = events.reduce((sum, event) => sum + event.packets, 0);
  const usedBytes = events.reduce((sum, event) => sum + event.bytes, 0);
  const overPackets = usedPackets + params.packets > params.config.maxSends;
  const overBytes = usedBytes + params.bytes > params.config.maxBytes;
  if (overPackets || overBytes) {
    if (events.length === 0) buckets.delete(key);
    else buckets.set(key, { windowMs: params.config.windowMs, events });
    const retryAfterMs = retryDelay(events, params.packets, params.bytes, params.config, now);
    const exceeded = [
      overPackets ? `packets ${usedPackets}+${params.packets}/${params.config.maxSends}` : undefined,
      overBytes ? `UTF-8 bytes ${usedBytes}+${params.bytes}/${params.config.maxBytes}` : undefined,
    ].filter(Boolean).join(", ");
    const oversized = params.packets > params.config.maxSends || params.bytes > params.config.maxBytes;
    // No body, session key, or full target crosses the log boundary.
    console.warn(
      `[meshcore] per-session send refused kind=dm packets=${params.packets} bytes=${params.bytes} retryAfterMs=${retryAfterMs}`,
    );
    throw new SessionSendRateLimitExceededError(
      `MeshCore per-session flood guard refused the whole payload after target resolution and before any radio frame: ` +
        `${exceeded} in the rolling ${Math.round(params.config.windowMs / 60_000)}m window. ` +
        `Retry in ~${Math.ceil(retryAfterMs / 1_000)}s (retryAfterMs=${retryAfterMs}). ` +
        (oversized
          ? "This single send exceeds the session budget: waiting alone will not admit it; split it or tune channels.meshcore.sessionSendRateLimit. "
          : "") +
        "Nothing was queued. The independent channels.meshcore.sendRateLimit account guard remains active.",
      retryAfterMs,
    );
  }
  events.push({ at: now, packets: params.packets, bytes: params.bytes });
  buckets.set(key, { windowMs: params.config.windowMs, events });
}
