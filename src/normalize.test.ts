import { describe, expect, it } from "vitest";
import {
  buildMeshcoreAllowlistCandidates,
  formatMeshcoreChannelTarget,
  formatMeshcoreNodeId,
  isMeshcoreGroupTarget,
  looksLikeMeshcoreTargetId,
  normalizeMeshcoreAllowEntry,
  normalizeMeshcoreMessagingTarget,
  parseMeshcoreChannelIndex,
  parseMeshcoreNodeId,
  resolveMeshcoreAllowlistMatch,
} from "./normalize.js";

describe("meshcore normalize", () => {
  it("formats node ids", () => {
    expect(formatMeshcoreNodeId("aabbccdd1122")).toBe("!aabbccdd1122");
    expect(formatMeshcoreNodeId("!AABBCCDD1122")).toBe("!aabbccdd1122");
  });

  it("normalizes messaging targets", () => {
    expect(normalizeMeshcoreMessagingTarget("meshcore:channel:0")).toBe("channel:0");
    expect(normalizeMeshcoreMessagingTarget("ch:2")).toBe("channel:2");
    expect(normalizeMeshcoreMessagingTarget("broadcast")).toBe("channel:0");
    expect(normalizeMeshcoreMessagingTarget("!aabbccdd1122")).toBe("!aabbccdd1122");
    expect(normalizeMeshcoreMessagingTarget("\n")).toBeUndefined();
  });

  it("parses channel indices", () => {
    expect(parseMeshcoreChannelIndex("channel:0")).toBe(0);
    expect(parseMeshcoreChannelIndex("ch:3")).toBe(3);
    expect(parseMeshcoreChannelIndex("broadcast")).toBe(0);
    expect(formatMeshcoreChannelTarget(1)).toBe("channel:1");
  });

  it("parses node ids", () => {
    expect(parseMeshcoreNodeId("!aabbccdd1122")).toBe("aabbccdd1122");
    expect(parseMeshcoreNodeId("aabbccdd1122")).toBe("aabbccdd1122");
    expect(parseMeshcoreNodeId("meshcore:!aabbccdd1122")).toBe("aabbccdd1122");
  });

  it("detects group targets", () => {
    expect(isMeshcoreGroupTarget("channel:0")).toBe(true);
    expect(isMeshcoreGroupTarget("broadcast")).toBe(true);
    expect(isMeshcoreGroupTarget("!aabbccdd1122")).toBe(false);
  });

  it("detects target-like ids", () => {
    expect(looksLikeMeshcoreTargetId("!aabbccdd1122")).toBe(true);
    expect(looksLikeMeshcoreTargetId("meshcore:channel:0")).toBe(true);
    expect(looksLikeMeshcoreTargetId("hello")).toBe(false);
  });

  it("normalizes allowlist entries", () => {
    expect(normalizeMeshcoreAllowEntry("*")).toBe("*");
    expect(normalizeMeshcoreAllowEntry("!aabbccdd1122")).toBe("!aabbccdd1122");
    expect(normalizeMeshcoreAllowEntry("meshcore:!aabbccdd1122")).toBe("!aabbccdd1122");
    expect(normalizeMeshcoreAllowEntry("MyNode")).toBe("mynode");
  });

  it("builds allowlist candidates", () => {
    expect(
      buildMeshcoreAllowlistCandidates({
        senderNodeId: "!aabbccdd1122",
        senderName: "MyNode",
      }),
    ).toContain("!aabbccdd1122");
  });

  it("matches senders by exact node id or name", () => {
    expect(
      resolveMeshcoreAllowlistMatch({
        allowFrom: ["!aabbccdd1122"],
        senderNodeId: "!aabbccdd1122",
      }).allowed,
    ).toBe(true);
    expect(
      resolveMeshcoreAllowlistMatch({
        allowFrom: ["mynode"],
        senderNodeId: "!aabbccdd1122",
        senderName: "MyNode",
      }).allowed,
    ).toBe(true);
    expect(
      resolveMeshcoreAllowlistMatch({
        allowFrom: ["!aabbccdd1122"],
        senderNodeId: "!aabbccdd1123",
      }).allowed,
    ).toBe(false);
  });

  it("matches prefix allowlist entries", () => {
    expect(
      resolveMeshcoreAllowlistMatch({
        allowFrom: ["!aabbccdd"],
        senderNodeId: "!aabbccdd1122",
      }).allowed,
    ).toBe(true);
  });
});
