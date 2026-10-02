import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { monitorMeshcoreProvider } from "./monitor.js";
import type { CoreConfig } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";

const {
  connectMeshcoreDeviceMock,
  disconnectMeshcoreDeviceMock,
  resolveMeshcoreAccountMock,
  createAccountStatusSinkMock,
} = vi.hoisted(() => ({
  connectMeshcoreDeviceMock: vi.fn(),
  disconnectMeshcoreDeviceMock: vi.fn(),
  resolveMeshcoreAccountMock: vi.fn(),
  createAccountStatusSinkMock: vi.fn(() => vi.fn()),
}));

vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return {
    ...actual,
    connectMeshcoreDevice: connectMeshcoreDeviceMock,
    disconnectMeshcoreDevice: disconnectMeshcoreDeviceMock,
  };
});

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return {
    ...actual,
    resolveMeshcoreAccount: resolveMeshcoreAccountMock,
  };
});

vi.mock("./channel-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel-api.js")>();
  return {
    ...actual,
    createAccountStatusSink: createAccountStatusSinkMock,
  };
});

vi.mock("./inbound.js", () => ({
  handleMeshcoreInbound: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageMeshcore: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getMeshcoreRuntime: vi.fn(),
}));

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createRuntime() {
  return {
    config: {
      current: () => ({ channels: { meshcore: { host: "192.0.2.10" } } }),
    },
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
      shouldLogVerbose: () => false,
    },
    channel: {
      activity: { record: vi.fn() },
    },
  };
}

function createResolvedAccount() {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    transport: "tcp" as const,
    host: "192.0.2.10",
    port: 5000,
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "disabled",
      groupAllowFrom: [],
      channels: [0],
    },
  };
}

function createConnection() {
  const emitter = new EventEmitter();
  return {
    connection: emitter as unknown as {
      on: (event: string | number, listener: (...args: any[]) => void) => unknown;
      off: (event: string | number, listener: (...args: any[]) => void) => unknown;
      emit: (event: string | number, ...args: unknown[]) => boolean;
      getWaitingMessages: () => Promise.resolve([]);
    },
    contacts: [],
    channels: [],
    accountId: "default",
    connected: true,
  };
}

describe("monitorMeshcoreProvider", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getMeshcoreRuntime } = await import("./runtime.js");
    getMeshcoreRuntime.mockReturnValue(createRuntime());
    resolveMeshcoreAccountMock.mockReturnValue(createResolvedAccount());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects the monitor promise when the socket disconnects mid-session", async () => {
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    // Let the async IIFE attach handlers and create the settlement promise.
    await new Promise((resolve) => setTimeout(resolve, 0));

    handle.connection.emit("disconnected");

    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });

  it("resolves gracefully when abortSignal fires", async () => {
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    const abortController = new AbortController();

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      abortSignal: abortController.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abortController.abort();

    await expect(monitorPromise).resolves.toEqual({ stop: expect.any(Function) });
  });

  it("strips the 4 leading signature bytes from SignedPlain DMs (txtType=2)", async () => {
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    const onMessage = vi.fn();

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      onMessage,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // meshcore.js emits ContactMsgRecv as numeric code 7.
    handle.connection.emit(7, {
      pubKeyPrefix: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
      pathLen: 0,
      txtType: 2,
      senderTimestamp: 1700000000,
      text: "SIGMhello from signed peer",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello from signed peer",
        isGroup: false,
      }),
      handle,
    );

    handle.connection.emit("disconnected");
    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });
});
