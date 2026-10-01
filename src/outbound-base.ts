import { sanitizeForPlainText } from "openclaw/plugin-sdk/infra-runtime";
import { chunkTextForOutbound } from "./channel-api.js";

export const meshcoreOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "text" as const,
  textChunkLimit: 133,
  sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
};
