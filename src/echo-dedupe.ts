const DEFAULT_TTL_MS = 120_000;
const DEFAULT_MAX = 200;

const recentOutbound = new Map<string, number>();

function prune(now: number, ttlMs: number, max: number): void {
  for (const [text, at] of recentOutbound) {
    if (now - at > ttlMs) {
      recentOutbound.delete(text);
    }
  }
  while (recentOutbound.size > max) {
    const oldest = recentOutbound.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    recentOutbound.delete(oldest);
  }
}

export function rememberOutboundEcho(
  text: string,
  opts?: { ttlMs?: number; max?: number },
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const now = Date.now();
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const max = opts?.max ?? DEFAULT_MAX;
  recentOutbound.set(trimmed, now);
  prune(now, ttlMs, max);
}

export function isOutboundEcho(text: string, opts?: { ttlMs?: number }): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const at = recentOutbound.get(trimmed);
  if (at === undefined) {
    return false;
  }
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  if (Date.now() - at > ttlMs) {
    recentOutbound.delete(trimmed);
    return false;
  }
  return true;
}

export function clearOutboundEchoCache(): void {
  recentOutbound.clear();
}
