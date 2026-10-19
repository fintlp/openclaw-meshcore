import { beforeEach, describe, expect, it, vi } from "vitest";

const stopMock = vi.fn();
const monitorMock = vi.fn();

vi.mock("./discovery-summary.js", () => ({
  ensureDiscoverySummarySync: () => {},
}));
vi.mock("./node-status.js", () => ({
  readNodeStatusSnapshot: () => null,
  updateNodeStatusOps: () => {},
}));
vi.mock("./monitor.js", () => ({
  monitorMeshcoreProvider: (...args: unknown[]) => monitorMock(...args),
}));

import { startMeshcoreGatewayAccount } from "./gateway.js";

function makeAccount() {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    transport: "tcp",
    host: "127.0.0.1",
    port: 5000,
    config: {},
  } as never;
}

describe("meshcore gateway account lifecycle", () => {
  beforeEach(() => {
    stopMock.mockReset();
    monitorMock.mockReset();
  });

  it("start resolves a handle with stop(); abort calls stop() exactly once with the handle and resolves after the stop", async () => {
    const events: string[] = [];
    const handle = { stop: stopMock };
    stopMock.mockImplementation(() => {
      events.push("stop");
    });
    monitorMock.mockImplementation(async () => handle);

    const ac = new AbortController();
    const run = startMeshcoreGatewayAccount({
      cfg: {} as never,
      accountId: "default",
      account: makeAccount(),
      runtime: {} as never,
      abortSignal: ac.signal,
      setStatus: () => {},
    }).then(() => {
      events.push("resolved");
    });

    await vi.waitFor(() => {
      if (monitorMock.mock.calls.length === 0) {
        throw new Error("provider not started yet");
      }
    });
    expect(stopMock).not.toHaveBeenCalled();
    expect(events).not.toContain("resolved");

    ac.abort();
    await run;

    // The gateway's stop closure calls monitor.stop() — the handle API takes
    // no arguments, and the lifecycle awaits the closure before resolving
    // (verified against the installed openclaw 2026.10.5 runtime).
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["stop", "resolved"]);
  });
});
