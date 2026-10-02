import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearOutboundEchoCache, isOutboundEcho } from "./echo-dedupe.js";
import { sendMessageMeshcore } from "./send.js";
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
        ...overrides,
      },
    },
  } as CoreConfig;
}

function createDeviceHandle(sendTextMessage: ReturnType<typeof vi.fn>) {
  return {
    accountId: "default",
    connection: {
      sendTextMessage,
    },
    connected: true,
    contacts: [],
    channels: [],
  };
}

describe("sendMessageMeshcore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOutboundEchoCache();
  });

  afterEach(() => {
    clearOutboundEchoCache();
    vi.clearAllMocks();
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
});
