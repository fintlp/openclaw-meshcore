import { describe, expect, it } from "vitest";
import {
  buildMeshcorePairingReplyText,
  countMeshcorePairingReplyPackets,
} from "./pairing-reply.js";
import { chunkTextWithNumbering } from "./send.js";

const nodeId = "!" + "ab".repeat(32);
const senderIdLine = "Your MeshCore node id: " + nodeId;

describe("MeshCore pairing reply sizing", () => {
  it("uses the real stock host text, including the full id line", () => {
    const text = buildMeshcorePairingReplyText({ code: "ABCD2345", senderIdLine });
    expect(text).toBe([
      "OpenClaw: access not configured.",
      "",
      senderIdLine,
      "Pairing code:",
      "```",
      "ABCD2345",
      "```",
      "",
      "Ask the bot owner to approve with:",
      "```",
      "openclaw pairing approve meshcore ABCD2345",
      "```",
    ].join("\n"));
    expect(Buffer.byteLength(text)).toBe(240);
    const chunks = chunkTextWithNumbering(text, 127, true);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => Buffer.byteLength(chunk))).toEqual([62, 124, 70]);
    expect(countMeshcorePairingReplyPackets({ senderIdLine })).toBe(chunks.length);
  });

  it("re-measures under the account's actual chunk settings", () => {
    expect(countMeshcorePairingReplyPackets({
      senderIdLine,
      textChunkLimit: 100,
      chunkNumbering: true,
      outboundSignedPlain: true,
    })).toBeGreaterThan(3);
  });
});
