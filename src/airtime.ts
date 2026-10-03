/**
 * LoRa packet time-on-air estimation for MeshCore outbound text pacing.
 *
 * Uses the Semtech LoRa modulation formula:
 *
 *   Ts = 2^SF / BW
 *   T_preamble = (N_preamble + 4.25) * Ts
 *   payload_sym = 8 + max(ceil((8*PL + 28 - 4*SF + 16 - 20*H) / (4*(SF - 2*DE))) * (CR + 4), 0)
 *   T_payload = payload_sym * Ts
 *   T_total = T_preamble + T_payload
 *
 * Constants:
 *   PL  = payload length in bytes
 *   SF  = spreading factor
 *   BW  = bandwidth in Hz
 *   CR  = coding-rate code 1..4 (4/(4+CR), i.e. 1=4/5 ... 4=4/8)
 *   H   = 0 explicit header, 1 implicit header
 *   DE  = 1 low-data-rate-optimize when symbol duration > 16 ms (i.e. 2^SF / BW > 0.016)
 *   16  = CRC enabled
 *
 * MeshCore stores the coding-rate denominator in SelfInfo.radioCr (5..8), so
 * we map it to the standard CR code with `radioCr - 4`.
 */

export type LoraAirtimeParams = {
  /** Payload length in bytes (the MeshCore text frame payload). */
  payloadBytes: number;
  /** Spreading factor (7-12 typical). */
  spreadingFactor: number;
  /** Bandwidth in Hz (e.g. 62500). */
  bandwidthHz: number;
  /**
   * Coding rate as stored by MeshCore SelfInfo: denominator 5..8 for 4/5..4/8.
   * Values 1..4 are accepted as standard CR codes as a defensive fallback.
   */
  codingRate: number;
  /** Number of preamble symbols (default 8). */
  preambleSymbols?: number;
  /** 0 = explicit header, 1 = implicit header (default explicit). */
  headerMode?: number;
  /**
   * 1 = low data-rate optimize enabled.
   * Default: on when the symbol duration exceeds 16 ms (Semtech/RadioLib rule).
   */
  lowDataRateOptimize?: number;
};

function normalizeCodingRate(codingRate: number): number {
  // MeshCore stores coding rate as denominator 5..8; map to standard CR code 1..4.
  if (codingRate >= 5 && codingRate <= 8) {
    return codingRate - 4;
  }
  if (codingRate >= 1 && codingRate <= 4) {
    return codingRate;
  }
  // Defensive fallback to 4/8 (CR code 4) if the node returns something odd.
  return 4;
}

function isLowDataRateOptimizeEnabled(sf: number, bw: number): number {
  // Semtech/RadioLib: DE is enabled when symbol duration exceeds 16 ms.
  const symbolDurationMs = (2 ** sf / bw) * 1000;
  return symbolDurationMs > 16 ? 1 : 0;
}

export function calculateLoraAirtimeMs(params: LoraAirtimeParams): number {
  const pl = Math.max(0, Math.floor(params.payloadBytes));
  const sf = Math.max(6, Math.min(12, params.spreadingFactor));
  const bw = Math.max(1, params.bandwidthHz);
  const cr = normalizeCodingRate(params.codingRate);
  const preambleSymbols = params.preambleSymbols ?? 8;
  const h = params.headerMode === 1 ? 1 : 0;
  const de = params.lowDataRateOptimize ?? isLowDataRateOptimizeEnabled(sf, bw);

  const symbolDurationMs = (2 ** sf / bw) * 1000;

  const preambleDurationMs = (preambleSymbols + 4.25) * symbolDurationMs;

  // Numerator from the Semtech payload-symbol formula.
  const numerator = 8 * pl + 28 - 4 * sf + 16 - 20 * h;
  const denominator = 4 * (sf - 2 * de);
  const payloadSymbols =
    8 + Math.max(0, Math.ceil(Math.max(0, numerator) / denominator)) * (cr + 4);

  const payloadDurationMs = payloadSymbols * symbolDurationMs;

  return preambleDurationMs + payloadDurationMs;
}

export type SendPacingConfig = {
  enabled: boolean;
  minDelayMs: number;
  maxDelayMs: number;
  airtimeMargin: number;
  defaultSf: number;
  defaultBw: number;
  defaultCr: number;
};

export function resolveSendPacingConfig(
  raw: Record<string, unknown> | undefined,
): SendPacingConfig {
  const pacing = raw ?? {};
  return {
    enabled: typeof pacing.enabled === "boolean" ? pacing.enabled : true,
    minDelayMs: typeof pacing.minDelayMs === "number" ? Math.max(0, pacing.minDelayMs) : 200,
    maxDelayMs: typeof pacing.maxDelayMs === "number" ? Math.max(0, pacing.maxDelayMs) : 5000,
    airtimeMargin:
      typeof pacing.airtimeMargin === "number" && pacing.airtimeMargin >= 1
        ? pacing.airtimeMargin
        : 1.25,
    defaultSf: typeof pacing.defaultSf === "number" ? Math.max(6, Math.min(12, pacing.defaultSf)) : 8,
    defaultBw: typeof pacing.defaultBw === "number" ? Math.max(1, pacing.defaultBw) : 62_500,
    defaultCr: typeof pacing.defaultCr === "number" ? pacing.defaultCr : 8,
  };
}

export function calculateChunkAirtimeMs(
  chunkBytes: number,
  radioParams: { radioSf?: number; radioBw?: number; radioCr?: number } | undefined,
  pacing: SendPacingConfig,
): number {
  // device-client normalizes missing SelfInfo fields to 0, so a truthy >0 guard
  // is required; otherwise a node that reports radioCr=0 would silently use 0.
  const sf =
    radioParams && radioParams.radioSf != null && radioParams.radioSf > 0
      ? radioParams.radioSf
      : pacing.defaultSf;
  const bw =
    radioParams && radioParams.radioBw != null && radioParams.radioBw > 0
      ? radioParams.radioBw
      : pacing.defaultBw;
  const cr =
    radioParams && radioParams.radioCr != null && radioParams.radioCr > 0
      ? radioParams.radioCr
      : pacing.defaultCr;

  return calculateLoraAirtimeMs({
    payloadBytes: chunkBytes,
    spreadingFactor: sf,
    bandwidthHz: bw,
    codingRate: cr,
  });
}

export function estimateChunkAirtimeMs(
  chunkBytes: number,
  radioParams: { radioSf?: number; radioBw?: number; radioCr?: number } | undefined,
  pacing: SendPacingConfig,
): number {
  const baseMs = calculateChunkAirtimeMs(chunkBytes, radioParams, pacing);
  const withMargin = Math.ceil(baseMs * pacing.airtimeMargin);
  return Math.max(pacing.minDelayMs, Math.min(pacing.maxDelayMs, withMargin));
}
