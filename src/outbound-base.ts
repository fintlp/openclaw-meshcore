import { sanitizeForPlainText } from "openclaw/plugin-sdk/infra-runtime";
import { MESHCORE_WIRE_CHUNK_LIMIT } from "./send.js";

/**
 * The MeshCore wire limit is 127 bytes per text frame, and the plugin's own
 * chunker (src/send.ts) budgets prefixes and enforces that cap. Tell the
 * OpenClaw host NOT to pre-chunk outbound text, so the plugin receives the
 * full message and can number chunks as one sequence.
 *
 * Even though the host must not pre-chunk here, the adapter still declares
 * textChunkLimit because the host's block-streaming layer reads it directly
 * (node_modules/openclaw/dist/block-streaming-BEzM6HHK.mjs:17) regardless of
 * chunker. This mirrors the built-in Telegram adapter, which keeps
 * chunker:null and textChunkLimit set together. Removing textChunkLimit would
 * silently widen live-reply coalescing from 127 to the host default (~1200).
 */
export const meshcoreOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  // Host must not pre-chunk; plugin self-chunks so [n/N] numbering reaches
  // the wire as one contiguous sequence.
  chunker: null,
  chunkerMode: "text" as const,
  textChunkLimit: MESHCORE_WIRE_CHUNK_LIMIT,
  sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
};
