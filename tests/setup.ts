/**
 * Global test isolation for the meshcore suite.
 *
 * Every test worker redirects OPENCLAW_STATE_DIR and TMPDIR into a per-run
 * root that is deleted after the file finishes, pass or fail.
 *
 * Why this exists: under the gateway's exec environment TMPDIR points at
 * ~/.openclaw/tmp, so bare mkdtemp(join(tmpdir(), "meshcore-...")) calls in
 * tests landed INSIDE the operator's live state tree (~24,000 dirs / 1.1 GB
 * accumulated over two weeks), and SDK helpers that resolve OpenClaw state
 * from the environment registered test agent databases in the real
 * agent-database registry (62 rows, later removed by openclaw doctor).
 * Never let a test touch the operator's real state.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

const inheritedTmpdir = process.env.TMPDIR ?? tmpdir();
const runStartedAt = Date.now();
const runRoot = mkdtempSync(join(tmpdir(), "meshcore-test-run-"));
const stateDir = join(runRoot, "openclaw-state");
const tmpDir = join(runRoot, "tmp");

beforeAll(() => {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.TMPDIR = tmpDir;
});

afterAll(() => {
  rmSync(runRoot, { recursive: true, force: true });
  // Leak tripwire: nothing this run created may remain in the inherited tmp.
  const leaked = readdirSync(inheritedTmpdir)
    .filter((name) => name.startsWith("meshcore-") && !name.startsWith("meshcore-test-run-"))
    .filter((name) => {
      try {
        return statSync(join(inheritedTmpdir, name)).birthtimeMs >= runStartedAt - 5000;
      } catch {
        return false;
      }
    });
  if (leaked.length > 0) {
    throw new Error(
      "meshcore test run leaked " +
        leaked.length +
        " temp dir(s) into " +
        inheritedTmpdir +
        ": " +
        leaked.join(", "),
    );
  }
});

export const testRunRoot = runRoot;
export const testStateDir = stateDir;
export const testTmpDir = tmpDir;
