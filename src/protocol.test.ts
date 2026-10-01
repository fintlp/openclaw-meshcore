import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  formatNodeIdFromBytes,
  formatNodeIdPrefixFromBytes,
  hexToBytes,
  isValidPubkeyHex,
  messageIdFromTimestamp,
  normalizePubkeyHex,
} from "./protocol.js";

describe("meshcore protocol helpers", () => {
  it("converts bytes to hex", () => {
    expect(bytesToHex(new Uint8Array([0xab, 0xcd, 0xef]))).toBe("abcdef");
  });

  it("converts hex to bytes", () => {
    expect(Array.from(hexToBytes("abcdef"))).toEqual([0xab, 0xcd, 0xef]);
  });

  it("validates full public key hex", () => {
    expect(isValidPubkeyHex("a".repeat(64))).toBe(true);
    expect(isValidPubkeyHex("a".repeat(63))).toBe(false);
    expect(isValidPubkeyHex("g".repeat(64))).toBe(false);
  });

  it("normalizes pubkey hex", () => {
    expect(normalizePubkeyHex(" AB CD ")).toBe("abcd");
  });

  it("formats node ids", () => {
    const full = new Uint8Array(32);
    full[0] = 0xab;
    full[31] = 0xef;
    expect(formatNodeIdFromBytes(full)).toBe(`!ab${"00".repeat(30)}ef`);
    expect(formatNodeIdPrefixFromBytes(full)).toBe("!ab0000000000");
  });

  it("generates message ids from timestamp", () => {
    const id = messageIdFromTimestamp(1_700_000_000);
    expect(id.startsWith("mc-")).toBe(true);
  });
});
