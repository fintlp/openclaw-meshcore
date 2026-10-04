import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  attachSendConfirmedHandler,
  clearSendConfirmedStateForTests,
  connectMeshcoreDevice,
  disconnectMeshcoreDevice,
  waitForSendConfirmed,
} from "./device-client.js";

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
      setImmediate(() => {
        this.emit(original.Constants.ResponseCodes.SelfInfo, {
        type: 1,
        txPower: 20,
        maxTxPower: 22,
        publicKey: new Uint8Array(32).fill(2),
        advLat: 0,
        advLon: 0,
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
});
