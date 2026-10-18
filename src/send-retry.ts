/**
 * DM delivery-report auto-retry (issue #25): optionally retransmit a DM when
 * the node reports definitive non-delivery — the SendConfirmed push for the
 * final frame's ack tag never arrives within the firmware's estimated ACK
 * window (the same signal the MeshOS app surfaces as a red cross).
 *
 * LoRa airtime is a shared commons, so retries are:
 * - OFF by default (conservative send doctrine),
 * - bounded (maxAttempts counts the initial send, so 2 = one retry),
 * - backed off (a fixed backoff between attempts doubles as the late-ACK
 *   guard window: a confirm arriving during backoff cancels the retry, so a
 *   late delivery report never triggers a duplicate send),
 * - airtime-counted (every attempt passes through the sendRateLimit flood
 *   guard again; a refused retry stops the loop whole, never partially aired).
 */

export type SendRetryConfig = {
  enabled: boolean;
  /** Maximum total transmission attempts, including the initial send. */
  maxAttempts: number;
  /** Fixed backoff between attempts in milliseconds. */
  backoffMs: number;
};

export const SEND_RETRY_DEFAULTS: SendRetryConfig = {
  enabled: false,
  maxAttempts: 2,
  backoffMs: 30_000,
};

const MAX_ATTEMPTS_CAP = 5;
const BACKOFF_MS_MIN = 1_000;
const BACKOFF_MS_MAX = 600_000;

export function resolveSendRetryConfig(
  raw: Record<string, unknown> | undefined,
): SendRetryConfig {
  const retry = raw ?? {};
  return {
    enabled: typeof retry.enabled === "boolean" ? retry.enabled : SEND_RETRY_DEFAULTS.enabled,
    maxAttempts:
      typeof retry.maxAttempts === "number" &&
      Number.isInteger(retry.maxAttempts) &&
      retry.maxAttempts >= 1
        ? Math.min(retry.maxAttempts, MAX_ATTEMPTS_CAP)
        : SEND_RETRY_DEFAULTS.maxAttempts,
    backoffMs:
      typeof retry.backoffMs === "number" && retry.backoffMs >= BACKOFF_MS_MIN
        ? Math.min(retry.backoffMs, BACKOFF_MS_MAX)
        : SEND_RETRY_DEFAULTS.backoffMs,
  };
}

/**
 * Thrown when every attempt's delivery report timed out: the message was
 * transmitted but the mesh never confirmed delivery. Only reachable when
 * sendRetry is enabled; with the default config the send path stays
 * fire-and-forget and never throws for missing delivery reports.
 */
export class MeshcoreDeliveryFailedError extends Error {
  readonly attempts: number;

  constructor(message: string, attempts: number) {
    super(message);
    this.name = "MeshcoreDeliveryFailedError";
    this.attempts = attempts;
  }
}

/**
 * Lower/upper bounds for the delivery-report wait. The wait derives from the
 * firmware's own estTimeout (the same window the MeshOS app uses before
 * flagging non-delivery), clamped so a degenerate firmware value cannot make
 * the wait meaningless or hold the send queue hostage.
 */
export const DELIVERY_REPORT_TIMEOUT_MIN_MS = 500;
export const DELIVERY_REPORT_TIMEOUT_MAX_MS = 30_000;

export function resolveDeliveryReportTimeoutMs(params: {
  estTimeoutMs?: number;
  fallbackMs: number;
}): number {
  const base =
    typeof params.estTimeoutMs === "number" && params.estTimeoutMs > 0
      ? params.estTimeoutMs
      : params.fallbackMs;
  return Math.max(
    DELIVERY_REPORT_TIMEOUT_MIN_MS,
    Math.min(DELIVERY_REPORT_TIMEOUT_MAX_MS, Math.ceil(base)),
  );
}
