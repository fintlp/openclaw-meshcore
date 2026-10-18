import { describe, expect, it } from "vitest";
import { meshcoreSetupAdapter, parsePort } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const ACCOUNT_ID = "default";

function applyInput(input: Record<string, unknown>, cfg: CoreConfig = {} as CoreConfig) {
  const next = meshcoreSetupAdapter.applyAccountConfig?.({
    cfg,
    accountId: ACCOUNT_ID,
    input,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test context
  } as any) as CoreConfig;
  return next?.channels?.meshcore;
}

describe("parsePort", () => {
  it("parses valid ports and falls back on junk", () => {
    expect(parsePort("5000", 5001)).toBe(5000);
    expect(parsePort("", 5000)).toBe(5000);
    expect(parsePort("abc", 5000)).toBe(5000);
    expect(parsePort("99999", 5000)).toBe(5000);
  });
});

describe("meshcoreSetupAdapter.applyAccountConfig", () => {
  it("defaults to port 5000 when only a host is given", () => {
    const section = applyInput({ host: "node.local" });
    expect(section?.host).toBe("node.local");
    expect(section?.port).toBe(5000);
  });

  it("parses host:port suffix from --host", () => {
    const section = applyInput({ host: "node.local:5001" });
    expect(section?.host).toBe("node.local");
    expect(section?.port).toBe(5001);
  });

  it("explicit port wins over the suffix default chain", () => {
    const section = applyInput({ host: "node.local:5001", port: "5002" });
    expect(section?.host).toBe("node.local");
    expect(section?.port).toBe(5002);
  });

  it("accepts valid dmPolicy values and ignores invalid ones", () => {
    expect(applyInput({ host: "n", dmPolicy: "open" })?.dmPolicy).toBe("open");
    expect(applyInput({ host: "n", dmPolicy: "Pairing" })?.dmPolicy).toBe("pairing");
    expect(applyInput({ host: "n", dmPolicy: "bogus" })?.dmPolicy).toBeUndefined();
  });
});
