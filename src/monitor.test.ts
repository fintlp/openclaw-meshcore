import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorMeshcoreProvider, resetPositionResyncStateForTests } from "./monitor.js";
import {
  getContactBookEntries,
  POSITION_RESYNC_AFTER_MS,
  rememberContact,
  resetContactBookForTests,
  setContactBookPathForTests,
} from "./contact-book.js";
import { bytesToHex, hexToBytes } from "./protocol.js";
import type { CoreConfig } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";

const {
  connectMeshcoreDeviceMock,
  disconnectMeshcoreDeviceMock,
  resolveMeshcoreAccountMock,
  createAccountStatusSinkMock,
  contactSyncScheduleMock,
  contactSyncDisposeMock,
  syncContactsFromNodeMock,
} = vi.hoisted(() => ({
  connectMeshcoreDeviceMock: vi.fn(),
  disconnectMeshcoreDeviceMock: vi.fn(),
  resolveMeshcoreAccountMock: vi.fn(),
  createAccountStatusSinkMock: vi.fn(() => vi.fn()),
  contactSyncScheduleMock: vi.fn(),
  contactSyncDisposeMock: vi.fn(),
  syncContactsFromNodeMock: vi.fn(),
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

vi.mock("./contact-sync.js", () => ({
  createThrottledContactSync: vi.fn(() => ({
    schedule: contactSyncScheduleMock,
    dispose: contactSyncDisposeMock,
  })),
  syncContactsFromNode: syncContactsFromNodeMock,
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
    contactSyncScheduleMock.mockClear();
    resetPositionResyncStateForTests();
    const dir = mkdtempSync(join(tmpdir(), "meshcore-monitor-"));
    setContactBookPathForTests(join(dir, "contacts.json"));
    resetContactBookForTests();
    const { getMeshcoreRuntime } = await import("./runtime.js");
    getMeshcoreRuntime.mockReturnValue(createRuntime());
    resolveMeshcoreAccountMock.mockReturnValue(createResolvedAccount());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetContactBookForTests();
    setContactBookPathForTests(undefined);
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

  it("stores every NewAdvert (0x8A) field in the contact book", async () => {
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const publicKey = hexToBytes(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    );
    const outPath = new Uint8Array(64);
    outPath[0] = 0x01;
    outPath[1] = 0x02;

    handle.connection.emit(0x8a, {
      publicKey,
      type: 1,
      flags: 2,
      outPathLen: 2,
      outPath,
      advName: "AdvertNode",
      lastAdvert: 1234567890,
      advLat: 48858900,
      advLon: 2294500,
      lastMod: 1234567000,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const entries = getContactBookEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.publicKey).toEqual(publicKey);
    expect(entry.type).toBe(1);
    expect(entry.flags).toBe(2);
    expect(entry.outPathLen).toBe(2);
    expect(bytesToHex(entry.outPath)).toBe("0102" + "00".repeat(62));
    expect(entry.advName).toBe("AdvertNode");
    expect(entry.lastAdvert).toBe(1234567890);
    expect(entry.advLat).toBe(48858900);
    expect(entry.advLon).toBe(2294500);
    expect(entry.lastMod).toBe(1234567000);

    handle.connection.emit("disconnected");
    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });

  it("merges a pubkey-only Advert (0x80) without zeroing richer NewAdvert fields", async () => {
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const publicKey = hexToBytes(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    );
    const outPath = new Uint8Array(64);
    outPath[0] = 0x01;

    handle.connection.emit(0x8a, {
      publicKey,
      type: 1,
      flags: 2,
      outPathLen: 1,
      outPath,
      advName: "RichNode",
      lastAdvert: 1234567890,
      advLat: 48858900,
      advLon: 2294500,
      lastMod: 1234567000,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    handle.connection.emit(0x80, { publicKey });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const entries = getContactBookEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.publicKey).toEqual(publicKey);
    expect(entry.type).toBe(1);
    expect(entry.flags).toBe(2);
    expect(entry.outPathLen).toBe(1);
    expect(bytesToHex(entry.outPath)).toBe("01" + "00".repeat(63));
    expect(entry.advName).toBe("RichNode");
    expect(entry.advLat).toBe(48858900);
    expect(entry.advLon).toBe(2294500);

    handle.connection.emit("disconnected");
    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });

  it("0x80 push schedules a contact sync when stored metadata is missing", async () => {
    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    contactSyncScheduleMock.mockClear();

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const publicKey = hexToBytes(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    );

    // A pubkey-only 0x80 push leaves metadata missing.
    handle.connection.emit(0x80, { publicKey });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(contactSyncScheduleMock).toHaveBeenCalledTimes(1);

    handle.connection.emit("disconnected");
    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });

  it("0x80 push does not schedule a contact sync when stored metadata is complete", async () => {
    vi.useFakeTimers();
    const nowSeconds = 2_000_000_000;
    vi.setSystemTime(nowSeconds * 1000);

    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    contactSyncScheduleMock.mockClear();

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    await vi.advanceTimersByTimeAsync(0);

    const publicKey = hexToBytes(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    );
    const outPath = new Uint8Array(64);
    outPath[0] = 0x01;

    // First establish complete, fresh metadata via 0x8A.
    handle.connection.emit(0x8a, {
      publicKey,
      type: 1,
      flags: 2,
      outPathLen: 1,
      outPath,
      advName: "RichNode",
      lastAdvert: nowSeconds - 60,
      advLat: 48858900,
      advLon: 2294500,
      lastMod: nowSeconds - 120,
    });
    await vi.advanceTimersByTimeAsync(0);

    // A subsequent pubkey-only 0x80 push preserves metadata; no sync needed.
    handle.connection.emit(0x80, { publicKey });
    await vi.advanceTimersByTimeAsync(0);

    expect(contactSyncScheduleMock).not.toHaveBeenCalled();

    handle.connection.emit("disconnected");
    vi.useRealTimers();
    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });

  it("0x80 push schedules a re-sync when the stored lastAdvert is older than POSITION_RESYNC_AFTER_MS (issue #18)", async () => {
    vi.useFakeTimers();
    const nowSeconds = 2_000_000_000;
    vi.setSystemTime(nowSeconds * 1000);

    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    contactSyncScheduleMock.mockClear();

    const publicKey = hexToBytes(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    );
    rememberContact(
      {
        publicKey,
        advName: "OldNode",
        lastAdvert: nowSeconds - Math.floor(POSITION_RESYNC_AFTER_MS / 1000) - 3600,
        advLat: 48858900,
        advLon: 2294500,
      },
      "default",
    );

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    await vi.advanceTimersByTimeAsync(0);
    handle.connection.emit(0x80, { publicKey });
    await vi.advanceTimersByTimeAsync(0);

    expect(contactSyncScheduleMock).toHaveBeenCalledTimes(1);

    handle.connection.emit("disconnected");
    vi.useRealTimers();
    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });

  it("0x80 push does not schedule a re-sync when the stored lastAdvert is fresh", async () => {
    vi.useFakeTimers();
    const nowSeconds = 2_000_000_000;
    vi.setSystemTime(nowSeconds * 1000);

    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    contactSyncScheduleMock.mockClear();

    const publicKey = hexToBytes(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    );
    rememberContact(
      {
        publicKey,
        advName: "FreshNode",
        lastAdvert: nowSeconds - 3600,
        advLat: 48858900,
        advLon: 2294500,
      },
      "default",
    );

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    await vi.advanceTimersByTimeAsync(0);
    handle.connection.emit(0x80, { publicKey });
    await vi.advanceTimersByTimeAsync(0);

    expect(contactSyncScheduleMock).not.toHaveBeenCalled();

    handle.connection.emit("disconnected");
    vi.useRealTimers();
    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });

  it("0x80 push re-sync is throttled to once per contact per POSITION_RESYNC_AFTER_MS window (issue #18)", async () => {
    vi.useFakeTimers();
    const nowSeconds = 2_000_000_000;
    vi.setSystemTime(nowSeconds * 1000);

    const handle = createConnection();
    connectMeshcoreDeviceMock.mockResolvedValue(handle);
    contactSyncScheduleMock.mockClear();

    const publicKey = hexToBytes(
      "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
    );
    rememberContact(
      {
        publicKey,
        advName: "OldNode",
        lastAdvert: nowSeconds - Math.floor(POSITION_RESYNC_AFTER_MS / 1000) - 3600,
        advLat: 48858900,
        advLon: 2294500,
      },
      "default",
    );

    const monitorPromise = monitorMeshcoreProvider({
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    await vi.advanceTimersByTimeAsync(0);
    handle.connection.emit(0x80, { publicKey });
    await vi.advanceTimersByTimeAsync(0);
    expect(contactSyncScheduleMock).toHaveBeenCalledTimes(1);

    // A second push inside the same window must not schedule again.
    contactSyncScheduleMock.mockClear();
    handle.connection.emit(0x80, { publicKey });
    await vi.advanceTimersByTimeAsync(0);
    expect(contactSyncScheduleMock).not.toHaveBeenCalled();

    handle.connection.emit("disconnected");
    vi.useRealTimers();
    await expect(monitorPromise).rejects.toThrow(/MeshCore device disconnected/);
  });
});
