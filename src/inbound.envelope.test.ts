import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChannelInboundEnvelopeBuilder,
  resolveInboundSessionEnvelopeContext,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

describe("meshcore inbound envelope format (#43 golden)", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "meshcore-envelope-"));
    storePath = join(tempDir, "sessions.json");
  });

  afterEach(() => {
    // Intentionally leave temp dir cleanup to OS; no ~/.openclaw/state touched.
  });

  function makeConfig(): OpenClawConfig {
    return {
      agents: {
        defaults: {
          userTimezone: "UTC",
        },
      },
      session: {
        store: storePath,
      },
      channels: {
        meshcore: {
          host: "192.0.2.10",
        },
      },
    } as OpenClawConfig;
  }

  it("produces deterministic direct-DM envelope without previous timestamp", () => {
    const cfg = makeConfig();
    const peer = { kind: "direct" as const, id: "!aabbccdd1122" };
    const route = resolveAgentRoute({
      cfg,
      channel: "meshcore",
      accountId: "default",
      peer,
      defaultAgentId: "meshcore",
    });

    const envelopeCtx = resolveInboundSessionEnvelopeContext({
      cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });

    const buildEnvelope = createChannelInboundEnvelopeBuilder({
      cfg,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
    });

    const timestamp = Date.UTC(2023, 10, 14, 22, 13, 20);
    const body = buildEnvelope({
      channel: "MeshCore",
      from: "!aabbccdd1122",
      timestamp,
      body: "hello",
      previousTimestamp: envelopeCtx.previousTimestamp,
      envelope: envelopeCtx.envelopeOptions,
    });

    expect(envelopeCtx.storePath).toBe(storePath);
    expect(body).toBe("[MeshCore !aabbccdd1122 Tue 2023-11-14T22:13:20Z] hello");
  });

  it("produces deterministic group envelope without previous timestamp", () => {
    const cfg = makeConfig();
    const peer = { kind: "group" as const, id: "meshcore:channel:0" };
    const route = resolveAgentRoute({
      cfg,
      channel: "meshcore",
      accountId: "default",
      peer,
      defaultAgentId: "meshcore",
    });

    const envelopeCtx = resolveInboundSessionEnvelopeContext({
      cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });

    const buildEnvelope = createChannelInboundEnvelopeBuilder({
      cfg,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
    });

    const timestamp = Date.UTC(2023, 10, 14, 22, 13, 20);
    const body = buildEnvelope({
      channel: "MeshCore",
      from: "meshcore:channel:0",
      timestamp,
      body: "group hello",
      previousTimestamp: envelopeCtx.previousTimestamp,
      envelope: envelopeCtx.envelopeOptions,
    });

    expect(body).toBe("[MeshCore meshcore:channel:0 Tue 2023-11-14T22:13:20Z] group hello");
  });
});
