import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { clearSendConfirmedStateForTests } from "./device-client.js";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { clearPacingStateForTests } from "./pacing.js";
import { clearSendRateLimitState, SendRateLimitExceededError } from "./rate-limit.js";
import {
  DELIVERY_REPORT_TIMEOUT_MAX_MS,
  DELIVERY_REPORT_TIMEOUT_MIN_MS,
  MeshcoreDeliveryFailedError,
  resolveDeliveryReportTimeoutMs,
  resolveSendRetryConfig,
  SEND_RETRY_DEFAULTS,
} from "./send-retry.js";
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
        chunkNumbering: false,
        sendPacing: { enabled: false },
        ...overrides,
      },
    },
  } as CoreConfig;
}

type MockHandle = ReturnType<typeof createDeviceHandle>;

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

/** Emit a SendConfirmed (0x82) push for the given ack tag after a tick. */
function emitSendConfirmed(handle: MockHandle, ackCode: number, delayMs = 5): void {
  setTimeout(() => {
    handle.connection.emit(0x82, { ackCode, roundTrip: 250 });
  }, delayMs);
}

const RETRY_ON = { enabled: true, maxAttempts: 2, backoffMs: 1_000 };

describe("sendMessageMeshcore delivery-report retry (issue #25)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOutboundEchoCache();
    clearPacingStateForTests();
    clearSendConfirmedStateForTests();
    clearSendRateLimitState();
  });

  afterEach(() => {
    clearOutboundEchoCache();
    vi.clearAllMocks();
    clearPacingStateForTests();
    clearSendConfirmedStateForTests();
    clearSendRateLimitState();
  });

  it("retries on a timeout delivery report and resolves when the retry is confirmed", async () => {
    let call = 0;
    const sendTextMessage = vi.fn(async () => {
      call += 1;
      return { expectedAckCrc: call, estTimeout: 100 };
    });
    const handle = createDeviceHandle(sendTextMessage);
    getMeshcoreDeviceMock.mockReturnValue(handle);

    const delays: number[] = [];
    const promise = sendMessageMeshcore(TEST_NODE_ID, "retry me", {
      cfg: createConfig({ sendRetry: RETRY_ON }),
      retryBackoffSleep: async (ms) => {
        delays.push(ms);
        // The second attempt's report confirms delivery.
        emitSendConfirmed(handle, 2, 1);
      },
    });

    const result = await promise;
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1_000]);
    expect(result.messageId).toBe("2");
    expect(result.receipt.platformMessageIds).toEqual(["2"]);
  });

  it("does not retry when the delivery report confirms the first attempt", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 7, estTimeout: 100 }));
    const handle = createDeviceHandle(sendTextMessage);
    getMeshcoreDeviceMock.mockReturnValue(handle);
    emitSendConfirmed(handle, 7);

    const delays: number[] = [];
    const result = await sendMessageMeshcore(TEST_NODE_ID, "first try", {
      cfg: createConfig({ sendRetry: RETRY_ON }),
      retryBackoffSleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(result.messageId).toBe("7");
  });

  it("credits the confirm to the report wait when pacing pre-registered a waiter (ack mode)", async () => {
    // With pacing enabled in ack mode, afterFrame pre-registers the final
    // frame's waiter. awaitFrameReport must take it over (single-waiter
    // invariant); if it did not, the pacing waiter would swallow the confirm
    // and the report wait would burn its full timeout and then fail.
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 11, estTimeout: 100 }));
    const handle = createDeviceHandle(sendTextMessage);
    getMeshcoreDeviceMock.mockReturnValue(handle);
    emitSendConfirmed(handle, 11, 20);

    const result = await sendMessageMeshcore(TEST_NODE_ID, "paced", {
      cfg: createConfig({
        sendPacing: { enabled: true, mode: "ack", ackTimeoutMs: 5_000 },
        sendRetry: RETRY_ON,
      }),
      retryBackoffSleep: async () => {},
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("11");
  });

  it("caps retransmissions at maxAttempts and then throws MeshcoreDeliveryFailedError", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1, estTimeout: 100 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const error = await sendMessageMeshcore(TEST_NODE_ID, "never confirmed", {
      cfg: createConfig({ sendRetry: { enabled: true, maxAttempts: 2, backoffMs: 1_000 } }),
      retryBackoffSleep: async () => {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MeshcoreDeliveryFailedError);
    expect((error as MeshcoreDeliveryFailedError).attempts).toBe(2);
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it("backs off with the configured fixed delay between attempts", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1, estTimeout: 100 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const delays: number[] = [];
    await sendMessageMeshcore(TEST_NODE_ID, "backoff schedule", {
      cfg: createConfig({ sendRetry: { enabled: true, maxAttempts: 3, backoffMs: 5_000 } }),
      retryBackoffSleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => {});

    expect(sendTextMessage).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([5_000, 5_000]);
  });

  it("a confirm with a non-matching ack tag is never credited to the report wait", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 42, estTimeout: 100 }));
    const handle = createDeviceHandle(sendTextMessage);
    getMeshcoreDeviceMock.mockReturnValue(handle);
    // Confirm arrives, but for the wrong tag: fail-closed, must still retry
    // and finally fail rather than falsely reporting delivery.
    emitSendConfirmed(handle, 999, 10);

    const error = await sendMessageMeshcore(TEST_NODE_ID, "wrong tag", {
      cfg: createConfig({ sendRetry: RETRY_ON }),
      retryBackoffSleep: async () => {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MeshcoreDeliveryFailedError);
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it("a late delivery report during backoff cancels the retry (no duplicate send)", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 5, estTimeout: 100 }));
    const handle = createDeviceHandle(sendTextMessage);
    getMeshcoreDeviceMock.mockReturnValue(handle);

    const result = await sendMessageMeshcore(TEST_NODE_ID, "late ack", {
      cfg: createConfig({ sendRetry: RETRY_ON }),
      retryBackoffSleep: async () => {
        // The tardy SendConfirmed for attempt 1 lands inside the backoff window.
        emitSendConfirmed(handle, 5, 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });

    expect(result.messageId).toBe("5");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("every attempt consumes rate-limit budget; a refused retry stops whole", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1, estTimeout: 100 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const error = await sendMessageMeshcore(TEST_NODE_ID, "budget", {
      cfg: createConfig({
        sendRetry: RETRY_ON,
        sendRateLimit: { enabled: true, maxSends: 1, windowMs: 600_000 },
      }),
      retryBackoffSleep: async () => {},
    }).catch((e: unknown) => e);

    // Attempt 1 consumed the single packet of budget; the retry is refused
    // before any frame goes on air (whole-or-nothing), so exactly one
    // transmission happened.
    expect(error).toBeInstanceOf(SendRateLimitExceededError);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("rate-limit budget sized for all attempts lets them through and the failure is a delivery failure", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1, estTimeout: 100 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const error = await sendMessageMeshcore(TEST_NODE_ID, "budget ok", {
      cfg: createConfig({
        sendRetry: RETRY_ON,
        sendRateLimit: { enabled: true, maxSends: 2, windowMs: 600_000 },
      }),
      retryBackoffSleep: async () => {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MeshcoreDeliveryFailedError);
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it("is disabled by default: no report wait, no retry, fire-and-forget", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 3, estTimeout: 100 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const result = await sendMessageMeshcore(TEST_NODE_ID, "default path", {
      cfg: createConfig(),
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("3");
  });

  it("explicitly disabled retry behaves like the default path", async () => {
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 4, estTimeout: 100 }));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const result = await sendMessageMeshcore(TEST_NODE_ID, "explicit off", {
      cfg: createConfig({ sendRetry: { enabled: false, maxAttempts: 5, backoffMs: 1_000 } }),
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe("4");
  });

  it("does not retry when the node returns no ack tag (timeout-ambiguous)", async () => {
    const sendTextMessage = vi.fn(async () => ({}));
    getMeshcoreDeviceMock.mockReturnValue(createDeviceHandle(sendTextMessage));

    const delays: number[] = [];
    const result = await sendMessageMeshcore(TEST_NODE_ID, "no tag", {
      cfg: createConfig({ sendRetry: RETRY_ON }),
      retryBackoffSleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(result.target).toBe(TEST_NODE_ID);
  });
});

describe("resolveSendRetryConfig", () => {
  it("defaults to disabled with conservative bounds", () => {
    expect(resolveSendRetryConfig(undefined)).toEqual(SEND_RETRY_DEFAULTS);
    expect(resolveSendRetryConfig({})).toEqual({
      enabled: false,
      maxAttempts: 2,
      backoffMs: 30_000,
    });
  });

  it("clamps maxAttempts to the hard cap and falls back on garbage", () => {
    expect(resolveSendRetryConfig({ enabled: true, maxAttempts: 99, backoffMs: 2_000 })).toEqual({
      enabled: true,
      maxAttempts: 5,
      backoffMs: 2_000,
    });
    expect(
      resolveSendRetryConfig({ enabled: true, maxAttempts: 0, backoffMs: 2_000 }).maxAttempts,
    ).toBe(2);
    expect(
      resolveSendRetryConfig({ enabled: true, maxAttempts: 1.5, backoffMs: 2_000 }).maxAttempts,
    ).toBe(2);
  });

  it("falls back to the default backoff below the minimum and clamps at the maximum", () => {
    expect(resolveSendRetryConfig({ enabled: true, backoffMs: 500 }).backoffMs).toBe(30_000);
    expect(resolveSendRetryConfig({ enabled: true, backoffMs: 999_999 }).backoffMs).toBe(600_000);
  });
});

describe("resolveDeliveryReportTimeoutMs", () => {
  it("clamps the firmware estimate into the report window bounds", () => {
    expect(resolveDeliveryReportTimeoutMs({ estTimeoutMs: 100, fallbackMs: 6_000 })).toBe(
      DELIVERY_REPORT_TIMEOUT_MIN_MS,
    );
    expect(resolveDeliveryReportTimeoutMs({ estTimeoutMs: 12_000, fallbackMs: 6_000 })).toBe(12_000);
    expect(resolveDeliveryReportTimeoutMs({ estTimeoutMs: 999_999, fallbackMs: 6_000 })).toBe(
      DELIVERY_REPORT_TIMEOUT_MAX_MS,
    );
  });

  it("uses the fallback when the firmware gave no usable estimate", () => {
    expect(resolveDeliveryReportTimeoutMs({ fallbackMs: 6_000 })).toBe(6_000);
    expect(resolveDeliveryReportTimeoutMs({ estTimeoutMs: 0, fallbackMs: 6_000 })).toBe(6_000);
  });
});
