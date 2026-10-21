/**
 * Durability store v2 — at-least-once inbound delivery across gateway restarts
 * (issue #48; spec + adversarial review round 1 in the issue comments).
 *
 * Guarantees this module makes (and nothing more):
 *  - A frame admitted for session dispatch is logged BEFORE dispatch work.
 *  - Dispatch is claimed with a lease and counted BEFORE the turn runs, so
 *    process deaths count as attempts and crash-loops dead-letter.
 *  - The cursor never moves backwards and only covers contiguous complete
 *    rows; stale pending rows are dead-lettered by local age, never skipped.
 *  - Terminal states blank body/raw_json: at rest we keep dedupe keys, not
 *    conversations.
 *  - Any store failure degrades to continue-without-durability (fail-open,
 *    sticky degraded flag) — durability never makes delivery worse.
 *
 * What it cannot guarantee (documented, not hidden): a turn accepted into the
 * host in-memory follow-up queue is only as durable as the host process;
 * a restart there can duplicate or lose the queued follow-up.
 */

export type DurabilityConfig = {
  enabled: boolean;
  retentionDays: number;
  maxEvents: number;
  pruneBatch: number;
  /** Max age (ms) a pending event may reach before dead-lettered as stale at replay. Default 1h. */
  maxReplayAgeMs: number;
  maxDispatchAttempts: number;
  /** Lease (ms) for a claimed dispatch; a crash reclaims after expiry. */
  leaseMs: number;
  dbPath?: string;
};

export const DEFAULT_DURABILITY_CONFIG: DurabilityConfig = {
  enabled: true,
  retentionDays: 30,
  maxEvents: 50_000,
  pruneBatch: 1_000,
  maxReplayAgeMs: 3_600_000,
  maxDispatchAttempts: 3,
  leaseMs: 300_000,
};

export type DurabilityDispatchState = "pending" | "inflight" | "dispatched" | "dead";

export type DurabilityEvent = {
  id: number;
  accountId: string;
  dedupeKey: string;
  receivedAt: number; // local gateway clock
  senderTs: number; // sender clock (untrusted)
  kind: "direct" | "group";
  peerId: string;
  senderLabel: string | null;
  admission: string;
  dispatchState: DurabilityDispatchState;
  attempts: number;
  lastError: string | null;
};

export type ClaimResult = "claimed" | "busy" | "dead";
export type IntakeResult = { id: number; duplicate: boolean };
export type DurabilityMetrics = {
  pending: number;
  dead: number;
  oldestPendingAt: number | null;
  duplicates: number;
  degraded: boolean;
};

export type DurabilityStore = {
  /** Insert an admitted frame (admission happens before intake by design). */
  intake(params: {
    accountId: string;
    dedupeKey: string;
    kind: "direct" | "group";
    peerId: string;
    senderLabel?: string;
    senderTs: number;
    body: string;
    rawJson: string;
  }): IntakeResult;
  /** Read-only duplicate probe (before any dispatch work, incl. commands). */
  isDuplicate(accountId: string, dedupeKey: string): boolean;
  /** Duplicate probe WITH row state — a hit on a pending/inflight row means redeliver, not drop (review round-3 m7). */
  findDuplicate(accountId: string, dedupeKey: string): { id: number; state: DurabilityDispatchState } | null;
  /** Atomically claim a dispatch slot; counts the attempt. */
  claim(accountId: string, id: number, maxAttempts: number, leaseMs: number): ClaimResult;
  /** Atomically claim the oldest pending event for replay (optionally after a given id); null when none. */
  claimNext(accountId: string, maxAttempts: number, leaseMs: number, afterId?: number): DurabilityEvent | null;
  /** Terminal: mark dispatched, blank body/raw, advance cursor. */
  markDispatched(accountId: string, id: number): void;
  /** Release a claim back to pending with the error noted. */
  releaseClaim(accountId: string, id: number, error: string): void;
  /** Terminal dead-letter with reason (corrupt payload, stale, exhausted). */
  deadLetter(accountId: string, id: number, reason: string): void;
  /** Dead-letter old pending rows by LOCAL age; returns ids. */
  sweepStale(accountId: string, maxAgeMs: number, now?: number): number[];
  /** Startup maintenance: legacy pending admissions, expired leases. */
  startupSweep(accountId: string): void;
  pendingCount(accountId: string): number;
  cursor(accountId: string): { lastEventId: number; updatedAt: number };
  /** Prune complete rows by age then count cap, looping until under budget. */
  prune(params: { retentionDays: number; maxEvents: number; batch: number; now?: number }): { removed: number };
  /** Unconditional WAL truncate checkpoint (blanked bytes must not linger in the WAL). */
  checkpoint(): void;
  metrics(accountId: string): DurabilityMetrics;
  /** Raw message payload for a claimed replay event. */
  rawJsonOf(id: number): string | null;
  close(): void;
};

