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
        host: "192.168.1.226",
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
        host: "192.168.1.226",
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
      cfg: createConfig({ textChunkLimit: 2 }),
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), "😀😀");
    expect(sendTextMessage).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), "😀");
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
