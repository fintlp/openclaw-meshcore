import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { materializeWithHostValidator } from "../tests/host-plugin-schema-validator.js";
import { resolveMeshcoreAccount } from "./accounts.js";
import { MeshcoreConfigSchema } from "./config-schema.js";
import type { CoreConfig } from "./types.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const manifestSchema = manifest.channelConfigs.meshcore.schema;

async function resolveWithHost(sessionSendRateLimit: unknown, accountLimit?: unknown) {
  const value = await materializeWithHostValidator(manifestSchema, {
    host: "192.0.2.10",
    sessionSendRateLimit,
    accounts: { ops: accountLimit === undefined ? {} : { sessionSendRateLimit: accountLimit } },
  });
  return {
    materialized: value,
    account: resolveMeshcoreAccount({
      cfg: { channels: { meshcore: value } } as CoreConfig,
      accountId: "ops",
    }),
  };
}

describe("MeshCore session guard host-validated inheritance", () => {
  it("passes top-level enabled:false and custom values through the real host materializer to named accounts", async () => {
    const { materialized, account } = await resolveWithHost({
      enabled: false, maxSends: 7, maxBytes: 700, windowMs: 7_000,
    });
    expect(materialized.accounts.ops.sessionSendRateLimit).toBeUndefined();
    expect(account.config.sessionSendRateLimit).toEqual({
      enabled: false, maxSends: 7, maxBytes: 700, windowMs: 7_000,
    });
  });

  it("inherits top-level custom values without replacing them with account defaults", async () => {
    const { account } = await resolveWithHost({
      enabled: true, maxSends: 9, maxBytes: 900, windowMs: 9_000,
    });
    expect(account.config.sessionSendRateLimit).toEqual({
      enabled: true, maxSends: 9, maxBytes: 900, windowMs: 9_000,
    });
  });

  it("deep-merges an explicit partial account override field-by-field", async () => {
    const { materialized, account } = await resolveWithHost(
      { enabled: false, maxSends: 7, maxBytes: 700, windowMs: 7_000 },
      { maxBytes: 42 },
    );
    expect(materialized.accounts.ops.sessionSendRateLimit).toEqual({ maxBytes: 42 });
    expect(account.config.sessionSendRateLimit).toEqual({
      enabled: false, maxSends: 7, maxBytes: 42, windowMs: 7_000,
    });
  });

  it("re-enables only when the account explicitly sets enabled:true", async () => {
    const { account } = await resolveWithHost(
      { enabled: false, maxSends: 7, maxBytes: 700, windowMs: 7_000 },
      { enabled: true },
    );
    expect(account.config.sessionSendRateLimit).toEqual({
      enabled: true, maxSends: 7, maxBytes: 700, windowMs: 7_000,
    });
  });

  it("pins Zod inner defaults and windowMs floor while account objects have no object default", () => {
    const parsed = MeshcoreConfigSchema.parse({
      sessionSendRateLimit: { maxSends: 2 },
      accounts: { ops: {} },
    });
    expect(parsed.sessionSendRateLimit).toEqual({
      enabled: true, maxSends: 2, maxBytes: 1_270, windowMs: 600_000,
    });
    expect(parsed.accounts?.ops?.sessionSendRateLimit).toBeUndefined();
    const withInnerDefaults = MeshcoreConfigSchema.parse({
      accounts: { ops: { sessionSendRateLimit: { maxBytes: 42 } } },
    });
    expect(withInnerDefaults.accounts?.ops?.sessionSendRateLimit).toEqual({
      enabled: true, maxSends: 10, maxBytes: 42, windowMs: 600_000,
    });
    expect(MeshcoreConfigSchema.safeParse({ sessionSendRateLimit: { windowMs: 999 } }).success).toBe(false);
    expect(MeshcoreConfigSchema.safeParse({ accounts: { ops: { sessionSendRateLimit: { windowMs: 999 } } } }).success).toBe(false);
  });

  it("keeps manifest defaults at the root but not in account-level objects or inner fields", () => {
    const root = manifestSchema.properties.sessionSendRateLimit;
    const account = manifestSchema.properties.accounts.additionalProperties.properties.sessionSendRateLimit;
    expect(root.default).toEqual({ enabled: true, maxSends: 10, maxBytes: 1_270, windowMs: 600_000 });
    expect(manifestSchema.required).toContain("sessionSendRateLimit");
    expect(account.default).toBeUndefined();
    expect(account.required).toBeUndefined();
    expect(Object.values(account.properties).every((field: any) => field.default === undefined)).toBe(true);
  });
});
