import { describe, expect, it } from "vitest";
import {
  calculateLoraAirtimeMs,
  estimateChunkAirtimeMs,
  resolveSendPacingConfig,
} from "./airtime.js";

describe("calculateLoraAirtimeMs", () => {
  it("matches the documented >1s airtime for a 133-byte frame at SF8/BW62.5k/CR4/8", () => {
    const ms = calculateLoraAirtimeMs({
      payloadBytes: 133,
      spreadingFactor: 8,
      bandwidthHz: 62_500,
      codingRate: 8, // MeshCore denominator 8 -> 4/8
    });

    // Preamble ~50 ms + payload ~1147 ms = ~1197 ms.
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(1300);
  });

  it("returns a shorter airtime for smaller payloads", () => {
    const ms = calculateLoraAirtimeMs({
      payloadBytes: 34,
      spreadingFactor: 8,
      bandwidthHz: 62_500,
      codingRate: 8,
    });

    expect(ms).toBeGreaterThan(300);
    expect(ms).toBeLessThan(500);
  });

  it("increases airtime with higher spreading factor", () => {
    const sf8 = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 62_500,
      codingRate: 8,
    });
    const sf10 = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 10,
      bandwidthHz: 62_500,
      codingRate: 8,
    });

    expect(sf10).toBeGreaterThan(sf8);
  });

  it("decreases airtime with wider bandwidth", () => {
    const bw62500 = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 62_500,
      codingRate: 8,
    });
    const bw125000 = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 125_000,
      codingRate: 8,
    });

    expect(bw125000).toBeLessThan(bw62500);
  });

  it("defensively accepts standard CR codes 1..4", () => {
    const cr4 = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 62_500,
      codingRate: 4,
    });
    const cr8 = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 62_500,
      codingRate: 8,
    });

    // Both map to 4/8; results must match.
    expect(cr4).toBe(cr8);
  });

  it("clamps out-of-range CR values to 4/8", () => {
    const sane = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 62_500,
      codingRate: 8,
    });
    const weird = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 62_500,
      codingRate: 99,
    });

    expect(weird).toBe(sane);
  });

  it("enables low-data-rate optimize when symbol duration exceeds 16 ms", () => {
    // SF10 / BW62.5k => Ts = 1024/62500 = 16.384 ms > 16 ms => DE on.
    const sf10 = calculateLoraAirtimeMs({
      payloadBytes: 32,
      spreadingFactor: 10,
      bandwidthHz: 62_500,
      codingRate: 8,
    });
    // SF9 / BW62.5k => Ts = 512/62500 = 8.192 ms <= 16 ms => DE off.
    const sf9 = calculateLoraAirtimeMs({
      payloadBytes: 32,
      spreadingFactor: 9,
      bandwidthHz: 62_500,
      codingRate: 8,
    });

    expect(sf10).toBeGreaterThan(sf9);

    // Verify DE actually changed the symbol count by comparing with explicit de=0.
    const sf10NoDe = calculateLoraAirtimeMs({
      payloadBytes: 32,
      spreadingFactor: 10,
      bandwidthHz: 62_500,
      codingRate: 8,
      lowDataRateOptimize: 0,
    });
    expect(sf10).toBeGreaterThan(sf10NoDe);

    // SF9 is below the DE threshold, so auto-DE should equal explicit de=0.
    const sf9NoDe = calculateLoraAirtimeMs({
      payloadBytes: 32,
      spreadingFactor: 9,
      bandwidthHz: 62_500,
      codingRate: 8,
      lowDataRateOptimize: 0,
    });
    expect(sf9).toBe(sf9NoDe);
  });

  it("honours explicit lowDataRateOptimize override", () => {
    const withDe = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 125_000,
      codingRate: 8,
      lowDataRateOptimize: 1,
    });
    const withoutDe = calculateLoraAirtimeMs({
      payloadBytes: 64,
      spreadingFactor: 8,
      bandwidthHz: 125_000,
      codingRate: 8,
      lowDataRateOptimize: 0,
    });

    expect(withDe).toBeGreaterThan(withoutDe);
  });
});

