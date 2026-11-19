import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "../index.js";
import { MeshcoreConfigSchema } from "./config-schema.js";
import { clearSendConfirmedStateForTests } from "./device-client.js";
import { clearOutboundEchoCache } from "./echo-dedupe.js";
import { clearPacingStateForTests } from "./pacing.js";
import { clearSendRateLimitState, SendRateLimitExceededError } from "./rate-limit.js";
import { chunkMeshcoreOutboundText, sendMessageMeshcore } from "./send.js";
import {
  clearSessionSendRateLimitState,
  enforceMeshcoreSessionSendRateLimit,
  resolveSessionSendRateLimitConfig,
  SESSION_SEND_RATE_LIMIT_DEFAULTS,
  SessionSendRateLimitExceededError,
  sessionSendRateLimitBucketCountForTests,
} from "./session-rate-limit.js";
import type { CoreConfig } from "./types.js";

const { connectMock, getMock } = vi.hoisted(() => ({ connectMock: vi.fn(), getMock: vi.fn() }));
vi.mock("./device-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-client.js")>();
  return { ...actual, connectMeshcoreDevice: connectMock, getMeshcoreDevice: getMock };
});

const NODE = "!".padEnd(1, "") + "aabbccdd".padEnd(64, "0");
const NODES = ["a", "b", "c"].map((hex) => `!${hex.repeat(64)}`);

function config(overrides: Record<string, unknown> = {}): CoreConfig {
  return {
    channels: {
      meshcore: {
        host: "192.0.2.10",
        chunkNumbering: false,
        sendPacing: { enabled: false },
        sessionSendRateLimit: { maxSends: 3, maxBytes: 10_000 },
        ...overrides,
      },
    },
  } as CoreConfig;
}

function device(sendTextMessage: ReturnType<typeof vi.fn>, accountId = "default") {
  const emitter = new EventEmitter();
  return {
    accountId,
    connection: {
      sendTextMessage,
      on: emitter.on.bind(emitter), off: emitter.off.bind(emitter), once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter), listenerCount: emitter.listenerCount.bind(emitter),
    },
    connected: true, contacts: [], channels: [],
  };
}

async function attempt(params: {
  cfg: CoreConfig;
  handle: ReturnType<typeof device>;
  sessionKey?: string;
  accountId?: string;
  text?: string;
  target?: string;
  purpose?: "dm" | "pairing";
}): Promise<unknown | null> {
  try {
    await sendMessageMeshcore(params.target ?? NODE, params.text ?? "ok", {
      cfg: params.cfg,
      accountId: params.accountId,
      sessionKey: params.sessionKey,
      purpose: params.purpose,
      deviceHandle: params.handle as never,
    });
    return null;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionSendRateLimitState();
  clearSendRateLimitState();
  clearPacingStateForTests();
  clearSendConfirmedStateForTests();
  clearOutboundEchoCache();
});
afterEach(() => {
  clearSessionSendRateLimitState();
  clearSendRateLimitState();
  clearPacingStateForTests();
  clearSendConfirmedStateForTests();
  clearOutboundEchoCache();
  vi.restoreAllMocks();
});

