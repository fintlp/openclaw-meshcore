import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pairingBudgetStateSizeForTests,
  resetPairingRequestBudgetForTests,
  runPairingChallenge,
  type PairingChallengeIssueOutcome,
} from "./pairing-budget.js";
import { PAIRING_DEFAULT_REPLY_PACKETS } from "./pairing-constants.js";
import { countMeshcorePairingReplyPackets } from "./pairing-reply.js";

const NOW = 1_800_000_000_000;
const key = (n: number) => "!" + n.toString(16).padStart(64, "0");
const REAL_REPLY_PACKETS = countMeshcorePairingReplyPackets({
  senderIdLine: "Your MeshCore node id: " + key(1),
});
const success = async (): Promise<PairingChallengeIssueOutcome> => ({
  created: true,
  replyDelivered: true,
});

afterEach(() => resetPairingRequestBudgetForTests());

describe("pairing request containment", () => {
  it("measures three packets for the real host-shaped reply", () => {
    expect(REAL_REPLY_PACKETS).toBe(3);
    expect(REAL_REPLY_PACKETS).toBe(PAIRING_DEFAULT_REPLY_PACKETS);
  });

  it("reserves at most three delivered new challenges per account per ten minutes", async () => {
    const issue = vi.fn(success);
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
    const issue = vi.fn(success);
    const base = { accountId: "default", nodeId: key(1), maxSends: 20, issue };
    expect((await runPairingChallenge({ ...base, nowMs: NOW })).issued).toBe(true);
    expect(await runPairingChallenge({ ...base, nowMs: NOW + 1_000 })).toMatchObject({
      issued: false, reason: "cooldown",
    });
    expect((await runPairingChallenge({ ...base, nowMs: NOW + 60_001 })).issued).toBe(true);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent same-key requests before issueChallenge", async () => {
    let release!: (outcome: PairingChallengeIssueOutcome) => void;
    const gate = new Promise<PairingChallengeIssueOutcome>((resolve) => { release = resolve; });
    const issue = vi.fn(() => gate);
    const base = { accountId: "default", nodeId: key(1), maxSends: 20, nowMs: NOW, issue };
    const first = runPairingChallenge(base);
    const second = runPairingChallenge(base);
    expect(issue).toHaveBeenCalledTimes(1);
    release({ created: true, replyDelivered: true });
    expect(await first).toMatchObject({ issued: true, coalesced: false });
    expect(await second).toMatchObject({ issued: true, coalesced: true });
  });

  it.each([
    { maxSends: 1, reason: "max-sends-too-low" },
    { maxSends: 2, reason: "pairing-reply-too-large" },
    { maxSends: 3, reason: "pairing-reply-too-large" },
  ])("rejects the real three-chunk reply at maxSends:$maxSends", async ({ maxSends, reason }) => {
    const issue = vi.fn(success);
    expect(await runPairingChallenge({
      accountId: "default",
      nodeId: key(1),
      maxSends,
      requiredPackets: REAL_REPLY_PACKETS,
      nowMs: NOW,
      issue,
    })).toMatchObject({ issued: false, reason });
    expect(issue).not.toHaveBeenCalled();
  });

  it.each([4, 20])("admits the real three-chunk reply at maxSends:%i", async (maxSends) => {
    const issue = vi.fn(success);
    expect(await runPairingChallenge({
      accountId: "default",
      nodeId: key(1),
      maxSends,
      requiredPackets: REAL_REPLY_PACKETS,
      nowMs: NOW,
      issue,
    })).toMatchObject({ issued: true, coalesced: false });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("does not spend account slots when the host reports an already-pending key", async () => {
    const pending = vi.fn(async (): Promise<PairingChallengeIssueOutcome> => ({
      created: false,
      replyDelivered: false,
    }));
    for (let n = 0; n < 6; n += 1) {
      expect(await runPairingChallenge({
        accountId: "default",
        nodeId: key(1),
        maxSends: 20,
        requiredPackets: REAL_REPLY_PACKETS,
        nowMs: NOW + n * 60_001,
        issue: pending,
      })).toMatchObject({ issued: false, coalesced: true, reason: "already-pending" });
    }
    expect(pending).toHaveBeenCalledTimes(6);

    const issue = vi.fn(success);
    for (let n = 2; n <= 4; n += 1) {
      expect((await runPairingChallenge({
        accountId: "default", nodeId: key(n), maxSends: 20,
        nowMs: NOW + 400_000 + n, issue,
      })).issued).toBe(true);
    }
    expect(await runPairingChallenge({
      accountId: "default", nodeId: key(5), maxSends: 20,
      nowMs: NOW + 400_005, issue,
    })).toMatchObject({ issued: false, reason: "budget" });
    expect(issue).toHaveBeenCalledTimes(3);
  });

  it("releases a failed-delivery reservation and coalesces the surviving host pending record", async () => {
    const issue = vi.fn()
      .mockResolvedValueOnce({ created: true, replyDelivered: false })
      .mockResolvedValueOnce({ created: false, replyDelivered: false })
      .mockImplementation(success);
    expect(await runPairingChallenge({
      accountId: "default", nodeId: key(1), maxSends: 20, nowMs: NOW, issue,
    })).toMatchObject({ issued: false, reason: "delivery-failed" });
    expect(await runPairingChallenge({
      accountId: "default", nodeId: key(1), maxSends: 20, nowMs: NOW + 60_001, issue,
    })).toMatchObject({ issued: false, coalesced: true, reason: "already-pending" });

    for (let n = 2; n <= 4; n += 1) {
      expect((await runPairingChallenge({
        accountId: "default", nodeId: key(n), maxSends: 20,
        nowMs: NOW + 120_000 + n, issue,
      })).issued).toBe(true);
    }
    expect(await runPairingChallenge({
      accountId: "default", nodeId: key(5), maxSends: 20,
      nowMs: NOW + 120_005, issue,
    })).toMatchObject({ issued: false, reason: "budget" });
  });

  it("bounds per-key tracking state under a long spray", async () => {
    const issue = vi.fn(success);
    for (let n = 1; n <= 300; n += 1) {
      await runPairingChallenge({
        accountId: "default", nodeId: key(n), maxSends: 20,
        nowMs: NOW + n * 600_001, issue,
      });
    }
    expect(pairingBudgetStateSizeForTests("default")).toBeLessThanOrEqual(256);
  });
});
