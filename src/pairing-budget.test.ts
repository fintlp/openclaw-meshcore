import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pairingBudgetStateSizeForTests,
  resetPairingRequestBudgetForTests,
  runPairingChallenge,
} from "./pairing-budget.js";

const NOW = 1_800_000_000_000;
const key = (n: number) => "!" + n.toString(16).padStart(64, "0");

afterEach(() => resetPairingRequestBudgetForTests());

describe("pairing request containment", () => {
  it("reserves at most three requests per account per ten minutes", async () => {
    const issue = vi.fn(async () => {});
    for (let n = 1; n <= 3; n += 1) {
      const r = await runPairingChallenge({
        accountId: "default", nodeId: key(n), maxSends: 20, nowMs: NOW + n, issue,
      });
      expect(r).toMatchObject({ issued: true, coalesced: false });
    }
    const refused = await runPairingChallenge({
      accountId: "default", nodeId: key(4), maxSends: 20, nowMs: NOW + 4, issue,
    });
    expect(refused).toMatchObject({ issued: false, reason: "budget" });
    expect(issue).toHaveBeenCalledTimes(3);

    const otherAccount = await runPairingChallenge({
      accountId: "other", nodeId: key(4), maxSends: 20, nowMs: NOW + 4, issue,
    });
    expect(otherAccount.issued).toBe(true);
    expect(issue).toHaveBeenCalledTimes(4);
  });

  it("applies a per-key cooldown independently of the account budget", async () => {
    const issue = vi.fn(async () => {});
    const base = { accountId: "default", nodeId: key(1), maxSends: 20, issue };
    expect((await runPairingChallenge({ ...base, nowMs: NOW })).issued).toBe(true);
    expect(await runPairingChallenge({ ...base, nowMs: NOW + 1_000 })).toMatchObject({
      issued: false, reason: "cooldown",
    });
    expect((await runPairingChallenge({ ...base, nowMs: NOW + 60_001 })).issued).toBe(true);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent same-key requests before issueChallenge", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const issue = vi.fn(() => gate);
    const base = { accountId: "default", nodeId: key(1), maxSends: 20, nowMs: NOW, issue };
    const first = runPairingChallenge(base);
    const second = runPairingChallenge(base);
    expect(issue).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ issued: true, coalesced: false });
    expect(await second).toMatchObject({ issued: true, coalesced: true });
  });

  it("rejects maxSends:1 at intake without invoking issueChallenge", async () => {
    const issue = vi.fn(async () => {});
    expect(await runPairingChallenge({
      accountId: "default", nodeId: key(1), maxSends: 1, nowMs: NOW, issue,
    })).toMatchObject({ issued: false, reason: "max-sends-too-low" });
    expect(issue).not.toHaveBeenCalled();
  });

  it("bounds per-key tracking state under a long spray", async () => {
    const issue = vi.fn(async () => {});
    for (let n = 1; n <= 300; n += 1) {
      await runPairingChallenge({
        accountId: "default", nodeId: key(n), maxSends: 20,
        nowMs: NOW + n * 600_001, issue,
      });
    }
    expect(pairingBudgetStateSizeForTests("default")).toBeLessThanOrEqual(256);
  });
});
