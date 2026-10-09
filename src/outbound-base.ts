import { sanitizeForPlainText } from "openclaw/plugin-sdk/infra-runtime";

/**
 * The MeshCore wire limit is 127 bytes per text frame, and the plugin's own
 * chunker (src/send.ts) budgets prefixes and enforces that cap. Tell the
 * OpenClaw host NOT to pre-chunk outbound text, so the plugin receives the
 * full message and can number chunks as one sequence.
 */
export const meshcoreOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: null,
  chunkerMode: "text" as const,
  sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
};
