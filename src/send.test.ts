import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { estimateChunkAirtimeMs, resolveSendPacingConfig } from "./airtime.js";
import { clearSendConfirmedStateForTests } from "./device-client.js";
import { clearOutboundEchoCache, isOutboundEcho } from "./echo-dedupe.js";
import { clearPacingStateForTests } from "./pacing.js";
import { MeshcoreSendAbortedError, sendMessageMeshcore } from "./send.js";
import type { CoreConfig } from "./types.js";

const TEST_NODE_ID = "!00000000000000000000000000000000000000000000000000000000aabbccdd";

const { connectMeshcoreDeviceMock, getMeshcoreDeviceMock } = vi.hoisted(() => ({
  connectMeshcoreDeviceMock: vi.fn(),
  getMeshcoreDeviceMock: vi.fn(),
}));

vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return {
    ...actual,
    connectMeshcoreDevice: connectMeshcoreDeviceMock,
    getMeshcoreDevice: getMeshcoreDeviceMock,
  };
});

function createConfig(overrides?: Partial<CoreConfig["channels"]["meshcore"]>): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        port: 5000,
        // Most existing tests exercise chunking/pacing logic, not numbering.
        // Disable numbering by default; chunk-numbering tests opt-in explicitly.
        chunkNumbering: false,
        // Most existing tests exercise chunking logic, not pacing. Disable
        // pacing by default so they stay fast; pacing tests opt-in explicitly.
        sendPacing: { enabled: false },
        ...overrides,
      },
    },
  } as CoreConfig;
}

function createDeviceHandle(
  sendTextMessage: ReturnType<typeof vi.fn>,
  selfInfo?: object,
  opts?: { emitSendConfirmed?: boolean },
) {
  const emitter = new EventEmitter();
  const handle = {
    accountId: "default",
    connection: {
      sendTextMessage,
      on: emitter.on.bind(emitter) as (event: string | number, listener: (...args: unknown[]) => void) => void,
      off: emitter.off.bind(emitter) as (event: string | number, listener: (...args: unknown[]) => void) => void,
      once: emitter.once.bind(emitter) as (event: string | number, listener: (...args: unknown[]) => void) => void,
      emit: emitter.emit.bind(emitter) as (event: string | number, ...args: unknown[]) => boolean,
      listenerCount: emitter.listenerCount.bind(emitter) as (event: string | number) => number,
    },
    connected: true,
    contacts: [],
    channels: [],
    ...(selfInfo ? { selfInfo } : {}),
  };

  if (opts?.emitSendConfirmed) {
    // Each successful sendTextMessage emits a SendConfirmed (0x82) push after a
    // small synthetic round-trip, exercising the FIFO ack-pacing path.
    sendTextMessage.mockImplementation(async () => {
      setTimeout(() => {
        handle.connection.emit(0x82, { ackCode: 1, roundTrip: 500 });
      }, 5);
      return { expectedAckCrc: 1 };
    });
  }

  return handle;
}

