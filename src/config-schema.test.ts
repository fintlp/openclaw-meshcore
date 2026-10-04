import { describe, expect, it } from "vitest";
import { buildManifest } from "../scripts/sync-manifest.js";
import { MeshcoreAccountSchema, MeshcoreConfigSchema } from "./config-schema.js";

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

function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
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

  // Drift-guard: the committed openclaw.plugin.json must be exactly what
  // `npm run sync-manifest` would write. This catches any hand-edits or
  // stale generated schema copies.
  it("committed manifest matches sync-manifest output", () => {
    const fs = require("fs");
    const committed = JSON.parse(fs.readFileSync("./openclaw.plugin.json", "utf8"));
    const generated = buildManifest();
    expect(generated).toEqual(committed);
  });

  // Drift-guard: every key of the zod channel config schema also exists in the
  // canonical JSON schema and in the manifest JSON schema. Checks BOTH copies
  // in openclaw.plugin.json (root channel config and per-account config).
  it("canonical and manifest schemas match zod keys", () => {
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync("./openclaw.plugin.json", "utf8"));
    const canonical = JSON.parse(
      fs.readFileSync("./src/meshcore-channel-config.schema.json", "utf8"),
    );

    const manifestProperties = manifest.channelConfigs.meshcore.schema.properties;
    const accountProperties = manifestProperties.accounts?.additionalProperties?.properties;

    const zodRootKeys = sortedKeys(MeshcoreConfigSchema.shape);
    const zodAccountKeys = sortedKeys(MeshcoreAccountSchema.shape);
    const canonicalRootKeys = sortedKeys(canonical.properties);
    const canonicalAccountKeys = sortedKeys(canonical.$defs.account.properties);
    const manifestRootKeys = sortedKeys(manifestProperties);
    const manifestAccountKeys = sortedKeys(accountProperties);

    // 1. Zod and canonical must agree (single source of truth for keys).
    expect(zodRootKeys, "zod root keys mismatch vs canonical").toEqual(canonicalRootKeys);
    expect(zodAccountKeys, "zod account keys mismatch vs canonical").toEqual(canonicalAccountKeys);

    // 2. Manifest must agree with canonical in both copies.
    expect(manifestRootKeys, "manifest root keys mismatch vs canonical").toEqual(canonicalRootKeys);
    expect(
      manifestAccountKeys,
      "manifest account keys mismatch vs canonical",
    ).toEqual(canonicalAccountKeys);

    // 3. Both manifest copies must be identical for the shared fields.
    const sharedRootKeys = manifestRootKeys.filter((k) => k !== "accounts" && k !== "defaultAccount");
    expect(manifestAccountKeys, "manifest root/account shared keys mismatch").toEqual(
      sharedRootKeys,
    );

    // 4. sendPacing keys and defaults across both copies (regression guard).
    const rootPacing = manifestProperties.sendPacing;
    const accountPacing = accountProperties.sendPacing;
    expect(rootPacing).toBeDefined();
    expect(accountPacing).toBeDefined();
    expect(rootPacing).toEqual(accountPacing);

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

    const expectedDefaults = {
      enabled: true,
      mode: "ack",
      minDelayMs: 200,
      maxDelayMs: 5000,
      airtimeMargin: 1.25,
      ackTimeoutMs: 6000,
      defaultSf: 8,
      defaultBw: 62500,
      defaultCr: 8,
    };

    for (const [copyName, pacingObj] of [
      ["root sendPacing", rootPacing],
      ["account sendPacing", accountPacing],
    ] as const) {
      const missing = zodKeys.filter((k) => !pacingObj.properties.hasOwnProperty(k));
      const extra = Object.keys(pacingObj.properties).filter((k) => !zodKeys.includes(k));
      expect(missing, `${copyName} is missing keys`).toEqual([]);
      expect(extra, `${copyName} has unexpected extra keys`).toEqual([]);
      expect(pacingObj.default, `${copyName} defaults mismatch`).toEqual(expectedDefaults);
    }
  });
});
