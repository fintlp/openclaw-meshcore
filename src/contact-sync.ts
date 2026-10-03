import type { ContactBookEntry } from "./contact-book.js";

export type ContactSyncDeps = {
  getContacts: () => Promise<Array<Record<string, unknown>>>;
  rememberContact: (
    entry: Partial<Omit<ContactBookEntry, "publicKey">> & { publicKey: Uint8Array },
  ) => void;
  debugLog?: (message: string) => void;
};

function normalizeUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }
  return undefined;
}

/**
 * Fetch the node's full contact list and feed every entry into the contact book.
 * Failures are swallowed: this is a best-effort metadata back-fill and must not
 * disturb the active connection.
 */
export async function syncContactsFromNode(deps: ContactSyncDeps): Promise<void> {
  try {
    const contacts = await deps.getContacts();
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
      deps.rememberContact({
        publicKey: bytes,
        type: typeof contact.type === "number" ? contact.type : undefined,
        flags: typeof contact.flags === "number" ? contact.flags : undefined,
        outPathLen:
          typeof contact.outPathLen === "number" ? contact.outPathLen : undefined,
        outPath: normalizeUint8Array(contact.outPath),
        advName: typeof contact.advName === "string" ? contact.advName : undefined,
        lastAdvert:
          typeof contact.lastAdvert === "number" ? contact.lastAdvert : undefined,
        advLat: typeof contact.advLat === "number" ? contact.advLat : undefined,
        advLon: typeof contact.advLon === "number" ? contact.advLon : undefined,
        lastMod: typeof contact.lastMod === "number" ? contact.lastMod : undefined,
      });
    }
  } catch (error) {
    deps.debugLog?.(`[meshcore contact-sync] sync failed: ${String(error)}`);
  }
}

/**
 * Create a trailing-edge debounced wrapper around {@link syncContactsFromNode}.
 * At most one sync is scheduled within the window; the timer is cleared on dispose.
 */
export function createDebouncedContactSync(
  deps: ContactSyncDeps & { debounceMs: number },
): {
  schedule: () => void;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule: () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void syncContactsFromNode(deps);
      }, deps.debounceMs);
    },
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
