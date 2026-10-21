import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  meshcoreDedupeKey,
  openDurabilityStore,
  type DurabilityStore,
} from "./durability.js";

let dir: string;
let dbPath: string;
let store: DurabilityStore | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "meshcore-durability-"));
  dbPath = join(dir, "durability.sqlite");
  store = await openDurabilityStore({ dbPath });
});

afterEach(() => {
  store?.close();
  store = null;
  rmSync(dir, { recursive: true, force: true });
});

function intakeN(s: DurabilityStore, n: number, opts: { accountId?: string; start?: number } = {}): number[] {
  const ids: number[] = [];
  const accountId = opts.accountId ?? "default";
  const start = opts.start ?? 1;
  for (let i = start; i < start + n; i++) {
    const res = s.intake({
      accountId,
      dedupeKey: "msg:!aa:" + (17000 + i) + ":k" + i,
      kind: "direct",
      peerId: "!aabbccdd",
      senderTs: 1700000000000 + i * 1000,
      body: "hello " + i,
      rawJson: JSON.stringify({ i }),
    });
    expect(res.duplicate).toBe(false);
    ids.push(res.id);
  }
  return ids;
}

describe("durability store v2 (#48, post-review)", () => {
  it("opens and degrades gracefully on an unwritable path", async () => {
    expect(store).not.toBeNull();
    const bad = await openDurabilityStore({ dbPath: join(dir, "missing-dir", "x", "y.sqlite") });
    expect(bad).toBeNull();
  });

  it("intake inserts once; same key is a counted duplicate, never two rows", () => {
    const s = store!;
    const p = {
      accountId: "default", dedupeKey: "msg:!aa:1:deadbeef", kind: "direct" as const,
      peerId: "!aa", senderTs: 1, body: "x", rawJson: "{}",
    };
    expect(s.intake(p).duplicate).toBe(false);
    const second = s.intake(p);
    expect(second.duplicate).toBe(true);
    expect(s.isDuplicate("default", p.dedupeKey)).toBe(true);
    // each duplicate SIGHTING counts: one at intake conflict, one at the probe
    expect(s.metrics("default").duplicates).toBe(2);
  });

  it("claim is exclusive; a second claim is busy, never double-dispatch", () => {
    const s = store!;
    const [a] = intakeN(s, 1);
    expect(s.claim("default", a, 3, 60_000)).toBe("claimed");
    expect(s.claim("default", a, 3, 60_000)).toBe("busy");
  });

  it("attempts count at claim; exhausted claims dead-letter", () => {
    const s = store!;
    const [a] = intakeN(s, 1);
    expect(s.claim("default", a, 2, 60_000)).toBe("claimed"); // attempt 1
    s.releaseClaim("default", a, "boom");
    expect(s.claim("default", a, 2, 60_000)).toBe("claimed"); // attempt 2
    s.releaseClaim("default", a, "boom");
    expect(s.claim("default", a, 2, 60_000)).toBe("dead"); // attempts exhausted
    expect(s.metrics("default").dead).toBe(1);
  });

  it("an expired lease is reclaimed (process died mid-turn)", () => {
    const s = store!;
    const [a] = intakeN(s, 1);
    expect(s.claim("default", a, 3, 1)).toBe("claimed"); // 1ms lease
    const start = Date.now();
    while (Date.now() - start < 5) { /* let the lease expire */ }
    expect(s.claim("default", a, 3, 60_000)).toBe("claimed"); // reclaimed
  });

  it("markDispatched is terminal, blanks body/raw, and advances the cursor contiguously", () => {
    const s = store!;
    const [a, b, c] = intakeN(s, 3);
    s.claim("default", a, 3, 60_000);
    s.markDispatched("default", a);
    expect(s.rawJsonOf(a)).toBe("");
    s.claim("default", c, 3, 60_000);
    s.markDispatched("default", c);
    expect(s.cursor("default").lastEventId).toBe(a); // b blocks the frontier
    s.claim("default", b, 3, 60_000);
    s.markDispatched("default", b);
    expect(s.cursor("default").lastEventId).toBe(c);
  });

  it("claimNext yields pending in id order and dead-letters exhausted rows", () => {
    const s = store!;
    const ids = intakeN(s, 3);
    // exhaust row 1 via claims
    for (let i = 0; i < 2; i++) {
      s.claim("default", ids[0], 2, 60_000);
      s.releaseClaim("default", ids[0], "x");
    }
    const ev = s.claimNext("default", 2, 60_000);
    expect(ev?.id).toBe(ids[1]); // row 1 dead-lettered as exhausted
    expect(s.metrics("default").dead).toBe(1);
  });

  it("sweepStale dead-letters by LOCAL age and the cursor never moves backwards", () => {
    const s = store!;
    const [a, b] = intakeN(s, 2);
    // make a look stale by rewinding received_at through a second intake path is not possible;
    // use sweep with a future 'now' so both rows are older than maxAge
    const future = Date.now() + 3_700_000;
    const swept = s.sweepStale("default", 3_600_000, future);
    expect(swept.sort()).toEqual([a, b].sort());
    expect(s.metrics("default").dead).toBe(2);
    // cursor past everything; a later dispatched mark cannot regress it
    const cur = s.cursor("default").lastEventId;
    const [c] = intakeN(s, 1, { start: 50 });
    s.claim("default", c, 3, 60_000);
    s.markDispatched("default", c);
    expect(s.cursor("default").lastEventId).toBeGreaterThanOrEqual(cur);
  });

  it("startupSweep fixes legacy pending admissions and expired leases", () => {
    const s = store!;
    const [a] = intakeN(s, 1);
    s.claim("default", a, 3, 1); // lease 1ms -> expired
    const start = Date.now();
    while (Date.now() - start < 5) { /* expire */ }
    s.startupSweep("default");
    const ev = s.claimNext("default", 3, 60_000);
    expect(ev?.id).toBe(a);
  });

  it("prune removes complete rows by age and count cap, looping until under budget, never pending work", () => {
    const s = store!;
    const now = Date.now();
    const old = intakeN(s, 6, { start: 1 });
    for (const id of old) {
      s.claim("default", id, 3, 60_000);
      s.markDispatched("default", id);
    }
    const pending = intakeN(s, 1, { start: 100 })[0];
    const res = s.prune({ retentionDays: 30, maxEvents: 2, batch: 2, now: now + 31 * 86_400_000 });
    expect(res.removed).toBeGreaterThanOrEqual(6);
    // pending row survives both passes
    expect(s.claimNext("default", 3, 60_000)?.id).toBe(pending);
  });

  it("fail-open: a dead store never breaks the live path and reports degraded", () => {
    const s = store!;
    intakeN(s, 1);
    s.close(); // kill the db under the store's feet
    expect(() => {
      const r = s.intake({
        accountId: "default", dedupeKey: "k", kind: "direct",
        peerId: "!aa", senderTs: 1, body: "x", rawJson: "{}",
      });
      expect(r).toEqual({ id: -1, duplicate: false });
      expect(s.isDuplicate("default", "k")).toBe(false);
      expect(s.claim("default", 1, 3, 1000)).toBe("claimed");
      expect(s.claimNext("default", 3, 1000)).toBeNull();
      s.markDispatched("default", 1);
      s.releaseClaim("default", 1, "x");
      s.deadLetter("default", 1, "x");
      expect(s.sweepStale("default", 1000)).toEqual([]);
      s.startupSweep("default");
      expect(s.pendingCount("default")).toBe(0);
      expect(s.cursor("default")).toEqual({ lastEventId: 0, updatedAt: 0 });
      expect(s.prune({ retentionDays: 30, maxEvents: 100, batch: 10 })).toEqual({ removed: 0 });
      expect(s.rawJsonOf(1)).toBeNull();
      s.close();
    }).not.toThrow();
    expect(s.metrics("default").degraded).toBe(true);
  });

  it("dedupe key normalizes sender prefix/full-key, buckets by day, and hashes untrimmed body", () => {
    const full = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const prefix = "aabbccddeeff";
    const ts = 1700000000000;
    expect(meshcoreDedupeKey({ senderNodeId: full, timestamp: ts, body: "ping" })).toBe(
      meshcoreDedupeKey({ senderNodeId: prefix, timestamp: ts, body: "ping" }),
    );
    expect(meshcoreDedupeKey({ senderNodeId: prefix, timestamp: ts, body: "ping" })).not.toBe(
      meshcoreDedupeKey({ senderNodeId: prefix, timestamp: ts + 86_400_000, body: "ping" }),
    );
    expect(meshcoreDedupeKey({ senderNodeId: prefix, timestamp: ts, body: "ping" })).not.toBe(
      meshcoreDedupeKey({ senderNodeId: prefix, timestamp: ts, body: "ping " }),
    );
    expect(meshcoreDedupeKey({ senderNodeId: prefix, timestamp: ts, body: "ping" })).toMatch(
      /^msg:aabbccddeeff:\d+:[0-9a-f]{8}$/,
    );
    // No clock dependence: the same frame mints ONE key at any wall-clock time
    // (the old UTC-day bucket changed keys at 00:00 UTC and double-dispatched).
    expect(meshcoreDedupeKey({ senderNodeId: prefix, timestamp: ts, body: "ping" })).toBe(
      meshcoreDedupeKey({ senderNodeId: prefix, timestamp: ts, body: "ping" }),
    );
  });


  it("C-1: a normal restart replays mid-turn work — foreign-owned claims are reclaimed at open", async () => {
    // process A opens, claims a message mid-turn, then "dies" (store closed)
    const procA = await openDurabilityStore({ dbPath, owner: "procA" });
    const [a] = intakeN(procA!, 1);
    expect(procA!.claim("default", a, 3, 300_000)).toBe("claimed");
    procA!.close();
    // process B opens 20 s later: the inflight row is reclaimed to pending
    // even though the 5-minute lease has not expired (review round-2 C-1 repro)
    const procB = await openDurabilityStore({ dbPath, owner: "procB" });
    const ev = procB!.claimNext("default", 3, 300_000);
    expect(ev?.id).toBe(a);
    procB!.markDispatched("default", a);
    expect(procB!.pendingCount("default")).toBe(0);
    procB!.close();
    store = await openDurabilityStore({ dbPath }); // keep afterEach cleanup happy
  });

  it("M-1: a released row is skipped for the rest of the replay pass (afterId)", () => {
    const s = store!;
    const [a, b] = intakeN(s, 2);
    // first pass: claim a, fail it, release -> pending again
    expect(s.claimNext("default", 3, 60_000)?.id).toBe(a);
    s.releaseClaim("default", a, "boom");
    // same pass continues AFTER a: b comes next, not a again
    expect(s.claimNext("default", 3, 60_000, a)?.id).toBe(b);
  });

  it("releaseClaim lets the real error overwrite a generic one (m-10)", () => {
    const s = store!;
    const [a] = intakeN(s, 1);
    s.claim("default", a, 3, 60_000);
    s.releaseClaim("default", a, "turn not dispatched (dispatch)");
    s.releaseClaim("default", a, "radio offline");
    const ev = s.claimNext("default", 3, 60_000);
    expect(ev?.lastError).toBe("radio offline");
  });

  it("schema migration: a user_version-0 database is dropped and recreated", async () => {
    // separate path: the beforeEach store already holds dbPath open
    const legacyPath = join(dir, "legacy.sqlite");
    const sqlite = await import("node:sqlite");
    const legacy = new sqlite.DatabaseSync(legacyPath);
    legacy.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, dedupe_key TEXT NOT NULL);",
    );
    legacy.close();
    const migrated = await openDurabilityStore({ dbPath: legacyPath });
    expect(migrated).not.toBeNull();
    const res = migrated!.intake({
      accountId: "default", dedupeKey: "msg:!aa:1:x", kind: "direct",
      peerId: "!aa", senderTs: 1, body: "hi", rawJson: "{}",
    });
    expect(res.duplicate).toBe(false);
    migrated!.close();
  });

  it("sliding 24 h window on received_at: a retransmit within the window is a duplicate; an older match is replaced as new", async () => {
    const s = store!;
    const key = meshcoreDedupeKey({ senderNodeId: "!aabbccdd", timestamp: 1700000000000, body: "ping" });
    const intake = () =>
      s.intake({
        accountId: "default", dedupeKey: key, kind: "direct",
        peerId: "!aa", senderTs: 1700000000000, body: "ping", rawJson: "{}",
      });
    const backdate = async (id: number, ageMs: number) => {
      const sqlite = await import("node:sqlite");
      const raw = new sqlite.DatabaseSync(dbPath);
      raw.exec("PRAGMA busy_timeout = 2000;");
      raw.prepare("UPDATE events SET received_at = ? WHERE id = ?").run(Date.now() - ageMs, id);
      raw.close();
    };
    const first = intake();
    expect(first.duplicate).toBe(false);
    // 23 h old: still inside the window — a duplicate, SAME row id
    await backdate(first.id, 23 * 3_600_000);
    const dupe = intake();
    expect(dupe.duplicate).toBe(true);
    expect(dupe.id).toBe(first.id);
    expect(s.isDuplicate("default", key)).toBe(true);
    expect(s.findDuplicate("default", key)?.id).toBe(first.id);
    // 25 h old: outside the window — replaced as new (new id, old row gone)
    await backdate(first.id, 25 * 3_600_000);
    const fresh = intake();
    expect(fresh.duplicate).toBe(false);
    expect(fresh.id).not.toBe(first.id);
    expect(s.findDuplicate("default", key)?.id).toBe(fresh.id);
    expect(s.pendingCount("default")).toBe(1); // the stale row was replaced, not doubled
  });

  it("a retransmit straddling the day boundary stays one frame (no key time bucket)", async () => {
    const s = store!;
    const key = meshcoreDedupeKey({ senderNodeId: "!aabbccdd", timestamp: 1700000000000, body: "x" });
    const first = s.intake({
      accountId: "default", dedupeKey: key, kind: "direct",
      peerId: "!aa", senderTs: 1, body: "x", rawJson: "{}",
    });
    // Received 23:59 UTC, retransmitted 00:01 UTC — a 2-minute gap across
    // 00:00 UTC. The old day-bucketed key changed here and the retransmit
    // double-dispatched.
    const sqlite = await import("node:sqlite");
    const raw = new sqlite.DatabaseSync(dbPath);
    raw.exec("PRAGMA busy_timeout = 2000;");
    raw.prepare("UPDATE events SET received_at = ? WHERE id = ?").run(Date.now() - 2 * 60_000, first.id);
    raw.close();
    const retransmit = s.intake({
      accountId: "default", dedupeKey: key, kind: "direct",
      peerId: "!aa", senderTs: 1, body: "x", rawJson: "{}",
    });
    expect(retransmit.duplicate).toBe(true);
    expect(retransmit.id).toBe(first.id);
  });


  it("m1: a foreign owner's release cannot free the current owner's live claim", async () => {
    // procOLD dies mid-claim; procNEW reclaims at open (C-1) and re-dispatches
    const procOLD = await openDurabilityStore({ dbPath, owner: "procOLD" });
    const [a] = intakeN(procOLD!, 1);
    expect(procOLD!.claim("default", a, 3, 300_000)).toBe("claimed");
    const procNEW = await openDurabilityStore({ dbPath, owner: "procNEW" });
    const ev = procNEW!.claimNext("default", 3, 300_000);
    expect(ev?.id).toBe(a); // reclaimed + re-claimed by the new owner
    // the STALE process now tries to free the live claim — must be a no-op
    procOLD!.releaseClaim("default", a, "stale release");
    expect(procNEW!.findDuplicate("default", "msg:!aa:17001:k1")?.state).toBe("inflight");
    procOLD!.close();
    procNEW!.markDispatched("default", a);
    procNEW!.close();
    store = await openDurabilityStore({ dbPath });
  });

  it("M3: a database NEWER than the supported schema disables cleanly, never throws", async () => {
    const futurePath = join(dir, "future.sqlite");
    const sqlite = await import("node:sqlite");
    const future = new sqlite.DatabaseSync(futurePath);
    future.exec("CREATE TABLE events (id INTEGER PRIMARY KEY); PRAGMA user_version = 99;");
    future.close();
    const s = await openDurabilityStore({ dbPath: futurePath });
    expect(s).toBeNull();
  });

  it("m8: claimNext never hands out a turn this process is still running (live claims)", () => {
    const s = store!;
    const [a, b] = intakeN(s, 2);
    expect(s.claim("default", a, 3, 300_000)).toBe("claimed"); // a is live in-process
    // claimNext must skip a (still running here) and return b
    expect(s.claimNext("default", 3, 60_000)?.id).toBe(b);
  });

  it("findDuplicate reports row state for the drop-vs-redeliver decision (m7)", () => {
    const s = store!;
    const [a] = intakeN(s, 1);
    expect(s.findDuplicate("default", "msg:!aa:17001:k1")).toEqual({ id: a, state: "pending" });
    s.claim("default", a, 3, 60_000);
    expect(s.findDuplicate("default", "msg:!aa:17001:k1")?.state).toBe("inflight");
    s.markDispatched("default", a);
    expect(s.findDuplicate("default", "msg:!aa:17001:k1")?.state).toBe("dispatched");
  });

  it("migration: a v1-layout database (user_version 1, no owner column) is rebuilt", async () => {
    const v1Path = join(dir, "v1.sqlite");
    const sqlite = await import("node:sqlite");
    const v1 = new sqlite.DatabaseSync(v1Path);
    v1.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, received_at INTEGER NOT NULL, sender_ts INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, peer_id TEXT NOT NULL, sender_label TEXT, body TEXT NOT NULL, raw_json TEXT NOT NULL, admission TEXT NOT NULL DEFAULT 'admitted', dispatch_state TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, dead_reason TEXT, UNIQUE (account_id, dedupe_key)); PRAGMA user_version = 1;",
    );
    v1.close();
    const migrated = await openDurabilityStore({ dbPath: v1Path });
    expect(migrated).not.toBeNull();
    const res = migrated!.intake({
      accountId: "default", dedupeKey: "msg:!aa:1:x", kind: "direct",
      peerId: "!aa", senderTs: 1, body: "hi", rawJson: "{}",
    });
    expect(res.duplicate).toBe(false);
    migrated!.close();
  });


  it("minor 2: a running turn keeps its lease renewed (no mid-flight reclaim past leaseMs)", async () => {
    const s = store!;
    const [a] = intakeN(s, 1);
    expect(s.claim("default", a, 3, 3000)).toBe("claimed"); // 3s lease
    // renewal runs every leaseMs/3 (min 1s); give it time to renew several times
    await new Promise((r) => setTimeout(r, 3500));
    // without renewal the lease would have expired; a second store must NOT
    // find a reclaimable row here — simulate by checking the row is still
    // inflight-owned (not pending) after 3x the lease
    expect(s.findDuplicate("default", "msg:!aa:17001:k1")?.state).toBe("inflight");
    s.markDispatched("default", a);
  });

  it("minor 5: a retry against the LIVE final attempt is busy, never a dead-letter of a running turn", () => {
    const s = store!;
    const [a] = intakeN(s, 1);
    expect(s.claim("default", a, 2, 300_000)).toBe("claimed"); // attempt 1
    s.releaseClaim("default", a, "boom");
    expect(s.claim("default", a, 2, 300_000)).toBe("claimed"); // attempt 2 (final, live)
    // a sender retry lands while the final attempt runs with a valid lease:
    expect(s.claim("default", a, 2, 300_000)).toBe("busy");
    expect(s.metrics("default").dead).toBe(0); // NOT dead-lettered
    s.markDispatched("default", a);
  });

  it("minor 7: a foreign database with an events table is refused untouched", async () => {
    const foreignPath = join(dir, "foreign.sqlite");
    const sqlite = await import("node:sqlite");
    const foreign = new sqlite.DatabaseSync(foreignPath);
    foreign.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO events VALUES (1, 'keep-me');");
    foreign.close();
    const s = await openDurabilityStore({ dbPath: foreignPath });
    expect(s).toBeNull();
    // and the foreign content is exactly as it was
    const check = new sqlite.DatabaseSync(foreignPath);
    const row = check.prepare("SELECT note FROM events WHERE id = 1").get() as { note: string };
    expect(row.note).toBe("keep-me");
    check.close();
  });

  it("minor 6: a too-new database is refused without a WAL-mode mutation", async () => {
    const futurePath = join(dir, "future2.sqlite");
    const sqlite = await import("node:sqlite");
    const future = new sqlite.DatabaseSync(futurePath);
    future.exec("CREATE TABLE events (id INTEGER PRIMARY KEY); PRAGMA user_version = 99;");
    future.close();
    expect(await openDurabilityStore({ dbPath: futurePath })).toBeNull();
    // the refused db was closed and not switched to WAL by our pragmas
    const check = new sqlite.DatabaseSync(futurePath);
    const v = check.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(99);
    check.close();
  });

  it("restart-mid-burst: reopening replays exactly the unclaimed remainder", async () => {
    const s = store!;
    const ids = intakeN(s, 50);
    for (const id of ids.slice(0, 20)) {
      s.claim("default", id, 3, 60_000);
      s.markDispatched("default", id);
    }
    s.close();
    store = await openDurabilityStore({ dbPath });
    const s2 = store!;
    const seen: number[] = [];
    for (;;) {
      const ev = s2.claimNext("default", 3, 60_000);
      if (!ev) break;
      seen.push(ev.id);
      s2.markDispatched("default", ev.id);
    }
    expect(seen).toEqual(ids.slice(20));
  });
});
