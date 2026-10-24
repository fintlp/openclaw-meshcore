import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorMeshcoreProvider, resetPositionResyncStateForTests } from "./monitor.js";
import { meshcoreDedupeKey, openDurabilityStore, type DurabilityStore } from "./durability.js";
import { resetContactBookForTests, setContactBookPathForTests } from "./contact-book.js";
import { resetIdentityBindingStateForTests, setIdentityBindingPathForTests } from "./identity-binding.js";
import { resetGroupLogStateForTests, setGroupLogPathForTests } from "./group-log.js";
import { resetNodeStatusStateForTests, setNodeStatusPathForTests } from "./node-status.js";
import type { CoreConfig, MeshcoreInboundMessage } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";

// The monitor tests below intentionally mock inbound to isolate signal
// propagation and race control. Real inbound finalization is covered by the
// direct integration tests in inbound-command-replay.repro.test.ts.

const {
  connectMeshcoreDeviceMock,
  disconnectMeshcoreDeviceMock,
  resolveMeshcoreAccountMock,
  createAccountStatusSinkMock,
  contactSyncScheduleMock,
  contactSyncDisposeMock,
  syncContactsFromNodeMock,
  handleMeshcoreInboundMock,
} = vi.hoisted(() => ({
  connectMeshcoreDeviceMock: vi.fn(),
  disconnectMeshcoreDeviceMock: vi.fn(),
  resolveMeshcoreAccountMock: vi.fn(),
  createAccountStatusSinkMock: vi.fn(() => vi.fn()),
  contactSyncScheduleMock: vi.fn(),
  contactSyncDisposeMock: vi.fn(),
  syncContactsFromNodeMock: vi.fn(),
  handleMeshcoreInboundMock: vi.fn(),
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
  return { ...actual, resolveMeshcoreAccount: resolveMeshcoreAccountMock };
});
vi.mock("./channel-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel-api.js")>();
  return { ...actual, createAccountStatusSink: createAccountStatusSinkMock };
});
vi.mock("./inbound.js", () => ({ handleMeshcoreInbound: handleMeshcoreInboundMock }));
vi.mock("./send.js", () => ({ sendMessageMeshcore: vi.fn() }));
vi.mock("./runtime.js", () => ({ getMeshcoreRuntime: vi.fn() }));
vi.mock("./contact-sync.js", () => ({
  createThrottledContactSync: vi.fn(() => ({
    schedule: contactSyncScheduleMock,
    dispose: contactSyncDisposeMock,
  })),
  syncContactsFromNode: syncContactsFromNodeMock,
}));

function createRuntimeEnv(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
}
function createRuntime() {
  return {
    config: { current: () => ({ channels: { meshcore: { host: "192.0.2.10" } } }) },
    logging: {
      getChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      shouldLogVerbose: () => false,
    },
    channel: { activity: { record: vi.fn() } },
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
      groupMonitorMode: "digest" as const,
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
      getWaitingMessages: () => Promise.resolve([]),
    },
    contacts: [],
    channels: [],
    accountId: "default",
    connected: true,
  };
}
function makeMessage(text = "hello"): MeshcoreInboundMessage {
  return {
    messageId: "mc-repro-1",
    target: "!aabbccdd1122",
    senderNodeId: "!aabbccdd1122",
    senderName: "TestNode",
    text,
    timestamp: 1700000000000,
    isGroup: false,
    meshChannel: 0,
    meshSecurity: { txtType: 0, signedPlain: false, identityBinding: "prefix-only" },
  };
}
function keyFor(message: MeshcoreInboundMessage) {
  return meshcoreDedupeKey({
    senderNodeId: message.senderNodeId,
    timestamp: message.timestamp,
    body: message.text,
  });
}

let dir: string;
let store: DurabilityStore | null;

beforeEach(async () => {
  vi.clearAllMocks();
  resetPositionResyncStateForTests();
  dir = mkdtempSync(join(tmpdir(), "meshcore-monitor-repro-"));
  resetContactBookForTests();
  resetIdentityBindingStateForTests();
  resetNodeStatusStateForTests();
  setContactBookPathForTests(join(dir, "contacts.json"));
  setGroupLogPathForTests(join(dir, "group-log.jsonl"));
  setNodeStatusPathForTests(join(dir, "node-status.json"));
  setIdentityBindingPathForTests(join(dir, "identity-bindings.json"));
  const { getMeshcoreRuntime } = await import("./runtime.js");
  vi.mocked(getMeshcoreRuntime).mockReturnValue(createRuntime() as never);
  resolveMeshcoreAccountMock.mockReturnValue(createResolvedAccount());
  handleMeshcoreInboundMock.mockResolvedValue(undefined);
  store = await openDurabilityStore({ dbPath: join(dir, "durability.sqlite") });
  expect(store).not.toBeNull();
});

afterEach(() => {
  store?.close();
  store = null;
  vi.restoreAllMocks();
  resetContactBookForTests();
  resetIdentityBindingStateForTests();
  setContactBookPathForTests(undefined);
  setGroupLogPathForTests(undefined);
  setNodeStatusPathForTests(undefined);
  setIdentityBindingPathForTests(undefined);
  resetGroupLogStateForTests();
  resetNodeStatusStateForTests();
  rmSync(dir, { recursive: true, force: true });
});

function monitorOptions() {
  return {
    config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
    runtime: createRuntimeEnv(),
    durability: store,
  };
}

