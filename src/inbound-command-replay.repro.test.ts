import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMeshcoreInbound } from "./inbound.js";
import { meshcoreDedupeKey, openDurabilityStore } from "./durability.js";
import { clearMeshcoreRuntime, getMeshcoreRuntime, setMeshcoreRuntime } from "./runtime.js";
import { resetNodeStatusStateForTests, setNodeStatusPathForTests } from "./node-status.js";
import type { CoreConfig, MeshcoreInboundMessage, ResolvedMeshcoreAccount } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { resolveInboundSessionEnvelopeContextAsync } from "openclaw/plugin-sdk/channel-inbound";

vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: vi.fn(({ peer }) => ({
    agentId: "meshcore",
    sessionKey: `meshcore:${peer?.kind === "group" ? "channel:0" : peer?.id ?? "unknown"}`,
    accountId: "default",
  })),
}));

vi.mock("./repeater-ops.js", () => ({
  runRepeaterOpsCommand: vi.fn(async () => "ops reply"),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    resolveInboundSessionEnvelopeContextAsync: vi.fn(async () => ({
      storePath: "/tmp/sessions.json",
      envelopeOptions: {},
      previousTimestamp: undefined,
    })),
    createChannelInboundEnvelopeBuilderAsync: vi.fn(async () =>
      vi.fn(({ body }) => body),
    ),
  };
});

const readAllowFromStoreMock = vi.fn(async () => []);
const upsertPairingRequestMock = vi.fn(async () => ({ code: "CODE", created: true }));

function createRuntime() {
  return {
    channel: {
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      commands: { shouldHandleTextCommands: vi.fn(() => false) },
      text: { hasControlCommand: vi.fn(() => false) },
      mentions: {
        buildMentionRegexes: vi.fn(() => []),
        matchesMentionPatterns: vi.fn(() => false),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "meshcore",
          sessionKey: "meshcore:!aabbccdd1122",
          accountId: "default",
        })),
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx) => ctx),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
        formatAgentEnvelope: vi.fn(({ body }) => ({ storePath: "/tmp/sessions.json", body })),
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
      inbound: { run: vi.fn() },
      session: {
        recordInboundSession: vi.fn(),
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        readSessionUpdatedAt: vi.fn(() => undefined),
      },
      activity: { record: vi.fn() },
    },
    config: { current: () => ({ channels: { meshcore: { host: "192.0.2.10" } } }) },
    logging: {
      getChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      shouldLogVerbose: () => false,
    },
  };
}

function createAccount(): ResolvedMeshcoreAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    transport: "tcp",
    host: "192.0.2.10",
    port: 5000,
    config: {
      dmPolicy: "allowlist",
      allowFrom: ["!aabbccdd1122"],
      groupPolicy: "disabled",
      groupAllowFrom: [],
      channels: [0],
    },
  } satisfies ResolvedMeshcoreAccount;
}

function createMessage(text = "!ping"): MeshcoreInboundMessage {
  return {
    messageId: "mc-dm-!aabbccdd1122-1700000000-ping",
    target: "!aabbccdd1122",
    senderNodeId: "!aabbccdd1122",
    senderName: "TestNode",
    text,
    timestamp: 1700000000000,
    isGroup: false,
    meshChannel: 0,
    meshSecurity: { txtType: 0, signedPlain: false, identityBinding: "prefix-only" },
  };
}

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meshcore-command-replay-"));
  dbPath = join(dir, "durability.sqlite");
  setNodeStatusPathForTests(join(dir, "node-status.json"));
  vi.mocked(resolveInboundSessionEnvelopeContextAsync).mockReset().mockResolvedValue({
    storePath: "/tmp/sessions.json",
    envelopeOptions: {},
    previousTimestamp: undefined,
  });
  setMeshcoreRuntime(createRuntime() as never);
});

