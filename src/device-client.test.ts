import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Constants } from "@liamcottle/meshcore.js";
import {
  attachSendConfirmedHandler,
  clearSendConfirmedStateForTests,
  connectMeshcoreDevice,
  disconnectMeshcoreDevice,
  waitForSendConfirmed,
} from "./device-client.js";
import {
  readNodeStatusSnapshot,
  resetNodeStatusStateForTests,
  setNodeStatusPathForTests,
} from "./node-status.js";

const fakeMode = vi.hoisted(() => ({
  mode: "full" as "full" | "no-self-info",
  selfInfoAdvLat: 0,
  selfInfoAdvLon: 0,
  setAdvertLatLongShouldFail: false,
}));

vi.mock("@liamcottle/meshcore.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  const original = await importOriginal<typeof import("@liamcottle/meshcore.js")>();

  class FakeTCPConnection extends EventEmitter {
    constructor(
      public host: string,
      public port: number,
    ) {
      super();
    }

    async connect() {
      // Emit synchronously so the connect promise resolves immediately; defer
      // SelfInfo to the next event-loop iteration so the handshake listener is
      // already registered.
      this.emit("connected");
      if (fakeMode.mode === "no-self-info") {
        // Simulate a node that never answers SelfInfo. Other connect-time fetches
        // must still run (issue #20).
        return;
      }
      setImmediate(() => {
        this.emit(original.Constants.ResponseCodes.SelfInfo, {
        type: 1,
        txPower: 20,
        maxTxPower: 22,
        publicKey: new Uint8Array(32).fill(2),
        advLat: fakeMode.selfInfoAdvLat,
        advLon: fakeMode.selfInfoAdvLon,
        reserved: new Uint8Array(0),
        manualAddContacts: 0,
        radioFreq: 868,
        radioBw: 125000,
        radioSf: 7,
        radioCr: 8,
        name: "testnode",
        });
      });
    }

    close() {
      this.emit("disconnected");
    }

    setAdvertLatLongCalls: Array<{ lat: number; lon: number }> = [];

    async setAdvertLatLong(latitude: number, longitude: number) {
      this.setAdvertLatLongCalls.push({ lat: latitude, lon: longitude });
      if (fakeMode.setAdvertLatLongShouldFail) {
        throw new Error("setAdvertLatLong failed");
      }
    }

    async sendCommandDeviceQuery() {
      setImmediate(() => {
        this.emit(original.Constants.ResponseCodes.DeviceInfo, {
        firmwareVer: 1,
        reserved: new Uint8Array(0),
        firmware_build_date: "2026-10-01",
        manufacturerModel: "testmodel",
        });
      });
    }

    async sendCommandGetContacts() {
      setImmediate(() => {
        this.emit(original.Constants.ResponseCodes.Contact, {
        publicKey: new Uint8Array(32).fill(1),
        type: 0,
        flags: 0,
        outPathLen: 0,
        outPath: new Uint8Array(0),
        advName: "friend",
        lastAdvert: 0,
        advLat: 0,
        advLon: 0,
        lastMod: 0,
        });
        this.emit(original.Constants.ResponseCodes.EndOfContacts);
      });
    }

    async sendCommandGetBatteryVoltage() {
      setImmediate(() => {
        this.emit(original.Constants.ResponseCodes.BatteryVoltage, {
        batteryMilliVolts: 4200,
        });
      });
    }

    async sendCommandGetChannel(idx: number) {
      setImmediate(() => {
        this.emit(original.Constants.ResponseCodes.ChannelInfo, {
        channelIdx: idx,
        name: `ch${idx}`,
        secret: Array.from(new Uint8Array(16).fill(idx)),
        });
      });
    }
  }

  return {
    ...original,
    TCPConnection: FakeTCPConnection,
  };
});

type FakeConnection = {
  on: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string | number, listener: (...args: unknown[]) => void) => unknown;
  emit: (event: string | number, ...args: unknown[]) => boolean;
};

function createFakeConnection(): FakeConnection {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
}

