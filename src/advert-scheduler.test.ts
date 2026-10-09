import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TCPConnection } from "@liamcottle/meshcore.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdvertScheduler, type AdvertSchedulerConfig } from "./advert-scheduler.js";
import {
  readNodeStatusSnapshot,
  resetNodeStatusStateForTests,
  setNodeStatusPathForTests,
} from "./node-status.js";

describe("advert scheduler", () => {
  let nodeStatusPath: string;
  const sent: Array<{ method: string; scope: string }> = [];
  const logs: string[] = [];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-advert-scheduler-"));
    nodeStatusPath = join(dir, "node-status.json");
    setNodeStatusPathForTests(nodeStatusPath);
    resetNodeStatusStateForTests();
    sent.length = 0;
    logs.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetNodeStatusStateForTests();
    setNodeStatusPathForTests(undefined);
  });

  const accountId = "test-account";

  function makeConnection(overrides: Record<string, unknown> = {}): TCPConnection {
    return {
      sendZeroHopAdvert: vi.fn().mockResolvedValue(undefined),
      sendFloodAdvert: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as TCPConnection;
  }

  function makeConfig(overrides: Partial<AdvertSchedulerConfig> = {}): AdvertSchedulerConfig {
    return {
      advertOnConnect: false,
      advertIntervalHours: 0,
      advertScope: "zero-hop",
      ...overrides,
    };
  }

  it("sends a zero-hop advert on demand", async () => {
    const connection = makeConnection();
    const scheduler = startAdvertScheduler({
      connection,
      accountId,
      config: makeConfig(),
      log: (message) => logs.push(message),
    });

    await scheduler.sendAdvert();

    expect(connection.sendZeroHopAdvert).toHaveBeenCalledTimes(1);
    expect(connection.sendFloodAdvert).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("sent zero-hop advert"))).toBe(true);
  });

  it("sends a flood advert when scoped to flood", async () => {
    const connection = makeConnection();
    const scheduler = startAdvertScheduler({
      connection,
      accountId,
      config: makeConfig({ advertScope: "flood" }),
      log: (message) => logs.push(message),
    });

    await scheduler.sendAdvert();

    expect(connection.sendFloodAdvert).toHaveBeenCalledTimes(1);
    expect(connection.sendZeroHopAdvert).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("sent flood advert"))).toBe(true);
  });

  it("updates the node-status snapshot with lastAdvertAt and advertScope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);

    // Seed a minimal snapshot so readNodeStatusSnapshot can read it back.
    const { writeNodeStatusSnapshot } = await import("./node-status.js");
    writeNodeStatusSnapshot(
      {
        type: 1,
        txPower: 22,
        maxTxPower: 23,
        publicKey: new Uint8Array(32),
        advLat: 0,
        advLon: 0,
        reserved: new Uint8Array(16),
        manualAddContacts: 0,
        radioFreq: 869_525_000,
        radioBw: 62_500,
        radioSf: 8,
        radioCr: 8,
        name: "TestNode",
      },
      {
        connectionState: "connected",
        since: 1_000_000_000_000,
        reconnectCount: 1,
      },
      accountId,
    );

    const scheduler = startAdvertScheduler({
      connection: makeConnection(),
      accountId,
      config: makeConfig({ advertScope: "flood" }),
      log: () => {},
    });

    await scheduler.sendAdvert();

    const snapshot = readNodeStatusSnapshot(accountId)!;
    expect(snapshot.lastAdvertAt).toBe(new Date(1_000_000_000_000).toISOString());
    expect(snapshot.advertScope).toBe("flood");
  });

  it("logs and swallows send errors", async () => {
    const connection = makeConnection({
      sendZeroHopAdvert: vi.fn().mockRejectedValue(new Error("airtime busy")),
    });
    const scheduler = startAdvertScheduler({
      connection,
      accountId,
      config: makeConfig(),
      log: (message) => logs.push(message),
    });

    const result = await scheduler.sendAdvert();

    expect(result).toBe(false);
    expect(logs.some((line) => line.includes("sent zero-hop advert"))).toBe(false);
    expect(logs.some((line) => line.includes("zero-hop advert send failed"))).toBe(true);
  });

  it("does not arm an interval when advertIntervalHours is 0", () => {
    vi.useFakeTimers();
    const connection = makeConnection();
    startAdvertScheduler({
      connection,
      accountId,
      config: makeConfig({ advertIntervalHours: 0 }),
      log: () => {},
    });

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(connection.sendZeroHopAdvert).not.toHaveBeenCalled();
  });

  it("fires a scheduled advert every advertIntervalHours", () => {
    vi.useFakeTimers();
    const connection = makeConnection();
    startAdvertScheduler({
      connection,
      accountId,
      config: makeConfig({ advertIntervalHours: 2 }),
      log: () => {},
    });

    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(connection.sendZeroHopAdvert).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(connection.sendZeroHopAdvert).toHaveBeenCalledTimes(2);
  });

  it("uses the configured scope for scheduled adverts", () => {
    vi.useFakeTimers();
    const connection = makeConnection();
    startAdvertScheduler({
      connection,
      accountId,
      config: makeConfig({ advertIntervalHours: 1, advertScope: "flood" }),
      log: () => {},
    });

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(connection.sendFloodAdvert).toHaveBeenCalledTimes(1);
  });

  it("stops firing after dispose", () => {
    vi.useFakeTimers();
    const connection = makeConnection();
    const scheduler = startAdvertScheduler({
      connection,
      accountId,
      config: makeConfig({ advertIntervalHours: 1 }),
      log: () => {},
    });

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(connection.sendZeroHopAdvert).toHaveBeenCalledTimes(1);

    scheduler.dispose();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(connection.sendZeroHopAdvert).toHaveBeenCalledTimes(1);
  });

  it("does not double-fire when sendAdvert is called while a scheduled advert is due", async () => {
    vi.useFakeTimers();
    const connection = makeConnection();
    const scheduler = startAdvertScheduler({
      connection,
      accountId,
      config: makeConfig({ advertIntervalHours: 1 }),
      log: () => {},
    });

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(connection.sendZeroHopAdvert).toHaveBeenCalledTimes(1);

    await scheduler.sendAdvert();
    expect(connection.sendZeroHopAdvert).toHaveBeenCalledTimes(2);
  });
});
