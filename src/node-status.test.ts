import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNodeStatusSnapshot,
  readNodeStatusSnapshot,
  resetNodeStatusStateForTests,
  setNodeStatusPathForTests,
  updateNodeStatusOps,
  writeNodeStatusSnapshot,
} from "./node-status.js";
import { hexToBytes } from "./protocol.js";
import type { MeshcoreSelfInfo } from "./types.js";

function makeSelfInfo(overrides?: Partial<MeshcoreSelfInfo>): MeshcoreSelfInfo {
  return {
    type: 1,
    txPower: 22,
    maxTxPower: 23,
    publicKey: hexToBytes(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    ),
    advLat: 48858900,
    advLon: 2294500,
    reserved: new Uint8Array(16),
    manualAddContacts: 0,
    radioFreq: 869_618_000,
    radioBw: 62_500,
    radioSf: 8,
    radioCr: 8,
    name: "TestNode",
    ...overrides,
  };
}

describe("node status snapshot", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-node-status-"));
    setNodeStatusPathForTests(join(dir, "node-status.json"));
  });

  afterEach(() => {
    resetNodeStatusStateForTests();
  });

  it("writes a snapshot from SelfInfo with decimal-degree position", () => {
    writeNodeStatusSnapshot(makeSelfInfo(), {
      connectionState: "connected",
      since: 1_700_000_000_000,
      reconnectCount: 1,
    });

    const snapshot = readNodeStatusSnapshot()!;
    expect(snapshot.name).toBe("TestNode");
    expect(snapshot.pubkey).toBe(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    );
    expect(snapshot.type).toBe(1);
    expect(snapshot.radio).toEqual({
      freq: 869_618_000,
      bw: 62_500,
      sf: 8,
      cr: { raw: 8, resolved: "4/8" },
    });
    expect(snapshot.txPower).toBe(22);
    expect(snapshot.maxTxPower).toBe(23);
    expect(snapshot.manualAddContacts).toBe(0);
    expect(snapshot.position).toEqual({ lat: 48.8589, lon: 2.2945 });
    expect(snapshot.connectionState).toBe("connected");
    expect(snapshot.since).toBe(new Date(1_700_000_000_000).toISOString());
    expect(snapshot.reconnectCount).toBe(1);
  });

  it("resolves coding-rate denominator to fraction", () => {
    const snapshot = buildNodeStatusSnapshot(
      makeSelfInfo({ radioCr: 5 }),
      {
        connectionState: "connected",
        since: 1_700_000_000_000,
        reconnectCount: 0,
      },
    );
    expect(snapshot.radio.cr).toEqual({ raw: 5, resolved: "4/5" });
  });

  it("handles zero coding-rate denominator gracefully", () => {
    const snapshot = buildNodeStatusSnapshot(
      makeSelfInfo({ radioCr: 0 }),
      {
        connectionState: "connected",
        since: 1_700_000_000_000,
        reconnectCount: 0,
      },
    );
    expect(snapshot.radio.cr).toEqual({ raw: 0, resolved: "4/8" });
  });

  it("preserves restart metadata on connect", () => {
    writeNodeStatusSnapshot(makeSelfInfo(), {
      connectionState: "connected",
      since: 1_700_000_000_000,
      reconnectCount: 3,
      lastRestartReason: "health-monitor-restart",
      lastRestartAt: 1_700_000_000_000,
    });

    const snapshot = readNodeStatusSnapshot()!;
    expect(snapshot.reconnectCount).toBe(3);
    expect(snapshot.lastRestartReason).toBe("health-monitor-restart");
    expect(snapshot.lastRestartAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("updates operational fields without touching SelfInfo data", () => {
    writeNodeStatusSnapshot(makeSelfInfo(), {
      connectionState: "connected",
      since: 1_700_000_000_000,
      reconnectCount: 1,
    });

    updateNodeStatusOps({
      connectionState: "disconnected",
      since: new Date(1_700_000_001_000).toISOString(),
    });

    const snapshot = readNodeStatusSnapshot()!;
    expect(snapshot.name).toBe("TestNode");
    expect(snapshot.position).toEqual({ lat: 48.8589, lon: 2.2945 });
    expect(snapshot.connectionState).toBe("disconnected");
    expect(snapshot.since).toBe(new Date(1_700_000_001_000).toISOString());
    expect(snapshot.reconnectCount).toBe(1);
  });

  it("increments reconnectCount across health-monitor restarts", () => {
    writeNodeStatusSnapshot(makeSelfInfo(), {
      connectionState: "connected",
      since: 1_700_000_000_000,
      reconnectCount: 5,
    });

    const prior = readNodeStatusSnapshot();
    const reconnectCount = (prior?.reconnectCount ?? 0) + 1;
    updateNodeStatusOps({
      reconnectCount,
      lastRestartReason: "health-monitor-restart",
      lastRestartAt: new Date(1_700_000_000_000).toISOString(),
    });

    const snapshot = readNodeStatusSnapshot()!;
    expect(snapshot.reconnectCount).toBe(6);
    expect(snapshot.lastRestartReason).toBe("health-monitor-restart");
  });

  it("writes atomically (tmp + rename)", () => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-node-status-atomic-"));
    setNodeStatusPathForTests(join(dir, "node-status.json"));
    writeNodeStatusSnapshot(makeSelfInfo(), {
      connectionState: "connected",
      since: 1_700_000_000_000,
      reconnectCount: 1,
    });

    const files = new Set(
      readdirSync(dir).filter((f) => f.startsWith("node-status")),
    );
    expect(files).toEqual(new Set(["node-status.json"]));
  });

  it("returns undefined when no snapshot has been written", () => {
    expect(readNodeStatusSnapshot()).toBeUndefined();
  });
});