afterEach(() => {
  clearMeshcoreRuntime();
  resetNodeStatusStateForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("repro: command frame durability after a crash", () => {
  it("persists a command with an empty raw payload, so replay cannot re-enter the command path", async () => {
    const store = await openDurabilityStore({ dbPath });
    expect(store).not.toBeNull();
    const message = createMessage();
    const sendReply = vi.fn(async () => {
      throw new Error("simulated process death after command reply send");
    });

    await expect(
      handleMeshcoreInbound({
        message,
        account: createAccount(),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv,
        sendReply,
        durability: store,
      }),
    ).rejects.toThrow("simulated process death");

    const key = meshcoreDedupeKey({
      senderNodeId: message.senderNodeId,
      timestamp: message.timestamp,
      body: message.text,
    });
    const row = store!.findDuplicate("default", key);
    expect(row).not.toBeNull();
    expect(row!.state).toBe("pending");

    const replay = store!.claimNext("default", 3, 30_000);
    expect(replay?.id).toBe(row!.id);
    const raw = JSON.parse(store!.rawJsonOf(replay!.id)!) as { text?: string };
    // This is the exact monitor replay guard: !raw || typeof raw.text !== "string"
    // => deadLetter(..., "not-replayable"). The command is therefore lost,
    // not retried, after a crash before commandMark().
    expect(raw.text).toBeUndefined();
    store!.close();
  });

  it("releases a replay claim when abort arrives during host finalization", async () => {
    const store = await openDurabilityStore({ dbPath });
    const message = createMessage("hello");
    const intake = store!.intake({
      accountId: "default",
      dedupeKey: meshcoreDedupeKey({
        senderNodeId: message.senderNodeId,
        timestamp: message.timestamp,
        body: message.text,
      }),
      kind: "direct",
      peerId: message.senderNodeId,
      senderTs: message.timestamp,
      body: message.text,
      rawJson: JSON.stringify(message),
    });
    expect(store!.claimNext("default", 3, 30_000)?.id).toBe(intake.id);
    const abort = new AbortController();
    const run = getMeshcoreRuntime().channel.inbound.run;
    vi.mocked(run).mockImplementation(async (args: any) => {
      abort.abort();
      args.adapter.onFinalize({ dispatched: true, admission: { kind: "dispatch" } });
    });

    await handleMeshcoreInbound({
      message,
      account: createAccount(),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv,
      durability: store,
      replayOf: intake.id,
      abortSignal: abort.signal,
    });

    expect(store!.findDuplicate("default", meshcoreDedupeKey({
      senderNodeId: message.senderNodeId,
      timestamp: message.timestamp,
      body: message.text,
    }))?.state).toBe("pending");
    store!.close();
  });

  it("does not start host dispatch when abort arrives during envelope setup", async () => {
    const store = await openDurabilityStore({ dbPath });
    const message = createMessage("hello");
    const intake = store!.intake({
      accountId: "default",
      dedupeKey: meshcoreDedupeKey({
        senderNodeId: message.senderNodeId,
        timestamp: message.timestamp,
        body: message.text,
      }),
      kind: "direct",
      peerId: message.senderNodeId,
      senderTs: message.timestamp,
      body: message.text,
      rawJson: JSON.stringify(message),
    });
    expect(store!.claimNext("default", 3, 30_000)?.id).toBe(intake.id);
    const abort = new AbortController();
    let resolveGate!: (value: {
      storePath: string;
      envelopeOptions: Record<string, never>;
      previousTimestamp: undefined;
    }) => void;
    const gate = new Promise<{
      storePath: string;
      envelopeOptions: Record<string, never>;
      previousTimestamp: undefined;
    }>((resolve) => { resolveGate = resolve; });
    const envelopeMock = vi.mocked(resolveInboundSessionEnvelopeContextAsync);
    envelopeMock.mockImplementationOnce(() => gate);
    const run = getMeshcoreRuntime().channel.inbound.run;

    const pending = handleMeshcoreInbound({
      message,
      account: createAccount(),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv,
      durability: store,
      replayOf: intake.id,
      abortSignal: abort.signal,
    });
    await vi.waitFor(() => expect(envelopeMock).toHaveBeenCalled());
    abort.abort();
    resolveGate({
      storePath: "/tmp/sessions.json",
      envelopeOptions: {},
      previousTimestamp: undefined,
    });
    await pending;

    expect(run).not.toHaveBeenCalled();
    expect(store!.findDuplicate("default", meshcoreDedupeKey({
      senderNodeId: message.senderNodeId,
      timestamp: message.timestamp,
      body: message.text,
    }))?.state).toBe("pending");
    store!.close();
  });
});
