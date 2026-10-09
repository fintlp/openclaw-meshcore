import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { meshcorePlugin } from "./channel.js";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { MESHCORE_WIRE_CHUNK_LIMIT } from "./send.js";
import { clearPacingStateForTests } from "./pacing.js";
import { clearSendConfirmedStateForTests } from "./device-client.js";
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
        // Simulate the live failure mode: an operator-set limit above the wire
        // cap must be clamped to 127 bytes by the plugin's own chunker.
        textChunkLimit: 500,
        chunkNumbering: true,
        sendPacing: { enabled: false },
        ...overrides,
      },
    },
  } as CoreConfig;
}

function createDeviceHandle(sendTextMessage: ReturnType<typeof vi.fn>) {
  const emitter = new EventEmitter();
  return {
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
  };
}

describe("meshcorePlugin outbound sendText (host-chunking suppression, issue #39)", () => {
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

  it("regression: registered outbound adapter keeps chunker:null and textChunkLimit=127 (issue #39)", () => {
    // The host must not pre-chunk, but it still reads textChunkLimit for its
    // block-streaming layer. Losing the field silently widens live-reply
    // coalescing to the host default (~1200). See outbound-base.ts.
    const outbound = meshcorePlugin.outbound as Record<string, unknown>;
    expect(outbound.chunker).toBeNull();
    expect(outbound.textChunkLimit).toBe(MESHCORE_WIRE_CHUNK_LIMIT);
  });

  it("receives the full text from the host and emits ≤127-byte numbered chunks", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    // Build text that would exceed 127 bytes and would require multiple chunks.
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(300);

    const result = await meshcorePlugin.outbound.sendText({
      cfg: createConfig(),
      to: TEST_NODE_ID,
      text,
    });

    expect(result.target.kind).toBe("conversation");
    expect(result.target.id).toBe(TEST_NODE_ID);

    const encoder = new TextEncoder();
    const chunks = sendTextMessage.mock.calls.map((call) => call[1] as string);

    expect(chunks.length).toBeGreaterThan(1);

    const numbering: Array<{ index: number; total: number }> = [];
    for (const chunk of chunks) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(127);
      const match = chunk.match(/^\[(\d+)\/(\d+)\] /);
      expect(match).not.toBeNull();
      numbering.push({ index: Number(match![1]), total: Number(match![2]) });
    }

    expect(numbering[0].index).toBe(1);
    expect(numbering.at(-1)!.index).toBe(numbering.at(-1)!.total);
    for (let i = 1; i < numbering.length; i++) {
      expect(numbering[i].index).toBe(numbering[i - 1].index + 1);
      expect(numbering[i].total).toBe(numbering[0].total);
    }

    // Reassemble the bodies and confirm no words were lost or reordered.
    const reassembledWords = chunks
      .map((c) => c.replace(/^\[\d+\/\d+\] /, ""))
      .flatMap((c) => c.split(/\s+/).filter((w) => w.length > 0));
    expect(reassembledWords).toEqual(words);
  });

  it("emits ≤127-byte numbered chunks for multibyte text (umlauts, CJK, emoji)", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const multibyteWords = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? `über-${i} 東京-${i} 🎉-${i}` : `café-${i} 北京-${i} 📡-${i}`,
    );
    const text = multibyteWords.join(" ");
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(500);

    await meshcorePlugin.outbound.sendText({
      cfg: createConfig(),
      to: TEST_NODE_ID,
      text,
    });

    const encoder = new TextEncoder();
    const chunks = sendTextMessage.mock.calls.map((call) => call[1] as string);

    expect(chunks.length).toBeGreaterThan(1);

    const numbering: Array<{ index: number; total: number }> = [];
    for (const chunk of chunks) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(MESHCORE_WIRE_CHUNK_LIMIT);
      const match = chunk.match(/^\[(\d+)\/(\d+)\] /);
      expect(match).not.toBeNull();
      numbering.push({ index: Number(match![1]), total: Number(match![2]) });
      // Each emitted chunk must be valid UTF-8 (no split multibyte code point).
      expect(() => encoder.encode(chunk)).not.toThrow();
    }

    expect(numbering[0].index).toBe(1);
    expect(numbering.at(-1)!.index).toBe(numbering.at(-1)!.total);
    for (let i = 1; i < numbering.length; i++) {
      expect(numbering[i].index).toBe(numbering[i - 1].index + 1);
      expect(numbering[i].total).toBe(numbering[0].total);
    }

    // Reassemble and confirm every original word survived, in order.
    const reassembledWords = chunks
      .map((c) => c.replace(/^\[\d+\/\d+\] /, ""))
      .flatMap((c) => c.split(/\s+/).filter((w) => w.length > 0));
    expect(reassembledWords).toEqual(multibyteWords.flatMap((line) => line.split(/\s+/)));
  });

  it("does not prefix a single-chunk message", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 42 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const text = "short";
    await meshcorePlugin.outbound.sendText({
      cfg: createConfig(),
      to: TEST_NODE_ID,
      text,
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).toHaveBeenCalledWith(expect.any(Uint8Array), "short");
  });
});
