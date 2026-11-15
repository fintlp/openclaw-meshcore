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

/** Packet timestamps per account and purpose, pruned per rolling window. */
const buckets = new Map<string, number[]>();
const pairingBuckets = new Map<string, number[]>();
const nativePingBuckets = new Map<string, number[]>();

/** Test hook: drop all recorded send activity. */
export function clearSendRateLimitState(accountId?: string): void {
  if (accountId === undefined) {
    buckets.clear();
    pairingBuckets.clear();
    nativePingBuckets.clear();
  } else {
    buckets.delete(accountId);
    pairingBuckets.delete(accountId);
    nativePingBuckets.delete(accountId);
  }
}

export function pairingPacketCap(config: SendRateLimitConfig): number {
  return Math.min(3, Math.max(0, config.maxSends - 1));
}

function recentPackets(map: Map<string, number[]>, accountId: string, windowStart: number): number[] {
  const recent = (map.get(accountId) ?? []).filter((t) => t > windowStart);
  map.set(accountId, recent);
  return recent;
}

function retryAfterMs(recent: number[], now: number, windowMs: number): number {
  return Math.max(1_000, (recent[0] ?? now) + windowMs - now);
}

export function assertSendRateLimit(params: {
  accountId: string;
  /** Number of airtime packets this message will occupy. */
  packets: number;
  config: SendRateLimitConfig;
  nowMs?: number;
  /** Trusted internal send purpose; never a public tool parameter. */
  purpose?: "dm" | "pairing";
  /** Free-form label for error text, e.g. "DM" or "group channel". */
  scope?: string;
  /** Config path surface for error text, e.g. "channels.meshcore.sendRateLimit". */
  configPath?: string;
}): void {
  const { config } = params;
  const purpose = params.purpose ?? "dm";
  if (params.packets <= 0 || (purpose === "dm" && !config.enabled)) {
    return;
  }
  const now = params.nowMs ?? Date.now();
  const windowStart = now - config.windowMs;
  const normal = recentPackets(buckets, params.accountId, windowStart);
  const pairing = recentPackets(pairingBuckets, params.accountId, windowStart);
  const recent = purpose === "pairing" ? pairing : normal;
  const windowMinutes = Math.round(config.windowMs / 60_000);
  const configPath = params.configPath ?? "channels.meshcore.sendRateLimit";

  if (purpose === "pairing") {
    const cap = pairingPacketCap(config);
    const overPairingShare = pairing.length + params.packets > cap;
    const overTotal = config.enabled && normal.length + pairing.length + params.packets > config.maxSends;
    if (overPairingShare || overTotal) {
      const delay = retryAfterMs(pairing.length > 0 ? pairing : [...normal, ...pairing].sort((a, b) => a - b), now, config.windowMs);
      throw new SendRateLimitExceededError(
        cap === 0
          ? `MeshCore pairing is disabled by the packet partition: maxSends=${config.maxSends} leaves no pairing packet while preserving one normal DM packet.`
          : `MeshCore pairing packet budget reached: ${pairing.length}/${cap} pairing packet(s) in the last ${windowMinutes}m; ` +
            `this challenge needs ${params.packets}. Retry in ~${Math.ceil(delay / 1_000)}s, or tune ${configPath} (LoRa airtime rule).`,
        delay,
      );
    }
    for (let i = 0; i < params.packets; i += 1) pairing.push(now);
    return;
  }

  const total = normal.length + pairing.length;
  if (total + params.packets > config.maxSends) {
    const delay = retryAfterMs([...normal, ...pairing].sort((a, b) => a - b), now, config.windowMs);
    throw new SendRateLimitExceededError(
      `MeshCore send rate limit reached: ${total} packet(s) sent in the last ` +
        `${windowMinutes}m (limit ${config.maxSends}); this ${params.scope ?? "message"} needs ` +
        `${params.packets} more. Retry in ~${Math.ceil(delay / 1_000)}s, or tune ` +
        `${configPath} (LoRa airtime rule).`,
      delay,
    );
  }
  for (let i = 0; i < params.packets; i += 1) normal.push(now);
}


/** The explicit native !ping compatibility exception has its own 3/10 min budget. */
export function assertNativePingRateLimit(params: { accountId: string; nowMs?: number }): void {
  const now = params.nowMs ?? Date.now();
  const windowMs = 600_000;
  const recent = recentPackets(nativePingBuckets, params.accountId, now - windowMs);
  if (recent.length >= 3) {
    const delay = retryAfterMs(recent, now, windowMs);
    throw new SendRateLimitExceededError(
      "MeshCore native !ping reply budget reached (3 per 10m per account); " +
        "retry after the window slides. This budget is independent of pairing and normal DM sends.",
      delay,
    );
  }
  recent.push(now);
}
