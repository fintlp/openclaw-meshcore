import { describe, expect, it } from "vitest";
import { MeshcoreConfigSchema } from "./config-schema.js";

function expectValidConfig(result: ReturnType<typeof MeshcoreConfigSchema.safeParse>) {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("expected config to be valid");
  }
  return result.data;
}

function expectInvalidConfig(result: ReturnType<typeof MeshcoreConfigSchema.safeParse>) {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected config to be invalid");
  }
  return result.error.issues;
}

describe("meshcore config schema", () => {
  it("accepts basic config", () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        port: 5000,
        channels: [0],
      }),
    );

    expect(config.host).toBe("192.168.1.10");
    expect(config.port).toBe(5000);
    expect(config.transport).toBe("tcp");
    expect(config.channels).toEqual([0]);
  });

  it("defaults groupPolicy to disabled", () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
      }),
    );
    expect(config.groupPolicy).toBe("disabled");
  });

  it("accepts logInboundMessageContent opt-in", () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        logInboundMessageContent: true,
      }),
    );
    expect(config.logInboundMessageContent).toBe(true);
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidConfig(
      MeshcoreConfigSchema.safeParse({
        dmPolicy: "open",
        allowFrom: ["!aabbccdd1122"],
      }),
    );

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        dmPolicy: "open",
        allowFrom: ["*"],
      }),
    );

    expect(config.dmPolicy).toBe("open");
  });

  it("accepts numeric allowFrom entries", () => {
    const parsed = MeshcoreConfigSchema.parse({
      dmPolicy: "allowlist",
      allowFrom: [12345, "!aabbccdd1122"],
    });

    expect(parsed.allowFrom).toEqual([12345, "!aabbccdd1122"]);
  });

  it("rejects invalid transport", () => {
    const issues = expectInvalidConfig(
      MeshcoreConfigSchema.safeParse({
        transport: "serial",
      }),
    );
    expect(issues.some((issue) => issue.path.includes("transport"))).toBe(true);
  });
});
