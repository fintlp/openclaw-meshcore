import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * JSON-lines digest of admitted group/broadcast messages.
 *
 * In "digest" groupMonitorMode, monitored group messages are appended here
 * instead of being routed to agent sessions. The file is rotated at ~1000
 * lines, keeping the newest entries (issue #7).
 */
export type GroupLogEntry = {
  /** ISO 8601 timestamp when the message was received by the gateway. */
  ts: string;
  /** Mesh channel target, e.g. "channel:0". */
  channel: string;
  /** First 6 bytes of the sender public key as 12 lowercase hex chars, if known. */
  senderPubkeyPrefix?: string;
  /** Advertised sender name, if known from the contact book. */
  name?: string;
  /** Message text. */
  text: string;
};

const GROUP_LOG_MAX_LINES = 1000;

let testGroupLogPath: string | undefined;

/** @internal Test-only path override; avoids env-var races across parallel test files. */
export function setGroupLogPathForTests(path: string | undefined): void {
  testGroupLogPath = path;
}

function getGroupLogPath(): string {
  return (
    testGroupLogPath ??
    `${process.env.HOME ?? "~"}/.openclaw/state/meshcore-group-log.jsonl`
  );
}

function atomicWriteLines(path: string, lines: string[]): void {
  const tmpPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, lines.length ? `${lines.join("\n")}\n` : "");
  renameSync(tmpPath, path);
}

function isValidLogLine(line: string): boolean {
  if (line.trim().length === 0) {
    return false;
  }
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function readLines(path: string): string[] {
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) {
      return [];
    }
    return text.split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/** Append a group message to the digest log, rotating to keep the newest valid lines. */
export function appendGroupLogEntry(entry: GroupLogEntry): void {
  const path = getGroupLogPath();
  const lines = readLines(path).filter(isValidLogLine);
  lines.push(JSON.stringify(entry));
  if (lines.length > GROUP_LOG_MAX_LINES) {
    lines.splice(0, lines.length - GROUP_LOG_MAX_LINES);
  }
  atomicWriteLines(path, lines);
}

/** @internal Read all entries for tests/debugging. */
export function readGroupLogEntries(): GroupLogEntry[] {
  const entries: GroupLogEntry[] = [];
  for (const line of readLines(getGroupLogPath())) {
    try {
      entries.push(JSON.parse(line) as GroupLogEntry);
    } catch {
      // Drop corrupt lines rather than failing the whole read.
    }
  }
  return entries;
}

/** @internal Reset the test path only; does not delete the persisted file. */
export function resetGroupLogStateForTests(): void {
  testGroupLogPath = undefined;
}
