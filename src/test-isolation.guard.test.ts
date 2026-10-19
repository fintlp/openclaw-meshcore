import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { pluginStateDir } from "./state-dir.js";

describe("test isolation guard", () => {
  it("redirects OPENCLAW_STATE_DIR into the per-run test root", () => {
    expect(process.env.OPENCLAW_STATE_DIR ?? "").toContain("meshcore-test-run-");
  });

  it("redirects TMPDIR into the per-run test root", () => {
    expect(process.env.TMPDIR ?? "").toContain("meshcore-test-run-");
    expect(tmpdir()).toBe(process.env.TMPDIR);
  });

  it("never resolves plugin state into the operator state dir under vitest", () => {
    expect(pluginStateDir()).not.toContain(".openclaw/state");
  });
});
