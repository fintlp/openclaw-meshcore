import {
  chunkTextWithNumbering,
  MESHCORE_WIRE_CHUNK_LIMIT,
} from "./send.js";

const MEASUREMENT_PAIRING_CODE = "ABCD2345";
const SIGNED_PLAIN_PREFIX_BYTES = 4;

/**
 * The stock OpenClaw pairing reply shape on both supported host versions.
 * Keeping construction here lets intake measure the same text that the host
 * sends, including the full node-id line and approval instructions.
 */
export function buildMeshcorePairingReplyText(params: {
  code: string;
  senderIdLine: string;
}): string {
  return [
    "OpenClaw: access not configured.",
    "",
    params.senderIdLine,
    "Pairing code:",
    "```",
    params.code,
    "```",
    "",
    "Ask the bot owner to approve with:",
    "```",
    `openclaw pairing approve meshcore ${params.code}`,
    "```",
  ].join("\n");
}

/** Compute the real packet cost under the account's outbound chunk settings. */
export function countMeshcorePairingReplyPackets(params: {
  senderIdLine: string;
  textChunkLimit?: number;
  chunkNumbering?: boolean;
  outboundSignedPlain?: boolean;
}): number {
  const plainChunkLimit = Math.min(
    params.textChunkLimit ?? MESHCORE_WIRE_CHUNK_LIMIT,
    MESHCORE_WIRE_CHUNK_LIMIT,
  );
  const chunkLimit = params.outboundSignedPlain === true
    ? Math.max(1, plainChunkLimit - SIGNED_PLAIN_PREFIX_BYTES)
    : plainChunkLimit;
  const representativeReply = buildMeshcorePairingReplyText({
    code: MEASUREMENT_PAIRING_CODE,
    senderIdLine: params.senderIdLine,
  });
  return chunkTextWithNumbering(
    representativeReply,
    chunkLimit,
    params.chunkNumbering ?? true,
  ).length;
}
