import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-message";
import { sendMessageMeshcore } from "./send.js";
import type { CoreConfig } from "./types.js";

export const meshcoreMessageAdapter = defineChannelMessageAdapter({
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, replyToId }) => {
      const result = await sendMessageMeshcore(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return {
        messageId: result.messageId,
        receipt: result.receipt,
      };
    },
  },
});
