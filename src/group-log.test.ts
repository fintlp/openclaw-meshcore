import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendGroupLogEntry,
  readGroupLogEntries,
  resetGroupLogStateForTests,
  setGroupLogPathForTests,
} from "./group-log.js";

describe("group digest log", () => {
  let groupLogPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-group-log-"));
    groupLogPath = join(dir, "group-log.jsonl");
    setGroupLogPathForTests(groupLogPath);
  });

  afterEach(() => {
    resetGroupLogStateForTests();
  });

  it("appends entries as JSON lines", () => {
    appendGroupLogEntry({
      ts: "2026-10-05T09:00:00.000Z",
      channel: "channel:0",
      senderPubkeyPrefix: "aabbccdd1122",
      name: "TestNode",
      text: "hello group",
    });

    const entries = readGroupLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      ts: "2026-10-05T09:00:00.000Z",
      channel: "channel:0",
      senderPubkeyPrefix: "aabbccdd1122",
      name: "TestNode",
      text: "hello group",
    });
  });

  it("supports missing optional fields", () => {
    appendGroupLogEntry({
      ts: "2026-10-05T09:00:00.000Z",
      channel: "channel:1",
      text: "anonymous broadcast",
    });

    const entries = readGroupLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].senderPubkeyPrefix).toBeUndefined();
    expect(entries[0].name).toBeUndefined();
  });

  it("keeps the newest entries when rotating at ~1000 lines", () => {
    for (let i = 0; i < 1005; i++) {
      appendGroupLogEntry({
        ts: `2026-10-05T09:${String(i).padStart(4, "0")}:00.000Z`,
        channel: "channel:0",
        text: `msg ${i}`,
      });
    }

    const entries = readGroupLogEntries();
    expect(entries).toHaveLength(1000);
    expect(entries[0].text).toBe("msg 5");
    expect(entries[entries.length - 1].text).toBe("msg 1004");
  });

  it("writes atomically (tmp + rename)", () => {
    appendGroupLogEntry({
      ts: "2026-10-05T09:00:00.000Z",
      channel: "channel:0",
      text: "atomic",
    });

    const dir = join(tmpdir(), "meshcore-group-log-atomic-check");
    setGroupLogPathForTests(join(dir, "group-log.jsonl"));
    appendGroupLogEntry({
      ts: "2026-10-05T09:00:00.000Z",
      channel: "channel:0",
      text: "atomic",
    });

    const files = new Set(
      readdirSync(dir).filter((f) => f.startsWith("group-log")),
    );
    expect(files).toEqual(new Set(["group-log.jsonl"]));
  });

  it("returns empty array when no log exists", () => {
    expect(readGroupLogEntries()).toEqual([]);
  });
});
