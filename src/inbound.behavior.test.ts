import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMeshcoreInbound } from "./inbound.js";
import { clearMeshcoreRuntime, getMeshcoreRuntime, setMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig, MeshcoreInboundMessage, ResolvedMeshcoreAccount } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";

const {
  buildMentionRegexesMock,
  hasControlCommandMock,
  matchesMentionPatternsMock,
  readAllowFromStoreMock,
  upsertPairingRequestMock,
} = vi.hoisted(() => ({
  buildMentionRegexesMock: vi.fn(() => []),
  hasControlCommandMock: vi.fn(() => false),
  matchesMentionPatternsMock: vi.fn(() => false),
  readAllowFromStoreMock: vi.fn(async () => []),
  upsertPairingRequestMock: vi.fn(async () => ({ code: "CODE", created: true })),
}));

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(overrides?: Partial<ResolvedMeshcoreAccount>): ResolvedMeshcoreAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    transport: "tcp",
    host: "192.0.2.10",
    port: 5000,
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "disabled",
      groupAllowFrom: [],
      channels: [0],
    },
    ...overrides,
  } satisfies ResolvedMeshcoreAccount;
}

function createMessage(overrides?: Partial<MeshcoreInboundMessage>): MeshcoreInboundMessage {
  return {
    messageId: "mc-dm-!aabbccdd1122-1700000000-hello",
    target: "!aabbccdd1122",
    senderNodeId: "!aabbccdd1122",
    senderName: "TestNode",
    text: "hello",
    timestamp: Date.now(),
    isGroup: false,
    meshChannel: 0,
    ...overrides,
  };
}

function createBaseRuntime() {
  return {
    channel: {
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      commands: {
        shouldHandleTextCommands: shouldHandleTextCommandsMock,
      },
      text: {
        hasControlCommand: hasControlCommandMock,
      },
      mentions: {
        buildMentionRegexes: buildMentionRegexesMock,
        matchesMentionPatterns: matchesMentionPatternsMock,
      },
    },
    config: {
      current: () => ({ channels: { meshcore: { host: "192.0.2.10" } } }),
    },
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
      shouldLogVerbose: () => false,
    },
    channel2: {},
  };
}

const shouldHandleTextCommandsMock = vi.fn(() => false);