describe("waitForSendConfirmed per-frame ack correlation", () => {
  beforeEach(() => {
    clearSendConfirmedStateForTests();
  });

  afterEach(() => {
    clearSendConfirmedStateForTests();
  });

  it("releases only the waiter whose expectedAckCode matches the confirm", async () => {
    const connection = createFakeConnection();
    attachSendConfirmedHandler(connection as never, "acct-match");

    const waiting = waitForSendConfirmed({
      accountId: "acct-match",
      expectedAckCode: 42,
      timeoutMs: 50,
    });

    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    // A confirm with a different tag must NOT release the waiter.
    connection.emit(0x82, { ackCode: 7, roundTrip: 10 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    // The matching tag releases it.
    connection.emit(0x82, { ackCode: 42, roundTrip: 10 });
    await expect(waiting).resolves.toEqual({ ackCode: 42, roundTrip: 10 });
  });

  it("never credits a confirm that matched no waiter to a later frame (no buffering)", async () => {
    const connection = createFakeConnection();
    attachSendConfirmedHandler(connection as never, "acct-stale");

    // A confirm for a frame whose waiter already timed out arrives with nobody
    // listening. It must be dropped, not buffered for a future frame.
    connection.emit(0x82, { ackCode: 9, roundTrip: 10 });

    // A waiter expecting that same tag later must time out — the stale confirm
    // is gone, so a real round trip is still required.
    const waiting = waitForSendConfirmed({
      accountId: "acct-stale",
      expectedAckCode: 9,
      timeoutMs: 20,
    });
    await expect(waiting).resolves.toEqual({ timeout: true });
  });

  it("ignores a waiter without an expected tag (fail-closed)", async () => {
    const connection = createFakeConnection();
    attachSendConfirmedHandler(connection as never, "acct-untagged");

    const waiting = waitForSendConfirmed({
      accountId: "acct-untagged",
      timeoutMs: 20,
    });
    // An arbitrary confirm must not release an uncorrelatable waiter.
    connection.emit(0x82, { ackCode: 123, roundTrip: 10 });
    await expect(waiting).resolves.toEqual({ timeout: true });
  });
});

describe("connectMeshcoreDevice numeric response code handshake", () => {
  beforeEach(() => {
    fakeMode.mode = "full";
    fakeMode.selfInfoAdvLat = 0;
    fakeMode.selfInfoAdvLon = 0;
    fakeMode.setAdvertLatLongShouldFail = false;
    const dir = mkdtempSync(join(tmpdir(), "meshcore-device-client-"));
    setNodeStatusPathForTests(join(dir, "node-status.json"));
  });

  afterEach(() => {
    setNodeStatusPathForTests(undefined);
    resetNodeStatusStateForTests();
  });

  it("populates selfInfo, deviceInfo, contacts, batteryMv and channels when the node emits numeric response codes", async () => {
    const handle = await connectMeshcoreDevice({
      accountId: "acct-numeric-handshake",
      host: "127.0.0.1",
      port: 5000,
    });

    try {
      expect(handle.selfInfo).toBeDefined();
      expect(handle.selfInfo?.name).toBe("testnode");
      expect(handle.selfInfo?.publicKey).toEqual(new Uint8Array(32).fill(2));

      expect(handle.deviceInfo).toBeDefined();
      expect(handle.deviceInfo?.manufacturerModel).toBe("testmodel");

      expect(handle.contacts.length).toBe(1);
      expect(handle.contacts[0]?.advName).toBe("friend");

      expect(handle.batteryMv).toBe(4200);

      expect(handle.channels.length).toBe(8);
      expect(handle.channels[0]?.name).toBe("ch0");
      expect(handle.channels[7]?.name).toBe("ch7");
      expect(handle.connected).toBe(true);
    } finally {
      await disconnectMeshcoreDevice("acct-numeric-handshake");
    }
  });

  it("isolates a lost SelfInfo response so DeviceInfo, contacts, channels and battery still populate (issue #20)", async () => {
    fakeMode.mode = "no-self-info";
    const handle = await connectMeshcoreDevice({
      accountId: "acct-no-selfinfo",
      host: "127.0.0.1",
      port: 5000,
      handshakeTimeoutMs: 50,
    });

    try {
      expect(handle.selfInfo).toBeUndefined();

      expect(handle.deviceInfo).toBeDefined();
      expect(handle.deviceInfo?.manufacturerModel).toBe("testmodel");

      expect(handle.contacts.length).toBe(1);
      expect(handle.contacts[0]?.advName).toBe("friend");

      expect(handle.batteryMv).toBe(4200);

      expect(handle.channels.length).toBe(8);
      expect(handle.channels[0]?.name).toBe("ch0");

      // Each fetch must clean up its own listener; no leak from the timed-out
      // SelfInfo wait.
      expect(handle.connection.listenerCount(Constants.ResponseCodes.SelfInfo)).toBe(0);
      expect(handle.connection.listenerCount(Constants.ResponseCodes.DeviceInfo)).toBe(0);
      expect(handle.connection.listenerCount(Constants.ResponseCodes.Contact)).toBe(0);
      expect(handle.connection.listenerCount(Constants.ResponseCodes.EndOfContacts)).toBe(0);
      expect(handle.connection.listenerCount(Constants.ResponseCodes.ChannelInfo)).toBe(0);
      expect(handle.connection.listenerCount(Constants.ResponseCodes.BatteryVoltage)).toBe(0);
    } finally {
      await disconnectMeshcoreDevice("acct-no-selfinfo");
    }
  });

  it("skips advert position correction when advertLat/advertLon are unset", async () => {
    const handle = await connectMeshcoreDevice({
      accountId: "acct-no-advert-override",
      host: "127.0.0.1",
      port: 5000,
    });

    try {
      const conn = handle.connection as unknown as { setAdvertLatLongCalls: Array<{ lat: number; lon: number }> };
      expect(conn.setAdvertLatLongCalls).toHaveLength(0);
      const snapshot = readNodeStatusSnapshot()!;
      expect(snapshot.position).toEqual({ lat: 0, lon: 0 });
    } finally {
      await disconnectMeshcoreDevice("acct-no-advert-override");
    }
  });

  it("applies advert position correction when config differs beyond epsilon", async () => {
    fakeMode.selfInfoAdvLat = 48_858900;
    fakeMode.selfInfoAdvLon = 2_294500;

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const handle = await connectMeshcoreDevice({
      accountId: "acct-advert-correct",
      host: "127.0.0.1",
      port: 5000,
      advertLat: 50.123456,
      advertLon: 10.987654,
    });

    try {
      const conn = handle.connection as unknown as { setAdvertLatLongCalls: Array<{ lat: number; lon: number }> };
      expect(conn.setAdvertLatLongCalls).toEqual([{ lat: 50.123456, lon: 10.987654 }]);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("corrected advertised position"),
      );
      const snapshot = readNodeStatusSnapshot()!;
      expect(snapshot.position.lat).toBeCloseTo(50.123456, 6);
      expect(snapshot.position.lon).toBeCloseTo(10.987654, 6);
    } finally {
      consoleSpy.mockRestore();
      await disconnectMeshcoreDevice("acct-advert-correct");
    }
  });

  it("skips advert position correction when difference is within epsilon", async () => {
    fakeMode.selfInfoAdvLat = 48_858900;
    fakeMode.selfInfoAdvLon = 2_294500;

    const handle = await connectMeshcoreDevice({
      accountId: "acct-advert-near",
      host: "127.0.0.1",
      port: 5000,
      advertLat: 48.858905,
      advertLon: 2.294505,
    });

    try {
      const conn = handle.connection as unknown as { setAdvertLatLongCalls: Array<{ lat: number; lon: number }> };
      expect(conn.setAdvertLatLongCalls).toHaveLength(0);
      const snapshot = readNodeStatusSnapshot()!;
      expect(snapshot.position).toEqual({ lat: 48.8589, lon: 2.2945 });
    } finally {
      await disconnectMeshcoreDevice("acct-advert-near");
    }
  });

  it("logs correction failures to console.error and keeps the connection", async () => {
    fakeMode.selfInfoAdvLat = 0;
    fakeMode.selfInfoAdvLon = 0;
    fakeMode.setAdvertLatLongShouldFail = true;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handle = await connectMeshcoreDevice({
      accountId: "acct-advert-fail",
      host: "127.0.0.1",
      port: 5000,
      advertLat: 10,
      advertLon: 20,
    });

    try {
      expect(handle.connected).toBe(true);
      const conn = handle.connection as unknown as {
        setAdvertLatLongCalls: Array<{ lat: number; lon: number }>;
      };
      expect(conn.setAdvertLatLongCalls).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to apply advertised position correction"),
      );
    } finally {
      consoleSpy.mockRestore();
      await disconnectMeshcoreDevice("acct-advert-fail");
    }
  });
});
