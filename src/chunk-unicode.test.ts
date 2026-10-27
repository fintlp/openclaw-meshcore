/**
 * Grapheme-safe hard-split tests for the MeshCore outbound path (issue #58).
 *
 * chunkText already budgets UTF-8 bytes and prefers whitespace, but its
 * hard-split loop iterated code points, cutting combined characters (emoji
 * ZWJ sequences, flags, skin tones, Thai/Hindi marks, Hebrew niqqud, Arabic
 * tashkeel, decomposed accents) across two messages. The fix iterates
 * grapheme clusters (Intl.Segmenter) with a code-point fallback for a single
 * oversized grapheme and for runtimes without Intl.Segmenter.
 *
 * The corpus is shared byte-for-byte with openclaw-meshtastic
 * (src/test-fixtures/unicode-corpus.ts). The sweep runs EVERY limit from 40
 * to 127 with [n/N] numbering on and off — whether a cut lands inside a
 * combined character depends on position, so fixed limits can miss it.
 */
import { describe, expect, it, vi } from "vitest";
import { UNICODE_CORPUS } from "./test-fixtures/unicode-corpus.js";
import { chunkTextWithNumbering } from "./send.js";

const encoder = new TextEncoder();
const utf8Bytes = (s: string): number => encoder.encode(s).length;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeCount = (s: string) => [...segmenter.segment(s)].length;
const stripPrefix = (s: string): string => s.replace(/^\[\d+\/\d+\] /, "");

// MeshCore wire cap for one text frame.
const MAX_LIMIT = 127;

describe("chunkTextWithNumbering: shared Unicode corpus sweep (issue #58)", () => {
  for (const [name, entry] of Object.entries(UNICODE_CORPUS)) {
    for (const numbering of [false, true]) {
      it(
        name +
          " (numbering " +
          (numbering ? "on" : "off") +
          "): byte limit, no loss, no broken graphemes at every limit",
        () => {
          const long = (entry.text + (entry.spaces ? " " : "")).repeat(12);
          for (let limit = 40; limit <= MAX_LIMIT; limit++) {
            const chunks = chunkTextWithNumbering(long, limit, numbering);
            expect(chunks.length).toBeGreaterThan(1);
            for (const c of chunks) {
              // The [n/N] prefix counts toward the wire limit.
              expect(utf8Bytes(c)).toBeLessThanOrEqual(limit);
            }
            // No content lost (prefixes removed, whitespace may move).
            const plain = chunks.map(stripPrefix);
            expect(plain.join("").replace(/\s+/g, "")).toBe(long.replace(/\s+/g, ""));
            // No join splits a grapheme cluster.
            for (let i = 0; i + 1 < plain.length; i++) {
              const [a, b] = [plain[i], plain[i + 1]];
              expect(graphemeCount(a + b)).toBe(graphemeCount(a) + graphemeCount(b));
            }
          }
        },
      );
    }

    it(name + ": text that fits stays one chunk without a prefix", () => {
      if (utf8Bytes(entry.text) > MAX_LIMIT) {
        // Over the wire cap even as a single message (e.g. Russian at ~135
        // bytes vs the 127-byte frame): must chunk cleanly instead.
        const chunks = chunkTextWithNumbering(entry.text, MAX_LIMIT, false);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join("").replace(/\s+/g, "")).toBe(entry.text.replace(/\s+/g, ""));
        return;
      }
      expect(chunkTextWithNumbering(entry.text, MAX_LIMIT, false)).toEqual([entry.text]);
      expect(chunkTextWithNumbering(entry.text, MAX_LIMIT, true)).toEqual([entry.text]);
    });
  }
});

describe("chunk numbering position for RTL text (issue #58)", () => {
  for (const name of ["hebrew", "arabic"]) {
    it(name + ": the [n/N] prefix stays at the logical start of every chunk", () => {
      const long = UNICODE_CORPUS[name].text.repeat(12);
      const chunks = chunkTextWithNumbering(long, MAX_LIMIT, true);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((c, i) => {
        const m = c.match(/^\[(\d+)\/(\d+)\] /);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBe(i + 1);
        expect(Number(m![2])).toBe(chunks.length);
        // Content follows the prefix in byte order, whatever the client
        // does visually with LTR-prefix + RTL-text.
        expect(stripPrefix(c).length).toBeGreaterThan(0);
      });
    });
  }
});

describe("chunkTextWithNumbering without Intl.Segmenter (issue #58)", () => {
  it("falls back to code points and logs once instead of crashing", () => {
    const intl = Intl as unknown as { Segmenter?: unknown };
    const original = intl.Segmenter;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    intl.Segmenter = undefined;
    try {
      const long = UNICODE_CORPUS.emojiSequences.text.repeat(12);
      const chunks = chunkTextWithNumbering(long, 60, false);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(utf8Bytes(c)).toBeLessThanOrEqual(60);
      }
      // No whitespace in the entry: the join is exact even in fallback mode.
      expect(chunks.join("")).toBe(long);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("Intl.Segmenter");

      chunkTextWithNumbering("x".repeat(200), 60, false);
      expect(warn).toHaveBeenCalledTimes(1); // still logged only once
    } finally {
      intl.Segmenter = original;
      warn.mockRestore();
    }
  });
});
