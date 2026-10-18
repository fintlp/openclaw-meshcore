import { afterEach, describe, expect, it } from "vitest";
import {
  assertSendRateLimit,
  clearSendRateLimitState,
  resolveSendRateLimitConfig,
  SEND_RATE_LIMIT_DEFAULTS,
  SendRateLimitExceededError,
} from "./rate-limit.js";

const BASE_NOW = 1_800_000_000_000;

describe("resolveSendRateLimitConfig", () => {
  it("applies defaults when unset", () => {
    expect(resolveSendRateLimitConfig(undefined)).toEqual(SEND_RATE_LIMIT_DEFAULTS);
    expect(SEND_RATE_LIMIT_DEFAULTS).toEqual({ enabled: true, maxSends: 20, windowMs: 600_000 });
  });

  it("honors explicit overrides and ignores invalid values", () => {
    expect(resolveSendRateLimitConfig({ enabled: false, maxSends: 5, windowMs: 60_000 })).toEqual({
      enabled: false,
      maxSends: 5,
      windowMs: 60_000,
    });
    expect(resolveSendRateLimitConfig({ maxSends: 0, windowMs: 500 })).toEqual({
      enabled: true,
      maxSends: 20,
      windowMs: 600_000,
    });
  });
});

describe("assertSendRateLimit", () => {
  afterEach(() => {
    clearSendRateLimitState();
  });

  it("allows sends up to the packet budget, then refuses", () => {
    const config = resolveSendRateLimitConfig({ maxSends: 3 });
    assertSendRateLimit({ accountId: "default", packets: 2, config, nowMs: BASE_NOW });
    assertSendRateLimit({ accountId: "default", packets: 1, config, nowMs: BASE_NOW + 1 });
    expect(() =>
      assertSendRateLimit({ accountId: "default", packets: 1, config, nowMs: BASE_NOW + 2 }),
    ).toThrow(SendRateLimitExceededError);
  });

  it("refuses a whole message when its chunks exceed the remaining budget", () => {
    const config = resolveSendRateLimitConfig({ maxSends: 4 });
    assertSendRateLimit({ accountId: "default", packets: 3, config, nowMs: BASE_NOW });
    expect(() =>
      assertSendRateLimit({ accountId: "default", packets: 2, config, nowMs: BASE_NOW + 1 }),
    ).toThrow(/needs 2 more/);
  });

  it("names the retry delay and config path in the refusal", () => {
    const config = resolveSendRateLimitConfig({ maxSends: 1, windowMs: 60_000 });
    assertSendRateLimit({ accountId: "default", packets: 1, config, nowMs: BASE_NOW });
    try {
      assertSendRateLimit({ accountId: "default", packets: 1, config, nowMs: BASE_NOW + 10_000 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SendRateLimitExceededError);
      const err = error as SendRateLimitExceededError;
      expect(err.message).toMatch(/channels\.meshcore\.sendRateLimit/);
      expect(err.message).toMatch(/Retry in ~50s/);
      expect(err.retryAfterMs).toBe(50_000);
      expect(err.message).toMatch(/LoRa airtime rule/);
    }
  });

  it("frees budget once the window slides past old sends", () => {
    const config = resolveSendRateLimitConfig({ maxSends: 2, windowMs: 60_000 });
    assertSendRateLimit({ accountId: "default", packets: 2, config, nowMs: BASE_NOW });
    // 61s later, both sends have aged out of the 60s window.
    assertSendRateLimit({ accountId: "default", packets: 2, config, nowMs: BASE_NOW + 61_000 });
  });

  it("does not count anything when disabled", () => {
    const config = resolveSendRateLimitConfig({ enabled: false, maxSends: 1 });
    for (let i = 0; i < 10; i += 1) {
      assertSendRateLimit({ accountId: "default", packets: 5, config, nowMs: BASE_NOW + i });
    }
  });

  it("tracks budgets independently per account", () => {
    const config = resolveSendRateLimitConfig({ maxSends: 1 });
    assertSendRateLimit({ accountId: "alpha", packets: 1, config, nowMs: BASE_NOW });
    assertSendRateLimit({ accountId: "beta", packets: 1, config, nowMs: BASE_NOW });
    expect(() =>
      assertSendRateLimit({ accountId: "alpha", packets: 1, config, nowMs: BASE_NOW + 1 }),
    ).toThrow(SendRateLimitExceededError);
  });
});