describe("MeshCore low-level per-session flood guard (#46)", () => {
  it("registers zero global message hooks and leaves Telegram preview/auto-reply behavior untouched", () => {
    const telegram = { allowProviderPreview: true };
    const on = vi.fn();
    const registerHook = vi.fn();
    const registerChannel = vi.fn();
    const api = {
      config: { channels: { meshcore: { host: "192.0.2.10" }, telegram } },
      registrationMode: "full",
      runtime: { channel: { activity: { record: vi.fn() } } },
      on,
      registerHook,
      registerChannel,
    } as unknown as OpenClawPluginApi;
    entry.register(api);
    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(on).not.toHaveBeenCalled();
    expect(registerHook).not.toHaveBeenCalled();
    expect(telegram).toEqual({ allowProviderPreview: true });
  });

  it("refuses a real same-session Promise.all burst before device I/O with typed errors and safe logs", async () => {
    const cfg = config();
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    const handle = device(sendTextMessage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = await Promise.all(
      Array.from({ length: 5 }, () => attempt({ cfg, handle, sessionKey: "agent:main:producer" })),
    );
    expect(results.filter((result) => result === null)).toHaveLength(3);
    const errors = results.filter((result) => result instanceof SessionSendRateLimitExceededError);
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toBeInstanceOf(SendRateLimitExceededError);
    expect(sendTextMessage).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [line] of warn.mock.calls) {
      expect(line).not.toContain("agent:main:producer");
      expect(line).not.toContain(NODE);
      expect(line).not.toContain("ok");
    }
    expect((errors[0] as SessionSendRateLimitExceededError).retryAfterMs).toBeGreaterThan(0);
  });

  it("refuses before connect when one payload exceeds the exact packet boundary", async () => {
    const cfg = config({ textChunkLimit: 40, sessionSendRateLimit: { maxSends: 1, maxBytes: 100 } });
    getMock.mockReturnValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = sendMessageMeshcore(NODE, "x".repeat(41), { cfg, sessionKey: "s" });
    await expect(promise).rejects.toBeInstanceOf(SessionSendRateLimitExceededError);
    await expect(promise).rejects.toMatchObject({ retryAfterMs: 600_000 });
    await expect(promise).rejects.toThrow("waiting alone will not admit it");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retryAfterMs=600000"));
    expect(connectMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("refuses group and invalid targets before charging or touching a device", async () => {
    const cfg = config({ sessionSendRateLimit: { maxSends: 1, maxBytes: 1 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendMessageMeshcore("channel:0", "xx", { cfg, sessionKey: "s" })).rejects.toThrow("receive-only");
    await expect(sendMessageMeshcore("not-a-target", "xx", { cfg, sessionKey: "s" })).rejects.toThrow("Invalid MeshCore target");
    expect(sessionSendRateLimitBucketCountForTests()).toBe(0);
    expect(connectMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("shares one producing budget across fanout A,B,C,A instead of deriving identity from targets", async () => {
    const cfg = config();
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    const handle = device(sendTextMessage);
    const results = [];
    for (const target of [NODES[0]!, NODES[1]!, NODES[2]!, NODES[0]!]) {
      results.push(await attempt({ cfg, handle, target, sessionKey: "one-producing-session" }));
    }
    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(sendTextMessage).toHaveBeenCalledTimes(3);
  });

  it("isolates independent sessions and resolved accounts", async () => {
    const cfg = config({
      defaultAccount: "a",
      accounts: { a: { host: "192.0.2.11" }, b: { host: "192.0.2.12" } },
      sessionSendRateLimit: { maxSends: 1, maxBytes: 100 },
    });
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    const a = device(sendTextMessage, "a");
    const b = device(sendTextMessage, "b");
    expect(await attempt({ cfg, handle: a, accountId: "a", sessionKey: "s:a" })).toBeNull();
    expect(await attempt({ cfg, handle: a, accountId: "a", sessionKey: "s:a" })).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(await attempt({ cfg, handle: a, accountId: "a", sessionKey: "s:b" })).toBeNull();
    expect(await attempt({ cfg, handle: b, accountId: "b", sessionKey: "s:a" })).toBeNull();
  });

  it("keeps the old aggregate account backstop across independent sessions", async () => {
    const cfg = config({ sendRateLimit: { maxSends: 3 }, sessionSendRateLimit: { maxSends: 2, maxBytes: 100 } });
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    const handle = device(sendTextMessage);
    const results = await Promise.all(
      ["a", "b", "c"].flatMap((sessionKey) => [0, 1].map(() => attempt({ cfg, handle, sessionKey }))),
    );
    expect(results.filter((result) => result === null)).toHaveLength(3);
    const errors = results.filter((result) => result instanceof SendRateLimitExceededError);
    expect(errors).toHaveLength(3);
    expect(errors.every((error) => !(error instanceof SessionSendRateLimitExceededError))).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(3);
  });

  it("keeps missing/empty keys and keyed pairing sends account-only", async () => {
    const cfg = config({ sessionSendRateLimit: { maxSends: 1, maxBytes: 100 } });
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    const handle = device(sendTextMessage);
    expect(await attempt({ cfg, handle })).toBeNull();
    expect(await attempt({ cfg, handle, sessionKey: "" })).toBeNull();
    expect(await attempt({ cfg, handle, sessionKey: "   " })).toBeNull();
    expect(await attempt({ cfg, handle, sessionKey: "pairing-producer", purpose: "pairing" })).toBeNull();
    expect(await attempt({ cfg, handle, sessionKey: "pairing-producer", purpose: "pairing" })).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledTimes(5);
  });

  it("disabled semantics affect only the session layer", async () => {
    const cfg = config({
      sendRateLimit: { maxSends: 1 },
      sessionSendRateLimit: { enabled: false, maxSends: 1, maxBytes: 100 },
    });
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    const handle = device(sendTextMessage);
    expect(await attempt({ cfg, handle, sessionKey: "s" })).toBeNull();
    const error = await attempt({ cfg, handle, sessionKey: "s" });
    expect(error).toBeInstanceOf(SendRateLimitExceededError);
    expect(error).not.toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("computes retryAfter from the events that must expire and does not charge refusals", () => {
    const cfg = resolveSessionSendRateLimitConfig({ maxSends: 2, maxBytes: 100, windowMs: 5_000 });
    const base = { accountId: "default", sessionKey: "s", packets: 1, bytes: 1, config: cfg };
    enforceMeshcoreSessionSendRateLimit({ ...base, nowMs: 0 });
    enforceMeshcoreSessionSendRateLimit({ ...base, nowMs: 1_000 });
    let error: unknown;
    try { enforceMeshcoreSessionSendRateLimit({ ...base, nowMs: 2_000 }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect((error as SessionSendRateLimitExceededError).retryAfterMs).toBe(3_000);
    expect(() => enforceMeshcoreSessionSendRateLimit({ ...base, nowMs: 5_000 })).not.toThrow();
    expect(() => enforceMeshcoreSessionSendRateLimit({ ...base, nowMs: 6_000 })).not.toThrow();
  });

  it("cleans stale buckets during the periodic sweep", () => {
    const cfg = resolveSessionSendRateLimitConfig({ windowMs: 1_000 });
    enforceMeshcoreSessionSendRateLimit({ accountId: "a", sessionKey: "old", packets: 1, bytes: 1, config: cfg, nowMs: 0 });
    expect(sessionSendRateLimitBucketCountForTests()).toBe(1);
    enforceMeshcoreSessionSendRateLimit({ accountId: "a", sessionKey: "new", packets: 1, bytes: 1, config: cfg, nowMs: 60_000 });
    expect(sessionSendRateLimitBucketCountForTests()).toBe(1);
  });

  it("uses trimmed UTF-8 bytes for the independent byte budget", async () => {
    const cfg = config({ sessionSendRateLimit: { maxSends: 20, maxBytes: 4 } });
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    const handle = device(sendTextMessage);
    expect(await attempt({ cfg, handle, text: "  éé  ", sessionKey: "bytes" })).toBeNull();
    const error = await attempt({ cfg, handle, text: "a", sessionKey: "bytes" });
    expect(error).toBeInstanceOf(SessionSendRateLimitExceededError);
    expect(String(error)).toContain("UTF-8 bytes 4+1/4");
    expect(sendTextMessage).toHaveBeenCalledWith(expect.any(Uint8Array), "éé");
  });

  it("matches final SignedPlain and chunk-numbering packet accounting exactly", async () => {
    const text = "😀".repeat(20);
    const accountConfig = { textChunkLimit: 40, outboundSignedPlain: true, chunkNumbering: true };
    const chunks = chunkMeshcoreOutboundText(text, accountConfig);
    expect(chunks.length).toBeGreaterThan(2);
    const cfg = config({
      ...accountConfig,
      sessionSendRateLimit: { maxSends: chunks.length, maxBytes: 1_000 },
    });
    const sendTextMessage = vi.fn(async () => ({ expectedAckCrc: 1 }));
    const handle = device(sendTextMessage);
    expect(await attempt({ cfg, handle, text, sessionKey: "signed" })).toBeNull();
    expect(sendTextMessage).toHaveBeenCalledTimes(chunks.length);
    expect(await attempt({ cfg, handle, text: "x", sessionKey: "signed" })).toBeInstanceOf(SessionSendRateLimitExceededError);
  });

  it("pins secure runtime, zod, and generated-manifest defaults", () => {
    expect(SESSION_SEND_RATE_LIMIT_DEFAULTS).toEqual({ enabled: true, maxSends: 10, maxBytes: 1_270, windowMs: 600_000 });
    expect(resolveSessionSendRateLimitConfig(undefined)).toEqual(SESSION_SEND_RATE_LIMIT_DEFAULTS);
    const parsed = MeshcoreConfigSchema.parse({});
    expect(parsed.sessionSendRateLimit).toEqual(SESSION_SEND_RATE_LIMIT_DEFAULTS);
    expect(MeshcoreConfigSchema.safeParse({ sessionSendRateLimit: { maxBytes: 0 } }).success).toBe(false);
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const surface = manifest.channelConfigs.meshcore;
    expect(surface.schema.properties.sessionSendRateLimit.default).toEqual(SESSION_SEND_RATE_LIMIT_DEFAULTS);
    expect(surface.schema.properties.accounts.additionalProperties.properties.sessionSendRateLimit.default).toBeUndefined();
    expect(surface.uiHints.sessionSendRateLimit.help).toContain("10");
  });
});