describe("meshcore inbound behavior", () => {
  beforeEach(() => {
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "CODE", created: true });
    shouldHandleTextCommandsMock.mockReset().mockReturnValue(false);
    hasControlCommandMock.mockReset().mockReturnValue(false);
    buildMentionRegexesMock.mockReset().mockReturnValue([]);
    matchesMentionPatternsMock.mockReset().mockReturnValue(false);
    setMeshcoreRuntime(createBaseRuntime() as never);
  });

  afterEach(() => {
    clearMeshcoreRuntime();
  });

  it("issues pairing challenge for unknown DM senders when dmPolicy=pairing", async () => {
    const sendReply = vi.fn(async () => undefined);
    await handleMeshcoreInbound({
      message: createMessage(),
      account: createAccount(),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply,
    });

    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalled();
    expect(getMeshcoreRuntime().logging.getChildLogger().info).not.toHaveBeenCalled();
  });

  it("dispatches DM from allowlisted sender", async () => {
    const sendReply = vi.fn(async () => undefined);
    const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
    setMeshcoreRuntime({
      ...createBaseRuntime(),
      channel: {
        ...createBaseRuntime().channel,
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
          formatAgentEnvelope: vi.fn(({ body }) => ({
            storePath: "/tmp/sessions.json",
            body,
          })),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: {
          run: inboundRunMock,
        },
        session: {
          recordInboundSession: vi.fn(),
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          readSessionUpdatedAt: vi.fn(() => undefined),
        },
        activity: {
          record: vi.fn(),
        },
      },
    } as never);

    await handleMeshcoreInbound({
      message: createMessage({
        senderNodeId: "!aabbccdd1122",
        target: "!aabbccdd1122",
      }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["!aabbccdd1122"],
          groupPolicy: "disabled",
          groupAllowFrom: [],
          channels: [0],
        },
      }),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply,
    });

    expect(inboundRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "meshcore",
        accountId: "default",
        raw: expect.objectContaining({
          text: "hello",
          senderNodeId: "!aabbccdd1122",
        }),
        adapter: expect.objectContaining({
          ingest: expect.any(Function),
          classify: expect.any(Function),
          resolveTurn: expect.any(Function),
        }),
      }),
    );
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("drops DM from non-allowlisted sender when dmPolicy=allowlist", async () => {
    const runtime = createRuntimeEnv();
    await handleMeshcoreInbound({
      message: createMessage({
        senderNodeId: "!aabbccdd1123",
        target: "!aabbccdd1123",
      }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["!aabbccdd1122"],
          groupPolicy: "disabled",
          groupAllowFrom: [],
          channels: [0],
        },
      }),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime,
      sendReply: vi.fn(async () => undefined),
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("drop DM sender !aabbccdd1123 (dmPolicy=allowlist)"),
    );
  });

  it("dispatches group message from allowlisted channel", async () => {
    const sendReply = vi.fn(async () => undefined);
    const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
    setMeshcoreRuntime({
      ...createBaseRuntime(),
      channel: {
        ...createBaseRuntime().channel,
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "meshcore",
            sessionKey: "meshcore:channel:0",
            accountId: "default",
          })),
        },
        reply: {
          finalizeInboundContext: vi.fn((ctx) => ctx),
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          formatAgentEnvelope: vi.fn(({ body }) => ({
            storePath: "/tmp/sessions.json",
            body,
          })),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: {
          run: inboundRunMock,
        },
        session: {
          recordInboundSession: vi.fn(),
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          readSessionUpdatedAt: vi.fn(() => undefined),
        },
        activity: {
          record: vi.fn(),
        },
      },
    } as never);

    await handleMeshcoreInbound({
      message: createMessage({
        isGroup: true,
        target: "channel:0",
        senderNodeId: "channel:0",
        text: "broadcast hello",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          channels: [0],
          groups: {
            "channel:0": {
              requireMention: false,
            },
          },
        },
      }),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply,
    });

    expect(inboundRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "meshcore",
        raw: expect.objectContaining({
          text: "broadcast hello",
          isGroup: true,
          target: "channel:0",
        }),
      }),
    );
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("drops group messages with a log line when groupPolicy=disabled", async () => {
    const runtime = createRuntimeEnv();
    await handleMeshcoreInbound({
      message: createMessage({
        isGroup: true,
        target: "channel:0",
        senderNodeId: "channel:0",
        text: "group ping",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "disabled",
          groupAllowFrom: [],
          channels: [0],
        },
      }),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime,
      sendReply: vi.fn(async () => undefined),
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("drop group sender channel:0 (policy=disabled)"),
    );
  });

  it("invokes onAdmittedGroup for admitted groups instead of dispatching", async () => {
    const onAdmittedGroup = vi.fn();
    await handleMeshcoreInbound({
      message: createMessage({
        isGroup: true,
        target: "channel:0",
        senderNodeId: "channel:0",
        text: "digest ping",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          channels: [0],
          groups: {
            "channel:0": {
              requireMention: false,
            },
          },
        },
      }),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply: vi.fn(async () => undefined),
      onAdmittedGroup,
    });

    expect(onAdmittedGroup).toHaveBeenCalledTimes(1);
    expect(onAdmittedGroup).toHaveBeenCalledWith(
      expect.objectContaining({ text: "digest ping", isGroup: true, target: "channel:0" }),
    );
  });

  it("does not invoke onAdmittedGroup when group admission rejects", async () => {
    const onAdmittedGroup = vi.fn();
    await handleMeshcoreInbound({
      message: createMessage({
        isGroup: true,
        target: "channel:0",
        senderNodeId: "channel:0",
        text: "rejected digest",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "disabled",
          groupAllowFrom: [],
          channels: [0],
        },
      }),
      config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply: vi.fn(async () => undefined),
      onAdmittedGroup,
    });

    expect(onAdmittedGroup).not.toHaveBeenCalled();
  });
});