type SqliteStatement = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

// v2 adds the owner column. Policy note: the drop-and-recreate migration
// wipes pending rows — acceptable only because no pre-v2 db ever shipped;
// the NEXT schema change must write a real migration.
const SCHEMA_VERSION = 2;
// Stamped on our databases so migration NEVER touches a foreign file that
// happens to contain an events table (review round-4 minor 7).
const APPLICATION_ID = 0x6d634452; // "mcDR"
const SCHEMA =
  "CREATE TABLE IF NOT EXISTS events (" +
  " id INTEGER PRIMARY KEY AUTOINCREMENT," +
  " account_id TEXT NOT NULL," +
  " dedupe_key TEXT NOT NULL," +
  " received_at INTEGER NOT NULL," +
  " sender_ts INTEGER NOT NULL DEFAULT 0," +
  " kind TEXT NOT NULL," +
  " peer_id TEXT NOT NULL," +
  " sender_label TEXT," +
  " body TEXT NOT NULL," +
  " raw_json TEXT NOT NULL," +
  " admission TEXT NOT NULL DEFAULT 'admitted'," +
  " dispatch_state TEXT NOT NULL DEFAULT 'pending'," +
  " lease_until INTEGER," +
  " owner TEXT," +
  " attempts INTEGER NOT NULL DEFAULT 0," +
  " last_error TEXT," +
  " dead_reason TEXT," +
  " UNIQUE (account_id, dedupe_key));" +
  "CREATE INDEX IF NOT EXISTS idx_events_account_id ON events (account_id, id);" +
  "CREATE TABLE IF NOT EXISTS cursors (" +
  " account_id TEXT PRIMARY KEY," +
  " last_event_id INTEGER NOT NULL DEFAULT 0," +
  " updated_at INTEGER NOT NULL);" +
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);" +
  "PRAGMA user_version = " + SCHEMA_VERSION + ";";

const INCOMPLETE = "admission = 'admitted' AND dispatch_state IN ('pending','inflight')";

type EventRow = {
  id: number; account_id: string; dedupe_key: string; received_at: number;
  sender_ts: number; kind: string; peer_id: string; sender_label: string | null;
  body: string; raw_json: string; admission: string; dispatch_state: string;
  attempts: number; last_error: string | null;
};

