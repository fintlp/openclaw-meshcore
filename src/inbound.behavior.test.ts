import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { handleMeshcoreInbound } from "./inbound.js";
import {
  resetNodeStatusStateForTests,
  setNodeStatusPathForTests,
  writeNodeStatusSnapshot,
} from "./node-status.js";
import { clearMeshcoreRuntime, getMeshcoreRuntime, setMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig, MeshcoreInboundMessage, ResolvedMeshcoreAccount } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToBytes } from "./protocol.js";

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
    meshSecurity: {
      txtType: 0,
      signedPlain: false,
      identityBinding: "prefix-only",
    },
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

function makeNodeStatusPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "meshcore-inbound-status-"));
  return join(dir, "node-status.json");
}

function makeRuntimeWithDispatch(inboundRunMock = vi.fn(async () => ({ dispatched: true }))) {
  return {
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
  };
}

describe("meshcore inbound behavior", () => {
  let nodeStatusPath: string;

  beforeEach(() => {
    nodeStatusPath = makeNodeStatusPath();
    setNodeStatusPathForTests(nodeStatusPath);
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
    resetNodeStatusStateForTests();
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
    setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

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

  it("exposes meshSecurity in the SDK ChannelStructuredContext payload", async () => {
    const sendReply = vi.fn(async () => undefined);
    const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
    setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

    const meshSecurity = {
      txtType: 2,
      signedPlain: true,
      senderPrefixHex: "41424344",
      lossy: false,
      prefixMatch: "pubkey-last4" as const,
      consistency: "insufficient" as const,
      identityBinding: "extended" as const,
    };

    await handleMeshcoreInbound({
      message: createMessage({
        senderNodeId: "!aabbccdd1122",
        target: "!aabbccdd1122",
        meshSecurity,
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

    expect(inboundRunMock).toHaveBeenCalledTimes(1);
    const turn = inboundRunMock.mock.calls[0][0].adapter.resolveTurn();
    // finalizeInboundContext is the real OpenClaw normalization step; arbitrary
    // keys survive it, so the meaningful assertion is the POST-normalization
    // shape. The compiled runtime then reads the capital-C field at:
    //   - bot-message-CMzg2kIN.mjs:1823: params.context.ctxPayload.ChannelStructuredContext ?? []
    //   - context-*.mjs:156-160 (resolveChannelStructuredContext):
    //       params.extra?.ChannelStructuredContext / params.supplemental?.channelStructuredContext
    const finalized = finalizeInboundContext(turn.ctxPayload);
    expect(finalized.ChannelStructuredContext).toEqual([
      {
        label: "MeshCore Message Security",
        source: "meshcore",
        type: "mesh_security",
        payload: meshSecurity,
      },
    ]);
    // Prove the entry is visible to the runtime's own read pattern.
    const runtimeRead = (finalized.ChannelStructuredContext ?? []) as Array<{
      label: string;
      source?: string;
      type?: string;
      payload: unknown;
    }>;
    expect(runtimeRead).toHaveLength(1);
    expect(runtimeRead[0].payload).toEqual(meshSecurity);
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

  describe("plugin-level command replies (issue #29)", () => {
    it("answers !ping directly for a paired/allowlisted sender", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

      writeNodeStatusSnapshot(
        {
          type: 1,
          txPower: 22,
          maxTxPower: 23,
          publicKey: hexToBytes(
            "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
          ),
          advLat: 48858900,
          advLon: 2294500,
          reserved: new Uint8Array(16),
          manualAddContacts: 0,
          radioFreq: 869_618_000,
          radioBw: 62_500,
          radioSf: 8,
          radioCr: 8,
          name: "GatewayNode",
        },
        {
          connectionState: "connected",
          since: 1_700_000_000_000,
          reconnectCount: 1,
        },
      );

      await handleMeshcoreInbound({
        message: createMessage({
          senderNodeId: "!aabbccdd1122",
          target: "!aabbccdd1122",
          text: "!ping",
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

      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledWith("!aabbccdd1122", "pong GatewayNode", undefined);
      expect(inboundRunMock).not.toHaveBeenCalled();
    });

    it("answers !status directly for a paired/allowlisted sender", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

      writeNodeStatusSnapshot(
        {
          type: 1,
          txPower: 22,
          maxTxPower: 23,
          publicKey: hexToBytes(
            "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb",
          ),
          advLat: 48858900,
          advLon: 2294500,
          reserved: new Uint8Array(16),
          manualAddContacts: 0,
          radioFreq: 869_618_000,
          radioBw: 62_500,
          radioSf: 8,
          radioCr: 8,
          name: "GatewayNode",
        },
        {
          connectionState: "connected",
          since: 1_700_000_000_000,
          reconnectCount: 2,
        },
      );

      await handleMeshcoreInbound({
        message: createMessage({
          senderNodeId: "!aabbccdd1122",
          target: "!aabbccdd1122",
          text: "!status",
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

      expect(sendReply).toHaveBeenCalledTimes(1);
      const reply = sendReply.mock.calls[0][1] as string;
      expect(reply).toMatch(/^connected /);
      expect(reply).toContain("name:GatewayNode");
      expect(reply).toContain("reconnects:2");
      expect(inboundRunMock).not.toHaveBeenCalled();
    });

    it("does not answer commands from an unknown sender (pairing flow instead)", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

      await handleMeshcoreInbound({
        message: createMessage({
          senderNodeId: "!aabbccdd1122",
          target: "!aabbccdd1122",
          text: "!ping",
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
        sendReply,
      });

      expect(upsertPairingRequestMock).toHaveBeenCalled();
      expect(sendReply).toHaveBeenCalled();
      const reply = sendReply.mock.calls[0][1] as string;
      expect(reply).not.toMatch(/^pong/);
      expect(inboundRunMock).not.toHaveBeenCalled();
    });

    it("requires an exact command match", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

      await handleMeshcoreInbound({
        message: createMessage({
          senderNodeId: "!aabbccdd1122",
          target: "!aabbccdd1122",
          text: "!ping please",
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

      expect(sendReply).not.toHaveBeenCalled();
      expect(inboundRunMock).toHaveBeenCalledTimes(1);
    });

    it("ignores commands in group channels", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

      await handleMeshcoreInbound({
        message: createMessage({
          isGroup: true,
          target: "channel:0",
          senderNodeId: "channel:0",
          text: "!ping",
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

      expect(sendReply).not.toHaveBeenCalled();
      expect(inboundRunMock).toHaveBeenCalledTimes(1);
    });

    it("can be disabled via config", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

      await handleMeshcoreInbound({
        message: createMessage({
          senderNodeId: "!aabbccdd1122",
          target: "!aabbccdd1122",
          text: "!ping",
        }),
        account: createAccount({
          config: {
            dmPolicy: "allowlist",
            allowFrom: ["!aabbccdd1122"],
            groupPolicy: "disabled",
            groupAllowFrom: [],
            channels: [0],
            commandRepliesEnabled: false,
          },
        }),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply,
      });

      expect(sendReply).not.toHaveBeenCalled();
      expect(inboundRunMock).toHaveBeenCalledTimes(1);
    });
  });
});