describe("resolveSendPacingConfig", () => {
  it("applies sane defaults", () => {
    const cfg = resolveSendPacingConfig(undefined);

    expect(cfg.enabled).toBe(true);
    expect(cfg.minDelayMs).toBe(200);
    expect(cfg.maxDelayMs).toBe(5000);
    expect(cfg.airtimeMargin).toBe(1.25);
    expect(cfg.defaultSf).toBe(8);
    expect(cfg.defaultBw).toBe(62_500);
    expect(cfg.defaultCr).toBe(8);
  });

  it("preserves explicit overrides", () => {
    const cfg = resolveSendPacingConfig({
      enabled: false,
      minDelayMs: 500,
      maxDelayMs: 10_000,
      airtimeMargin: 2.0,
      defaultSf: 10,
      defaultBw: 125_000,
      defaultCr: 5,
    });

    expect(cfg.enabled).toBe(false);
    expect(cfg.minDelayMs).toBe(500);
    expect(cfg.maxDelayMs).toBe(10_000);
    expect(cfg.airtimeMargin).toBe(2.0);
    expect(cfg.defaultSf).toBe(10);
    expect(cfg.defaultBw).toBe(125_000);
    expect(cfg.defaultCr).toBe(5);
  });

  it("rejects sub-1.0 airtime margins", () => {
    const cfg = resolveSendPacingConfig({ airtimeMargin: 0.5 });

    expect(cfg.airtimeMargin).toBe(1.25);
  });

  it("clamps negative delays to zero", () => {
    const cfg = resolveSendPacingConfig({ minDelayMs: -100, maxDelayMs: -50 });

    expect(cfg.minDelayMs).toBe(0);
    expect(cfg.maxDelayMs).toBe(0);
  });
});

describe("estimateChunkAirtimeMs", () => {
  it("uses live radio params when available with values DISTINCT from defaults", () => {
    const pacing = resolveSendPacingConfig({ airtimeMargin: 1.0 });
    // Defaults are SF8/BW62.5k/CR8; use SF10/BW31.25k/CR7 so swapping order matters.
    const ms = estimateChunkAirtimeMs(
      80,
      { radioSf: 10, radioBw: 31_250, radioCr: 7 },
      pacing,
    );

    // SF10/BW31.25k is much slower than the default.
    expect(ms).toBeGreaterThan(3000);
  });

  it("falls back to configured defaults when radio params are missing", () => {
    const pacing = resolveSendPacingConfig({ defaultSf: 7, defaultBw: 125_000, defaultCr: 8 });
    const ms = estimateChunkAirtimeMs(127, undefined, pacing);

    // SF7 / BW125k is much faster than the SF8 / BW62.5k default.
    expect(ms).toBeLessThan(600);
  });

  it("falls back to defaults when live params are zero (device-client normalization)", () => {
    const pacing = resolveSendPacingConfig({ airtimeMargin: 1.0, defaultSf: 7, defaultBw: 125_000, defaultCr: 5 });
    const ms = estimateChunkAirtimeMs(127, { radioSf: 0, radioBw: 0, radioCr: 0 }, pacing);

    // Should use the configured defaults, NOT zero (which would be invalid/very wrong).
    expect(ms).toBeLessThan(600);
  });

  it("applies the safety margin", () => {
    const withoutMargin = resolveSendPacingConfig({ airtimeMargin: 1.0 });
    const withMargin = resolveSendPacingConfig({ airtimeMargin: 2.0 });

    const base = estimateChunkAirtimeMs(64, { radioSf: 8, radioBw: 62_500, radioCr: 8 }, withoutMargin);
    const doubled = estimateChunkAirtimeMs(64, { radioSf: 8, radioBw: 62_500, radioCr: 8 }, withMargin);

    expect(doubled).toBeGreaterThan(base);
  });

  it("clamps to minDelayMs", () => {
    const pacing = resolveSendPacingConfig({ minDelayMs: 1000 });
    // A tiny payload at SF7/BW125k would normally be <100 ms.
    const ms = estimateChunkAirtimeMs(1, { radioSf: 7, radioBw: 125_000, radioCr: 5 }, pacing);

    expect(ms).toBe(1000);
  });

  it("clamps to maxDelayMs", () => {
    const pacing = resolveSendPacingConfig({ maxDelayMs: 500 });
    const ms = estimateChunkAirtimeMs(200, { radioSf: 12, radioBw: 62_500, radioCr: 8 }, pacing);

    expect(ms).toBe(500);
  });
});