function toEvent(row: EventRow): DurabilityEvent {
  return {
    id: row.id,
    accountId: row.account_id,
    dedupeKey: row.dedupe_key,
    receivedAt: row.received_at,
    senderTs: row.sender_ts,
    kind: row.kind === "group" ? "group" : "direct",
    peerId: row.peer_id,
    senderLabel: row.sender_label,
    admission: row.admission,
    dispatchState: row.dispatch_state as DurabilityDispatchState,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

/** Unique id for this process's claims; foreign-owned in-flight rows are reclaimed at open. */
const PROCESS_OWNER =
  process.pid + ":" + Date.now().toString(36) + ":" + Math.random().toString(36).slice(2, 8);

export async function openDurabilityStore(params: {
  dbPath: string;
  log?: (msg: string) => void;
  /** Test hook: override the process-owner tag. */
  owner?: string;
}): Promise<DurabilityStore | null> {
  const log = params.log ?? (() => {});
  const owner = params.owner ?? PROCESS_OWNER;
  let DatabaseSync: new (path: string) => SqliteDatabase;
  try {
    const mod = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    DatabaseSync = mod.DatabaseSync;
  } catch (err) {
    log("durability: node:sqlite unavailable (" + (err instanceof Error ? err.message : String(err)) + ") — inbound durability disabled");
    return null;
  }
  let db: SqliteDatabase | null = null;
  try {
    db = new DatabaseSync(params.dbPath);
    // Version/ownership checks come FIRST (round-4 minor 6): never mutate a
    // database we are about to refuse.
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const existingVersion = versionRow?.user_version ?? 0;
    const appIdRow = db.prepare("PRAGMA application_id").get() as { application_id: number };
    const appId = appIdRow?.application_id ?? 0;
    if (existingVersion > SCHEMA_VERSION) {
      log(`durability: database schema v${existingVersion} is newer than supported v${SCHEMA_VERSION} — disabled`);
      db.close();
      return null;
    }
    const hasEvents = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
    if (hasEvents && appId !== APPLICATION_ID) {
      // Ours-or-foreign discriminator (round-4 minor 7 + migration tests):
      // OUR legacy tables carry account_id + dedupe_key; a foreign events
      // table with a different shape is refused untouched.
      const cols = (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      const isOurs = cols.includes("account_id") && cols.includes("dedupe_key");
      if (!isOurs) {
        log("durability: file contains a foreign events table (not ours) — disabled, left untouched");
        db.close();
        return null;
      }
    }
    if (hasEvents && existingVersion < SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS cursors; DROP TABLE IF EXISTS meta;");
    }
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 1500;");
    db.exec("PRAGMA secure_delete = ON;");
    db.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
    db.exec(SCHEMA);
    // C-1 (review round 2): reclaim every in-flight row owned by ANOTHER
    // process, regardless of lease expiry — a normal restart replays mid-turn
    // work instead of abandoning it to the stale sweeper.
    db.prepare(
      "UPDATE events SET dispatch_state = 'pending', lease_until = NULL, owner = NULL" +
      " WHERE dispatch_state = 'inflight' AND (owner IS NULL OR owner != ?)",
    ).run(owner);

  const qIntake = db.prepare(
    "INSERT INTO events (account_id, dedupe_key, received_at, sender_ts, kind, peer_id, sender_label, body, raw_json)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" +
    " ON CONFLICT (account_id, dedupe_key) DO NOTHING",
  );
  const qFindDup = db.prepare("SELECT id, received_at, dispatch_state FROM events WHERE account_id = ? AND dedupe_key = ?");
  // Live in-process claims (review round-3 m8): an in-process reconnect must
  // not reclaim a turn this process is still running.
  const liveClaims = new Set<number>();
  // Lease renewal (round-4 minor 2): while a turn runs, its lease is renewed
  // every leaseMs/3 so a >leaseMs turn is never reclaimed mid-flight.
  const renewTimers = new Map<number, ReturnType<typeof setInterval>>();
  const qRenew = db.prepare(
    "UPDATE events SET lease_until = ? WHERE id = ? AND dispatch_state = 'inflight' AND owner = ?",
  );
  const startRenewal = (id: number, leaseMs: number): void => {
    stopRenewal(id);
    const timer = setInterval(() => {
      try {
        qRenew.run(Date.now() + leaseMs, id, owner);
      } catch {
        /* fail-open wrapper handles reporting */
      }
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    (timer as unknown as { unref?: () => void }).unref?.();
    renewTimers.set(id, timer);
  };
  const stopRenewal = (id: number): void => {
    const timer = renewTimers.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      renewTimers.delete(id);
    }
  };
  const qBumpDup = db.prepare(
    "INSERT INTO meta (key, value) VALUES ('duplicates', 1)" +
    " ON CONFLICT (key) DO UPDATE SET value = value + 1",
  );
  const qDupCount = db.prepare("SELECT value FROM meta WHERE key = 'duplicates'");
  const qClaim = db.prepare(
    "UPDATE events SET dispatch_state = 'inflight', lease_until = ?, owner = ?, attempts = attempts + 1" +
    " WHERE id = ? AND (dispatch_state = 'pending' OR (dispatch_state = 'inflight' AND lease_until < ?))",
  );
  const qClaimState = db.prepare("SELECT dispatch_state, attempts, lease_until FROM events WHERE id = ?");
  const qDead = db.prepare(
    "UPDATE events SET dispatch_state = 'dead', dead_reason = ?, body = '', raw_json = ''" +
    " WHERE id = ? AND dispatch_state IN ('pending','inflight') AND (owner IS NULL OR owner = ?)",
  );
  const qOldestPending = db.prepare(
    "SELECT * FROM events WHERE account_id = ? AND id > ? AND admission = 'admitted' AND (" +
    " dispatch_state = 'pending' OR (dispatch_state = 'inflight' AND lease_until < ?))" +
    " ORDER BY id LIMIT 1",
  );
  const qDispatched = db.prepare(
    "UPDATE events SET dispatch_state = 'dispatched', last_error = NULL, lease_until = NULL, owner = NULL, body = '', raw_json = ''" +
    " WHERE id = ? AND dispatch_state IN ('pending','inflight') AND (owner IS NULL OR owner = ?)",
  );
  // pending is included so a later release can overwrite last_error with the
  // real error (review m-10); dispatched/dead stay terminal.
  const qRelease = db.prepare(
    "UPDATE events SET dispatch_state = 'pending', lease_until = NULL, owner = NULL, last_error = ?" +
    " WHERE id = ? AND dispatch_state IN ('inflight','pending') AND (owner IS NULL OR owner = ?)",
  );
  const qFirstIncomplete = db.prepare(
    "SELECT MIN(id) AS first FROM events WHERE account_id = ? AND (" + INCOMPLETE + ")",
  );
  const qMaxId = db.prepare("SELECT COALESCE(MAX(id), 0) AS maxid FROM events WHERE account_id = ?");
  const qCursorUpsert = db.prepare(
    "INSERT INTO cursors (account_id, last_event_id, updated_at) VALUES (?, ?, ?)" +
    " ON CONFLICT (account_id) DO UPDATE SET" +
    " last_event_id = MAX(last_event_id, excluded.last_event_id)," +
    " updated_at = excluded.updated_at",
  );
  const qCursor = db.prepare("SELECT last_event_id, updated_at FROM cursors WHERE account_id = ?");
  const qSweepStale = db.prepare(
    "UPDATE events SET dispatch_state = 'dead', dead_reason = 'stale', body = '', raw_json = ''" +
    " WHERE account_id = ? AND dispatch_state = 'pending' AND received_at < ?",
  );
  const qStaleIds = db.prepare(
    "SELECT id FROM events WHERE account_id = ? AND dispatch_state = 'pending' AND received_at < ?",
  );
  const qSweepLegacy = db.prepare(
    "UPDATE events SET admission = 'admitted' WHERE account_id = ? AND admission = 'pending'",
  );
  const qReclaimLeases = db.prepare(
    "UPDATE events SET dispatch_state = 'pending', lease_until = NULL, owner = NULL" +
    " WHERE account_id = ? AND dispatch_state = 'inflight' AND lease_until < ?",
  );
  const qPendingCount = db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND (" + INCOMPLETE + ")",
  );
  const qMetricsPending = db.prepare(
    "SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM events" +
    " WHERE account_id = ? AND (" + INCOMPLETE + ")",
  );
  const qMetricsDead = db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE account_id = ? AND dispatch_state = 'dead'",
  );
  const qPruneAge = db.prepare(
    "DELETE FROM events WHERE id IN (" +
    " SELECT id FROM events WHERE received_at < ? AND NOT (" + INCOMPLETE + ") LIMIT ?)",
  );
  const qCount = db.prepare("SELECT COUNT(*) AS n FROM events");
  const qPruneCap = db.prepare(
    "DELETE FROM events WHERE id IN (" +
    " SELECT id FROM events WHERE NOT (" + INCOMPLETE + ") ORDER BY id LIMIT ?)",
  );
  const qRaw = db.prepare("SELECT raw_json FROM events WHERE id = ?");
  const advanceCursor = (accountId: string): void => {
    const first = (qFirstIncomplete.get(accountId) as { first: number | null }).first;
    const maxId = (qMaxId.get(accountId) as { maxid: number }).maxid;
    const frontier = (first ?? maxId + 1) - 1;
    qCursorUpsert.run(accountId, frontier, Date.now());
  };

  const store: DurabilityStore = {
    intake(p) {
      const existing = qFindDup.get(p.accountId, p.dedupeKey) as { id: number; received_at: number } | undefined;
      if (existing) {
        qBumpDup.run();
        return { id: existing.id, duplicate: true };
      }
      const res = qIntake.run(
        p.accountId, p.dedupeKey, Date.now(), p.senderTs, p.kind, p.peerId,
        p.senderLabel ?? null, p.body, p.rawJson,
      );
      if (Number(res.changes) === 1) {
        return { id: Number(res.lastInsertRowid), duplicate: false };
      }
      const row = qFindDup.get(p.accountId, p.dedupeKey) as { id: number } | undefined;
      qBumpDup.run();
      return { id: row?.id ?? -1, duplicate: true };
    },

    isDuplicate(accountId, dedupeKey) {
      const found = qFindDup.get(accountId, dedupeKey) !== undefined;
      if (found) {
        qBumpDup.run();
      }
      return found;
    },

    findDuplicate(accountId, dedupeKey) {
      const row = qFindDup.get(accountId, dedupeKey) as
        | { id: number; dispatch_state: string }
        | undefined;
      if (!row) {
        return null;
      }
      qBumpDup.run();
      return { id: row.id, state: row.dispatch_state as DurabilityDispatchState };
    },

    claim(accountId, id, maxAttempts, leaseMs) {
      void accountId;
      // Unknown ids are not a dispatch verdict (review M-2): a fail-open
      // intake returns id -1, and callers dispatch without durability.
      if (id < 0) return "busy";
      // Exhaustion is checked BEFORE the atomic claim: a pending row whose
      // attempts are spent must dead-letter, never claim again.
      const prior = qClaimState.get(id) as { dispatch_state: string; attempts: number } | undefined;
      if (!prior) return "dead";
      if (prior.dispatch_state === "dispatched" || prior.dispatch_state === "dead") return "dead";
      if (prior.attempts >= maxAttempts) {
        // Minor 5: a retry against a LIVE final attempt is busy, not a
        // dead-letter of a turn that is still running.
        const leaseUntil = (prior as unknown as { lease_until?: number }).lease_until ?? 0;
        if (prior.dispatch_state === "inflight" && leaseUntil >= Date.now()) {
          return "busy";
        }
        qDead.run("attempts-exhausted", id, owner);
        return "dead";
      }
      const now = Date.now();
      const res = qClaim.run(now + leaseMs, owner, id, now);
      if (Number(res.changes) === 1) {
        liveClaims.add(id);
        startRenewal(id, leaseMs);
        return "claimed";
      }
      return "busy";
    },

    claimNext(accountId, maxAttempts, leaseMs, afterId = 0) {
      const now = Date.now();
      for (let guard = 0; guard < 1000; guard++) {
        const row = qOldestPending.get(accountId, afterId, now) as EventRow | undefined;
        if (!row) return null;
        afterId = row.id;
        if (row.attempts >= maxAttempts) {
          qDead.run("attempts-exhausted", row.id, owner);
          advanceCursor(accountId);
          continue;
        }
        if (liveClaims.has(row.id)) {
          // m8: skip turns this process is actively running — but a wedged
          // turn whose lease expired is retried (and forgotten) instead of
          // blocking the row forever.
          const leaseUntil = (row as unknown as { lease_until?: number }).lease_until ?? 0;
          if (leaseUntil >= now) {
            continue;
          }
          liveClaims.delete(row.id);
        }
        const res = qClaim.run(now + leaseMs, owner, row.id, now);
        if (Number(res.changes) !== 1) continue;
        liveClaims.add(row.id);
        startRenewal(row.id, leaseMs);
        return toEvent({ ...row, dispatch_state: "inflight", attempts: row.attempts + 1 });
      }
      log("durability: claimNext guard limit hit — pending rows remain");
      return null;
    },

    markDispatched(accountId, id) {
      qDispatched.run(id, owner);
      liveClaims.delete(id);
      stopRenewal(id);
      advanceCursor(accountId);
    },

    releaseClaim(accountId, id, error) {
      qRelease.run(error.slice(0, 500), id, owner);
      liveClaims.delete(id);
      stopRenewal(id);
      void accountId;
    },

    deadLetter(accountId, id, reason) {
      qDead.run(reason.slice(0, 100), id, owner);
      liveClaims.delete(id);
      stopRenewal(id);
      advanceCursor(accountId);
    },

    sweepStale(accountId, maxAgeMs, now = Date.now()) {
      const cutoff = now - maxAgeMs;
      const ids = (qStaleIds.all(accountId, cutoff) as Array<{ id: number }>).map((r) => r.id);
      if (ids.length > 0) {
        qSweepStale.run(accountId, cutoff);
        advanceCursor(accountId);
      }
      return ids;
    },

    startupSweep(accountId) {
      qSweepLegacy.run(accountId);
      qReclaimLeases.run(accountId, Date.now());
    },

    pendingCount(accountId) {
      return (qPendingCount.get(accountId) as { n: number }).n;
    },

    cursor(accountId) {
      const cur = qCursor.get(accountId) as { last_event_id: number; updated_at: number } | undefined;
      return { lastEventId: cur?.last_event_id ?? 0, updatedAt: cur?.updated_at ?? 0 };
    },

    prune(p) {
      const now = p.now ?? Date.now();
      const cutoff = now - p.retentionDays * 86_400_000;
      let removed = 0;
      for (let i = 0; i < 50; i++) {
        const n = Number(qPruneAge.run(cutoff, p.batch).changes);
        removed += n;
        if (n < p.batch) break;
      }
      for (let i = 0; i < 50; i++) {
        const total = (qCount.get() as { n: number }).n;
        if (total <= p.maxEvents) break;
        const n = Number(qPruneCap.run(Math.min(total - p.maxEvents, p.batch)).changes);
        removed += n;
        if (n === 0) break;
      }
      if (removed > 0) {
        // Actually erase blanked bodies from the WAL (review round-2 m-4).
        db!.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      }
      return { removed };
    },

    checkpoint() {
      db!.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    },

    metrics(accountId) {
      const p = qMetricsPending.get(accountId) as { n: number; oldest: number | null };
      const d = qMetricsDead.get(accountId) as { n: number };
      const dup = (qDupCount.get() as { value: number } | undefined)?.value ?? 0;
      return { pending: p.n, dead: d.n, oldestPendingAt: p.oldest, duplicates: dup, degraded: false };
    },

    rawJsonOf(id) {
      return (qRaw.get(id) as { raw_json: string } | undefined)?.raw_json ?? null;
    },

    close() {
      try {
        renewTimers.forEach((_, id) => stopRenewal(id));
        db!.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        db!.close();
      } catch {
        /* already closed */
      }
    },
  };

  return makeFailOpen(store, log);
  } catch (err) {
    log("durability: cannot open " + params.dbPath + " (" + (err instanceof Error ? err.message : String(err)) + ") — inbound durability disabled");
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Fail-open wrapper: a store error must never make delivery WORSE than no
 * durability. First failure flips a sticky degraded flag (visible via
 * metrics) and logs rate-limited; every call answers the
 * continue-without-durability default.
 */
function makeFailOpen(store: DurabilityStore, log: (msg: string) => void): DurabilityStore {
  let degraded = false;
  let lastLogAt = 0;
  const note = (key: string, err: unknown) => {
    degraded = true;
    const now = Date.now();
    if (now - lastLogAt > 60_000) {
      lastLogAt = now;
      log(
        "durability: " + key + " failed (" + (err instanceof Error ? err.message : String(err)) + ") — continuing without durability (degraded)",
      );
    }
  };
  const defaults: Record<string, () => unknown> = {
    intake: () => ({ id: -1, duplicate: false }),
    isDuplicate: () => false,
    findDuplicate: () => null,
    checkpoint: () => undefined,
    claim: () => "claimed",
    claimNext: () => null,
    markDispatched: () => undefined,
    releaseClaim: () => undefined,
    deadLetter: () => undefined,
    sweepStale: () => [],
    startupSweep: () => undefined,
    pendingCount: () => 0,
    cursor: () => ({ lastEventId: 0, updatedAt: 0 }),
    prune: () => ({ removed: 0 }),
    metrics: () => ({ pending: 0, dead: 0, oldestPendingAt: null, duplicates: 0, degraded: true }),
    rawJsonOf: () => null,
    close: () => undefined,
  };
  const wrapped = {} as Record<string, (...args: unknown[]) => unknown>;
  for (const key of Object.keys(defaults)) {
    const fn = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[key];
    wrapped[key] = (...args: unknown[]) => {
      try {
        const result = fn.apply(store, args);
        if (key === "metrics" && result && typeof result === "object") {
          return { ...(result as Record<string, unknown>), degraded };
        }
        return result;
      } catch (err) {
        note(key, err);
        return defaults[key]();
      }
    };
  }
  return wrapped as unknown as DurabilityStore;
}

/**
 * Stable dedupe key for a normalized inbound message. The companion protocol
 * has no packet id; key on the sender 6-byte pubkey prefix (stable across
 * prefix-to-full-key upgrades), the sender-day (bounds staleness of unsynced
 * clocks), the sender timestamp, and an FNV-1a hash of the UNTRIMMED body.
 */
export function meshcoreDedupeKey(params: {
  senderNodeId: string;
  timestamp: number;
  body: string;
}): string {
  // Hex senders normalize to the 6-byte pubkey prefix (stable across
  // prefix-to-full-key upgrades); non-hex senders stay verbatim (no collapse).
  const hex = params.senderNodeId.toLowerCase().replace(/[^0-9a-f]/g, "");
  const sender = hex.length >= 12 ? hex.slice(0, 12) : params.senderNodeId;
  // The local receive-day bounds how long a clock-less sender's identical
  // frame can be dropped as a duplicate (~24h, review nit).
  const localDay = Math.floor(Date.now() / 86_400_000);
  let hash = 0x811c9dc5;
  const s = params.body;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return "msg:" + sender + ":" + localDay + ":" + params.timestamp + ":" + hash.toString(16).padStart(8, "0");
}
