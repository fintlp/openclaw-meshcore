import type { ContactBookEntry } from "./contact-book.js";

export type ContactSyncDeps = {
  getContacts: () => Promise<Array<Record<string, unknown>>>;
  rememberContact: (
    entry: Partial<Omit<ContactBookEntry, "publicKey">> & { publicKey: Uint8Array },
    accountId: string,
    maxEntries?: number,
  ) => void;
  accountId: string;
  contactBookMaxEntries?: number;
  log: (message: string) => void;
  debugLog?: (message: string) => void;
};

const DEFAULT_GET_CONTACTS_TIMEOUT_MS = 10_000;

function normalizeUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }
  return undefined;
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
 * Fetch the node's full contact list and feed every entry into the contact book.
 * Failures are swallowed: this is a best-effort metadata back-fill and must not
 * disturb the active connection.
 */
export async function syncContactsFromNode(deps: ContactSyncDeps): Promise<void> {
  try {
    const contacts = await withTimeout(
      deps.getContacts(),
      DEFAULT_GET_CONTACTS_TIMEOUT_MS,
      "getContacts",
    );
    if (!Array.isArray(contacts)) {
      deps.debugLog?.(
        `[meshcore contact-sync] getContacts returned non-array: ${typeof contacts}`,
      );
      return;
    }
    for (const contact of contacts) {
      if (!contact || typeof contact !== "object") {
        continue;
      }
      const pk = contact.publicKey;
      const bytes = normalizeUint8Array(pk);
      if (!bytes || bytes.length !== 32) {
        continue;
      }
      // readCString(32) returns undefined when the name fills all 32 bytes with
      // no NUL terminator. Normalize to "" here so downstream code only sees a
      // string. Issue #11: maximal-length names without a NUL remain a known
      // limitation and are intentionally NOT treated as missing metadata.
      //
      // This normalization is defensive: rememberContact already collapses
      // undefined and "" to the existing name, but the sync layer must not pass
      // a non-string value (e.g. "undefined") that would overwrite an existing
      // name. Issue #18 item 2.
      const advName =
        typeof contact.advName === "string"
          ? contact.advName
          : contact.advName === undefined
            ? ""
            : String(contact.advName);
      deps.rememberContact(
        {
          publicKey: bytes,
          type: typeof contact.type === "number" ? contact.type : undefined,
          flags: typeof contact.flags === "number" ? contact.flags : undefined,
          outPathLen:
            typeof contact.outPathLen === "number" ? contact.outPathLen : undefined,
          outPath: normalizeUint8Array(contact.outPath),
          advName,
          lastAdvert:
            typeof contact.lastAdvert === "number" ? contact.lastAdvert : undefined,
          advLat: typeof contact.advLat === "number" ? contact.advLat : undefined,
          advLon: typeof contact.advLon === "number" ? contact.advLon : undefined,
          lastMod: typeof contact.lastMod === "number" ? contact.lastMod : undefined,
        },
        deps.accountId,
        deps.contactBookMaxEntries,
      );
    }
  } catch (error) {
    deps.log(
      `[meshcore contact-sync] sync failed for ${deps.accountId}: ${String(error)}`,
    );
  }
}

/**
 * Create a throttled wrapper around {@link syncContactsFromNode}.
 *
 * The first schedule() arms a fixed window; any schedule() calls inside the
 * window are ignored. When the window expires the sync runs once. A schedule()
 * after the window has expired arms a new window. This is a throttle, not a
 * debounce: repeated calls do not reset or extend the delay.
 */
export function createThrottledContactSync(
  deps: ContactSyncDeps & { throttleMs: number },
): {
  schedule: () => void;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  return {
    schedule: () => {
      if (timer || running) return;
      timer = setTimeout(() => {
        timer = null;
        running = true;
        void syncContactsFromNode(deps).finally(() => {
          running = false;
        });
      }, deps.throttleMs);
    },
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
