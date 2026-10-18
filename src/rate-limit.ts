/**
 * Outbound flood guard: caps how many airtime packets the agent may transmit
 * per rolling time window. LoRa airtime is a shared commons — a looping or
 * compromised session must not be able to monopolize the frequency.
 *
 * Counts packets (chunks), not messages: airtime cost is per frame on air.
 * The check happens before the first frame of a message is transmitted, so a
 * message is either sent whole or refused whole — never partially aired.
 */

export type SendRateLimitConfig = {
  enabled: boolean;
  /** Maximum packets per rolling window. */
  maxSends: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
};

export const SEND_RATE_LIMIT_DEFAULTS: SendRateLimitConfig = {
  enabled: true,
  maxSends: 20,
  windowMs: 600_000,
};

export function resolveSendRateLimitConfig(
  raw: Record<string, unknown> | undefined,
): SendRateLimitConfig {
  const limit = raw ?? {};
  return {
    enabled: typeof limit.enabled === "boolean" ? limit.enabled : SEND_RATE_LIMIT_DEFAULTS.enabled,
    maxSends:
      typeof limit.maxSends === "number" && Number.isInteger(limit.maxSends) && limit.maxSends >= 1
        ? limit.maxSends
        : SEND_RATE_LIMIT_DEFAULTS.maxSends,
    windowMs:
      typeof limit.windowMs === "number" && limit.windowMs >= 1_000
        ? limit.windowMs
        : SEND_RATE_LIMIT_DEFAULTS.windowMs,
  };
}

export class SendRateLimitExceededError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "SendRateLimitExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Packet timestamps per account, pruned to the rolling window on each check. */
const buckets = new Map<string, number[]>();

/** Test hook: drop all recorded send activity. */
export function clearSendRateLimitState(accountId?: string): void {
  if (accountId === undefined) {
    buckets.clear();
  } else {
    buckets.delete(accountId);
  }
}

export function assertSendRateLimit(params: {
  accountId: string;
  /** Number of airtime packets this message will occupy. */
  packets: number;
  config: SendRateLimitConfig;
  nowMs?: number;
  /** Free-form label for error text, e.g. "DM" or "group channel". */
  scope?: string;
  /** Config path surface for error text, e.g. "channels.meshcore.sendRateLimit". */
  configPath?: string;
}): void {
  const { config } = params;
  if (!config.enabled || params.packets <= 0) {
    return;
  }
  const now = params.nowMs ?? Date.now();
  const windowStart = now - config.windowMs;
  const recent = (buckets.get(params.accountId) ?? []).filter((t) => t > windowStart);
  buckets.set(params.accountId, recent);

  if (recent.length + params.packets > config.maxSends) {
    const oldest = recent[0] ?? now;
    const retryAfterMs = Math.max(1_000, oldest + config.windowMs - now);
    const windowMinutes = Math.round(config.windowMs / 60_000);
    throw new SendRateLimitExceededError(
      `MeshCore send rate limit reached: ${recent.length} packet(s) sent in the last ` +
        `${windowMinutes}m (limit ${config.maxSends}); this ${params.scope ?? "message"} needs ` +
        `${params.packets} more. Retry in ~${Math.ceil(retryAfterMs / 1_000)}s, or tune ` +
        `${params.configPath ?? "channels.meshcore.sendRateLimit"} (LoRa airtime rule).`,
      retryAfterMs,
    );
  }

  for (let i = 0; i < params.packets; i += 1) {
    recent.push(now);
  }
}
