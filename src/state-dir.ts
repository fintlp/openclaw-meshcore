import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the directory that persistent plugin state files live in
 * (contact book, node-status snapshot, group log).
 *
 * Under vitest this NEVER resolves to the operator's real
 * `~/.openclaw/state`. Tests are expected to install their own per-test
 * path overrides, but a test that forgets one (or whose teardown fires an
 * async write after the override was cleared) would otherwise write live
 * state. Observed in the batch-2 review round 1: a disconnect ops write
 * landed after `afterEach` cleared the override and recreated
 * `meshcore-node-status.json` in the real state dir.
 */
export function pluginStateDir(): string {
  if (process.env.VITEST) {
    return join(tmpdir(), "meshcore-vitest-state");
  }
  return `${process.env.HOME ?? "~"}/.openclaw/state`;
}
