import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSendConfirmedStateForTests } from "./device-client.js";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { monitorMeshcoreProvider } from "./monitor.js";
import { clearPacingStateForTests } from "./pacing.js";
import { clearSendRateLimitState } from "./rate-limit.js";
import {
  clearSessionSendRateLimitState,
  SessionSendRateLimitExceededError,
} from "./session-rate-limit.js";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";

const { connectMock, disconnectMock, resolveAccountMock, getRuntimeMock, hostOnErrorMock } = vi.hoisted(() => ({
  connectMock: vi.fn(), disconnectMock: vi.fn(), resolveAccountMock: vi.fn(),
  getRuntimeMock: vi.fn(), hostOnErrorMock: vi.fn(),
}));
vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return { ...actual, connectMeshcoreDevice: connectMock, disconnectMeshcoreDevice: disconnectMock };
});
vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return { ...actual, resolveMeshcoreAccount: resolveAccountMock };
});
vi.mock("./runtime.js", () => ({ getMeshcoreRuntime: getRuntimeMock }));
vi.mock("./inbound.js", () => ({
  handleMeshcoreInbound: vi.fn(async (params: {
    message: MeshcoreInboundMessage;
    sendReply: (
      target: string, text: string, replyToId?: string,
      purpose?: "dm" | "pairing", sessionKey?: string,
    ) => Promise<void>;
  }) => {
    const target = params.message.senderNodeId;
    await params.sendReply(target, "first", undefined, undefined, "agent:main:producer");
    try {
      await params.sendReply(target, "second", undefined, undefined, "agent:main:producer");
    } catch (error) {
      hostOnErrorMock(error);
    }
  }),
}));

const PUBLIC_KEY = new Uint8Array([...Buffer.from("aabbccddeeff", "hex"), ...new Uint8Array(26).fill(1)]);
const NODE_ID = "!".concat(Buffer.from(PUBLIC_KEY).toString("hex"));

function runtime() {
  return {
    config: { current: () => ({ channels: { meshcore: { host: "192.0.2.10" } } }) },
    logging: {
      getChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      shouldLogVerbose: () => false,
    },
    channel: { activity: { record: vi.fn() } },
  };
}

function account() {
  return {
    accountId: "default", enabled: true, configured: true, transport: "tcp" as const,
    host: "192.0.2.10", port: 5000,
    config: {
      dmPolicy: "pairing", allowFrom: [], groupPolicy: "disabled", channels: [0],
      chunkNumbering: false, sendPacing: { enabled: false },
      sessionSendRateLimit: { maxSends: 1, maxBytes: 100 },
    },
  };
}

function handle() {
  const emitter = new EventEmitter();
  const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
  const connection = Object.assign(emitter, {
    sendTextMessage,
    getContacts: vi.fn(async () => []),
    getWaitingMessages: vi.fn(async () => []),
  });
  return {
    accountId: "default", connected: true,
    connection,
    contacts: [{ publicKey: PUBLIC_KEY, advName: "TestNode" }],
    channels: [],
  };
}

describe("MeshCore production monitor producing-session replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionSendRateLimitState();
    clearSendRateLimitState();
    clearPacingStateForTests();
    clearSendConfirmedStateForTests();
    clearOutboundEchoCache();
    getRuntimeMock.mockReturnValue(runtime());
    resolveAccountMock.mockReturnValue(account());
    disconnectMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    clearSessionSendRateLimitState();
    clearSendRateLimitState();
    clearPacingStateForTests();
    clearSendConfirmedStateForTests();
    clearOutboundEchoCache();
    vi.restoreAllMocks();
  });

  it("rethrows the typed refusal to host onError without a second target log or refusal timestamp", async () => {
    const device = handle();
    connectMock.mockResolvedValue(device);
    const abort = new AbortController();
    const statusPatches: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const monitor = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      abortSignal: abort.signal,
      statusSink: (patch) => statusPatches.push(patch),
    });
    await vi.waitFor(() => expect(device.connection.listenerCount(7)).toBeGreaterThan(0), { timeout: 5_000 });
    device.connection.emit(7, {
      pubKeyPrefix: PUBLIC_KEY.slice(0, 6), pathLen: 0, txtType: 0,
      senderTimestamp: 1_700_000_000, text: "hello",
    });
    await vi.waitFor(() => expect(hostOnErrorMock).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    const refusal = hostOnErrorMock.mock.calls[0]![0];
    expect(refusal).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect((refusal as SessionSendRateLimitExceededError).retryAfterMs).toBeGreaterThan(0);
    expect(device.connection.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(statusPatches.filter((patch) => patch.lastOutboundAt !== undefined)).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("retryAfterMs=");
    expect(warn.mock.calls[0]![0]).not.toContain(NODE_ID);
    expect(warn.mock.calls[0]![0]).not.toContain("agent:main:producer");
    expect(warn.mock.calls[0]![0]).not.toContain("second");
    abort.abort();
    await expect(monitor).resolves.toEqual({ stop: expect.any(Function) });
  });
});
