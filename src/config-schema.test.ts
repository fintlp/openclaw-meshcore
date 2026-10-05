import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { buildManifest } from "../scripts/manifest-builder.js";
import { MeshcoreAccountSchema, MeshcoreConfigSchema } from "./config-schema.js";
import { meshcoreChannelConfigUiHints } from "./config-ui-hints.js";

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

const expectedSendPacingDefaults = {
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

const expectedSendPacingKeys = Object.keys(expectedSendPacingDefaults);

function getSendPacingCopies(manifest: Record<string, unknown>) {
  const manifestProperties = (manifest.channelConfigs as Record<string, Record<string, unknown>>)
    ?.meshcore?.schema?.properties as Record<string, unknown> | undefined;
  if (!manifestProperties) return { root: undefined, account: undefined };
  const rootPacing = manifestProperties.sendPacing as Record<string, unknown> | undefined;
  const accountPacing = (manifestProperties.accounts as Record<string, unknown> | undefined)
    ?.additionalProperties?.properties?.sendPacing as Record<string, unknown> | undefined;
  return { root: rootPacing, account: accountPacing };
}

/**
 * Drift-guard helper: returns a list of human-readable issues when the
 * committed/generated manifest diverges from the zod/canonical source of truth.
 * Never writes to disk.
 */
function checkManifestDrift(manifest: Record<string, unknown>): string[] {
  const issues: string[] = [];

  const meshcore = (manifest.channelConfigs as Record<string, Record<string, unknown> | undefined>)
    ?.meshcore;
  if (!meshcore) {
    return ["missing channelConfigs.meshcore"];
  }

  const manifestProperties = meshcore.schema?.properties as Record<string, unknown> | undefined;
  if (!manifestProperties) {
    return ["missing channelConfigs.meshcore.schema.properties"];
  }

  const accountProperties = (manifestProperties.accounts as Record<string, unknown> | undefined)
    ?.additionalProperties?.properties as Record<string, unknown> | undefined;
  if (!accountProperties) {
    return ["missing channelConfigs.meshcore.schema.properties.accounts.additionalProperties.properties"];
  }

  // 1. Zod and manifest must agree on root keys.
  const zodRootKeys = sortedKeys(MeshcoreConfigSchema.shape);
  const manifestRootKeys = sortedKeys(manifestProperties);
  const missingRootKeys = zodRootKeys.filter((k) => !manifestProperties.hasOwnProperty(k));
  const extraRootKeys = manifestRootKeys.filter((k) => !zodRootKeys.includes(k));
  if (missingRootKeys.length > 0) {
    issues.push(`manifest root missing keys: ${missingRootKeys.join(", ")}`);
  }
  if (extraRootKeys.length > 0) {
    issues.push(`manifest root unexpected extra keys: ${extraRootKeys.join(", ")}`);
  }

  // 2. Zod and manifest must agree on account keys.
  const zodAccountKeys = sortedKeys(MeshcoreAccountSchema.shape);
  const manifestAccountKeys = sortedKeys(accountProperties);
  const missingAccountKeys = zodAccountKeys.filter((k) => !accountProperties.hasOwnProperty(k));
  const extraAccountKeys = manifestAccountKeys.filter((k) => !zodAccountKeys.includes(k));
  if (missingAccountKeys.length > 0) {
    issues.push(`manifest account missing keys: ${missingAccountKeys.join(", ")}`);
  }
  if (extraAccountKeys.length > 0) {
    issues.push(`manifest account unexpected extra keys: ${extraAccountKeys.join(", ")}`);
  }

  // 3. Both manifest copies must be identical for the shared fields.
  const sharedRootKeys = manifestRootKeys.filter((k) => k !== "accounts" && k !== "defaultAccount");
  if (JSON.stringify(sharedRootKeys) !== JSON.stringify(manifestAccountKeys)) {
    issues.push("manifest root/account shared keys mismatch");
  }

  // 4. sendPacing shape and defaults across both copies.
  const { root: rootPacing, account: accountPacing } = getSendPacingCopies(manifest);
  if (!rootPacing) {
    issues.push("missing root sendPacing");
  }
  if (!accountPacing) {
    issues.push("missing account sendPacing");
  }
  if (!rootPacing || !accountPacing) {
    return issues;
  }
  if (JSON.stringify(rootPacing) !== JSON.stringify(accountPacing)) {
    issues.push("root sendPacing differs from account sendPacing");
  }

  for (const [copyName, pacingObj] of [
    ["root sendPacing", rootPacing],
    ["account sendPacing", accountPacing],
  ] as const) {
    const properties = pacingObj.properties as Record<string, { default?: unknown }> | undefined;
    if (!properties) {
      issues.push(`${copyName} missing properties`);
      continue;
    }
    const missing = expectedSendPacingKeys.filter((k) => !properties.hasOwnProperty(k));
    const extra = Object.keys(properties).filter((k) => !expectedSendPacingKeys.includes(k));
    if (missing.length > 0) {
      issues.push(`${copyName} missing keys: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      issues.push(`${copyName} unexpected extra keys: ${extra.join(", ")}`);
    }

    // Object-level default.
    if (JSON.stringify(pacingObj.default) !== JSON.stringify(expectedSendPacingDefaults)) {
      issues.push(`${copyName} object-level default mismatch`);
    }

    // Per-property defaults.
    for (const key of expectedSendPacingKeys) {
      const expected = expectedSendPacingDefaults[key as keyof typeof expectedSendPacingDefaults];
      const actual = properties[key]?.default;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        issues.push(
          `${copyName} default for ${key} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    }
  }

  return issues;
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

  it("accepts advertLat/advertLon overrides", () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        advertLat: 48.8589,
        advertLon: 2.2945,
      }),
    );
    expect(config.advertLat).toBe(48.8589);
    expect(config.advertLon).toBe(2.2945);
  });

  it("rejects advertLat outside -90..90", () => {
    const issues = expectInvalidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        advertLat: 91,
        advertLon: 2.2945,
      }),
    );
    expect(issues.some((issue) => issue.path.join(".") === "advertLat")).toBe(true);
  });

  it("rejects advertLon outside -180..180", () => {
    const issues = expectInvalidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        advertLat: 48.8589,
        advertLon: 181,
      }),
    );
    expect(issues.some((issue) => issue.path.join(".") === "advertLon")).toBe(true);
  });

  it("defaults groupMonitorMode to digest", () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
      }),
    );
    expect(config.groupMonitorMode).toBe("digest");
  });

  it("accepts groupMonitorMode session", () => {
    const config = expectValidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        groupMonitorMode: "session",
      }),
    );
    expect(config.groupMonitorMode).toBe("session");
  });

  it("rejects invalid groupMonitorMode", () => {
    const issues = expectInvalidConfig(
      MeshcoreConfigSchema.safeParse({
        host: "192.168.1.10",
        groupMonitorMode: "alerts",
      }) as ReturnType<typeof MeshcoreConfigSchema.safeParse>,
    );
    expect(issues.some((issue) => issue.path.join(".") === "groupMonitorMode")).toBe(true);
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
    const committed = JSON.parse(fs.readFileSync("./openclaw.plugin.json", "utf8"));
    const packageJson = JSON.parse(fs.readFileSync("./package.json", "utf8"));
    const canonicalSchema = JSON.parse(
      fs.readFileSync("./src/meshcore-channel-config.schema.json", "utf8"),
    );
    const generated = buildManifest(committed, packageJson, canonicalSchema, meshcoreChannelConfigUiHints);
    expect(generated).toEqual(committed);
  });

  // Regression: importing the drift-guard builder must not rewrite the
  // committed manifest. We perturb an in-memory copy and assert the guard
  // reports the divergence.
  it("drift guard detects stale in-memory manifest without rewriting disk", () => {
    const committed = JSON.parse(fs.readFileSync("./openclaw.plugin.json", "utf8"));
    const packageJson = JSON.parse(fs.readFileSync("./package.json", "utf8"));
    const canonicalSchema = JSON.parse(
      fs.readFileSync("./src/meshcore-channel-config.schema.json", "utf8"),
    );
    const perturbed = buildManifest(
      committed,
      packageJson,
      canonicalSchema,
      meshcoreChannelConfigUiHints,
    );

    // Mutation B1: change a default in both root and account copies.
    const meshcoreSchema = (perturbed.channelConfigs as Record<string, Record<string, unknown>>)
      .meshcore.schema as Record<string, unknown>;
    const rootPacing = meshcoreSchema.properties.sendPacing as Record<string, unknown>;
    const accountPacing = ((meshcoreSchema.properties.accounts as Record<string, unknown>)
      .additionalProperties as Record<string, unknown>).properties.sendPacing as Record<string, unknown>;

    (rootPacing.properties as Record<string, { default: unknown }>).minDelayMs.default = 999;
    (accountPacing.properties as Record<string, { default: unknown }>).minDelayMs.default = 999;

    const issues = checkManifestDrift(perturbed);
    expect(issues).toContainEqual(expect.stringContaining("minDelayMs"));
    expect(issues).toContainEqual(expect.stringContaining("default for minDelayMs mismatch"));
  });

  // Drift-guard: every key of the zod channel config schema also exists in the
  // canonical JSON schema and in the manifest JSON schema. Checks BOTH copies
  // in openclaw.plugin.json (root channel config and per-account config).
  it("canonical and manifest schemas match zod keys", () => {
    const manifest = JSON.parse(fs.readFileSync("./openclaw.plugin.json", "utf8"));

    const issues = checkManifestDrift(manifest);
    expect(issues).toEqual([]);
  });
});
