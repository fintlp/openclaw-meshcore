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

  it("applies sendPacing defaults", () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
      }),
    );

    expect(config.sendPacing).toEqual({
      enabled: true,
      mode: "ack",
      minDelayMs: 200,
      maxDelayMs: 5000,
      airtimeMargin: 1.25,
      ackTimeoutMs: 6000,
      defaultSf: 8,
      defaultBw: 62_500,
      defaultCr: 8,
    });
  });

  it("accepts sendPacing overrides", () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        sendPacing: {
          enabled: false,
          minDelayMs: 500,
          maxDelayMs: 3000,
          airtimeMargin: 2.0,
          defaultSf: 10,
          defaultBw: 125_000,
          defaultCr: 5,
        },
      }),
    );

    expect(config.sendPacing).toEqual({
      enabled: false,
      mode: "ack",
      minDelayMs: 500,
      maxDelayMs: 3000,
      airtimeMargin: 2.0,
      ackTimeoutMs: 6000,
      defaultSf: 10,
      defaultBw: 125_000,
      defaultCr: 5,
    });
  });

  it("rejects sendPacing with sub-1.0 airtime margin", () => {
    const issues = expectInvalidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        sendPacing: {
          airtimeMargin: 0.5,
        },
      }),
    );

    expect(issues.some((issue) => issue.path.join(".") === "sendPacing.airtimeMargin")).toBe(true);
  });

  it("rejects sendPacing with out-of-range spreading factor", () => {
    const issues = expectInvalidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        sendPacing: {
          defaultSf: 13,
        },
      }),
    );

    expect(issues.some((issue) => issue.path.join(".").startsWith("sendPacing.defaultSf"))).toBe(true);
  });

  it("rejects sendPacing with coding rate outside 1-8", () => {
    const issues = expectInvalidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        sendPacing: {
          defaultCr: 9,
        },
      }),
    );

    expect(issues.some((issue) => issue.path.join(".").startsWith("sendPacing.defaultCr"))).toBe(true);
  });

  // Drift-guard: assert every key of the zod channel config schema also exists in the manifest JSON schema.
  // FAILS if either schema is missing fields from the other (e.g. issue #16 where sendPacing was missing).
  it("manifest schema drift guard: every zod field exists in manifest", () => {
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync("./openclaw.plugin.json", "utf8"));
    const manifestProperties = manifest.channelConfigs.meshcore.schema.properties;
    const manifestPacing = manifestProperties.sendPacing.properties;

    // 1. Top-level channel config keys: every key in zod schema must exist in manifest
    const zodTopLevelKeys = Object.keys(MeshcoreConfigSchema.shape);
    const missingTopLevel = zodTopLevelKeys.filter((k) => !manifestProperties.hasOwnProperty(k));
    expect(missingTopLevel).toEqual([]);

    // 2. sendPacing keys and defaults
    const zodKeys = [
      "enabled",
      "mode",
      "minDelayMs",
      "maxDelayMs",
      "airtimeMargin",
      "ackTimeoutMs",
      "defaultSf",
      "defaultBw",
      "defaultCr",
    ];

    const missingInManifest = zodKeys.filter((k) => !manifestPacing.hasOwnProperty(k));
    const extraInManifest = Object.keys(manifestPacing).filter((k) => !zodKeys.includes(k));

    expect(missingInManifest).toEqual([]);
    expect(extraInManifest).toEqual([]);

    // Check defaults match
    const manifestDefaults = manifest.channelConfigs.meshcore.schema.properties.sendPacing.default;
    expect(manifestDefaults).toEqual({
      enabled: true,
      mode: "ack",
      minDelayMs: 200,
      maxDelayMs: 5000,
      airtimeMargin: 1.25,
      ackTimeoutMs: 6000,
      defaultSf: 8,
      defaultBw: 62500,
      defaultCr: 8,
    });
  });
});