describe("sendMessageMeshcore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOutboundEchoCache();
    clearPacingStateForTests();
    clearSendConfirmedStateForTests();
  });

  afterEach(() => {
    clearOutboundEchoCache();
    vi.clearAllMocks();
    clearPacingStateForTests();
    clearSendConfirmedStateForTests();
  });

  it("sends a DM and returns a receipt", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 12345 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const result = await sendMessageMeshcore(TEST_NODE_ID, "hello mesh", {
      cfg: createConfig(),
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "hello mesh",
    );
    expect(result.target).toBe(TEST_NODE_ID);
    expect(result.messageId).toBe("12345");
    expect(result.receipt.platformMessageIds).toEqual(["12345"]);
  });

  it("connects when no cached device handle exists", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 67890 }));
    getMeshcoreDeviceMock.mockReturnValue(undefined);
    connectMeshcoreDeviceMock.mockResolvedValue(createDeviceHandle(sendTextMessage));

    await sendMessageMeshcore(TEST_NODE_ID, "connect and send", {
      cfg: createConfig(),
    });

    expect(connectMeshcoreDeviceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        host: "192.0.2.10",
        port: 5000,
      }),
    );
    expect(sendTextMessage).toHaveBeenCalledWith(expect.any(Uint8Array), "connect and send");
  });

  it("rejects group targets to preserve LoRa airtime", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    await expect(
      sendMessageMeshcore("channel:0", "broadcast forbidden", {
        cfg: createConfig(),
      }),
    ).rejects.toThrow(/receive-only/);

    await expect(
      sendMessageMeshcore("broadcast", "broadcast forbidden", {
        cfg: createConfig(),
      }),
    ).rejects.toThrow(/receive-only/);

    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("marks outbound text before sendTextMessage so local echo is dropped", async () => {
    const sendTextMessage = vi.fn(async (_pubkey: Uint8Array, text: string) => {
      expect(isOutboundEcho(text)).toBe(true);
      return { expectedAckCrc: 42 };
    });
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    await sendMessageMeshcore(TEST_NODE_ID, "echo marker test", {
      cfg: createConfig(),
    });

    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "echo marker test",
    );
  });

  it("chunks long text without splitting surrogate pairs", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    await sendMessageMeshcore(TEST_NODE_ID, "😀😀😀", {
      cfg: createConfig({ textChunkLimit: 8 }),
    });

    // 8-byte limit fits two 4-byte emoji per chunk; no surrogate pair is split.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), "😀😀");
    expect(sendTextMessage).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), "😀");
  });

  it("chunks by UTF-8 byte length so multibyte text is never truncated on air", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const encoder = new TextEncoder();
    // 40 code points but 80+ bytes thanks to em-dashes — must span several chunks.
    const text = Array.from({ length: 10 }, () => "word — ").join("");
    const limit = 30;

    await sendMessageMeshcore(TEST_NODE_ID, text, {
      cfg: createConfig({ textChunkLimit: limit }),
    });

    expect(sendTextMessage.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendTextMessage.mock.calls) {
      const chunkText = call[1] as string;
      expect(encoder.encode(chunkText).length).toBeLessThanOrEqual(limit);
    }
    // Nothing lost: concatenated chunks reproduce every word.
    const reassembled = sendTextMessage.mock.calls.map((c) => c[1] as string).join(" ");
    expect(reassembled.split(/\s+/).filter((w) => w === "word")).toHaveLength(10);
    expect(reassembled.split(/\s+/).filter((w) => w === "—")).toHaveLength(10);
  });

  it("defaults to a 127-byte chunk limit so frames survive the wire cap (issue #5)", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    // 300 single-byte chars, no spaces: exercises the hard-split path over 3 chunks.
    const text = "0123456789".repeat(30);

    await sendMessageMeshcore(TEST_NODE_ID, text, {
      cfg: createConfig(), // no textChunkLimit -> default path
    });

    const encoder = new TextEncoder();
    expect(sendTextMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    let reassembled = "";
    for (const call of sendTextMessage.mock.calls) {
      const chunkText = call[1] as string;
      expect(encoder.encode(chunkText).length).toBeLessThanOrEqual(127);
      reassembled += chunkText;
    }
    // Hard-split path must be lossless: exact round-trip.
    expect(reassembled).toBe(text);
  });

  it("prefers whitespace boundaries when chunking", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    await sendMessageMeshcore(TEST_NODE_ID, "aaaa bbbb cccc", {
      cfg: createConfig({ textChunkLimit: 6 }),
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(3);
    expect(sendTextMessage).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), "aaaa");
    expect(sendTextMessage).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), "bbbb");
    expect(sendTextMessage).toHaveBeenNthCalledWith(3, expect.any(Uint8Array), "cccc");
  });

  it("passes replyTo through the receipt", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 999 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const result = await sendMessageMeshcore(TEST_NODE_ID, "thread reply", {
      cfg: createConfig(),
      replyTo: "mc-dm-TEST_NODE_ID-1700000000-hello",
    });

    expect(result.receipt.replyToId).toBe("mc-dm-TEST_NODE_ID-1700000000-hello");
  });

  it("throws when account is not configured", async () => {
    await expect(
      sendMessageMeshcore(TEST_NODE_ID, "no host", {
        cfg: { channels: { meshcore: {} } } as CoreConfig,
      }),
    ).rejects.toThrow(/not configured/);
  });

  describe("send pacing gate (time mode)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not delay single-chunk sends", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      const promise = sendMessageMeshcore(TEST_NODE_ID, "short", {
        cfg: createConfig({ sendPacing: { enabled: true, mode: "time" } }),
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(result.messageId).toBe("1");
    });

    it("paces a 300-char reply into 3 sends with ≥airtime gaps between EACH", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(
        createDeviceHandle(sendTextMessage, {
          radioSf: 8,
          radioBw: 62_500,
          radioCr: 8,
        }),
      );

      const text = "a".repeat(300);
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "time" } }),
      });

      const pacing = resolveSendPacingConfig({ mode: "time" });
      const expectedDelay = estimateChunkAirtimeMs(
        100,
        { radioSf: 8, radioBw: 62_500, radioCr: 8 },
        pacing,
      );

      // First chunk fires immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Gap 1: second chunk must wait the airtime of the first chunk.
      const start1 = Date.now();
      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(Date.now() - start1).toBeGreaterThanOrEqual(expectedDelay);

      // Gap 2: third chunk must wait the airtime of the second chunk.
      const start2 = Date.now();
      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTextMessage).toHaveBeenCalledTimes(3);
      expect(Date.now() - start2).toBeGreaterThanOrEqual(expectedDelay);

      // No trailing delay: promise resolves without further timer advancement.
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toEqual(
        expect.objectContaining({ messageId: "1", target: TEST_NODE_ID }),
      );
    });

    it("paces separate sendMessageMeshcore calls (SDK-chunked pieces)", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(
        createDeviceHandle(sendTextMessage, {
          radioSf: 8,
          radioBw: 62_500,
          radioCr: 8,
        }),
      );

      const cfg = createConfig({ sendPacing: { enabled: true, mode: "time" } });
      const pacing = resolveSendPacingConfig({ mode: "time" });
      const expectedDelay = estimateChunkAirtimeMs(
        100,
        { radioSf: 8, radioBw: 62_500, radioCr: 8 },
        pacing,
      );

      // Simulate the SDK passing three ≤100-byte pieces with zero inter-piece delay.
      const piece1 = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(100), { cfg });
      const piece2 = sendMessageMeshcore(TEST_NODE_ID, "b".repeat(100), { cfg });
      const piece3 = sendMessageMeshcore(TEST_NODE_ID, "c".repeat(100), { cfg });

      // First piece sends immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Second piece waits for airtime of first.
      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      // Third piece waits for airtime of second.
      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTextMessage).toHaveBeenCalledTimes(3);

      await Promise.all([piece1, piece2, piece3]);
    });

    it("uses configured radio defaults when SelfInfo is missing", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      const text = "a".repeat(200);
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "time", defaultSf: 7, defaultBw: 125_000, defaultCr: 5 },
        }),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      const pacing = resolveSendPacingConfig({
        mode: "time",
        defaultSf: 7,
        defaultBw: 125_000,
        defaultCr: 5,
      });
      const expectedDelay = estimateChunkAirtimeMs(100, undefined, pacing);

      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("can be disabled via config", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      const text = "a".repeat(200);
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: false },
        }),
      });

      // With pacing disabled both chunks should fire without any timer delay.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("propagates chunk-send rejection cleanly", async () => {
      const sendTextMessage = vi.fn(async () => {
        throw new Error("node rejected send");
      });
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      const promise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "time" },
        }),
      });

      await expect(promise).rejects.toThrow(/node rejected send/);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it("does not leave timers pending after a chunk-send failure", async () => {
      const sendTextMessage = vi.fn(async () => {
        throw new Error("node rejected send");
      });
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      await expect(
        sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
          cfg: createConfig({
            textChunkLimit: 100,
            sendPacing: { enabled: true, mode: "time" },
          }),
        }),
      ).rejects.toThrow(/node rejected send/);

      // No pending timers should remain.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects cleanly when a chunk fails mid-sequence with pacing enabled", async () => {
      const sendTextMessage = vi
        .fn()
        .mockResolvedValueOnce({ expectedAckCrc: 1 })
        .mockRejectedValueOnce(new Error("node rejected second chunk"));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      const promise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(250), {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "time" },
        }),
      });
      // Attach a no-op handler so the delayed rejection is never briefly
      // observed as unhandled while fake timers are advancing.
      promise.catch(() => {});

      // First chunk sends immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Pacing delay before the second chunk expires, then sendTextMessage throws.
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).rejects.toThrow(/node rejected second chunk/);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      // No pending timers should remain after the mid-sequence failure.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("recovers pacing queue after a mid-sequence disconnect and lets the next send proceed", async () => {
      const failingSend = vi
        .fn()
        .mockResolvedValueOnce({ expectedAckCrc: 1 })
        .mockRejectedValueOnce(new Error("device disconnected"));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(failingSend));

      const failedPromise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(250), {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "time" },
        }),
      });
      // Attach a no-op handler so the delayed rejection is never briefly
      // observed as unhandled while fake timers are advancing.
      failedPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(failedPromise).rejects.toThrow(/device disconnected/);
      expect(vi.getTimerCount()).toBe(0);

      // A subsequent send must not be blocked by the failed in-flight queue entry.
      const okSend = vi.fn(async () => ({ expectedAckCrc: 2 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(okSend));

      const nextPromise = sendMessageMeshcore(TEST_NODE_ID, "ok", {
        cfg: createConfig({ sendPacing: { enabled: true, mode: "time" } }),
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(nextPromise).resolves.toEqual(
        expect.objectContaining({ messageId: "2", target: TEST_NODE_ID }),
      );
      expect(okSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("send pacing gate (ack mode)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not delay single-chunk sends (single-frame sends unaffected)", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      const promise = sendMessageMeshcore(TEST_NODE_ID, "short", {
        cfg: createConfig({ sendPacing: { enabled: true, mode: "ack" } }),
      });
      await vi.advanceTimersByTimeAsync(0);
      const result = await promise;

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(result.messageId).toBe("1");
    });

    it("withholds frame N+1 until previous frame's SendConfirmed arrives", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      const handle = createDeviceHandle(sendTextMessage);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const text = "a".repeat(200);
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
      });

      // Frame 1 sends immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Advance time without confirm: frame 2 must remain withheld.
      await vi.advanceTimersByTimeAsync(1500);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Emit SendConfirmed (0x82) for frame 1.
      handle.connection.emit(0x82, { ackCode: 1, roundTrip: 1500 });
      await vi.advanceTimersByTimeAsync(0);

      // Frame 2 is now sent.
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("delivers multi-frame sequence with FIFO confirmation matching", async () => {
      let ackCounter = 0;
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: ++ackCounter }));
      const handle = createDeviceHandle(sendTextMessage);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const text = "a".repeat(300);
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
      });

      // Frame 1 sends immediately and returns expectedAckCrc: 1.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Confirm frame 1 with matching tag 1 -> frame 2 sends (returns expectedAckCrc: 2).
      handle.connection.emit(0x82, { ackCode: 1, roundTrip: 1200 });
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      // Confirm frame 2 with matching tag 2 -> frame 3 sends.
      handle.connection.emit(0x82, { ackCode: 2, roundTrip: 1400 });
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(3);

      await promise;
    });

    it("withholds frame N+1 when an unmatched ackCode is received; only matching expectedAckCrc releases the waiter", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 42 }));
      const handle = createDeviceHandle(sendTextMessage);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const text = "a".repeat(200);
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
      });

      // Frame 1 sends immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Emit confirm with WRONG ackCode (e.g. from an evicted/timed-out frame).
      handle.connection.emit(0x82, { ackCode: 999, roundTrip: 500 });
      await vi.advanceTimersByTimeAsync(0);

      // Frame 2 must STILL be withheld!
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Emit confirm with MATCHING ackCode (42).
      handle.connection.emit(0x82, { ackCode: 42, roundTrip: 500 });
      await vi.advanceTimersByTimeAsync(0);

      // Frame 2 is now released.
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("falls back to airtime pacing when SendConfirmed times out", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(
        createDeviceHandle(sendTextMessage, {
          radioSf: 8,
          radioBw: 62_500,
          radioCr: 8,
        }),
      );

      const text = "a".repeat(200);
      // Set ackTimeoutMs to 1000 ms, while airtime gap is ~1400 ms
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "ack", ackTimeoutMs: 1000 },
        }),
      });

      const pacing = resolveSendPacingConfig({
        mode: "ack",
        ackTimeoutMs: 1000,
      });
      const expectedFallbackDelay = estimateChunkAirtimeMs(
        100,
        { radioSf: 8, radioBw: 62_500, radioCr: 8 },
        pacing,
      );

      // Frame 1 sends immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Advance by ackTimeoutMs (1000 ms): frame 2 still withheld due to fallback airtime gap (>1000 ms).
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Advance remaining airtime gap: frame 2 sends.
      const remaining = expectedFallbackDelay - 1000;
      if (remaining > 1) {
        await vi.advanceTimersByTimeAsync(remaining - 1);
        expect(sendTextMessage).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
      } else {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("honors ackTimeoutMs override when airtime gap is smaller than timeout", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(
        createDeviceHandle(sendTextMessage, {
          radioSf: 7,
          radioBw: 125_000,
          radioCr: 5,
        }),
      );

      const text = "a".repeat(200);
      // Small airtime (~200 ms) with ackTimeoutMs 3000 ms
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "ack", ackTimeoutMs: 3000 },
        }),
      });

      // Frame 1 sends immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Frame 2 is withheld up to ackTimeoutMs.
      await vi.advanceTimersByTimeAsync(2999);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // At 3000 ms, timeout triggers and since elapsed >= airtime, sends immediately.
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("releases the pre-registered waiter when its confirm arrives before the next frame", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      const handle = createDeviceHandle(sendTextMessage, undefined, { emitSendConfirmed: true });
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const text = "a".repeat(200);
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
      });

      // Frame 1 sends.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Advance past synthetic 5ms delay so SendConfirmed is emitted and unblocks frame 2.
      await vi.advanceTimersByTimeAsync(5);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("releases a pre-registered waiter when the confirm arrives before the next send is invoked", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      const handle = createDeviceHandle(sendTextMessage, {
        radioSf: 7,
        radioBw: 125_000,
        radioCr: 5,
      });
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const cfg = createConfig({
        textChunkLimit: 100,
        sendPacing: { enabled: true, mode: "ack", ackTimeoutMs: 5000 },
      });

      // Frame A: a first, standalone send call.
      const frameA = sendMessageMeshcore(TEST_NODE_ID, "frame A", { cfg });
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      await frameA;

      // The confirm for frame A arrives BEFORE frame B (the next send call) is
      // invoked. With a waiter registered lazily in beforeFrame, the confirm
      // would be dropped and frame B would have to burn the full ackTimeoutMs.
      handle.connection.emit(0x82, { ackCode: 1, roundTrip: 50 });
      await vi.advanceTimersByTimeAsync(0);

      // Frame B: a second, standalone send call.
      const frameB = sendMessageMeshcore(TEST_NODE_ID, "frame B", { cfg });

      // Fast path: the pre-registered waiter was already released by frame A’s
      // confirm, so frame B must not wait the remaining ackTimeoutMs. A single
      // millisecond is far below the 5000 ms timeout.
      await vi.advanceTimersByTimeAsync(1);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await frameB;
    });

    it("mode switch allows choosing time or ack mode", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(
        createDeviceHandle(sendTextMessage, {
          radioSf: 8,
          radioBw: 62_500,
          radioCr: 8,
        }),
      );

      // In time mode, does not wait for SendConfirmed: sends after airtime delay
      const text = "a".repeat(200);
      const promise = sendMessageMeshcore(TEST_NODE_ID, text, {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "time" },
        }),
      });

      const pacing = resolveSendPacingConfig({ mode: "time" });
      const airtime = estimateChunkAirtimeMs(
        100,
        { radioSf: 8, radioBw: 62_500, radioCr: 8 },
        pacing,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(airtime);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);

      await promise;
    });

    it("propagates sendTextMessage errors cleanly in ack mode", async () => {
      const sendTextMessage = vi
        .fn()
        .mockResolvedValueOnce({ expectedAckCrc: 1 })
        .mockRejectedValueOnce(new Error("node rejected second chunk"));
      const handle = createDeviceHandle(sendTextMessage);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const promise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
      });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Emit confirm for frame 1 -> frame 2 attempts send and rejects
      handle.connection.emit(0x82, { ackCode: 1, roundTrip: 100 });
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).rejects.toThrow(/node rejected second chunk/);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("recovers pacing queue after failure in ack mode", async () => {
      const failingSend = vi
        .fn()
        .mockResolvedValueOnce({ expectedAckCrc: 1 })
        .mockRejectedValueOnce(new Error("device disconnected"));
      const handle1 = createDeviceHandle(failingSend);
      getMeshcoreDeviceMock.mockReturnValue(handle1);

      const failedPromise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
      });
      failedPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      handle1.connection.emit(0x82, { ackCode: 1, roundTrip: 100 });
      await vi.advanceTimersByTimeAsync(0);

      await expect(failedPromise).rejects.toThrow(/device disconnected/);

      // Advance past the airtime gap of frame 1
      await vi.advanceTimersByTimeAsync(5000);

      // Next send proceeds without delay and succeeds
      const okSend = vi.fn(async () => ({ expectedAckCrc: 2 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(okSend));

      const nextPromise = sendMessageMeshcore(TEST_NODE_ID, "ok", {
        cfg: createConfig({ sendPacing: { enabled: true, mode: "ack" } }),
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(nextPromise).resolves.toEqual(
        expect.objectContaining({ messageId: "2", target: TEST_NODE_ID }),
      );
      expect(okSend).toHaveBeenCalledTimes(1);
    });

    it("applies airtime pacing floor after a chunk-send failure in ack mode before allowing the next send", async () => {
      const failingSend = vi
        .fn()
        .mockResolvedValueOnce({ expectedAckCrc: 1 })
        .mockRejectedValueOnce(new Error("node rejected second chunk"));
      getMeshcoreDeviceMock.mockReturnValue(
        createDeviceHandle(failingSend, {
          radioSf: 8,
          radioBw: 62_500,
          radioCr: 8,
        }),
      );

      const failedPromise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(250), {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "ack" },
        }),
      });
      failedPromise.catch(() => {});

      // Frame 1 sends immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(failingSend).toHaveBeenCalledTimes(1);

      // Emit confirm for frame 1 -> frame 2 runs and throws immediately.
      getMeshcoreDeviceMock().connection.emit(0x82, { ackCode: 1, roundTrip: 100 });
      await vi.advanceTimersByTimeAsync(0);
      await expect(failedPromise).rejects.toThrow(/node rejected second chunk/);

      const pacing = resolveSendPacingConfig({ mode: "ack" });
      const expectedDelay = estimateChunkAirtimeMs(
        100,
        { radioSf: 8, radioBw: 62_500, radioCr: 8 },
        pacing,
      );

      // Immediately initiate next send.
      const okSend = vi.fn(async () => ({ expectedAckCrc: 2 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(okSend));

      const nextPromise = sendMessageMeshcore(TEST_NODE_ID, "ok", {
        cfg: createConfig({ sendPacing: { enabled: true, mode: "ack" } }),
      });

      // Because frame 1 was transmitted, the radio channel still needs the airtime gap.
      // At expectedDelay - 1 ms, next send must be withheld.
      await vi.advanceTimersByTimeAsync(expectedDelay - 1);
      expect(okSend).toHaveBeenCalledTimes(0);

      // At expectedDelay ms, next send transmits.
      await vi.advanceTimersByTimeAsync(1);
      expect(okSend).toHaveBeenCalledTimes(1);

      await nextPromise;
    });
  });

  describe("send resilience (#15)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("aborts remaining frames fast on disconnect and releases the queue", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      const handle = createDeviceHandle(sendTextMessage);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const promise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
      });
      promise.catch(() => {});

      // Frame 1 sends immediately and registers an ACK waiter.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Simulate a disconnect while frame 2 is waiting for frame 1's confirm.
      const errorPromise = expect(promise).rejects.toThrow(MeshcoreSendAbortedError);
      handle.connection.emit("disconnected");
      await errorPromise;

      // Frame 2 must never be attempted.
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // The error names the cause.
      await expect(promise).rejects.toMatchObject({
        name: "MeshcoreSendAbortedError",
        cause: "connection_lost",
      });

      // A subsequent send to the same account is no longer blocked.
      const okSend = vi.fn(async () => ({ expectedAckCrc: 2 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(okSend));

      const nextPromise = sendMessageMeshcore(TEST_NODE_ID, "ok", {
        cfg: createConfig({ sendPacing: { enabled: false } }),
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(nextPromise).resolves.toEqual(
        expect.objectContaining({ messageId: "2", target: TEST_NODE_ID }),
      );
      expect(okSend).toHaveBeenCalledTimes(1);
    });

    it("rejects a send that exceeds the queue budget, logs a dead-letter, and releases the queue", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // Never-confirming send plus a tiny budget forces the watchdog to fire.
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      const handle = createDeviceHandle(sendTextMessage);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const promise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
        cfg: createConfig({
          textChunkLimit: 100,
          sendPacing: { enabled: true, mode: "ack" },
        }),
        sendQueueBudgetMs: 50,
      });
      promise.catch(() => {});

      // Frame 1 sends; frame 2 waits for a confirm that never arrives.
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      await expect(promise).rejects.toMatchObject({
        name: "MeshcoreSendAbortedError",
        cause: "queue_budget_exceeded",
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toMatch(/^\[meshcore\] send queue budget exceeded; dead-letter message id/);

      // Later send to the same account succeeds.
      const okSend = vi.fn(async () => ({ expectedAckCrc: 2 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(okSend));

      const nextPromise = sendMessageMeshcore(TEST_NODE_ID, "ok", {
        cfg: createConfig({ sendPacing: { enabled: false } }),
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(nextPromise).resolves.toEqual(
        expect.objectContaining({ messageId: "2", target: TEST_NODE_ID }),
      );

      errorSpy.mockRestore();
    });

    it("clears disconnect listeners and timers when a send is aborted", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      const handle = createDeviceHandle(sendTextMessage);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const baseDisconnectListeners = handle.connection.listenerCount("disconnected");

      const promise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
        sendQueueBudgetMs: 50,
      });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      expect(handle.connection.listenerCount("disconnected")).toBeGreaterThan(baseDisconnectListeners);

      await vi.advanceTimersByTimeAsync(50);
      await expect(promise).rejects.toThrow(MeshcoreSendAbortedError);

      expect(handle.connection.listenerCount("disconnected")).toBe(baseDisconnectListeners);
      expect(vi.getTimerCount()).toBe(0);
      errorSpy.mockRestore();
    });

    it("clears disconnect listeners and timers after a mid-sequence disconnect abort", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      const handle = createDeviceHandle(sendTextMessage);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const baseDisconnectListeners = handle.connection.listenerCount("disconnected");

      const promise = sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
        cfg: createConfig({ textChunkLimit: 100, sendPacing: { enabled: true, mode: "ack" } }),
      });
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(0);
      handle.connection.emit("disconnected");
      await expect(promise).rejects.toThrow(MeshcoreSendAbortedError);

      expect(handle.connection.listenerCount("disconnected")).toBe(baseDisconnectListeners);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("send resilience probes (#15) — real timers", () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      clearOutboundEchoCache();
      vi.clearAllMocks();
      clearPacingStateForTests();
      clearSendConfirmedStateForTests();
    });

    it("PROBE-1: a hanging sendTextMessage is raced against the budget watchdog and releases the queue", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const hangingSend = vi.fn(async () => new Promise<never>(() => {}));
      const handle = createDeviceHandle(hangingSend);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const promise = sendMessageMeshcore(TEST_NODE_ID, "hang forever", {
        cfg: createConfig({ sendPacing: { enabled: false } }),
        sendQueueBudgetMs: 50,
      });
      promise.catch(() => {});

      await new Promise((r) => setTimeout(r, 80));
      await expect(promise).rejects.toMatchObject({
        name: "MeshcoreSendAbortedError",
        cause: "queue_budget_exceeded",
      });

      // The queue must be released: a later send to the same account actually
      // attempts its transmission.
      const laterSend = vi.fn(async () => ({ expectedAckCrc: 42 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(laterSend));

      const nextPromise = sendMessageMeshcore(TEST_NODE_ID, "later", {
        cfg: createConfig({ sendPacing: { enabled: false } }),
      });
      await expect(nextPromise).resolves.toEqual(
        expect.objectContaining({ messageId: "42", target: TEST_NODE_ID }),
      );
      expect(laterSend).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });

    it("PROBE-4: disconnect mid-sendTextMessage unwinds with cause connection_lost", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let orphanResolve: (value: { expectedAckCrc: number }) => void;
      const hangingSend = vi.fn(async () => {
        return new Promise<{ expectedAckCrc: number }>((resolve) => {
          orphanResolve = resolve;
        });
      });
      const handle = createDeviceHandle(hangingSend);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const promise = sendMessageMeshcore(TEST_NODE_ID, "disconnect me", {
        cfg: createConfig({ sendPacing: { enabled: false } }),
      });
      promise.catch(() => {});

      // Let the first frame enter sendTextMessage.
      await new Promise((r) => setTimeout(r, 10));

      // Simulate disconnect while sendTextMessage is still pending.
      handle.connection.emit("disconnected");

      await expect(promise).rejects.toMatchObject({
        name: "MeshcoreSendAbortedError",
        cause: "connection_lost",
      });

      // Late settlement of the orphaned library promise must not crash or
      // leave the queue wedged.
      orphanResolve!({ expectedAckCrc: 1 });
      await new Promise((r) => setTimeout(r, 10));

      const laterSend = vi.fn(async () => ({ expectedAckCrc: 99 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(laterSend));
      const nextPromise = sendMessageMeshcore(TEST_NODE_ID, "after disconnect", {
        cfg: createConfig({ sendPacing: { enabled: false } }),
      });
      await expect(nextPromise).resolves.toEqual(
        expect.objectContaining({ messageId: "99", target: TEST_NODE_ID }),
      );
      expect(laterSend).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });

    it("orphaned sendTextMessage promise that rejects late never triggers unhandledRejection", async () => {
      const unhandledRejections: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        let orphanReject: (error: Error) => void;
        const sendTextMessage = vi.fn(async () => {
          return new Promise<never>((_, reject) => {
            orphanReject = reject;
          });
        });
        const handle = createDeviceHandle(sendTextMessage);
        getMeshcoreDeviceMock.mockReturnValue(handle);

        const promise = sendMessageMeshcore(TEST_NODE_ID, "hang then reject", {
          cfg: createConfig({ sendPacing: { enabled: false } }),
          sendQueueBudgetMs: 50,
        });
        promise.catch(() => {});

        // Wait for the budget watchdog to fire and the race to reject.
        await new Promise((r) => setTimeout(r, 80));
        await expect(promise).rejects.toMatchObject({
          name: "MeshcoreSendAbortedError",
          cause: "queue_budget_exceeded",
        });

        // Force the abandoned library promise to reject late.
        orphanReject!(new Error("late rejection from meshcore.js"));

        // Give the event loop a turn to surface any unhandled rejection.
        await new Promise((r) => setTimeout(r, 30));

        expect(unhandledRejections).toHaveLength(0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("dead-letter is logged exactly once and only on genuine abandonment", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // Successful send within budget: no dead-letter.
      const okSend = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(okSend));
      await sendMessageMeshcore(TEST_NODE_ID, "ok", {
        cfg: createConfig({ sendPacing: { enabled: false } }),
        sendQueueBudgetMs: 50,
      });

      // Genuine abandonment via budget exceeded: exactly one dead-letter.
      const hangingSend = vi.fn(async () => new Promise<never>(() => {}));
      const handle = createDeviceHandle(hangingSend);
      getMeshcoreDeviceMock.mockReturnValue(handle);

      const promise = sendMessageMeshcore(TEST_NODE_ID, "abandoned", {
        cfg: createConfig({ sendPacing: { enabled: false } }),
        sendQueueBudgetMs: 50,
      });
      promise.catch(() => {});

      await new Promise((r) => setTimeout(r, 80));
      await expect(promise).rejects.toMatchObject({
        name: "MeshcoreSendAbortedError",
        cause: "queue_budget_exceeded",
      });

      const deadLetterCalls = errorSpy.mock.calls.filter((call) =>
        String(call[0]).includes("dead-letter"),
      );
      expect(deadLetterCalls).toHaveLength(1);

      errorSpy.mockRestore();
    });
  });

  describe("chunk numbering [n/N] (issue #28)", () => {
    it("does not prefix single-chunk messages", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      await sendMessageMeshcore(TEST_NODE_ID, "short", {
        cfg: createConfig({ chunkNumbering: true }),
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(sendTextMessage).toHaveBeenCalledWith(expect.any(Uint8Array), "short");
    });

    it("prefixes each chunk of a multi-chunk reply", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      await sendMessageMeshcore(TEST_NODE_ID, "aaaa bbbb cccc", {
        cfg: createConfig({ textChunkLimit: 12, chunkNumbering: true }),
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(3);
      expect(sendTextMessage).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), "[1/3] aaaa");
      expect(sendTextMessage).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), "[2/3] bbbb");
      expect(sendTextMessage).toHaveBeenNthCalledWith(3, expect.any(Uint8Array), "[3/3] cccc");
    });

    it("budgets the prefix inside the wire limit", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));
      const encoder = new TextEncoder();

      // 100 single-byte chars with a 40-byte limit. Without numbering the
      // reply would be 3 chunks; the "[3/3] " prefix forces a 4th chunk, and
      // every prefixed chunk must still fit inside the 40-byte cap.
      await sendMessageMeshcore(TEST_NODE_ID, "a".repeat(100), {
        cfg: createConfig({ textChunkLimit: 40, chunkNumbering: true }),
      });

      for (const call of sendTextMessage.mock.calls) {
        const chunkText = call[1] as string;
        expect(encoder.encode(chunkText).length).toBeLessThanOrEqual(40);
      }
      const reassembled = sendTextMessage.mock.calls.map((c) => c[1] as string).join("");
      expect(reassembled.replace(/\[\d+\/\d+\] /g, "")).toBe("a".repeat(100));
    });

    it("uses the worst-case prefix length for the final chunk count", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));
      const encoder = new TextEncoder();

      // Force a 10-chunk reply so the prefix is "[10/10] " (9 bytes). With a
      // limit of 20, the effective chunk budget is 11 bytes, producing many
      // more chunks, but the final count must still be consistent and every
      // prefixed chunk must fit.
      await sendMessageMeshcore(TEST_NODE_ID, "a".repeat(200), {
        cfg: createConfig({ textChunkLimit: 20, chunkNumbering: true }),
      });

      const finalCount = sendTextMessage.mock.calls.length;
      const prefixLen = encoder.encode(`[${finalCount}/${finalCount}] `).length;
      for (const call of sendTextMessage.mock.calls) {
        const chunkText = call[1] as string;
        expect(encoder.encode(chunkText).length).toBeLessThanOrEqual(20);
        expect(chunkText.startsWith("[") && chunkText.includes("/")).toBe(true);
        // Body portion alone must fit inside the budget left after the prefix.
        const body = chunkText.replace(/^\[\d+\/\d+\] /, "");
        expect(encoder.encode(body).length).toBeLessThanOrEqual(20 - prefixLen);
      }
    });

    it("is disabled by config", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      await sendMessageMeshcore(TEST_NODE_ID, "aaaa bbbb cccc", {
        cfg: createConfig({ textChunkLimit: 6, chunkNumbering: false }),
      });

      expect(sendTextMessage).toHaveBeenCalledTimes(3);
      expect(sendTextMessage).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), "aaaa");
      expect(sendTextMessage).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), "bbbb");
      expect(sendTextMessage).toHaveBeenNthCalledWith(3, expect.any(Uint8Array), "cccc");
    });

    it("never splits multibyte characters when numbering", async () => {
      const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
      getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

      await sendMessageMeshcore(TEST_NODE_ID, "😀😀😀", {
        cfg: createConfig({ textChunkLimit: 14, chunkNumbering: true }),
      });

      // "[1/N] " is 7 bytes; 14-byte limit leaves 7 bytes for the body,
      // enough for one 4-byte emoji per chunk, so each chunk is valid.
      for (const call of sendTextMessage.mock.calls) {
        const text = call[1] as string;
        expect([...text].every((cp) => cp !== "\uFFFD")).toBe(true);
      }
    });
  });
});
