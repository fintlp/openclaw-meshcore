import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDurabilityStore } from "./durability.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meshcore-failopen-repro-"));
  dbPath = join(dir, "durability.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("repro: fail-open claim on a persisted event", () => {
  it("returns busy after store failure, while replay can still claim the same row", async () => {
    const store = await openDurabilityStore({ dbPath });
    expect(store).not.toBeNull();
    const intake = store!.intake({
      accountId: "default",
      dedupeKey: "msg:!aa:1:failopen-repro",
      kind: "direct",
      peerId: "!aa",
      senderTs: 1,
      body: "hello",
      rawJson: JSON.stringify({ text: "hello" }),
    });
    expect(intake.id).toBeGreaterThan(0);

    // Force the wrapped store's underlying SQLite call to fail. The public
    // fail-open wrapper is what the live inbound path uses.
    store!.close();
    const verdict = store!.claim("default", intake.id, 3, 30_000);

    // A failed claim must not authorize a live dispatch. The row remains
    // pending and can be retried by startup replay instead of duplicated.
    expect(verdict).toBe("busy");

    // Reopen the same DB: the failed live claim did not dispatch or count an
    // attempt, so startup replay can still claim the row exactly once.
    const reopened = await openDurabilityStore({ dbPath });
    expect(reopened).not.toBeNull();
    const replay = reopened!.claimNext("default", 3, 30_000);
    expect(replay?.id).toBe(intake.id);
    reopened!.close();
  });
});
