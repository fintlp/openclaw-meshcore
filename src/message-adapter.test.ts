import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-message";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { meshcoreMessageAdapter } from "./message-adapter.js";

const sendMessageMeshcoreMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageMeshcore: sendMessageMeshcoreMock,
}));

const cfg = {
  channels: {
    meshcore: {
      host: "192.168.1.226",
      port: 5000,
    },
  },
} as OpenClawConfig;

describe("meshcore message adapter", () => {
  afterEach(() => {
    sendMessageMeshcoreMock.mockReset();
    clearOutboundEchoCache();
  });

  it("declares durable text and replyTo capabilities with receipt proofs", async () => {
    sendMessageMeshcoreMock.mockResolvedValue({
      messageId: "mc-12345",
      target: "!aabbccdd1122",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "meshcore", messageId: "mc-12345" }],
        kind: "text",
      }),
    });

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "meshcore",
      adapter: meshcoreMessageAdapter,
      proofs: {
        text: async () => {
          const result = await meshcoreMessageAdapter.send?.text?.({
            cfg,
            to: "!aabbccdd1122",
            text: "hello meshcore",
          });
          expect(sendMessageMeshcoreMock).toHaveBeenCalledWith(
            "!aabbccdd1122",
            "hello meshcore",
            expect.objectContaining({ cfg }),
          );
          expect(result?.receipt.platformMessageIds).toEqual(["mc-12345"]);
        },
        replyTo: async () => {
          sendMessageMeshcoreMock.mockResolvedValueOnce({
            messageId: "mc-12346",
            target: "!aabbccdd1122",
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "meshcore", messageId: "mc-12346" }],
              kind: "text",
              replyToId: "mc-12345",
            }),
          });
          const result = await meshcoreMessageAdapter.send?.text?.({
            cfg,
            to: "!aabbccdd1122",
            text: "reply body",
            replyToId: "mc-12345",
            accountId: "default",
          });
          expect(sendMessageMeshcoreMock).toHaveBeenCalledWith(
            "!aabbccdd1122",
            "reply body",
            expect.objectContaining({
              cfg,
              replyTo: "mc-12345",
              accountId: "default",
            }),
          );
          expect(result?.receipt.replyToId).toBe("mc-12345");
        },
      },
    });
  });
});
