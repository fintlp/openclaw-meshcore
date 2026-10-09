import type { TCPConnection } from "@liamcottle/meshcore.js";
import { updateNodeStatusOps } from "./node-status.js";

export type AdvertScope = "zero-hop" | "flood";

export type AdvertSchedulerConfig = {
  /** Send one advert immediately after connect. */
  advertOnConnect: boolean;
  /** Hours between scheduled adverts; 0 disables the interval. */
  advertIntervalHours: number;
  /** "zero-hop" (direct range) or "flood" (mesh-wide). */
  advertScope: AdvertScope;
};

export type AdvertSchedulerDeps = {
  connection: TCPConnection;
  accountId: string;
  config: AdvertSchedulerConfig;
  log: (message: string) => void;
};

export type AdvertScheduler = {
  /** Send one advert immediately, regardless of config. Returns true on success. */
  sendAdvert: (scope?: AdvertScope) => Promise<boolean>;
  /** Stop the recurring advert timer. */
  dispose: () => void;
};

const ADVERT_SEND_TIMEOUT_MS = 5_000;

function scopeToMethod(connection: TCPConnection, scope: AdvertScope): () => Promise<void> {
  return scope === "flood"
    ? () => connection.sendFloodAdvert()
    : () => connection.sendZeroHopAdvert();
}

function hoursToMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, context: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${context} timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      // Prevent dangling timers on normal completion.
      promise.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
    }),
  ]);
}

/**
 * Start the advert scheduler for a connected MeshCore node.
 *
 * Sends an immediate advert when advertOnConnect is true, then arms a
 * recurring timer when advertIntervalHours > 0. Every send is logged and
 * reflected in the node-status snapshot; failures are logged and swallowed.
 */
export function startAdvertScheduler(deps: AdvertSchedulerDeps): AdvertScheduler {
  const { connection, accountId, config, log } = deps;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let sending = false;

  async function sendAdvert(scope: AdvertScope = config.advertScope): Promise<boolean> {
    if (sending) {
      return false;
    }
    sending = true;

    const send = scopeToMethod(connection, scope);
    try {
      await withTimeout(
        send(),
        ADVERT_SEND_TIMEOUT_MS,
        `${scope} advert send`,
      );
      const nowIso = new Date().toISOString();
      log(`[${accountId}] sent ${scope} advert`);
      updateNodeStatusOps({ lastAdvertAt: nowIso, advertScope: scope }, accountId);
      return true;
    } catch (error) {
      log(
        `[${accountId}] ${scope} advert send failed: ${error instanceof Error ? error.message : String(error ?? "no response (Err)")}`,
      );
      return false;
    } finally {
      sending = false;
    }
  }

  if (config.advertIntervalHours > 0) {
    intervalTimer = setInterval(() => {
      if (sending) {
        log(`[${accountId}] scheduled advert skipped (previous send still in flight)`);
        return;
      }
      void sendAdvert();
    }, hoursToMs(config.advertIntervalHours));
  }

  return {
    sendAdvert: async (scope?: AdvertScope) => {
      return await sendAdvert(scope ?? config.advertScope);
    },
    dispose: () => {
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },
  };
}
