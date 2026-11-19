import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
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
    text: async (ctx) => {
      const { cfg, to, text, accountId, replyToId } = ctx;
      // Repo SDK 2026.10.5 does not declare the producing key added by the
      // 2026.11.3 host. Keep the older-host fallback as undefined/account-only.
      const sessionKey = (ctx as unknown as { sessionKey?: string }).sessionKey;
      const result = await sendMessageMeshcore(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        sessionKey,
        replyTo: replyToId ?? undefined,
      });
      return {
        messageId: result.messageId,
        receipt: result.receipt,
      };
    },
  },
});
