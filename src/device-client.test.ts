import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  attachSendConfirmedHandler,
  clearSendConfirmedStateForTests,
  waitForSendConfirmed,
} from "./device-client.js";

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