describe("monitor durability replay repros", () => {
  it("dead-letters a persisted command row instead of replaying it", async () => {
    const message = makeMessage("!ping");
    const intake = store!.intake({
      accountId: "default",
      dedupeKey: keyFor(message),
      kind: "direct",
      peerId: message.senderNodeId,
      senderTs: message.timestamp,
      body: message.text,
      rawJson: "{}",
    });
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    const monitorPromise = monitorMeshcoreProvider(monitorOptions());
    const rejected = expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);

    await vi.waitFor(() => {
      expect(store!.findDuplicate("default", keyFor(message))?.state).toBe("dead");
    });
    expect(handleMeshcoreInboundMock).not.toHaveBeenCalled();
    handle.connection.emit("disconnected");
    await rejected;
  });

  it("aborts replay finalization after disconnect instead of marking dispatched", async () => {
    const message = makeMessage("hello");
    const intake = store!.intake({
      accountId: "default",
      dedupeKey: keyFor(message),
      kind: "direct",
      peerId: message.senderNodeId,
      senderTs: message.timestamp,
      body: message.text,
      rawJson: JSON.stringify(message),
    });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const finished = vi.fn();
    handleMeshcoreInboundMock.mockImplementation(async (params: any) => {
      await dispatchGate;
      finished(params);
      // Emulate the real inbound finalization contract after host dispatch.
      if (params.replayOf !== undefined) {
        if (params.abortSignal?.aborted) {
          params.durability.releaseClaim(params.account.accountId, params.replayOf, "aborted");
        } else {
          params.durability.markDispatched(params.account.accountId, params.replayOf);
        }
      }
    });
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    const monitorPromise = monitorMeshcoreProvider(monitorOptions());
    const rejected = expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);

    await vi.waitFor(() => expect(handleMeshcoreInboundMock).toHaveBeenCalledTimes(1));
    const call = handleMeshcoreInboundMock.mock.calls[0][0];
    expect(call.replayOf).toBe(intake.id);
    expect(call.abortSignal).toBeDefined();
    expect(finished).not.toHaveBeenCalled();

    // The monitor races disconnect against the dispatch, but does not cancel
    // the dispatch itself. The socket is now gone while the turn is pending.
    handle.connection.emit("disconnected");
    await rejected;
    expect(finished).not.toHaveBeenCalled();

    // The host work may still finish, but its durability finalization is
    // suppressed and the event remains retryable rather than falsely dispatched.
    releaseDispatch();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1));
    expect(store!.findDuplicate("default", keyFor(message))?.state).toBe("pending");
  });

  it("aborts replay finalization on an external abort signal", async () => {
    const message = makeMessage("external abort");
    store!.intake({
      accountId: "default",
      dedupeKey: keyFor(message),
      kind: "direct",
      peerId: message.senderNodeId,
      senderTs: message.timestamp,
      body: message.text,
      rawJson: JSON.stringify(message),
    });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    handleMeshcoreInboundMock.mockImplementation(async (params: any) => {
      await dispatchGate;
      if (params.abortSignal?.aborted) {
        params.durability.releaseClaim(params.account.accountId, params.replayOf, "aborted");
      } else {
        params.durability.markDispatched(params.account.accountId, params.replayOf);
      }
    });
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    const abort = new AbortController();
    const monitorPromise = monitorMeshcoreProvider({
      ...monitorOptions(),
      abortSignal: abort.signal,
    });
    await vi.waitFor(() => expect(handleMeshcoreInboundMock).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(monitorPromise).resolves.toEqual({ stop: expect.any(Function) });
    releaseDispatch();
    await vi.waitFor(() => {
      expect(store!.findDuplicate("default", keyFor(message))?.state).toBe("pending");
    });
  });

  it("aborts a replay dispatch when the overall replay deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const message = makeMessage("deadline");
      store!.intake({
        accountId: "default",
        dedupeKey: keyFor(message),
        kind: "direct",
        peerId: message.senderNodeId,
        senderTs: message.timestamp,
        body: message.text,
        rawJson: JSON.stringify(message),
      });
      let releaseDispatch!: () => void;
      const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
      handleMeshcoreInboundMock.mockImplementation(async (params: any) => {
        await dispatchGate;
        if (params.abortSignal?.aborted) {
          params.durability.releaseClaim(params.account.accountId, params.replayOf, "timeout");
        } else {
          params.durability.markDispatched(params.account.accountId, params.replayOf);
        }
      });
      const handle = createConnection();
      connectMeshcoreDeviceMock.mockResolvedValue(handle);
      const monitorPromise = monitorMeshcoreProvider(monitorOptions());
      const rejected = expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
      await vi.advanceTimersByTimeAsync(20);
      expect(handleMeshcoreInboundMock).toHaveBeenCalledTimes(1);
      const call = handleMeshcoreInboundMock.mock.calls[0][0];
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(call.abortSignal.aborted).toBe(true);
      releaseDispatch();
      await vi.advanceTimersByTimeAsync(0);
      expect(store!.findDuplicate("default", keyFor(message))?.state).toBe("pending");
      handle.connection.emit("disconnected");
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still marks a normally completed replay dispatch as dispatched", async () => {
    const message = makeMessage("normal replay");
    store!.intake({
      accountId: "default",
      dedupeKey: keyFor(message),
      kind: "direct",
      peerId: message.senderNodeId,
      senderTs: message.timestamp,
      body: message.text,
      rawJson: JSON.stringify(message),
    });
    handleMeshcoreInboundMock.mockImplementation(async (params: any) => {
      if (params.replayOf !== undefined && !params.abortSignal?.aborted) {
        params.durability.markDispatched(params.account.accountId, params.replayOf);
      }
    });
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    const monitorPromise = monitorMeshcoreProvider(monitorOptions());
    const rejected = expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);

    await vi.waitFor(() => {
      expect(store!.findDuplicate("default", keyFor(message))?.state).toBe("dispatched");
    });
    expect(handleMeshcoreInboundMock).toHaveBeenCalledTimes(1);
    handle.connection.emit("disconnected");
    await rejected;
  });
});
