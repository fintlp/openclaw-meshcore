import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveMeshcoreAccount } from "./accounts.js";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { handleMeshcoreInbound } from "./inbound.js";
import { meshcoreDedupeKey, openDurabilityStore } from "./durability.js";
import {
  resetNodeStatusStateForTests,
  setNodeStatusPathForTests,
  writeNodeStatusSnapshot,
} from "./node-status.js";
import { clearMeshcoreRuntime, getMeshcoreRuntime, setMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig, MeshcoreGroupConfig, MeshcoreInboundMessage, ResolvedMeshcoreAccount } from "./types.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToBytes } from "./protocol.js";
import { createDmIdentityEvidence } from "./dm-identity.js";
import { resetPairingRequestBudgetForTests } from "./pairing-budget.js";
import { clearSendRateLimitState } from "./rate-limit.js";
import { chunkTextWithNumbering } from "./send.js";

vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: vi.fn(({ peer }) => ({
    agentId: "meshcore",
    sessionKey: `meshcore:${peer?.kind === "group" ? "channel:0" : peer?.id ?? "unknown"}`,
    accountId: "default",
  })),
}));

const { runRepeaterOpsCommandMock } = vi.hoisted(() => ({
  runRepeaterOpsCommandMock: vi.fn(async () => "ops reply"),
}));

vi.mock("./repeater-ops.js", () => ({
  runRepeaterOpsCommand: runRepeaterOpsCommandMock,
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

const TEST_NODE_ID = '!aabbccdd11220000000000000000000000000000000000000000000000000000';
function createMessage(overrides?: Partial<MeshcoreInboundMessage>): MeshcoreInboundMessage {
  const senderNodeId = overrides?.senderNodeId ?? TEST_NODE_ID;
  const fullKey = senderNodeId.startsWith("!") ? senderNodeId.slice(1) : "";
  const canonical = /^[0-9a-f]{64}$/.test(fullKey);
  return {
    messageId: "mc-dm-" + senderNodeId + "-1700000000-hello",
    target: senderNodeId,
    senderNodeId,
    senderName: "TestNode",
    text: "hello",
    timestamp: Date.now(),
    isGroup: false,
    meshChannel: 0,
    ...(canonical
      ? {
          dmIdentity: {
            status: "unique" as const,
            fullKey,
            nodeId: senderNodeId,
            name: "TestNode",
          },
          dmIdentityEvidence: createDmIdentityEvidence({
            wirePrefix: hexToBytes(fullKey.slice(0, 12)),
            fullKey,
          }),
        }
      : {}),
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
          sessionKey: "meshcore:!aabbccdd11220000000000000000000000000000000000000000000000000000",
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
    resetPairingRequestBudgetForTests();
    clearSendRateLimitState();
    setMeshcoreRuntime(createBaseRuntime() as never);
  });

  afterEach(() => {
    clearMeshcoreRuntime();
    resetNodeStatusStateForTests();
    resetPairingRequestBudgetForTests();
    clearSendRateLimitState();
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
        senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
        target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
      }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
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
          senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
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
        senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
        target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
        meshSecurity,
      }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
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
        senderNodeId: "!aabbccdd11230000000000000000000000000000000000000000000000000000",
        target: "!aabbccdd11230000000000000000000000000000000000000000000000000000",
      }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
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
      expect.stringContaining("drop DM account=default fingerprint=!aabbccdd1123"),
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
          senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          text: "!ping",
        }),
        account: createAccount({
          config: {
            dmPolicy: "allowlist",
            allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
            groupPolicy: "disabled",
            groupAllowFrom: [],
            channels: [0],
            commandPingAllowFrom: [TEST_NODE_ID],
          },
        }),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply,
      });

      expect(sendReply).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledWith("!aabbccdd11220000000000000000000000000000000000000000000000000000", "pong GatewayNode", undefined);
      expect(inboundRunMock).not.toHaveBeenCalled();
    });

    it("denies !status even for a full-key-allowlisted sender", async () => {
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
          senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          text: "!status",
        }),
        account: createAccount({
          config: {
            dmPolicy: "allowlist",
            allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
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
      expect(inboundRunMock).not.toHaveBeenCalled();
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    });

    it("terminates an unknown sender’s blocked native command without pairing", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

      await handleMeshcoreInbound({
        message: createMessage({
          senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
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

      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();
      expect(inboundRunMock).not.toHaveBeenCalled();
    });

    it("requires an exact command match", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

      await handleMeshcoreInbound({
        message: createMessage({
          senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          text: "!ping please",
        }),
        account: createAccount({
          config: {
            dmPolicy: "allowlist",
            allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
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
          senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
          text: "!ping",
        }),
        account: createAccount({
          config: {
            dmPolicy: "allowlist",
            allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
            groupPolicy: "disabled",
            groupAllowFrom: [],
            channels: [0],
            commandRepliesEnabled: false,
            commandPingAllowFrom: [TEST_NODE_ID],
          },
        }),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply,
      });

      expect(sendReply).not.toHaveBeenCalled();
      expect(inboundRunMock).not.toHaveBeenCalled();
    });

    describe("repeater-ops commands (issue #35)", () => {
      beforeEach(() => {
        runRepeaterOpsCommandMock.mockReset().mockResolvedValue("ops reply");
      });

      it("default-denies !neighbours for a full-key-allowlisted sender", async () => {
        const sendReply = vi.fn(async () => undefined);
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

        await handleMeshcoreInbound({
          message: createMessage({
            senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            text: "!neighbours !ff00ff00ff00",
          }),
          account: createAccount({
            config: {
              dmPolicy: "allowlist",
              allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
              groupPolicy: "disabled",
              groupAllowFrom: [],
              channels: [0],
            },
          }),
          config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
          runtime: createRuntimeEnv(),
          sendReply,
        });

        expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
        expect(sendReply).not.toHaveBeenCalled();
        expect(inboundRunMock).not.toHaveBeenCalled();
        expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      });

      it("default-denies !neighbours even without a node argument", async () => {
        const sendReply = vi.fn(async () => undefined);
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

        await handleMeshcoreInbound({
          message: createMessage({
            senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            text: "!neighbours",
          }),
          account: createAccount({
            config: {
              dmPolicy: "allowlist",
              allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
              groupPolicy: "disabled",
              groupAllowFrom: [],
              channels: [0],
            },
          }),
          config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
          runtime: createRuntimeEnv(),
          sendReply,
        });

        expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
        expect(sendReply).not.toHaveBeenCalled();
        expect(inboundRunMock).not.toHaveBeenCalled();
        expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      });

      it("stays silent for ops commands in group channels", async () => {
        const sendReply = vi.fn(async () => undefined);
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

        await handleMeshcoreInbound({
          message: createMessage({
            isGroup: true,
            target: "channel:0",
            senderNodeId: "channel:0",
            text: "!neighbours !ff00ff00ff00",
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

        expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
        expect(sendReply).not.toHaveBeenCalled();
        expect(inboundRunMock).toHaveBeenCalledTimes(1);
      });

      it("does not pair or run ops commands for unknown senders", async () => {
        const sendReply = vi.fn(async () => undefined);
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

        await handleMeshcoreInbound({
          message: createMessage({
            senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            text: "!neighbours !ff00ff00ff00",
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

        expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
        expect(upsertPairingRequestMock).not.toHaveBeenCalled();
        expect(inboundRunMock).not.toHaveBeenCalled();
      });

      it("respects commandRepliesEnabled:false for ops commands", async () => {
        const sendReply = vi.fn(async () => undefined);
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

        await handleMeshcoreInbound({
          message: createMessage({
            senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            text: "!neighbours !ff00ff00ff00",
          }),
          account: createAccount({
            config: {
              dmPolicy: "allowlist",
              allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
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

        expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
        expect(sendReply).not.toHaveBeenCalled();
        expect(inboundRunMock).not.toHaveBeenCalled();
      });

      it("does not mistake a longer word for an ops command", async () => {
        const sendReply = vi.fn(async () => undefined);
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

        await handleMeshcoreInbound({
          message: createMessage({
            senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            text: "!neighbourhood watch",
          }),
          account: createAccount({
            config: {
              dmPolicy: "allowlist",
              allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
              groupPolicy: "disabled",
              groupAllowFrom: [],
              channels: [0],
            },
          }),
          config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
          runtime: createRuntimeEnv(),
          sendReply,
        });

        expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
        expect(sendReply).not.toHaveBeenCalled();
        expect(inboundRunMock).toHaveBeenCalledTimes(1);
      });

      it("default-denies !rstatus for a full-key-allowlisted sender", async () => {
        const sendReply = vi.fn(async () => undefined);
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

        await handleMeshcoreInbound({
          message: createMessage({
            senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            text: "!rstatus !ff00ff00ff00",
          }),
          account: createAccount({
            config: {
              dmPolicy: "allowlist",
              allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
              groupPolicy: "disabled",
              groupAllowFrom: [],
              channels: [0],
            },
          }),
          config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
          runtime: createRuntimeEnv(),
          sendReply,
        });

        expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
        expect(sendReply).not.toHaveBeenCalled();
        expect(inboundRunMock).not.toHaveBeenCalled();
        expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      });

      it("default-denies !trace for a full-key-allowlisted sender", async () => {
        const sendReply = vi.fn(async () => undefined);
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);

        await handleMeshcoreInbound({
          message: createMessage({
            senderNodeId: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            target: "!aabbccdd11220000000000000000000000000000000000000000000000000000",
            text: "!trace !ff00ff00ff00",
          }),
          account: createAccount({
            config: {
              dmPolicy: "allowlist",
              allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"],
              groupPolicy: "disabled",
              groupAllowFrom: [],
              channels: [0],
            },
          }),
          config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
          runtime: createRuntimeEnv(),
          sendReply,
        });

        expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
        expect(sendReply).not.toHaveBeenCalled();
        expect(inboundRunMock).not.toHaveBeenCalled();
        expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      });
    });
  });

  describe("PR2 identity, owner, and pairing hardening", () => {
    const OTHER_NODE = "!" + "22".repeat(32);

    it("refuses configured mesh owner aliases before any host or tool dispatch", async () => {
      const aliases = [
        TEST_NODE_ID,
        TEST_NODE_ID.slice(1),
        "meshcore:" + TEST_NODE_ID,
        "meshcore:!" + TEST_NODE_ID.slice(1, 13),
      ];
      for (const ownerAllowFrom of aliases) {
        const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
        const sendReply = vi.fn(async () => undefined);
        setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);
        shouldHandleTextCommandsMock.mockReturnValue(true);
        hasControlCommandMock.mockReturnValue(true);
        await handleMeshcoreInbound({
          message: createMessage({ text: "/status" }),
          account: createAccount({
            config: {
              dmPolicy: "allowlist",
              allowFrom: [TEST_NODE_ID],
              groupPolicy: "disabled",
              commandPingAllowFrom: [TEST_NODE_ID],
            },
          }),
          config: {
            channels: { meshcore: { host: "192.0.2.10" } },
            commands: { ownerAllowFrom: [ownerAllowFrom] },
          } as unknown as CoreConfig,
          runtime: createRuntimeEnv(),
          sendReply,
        });
        expect(inboundRunMock).not.toHaveBeenCalled();
        expect(sendReply).not.toHaveBeenCalled();
        expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      }
    });

    it("suppresses host commands and the real owner-only tool surface for ordinary chat", async () => {
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);
      shouldHandleTextCommandsMock.mockReturnValue(true);
      hasControlCommandMock.mockReturnValue(true);
      const config = {
        channels: { meshcore: { host: "192.0.2.10" } },
        commands: { ownerAllowFrom: [OTHER_NODE] },
      } as unknown as CoreConfig;
      await handleMeshcoreInbound({
        message: createMessage({ text: "/status" }),
        account: createAccount({
          config: { dmPolicy: "allowlist", allowFrom: [TEST_NODE_ID], groupPolicy: "disabled" },
        }),
        config,
        runtime: createRuntimeEnv(),
        sendReply: vi.fn(async () => undefined),
      });
      expect(inboundRunMock).toHaveBeenCalledTimes(1);
      const turn = inboundRunMock.mock.calls[0][0].adapter.resolveTurn();
      expect(turn.ctxPayload.CommandAuthorized).toBe(false);
      expect(turn.ctxPayload.CommandInterpretationSuppressed).toBe(true);
      const finalized = finalizeInboundContext(turn.ctxPayload);
      expect(finalized.CommandAuthorized).toBe(false);
      expect(finalized.CommandInterpretationSuppressed).toBe(true);
      expect(finalized.RawBody).toBe("/status");

      const authorization = resolveCommandAuthorization({
        ctx: finalized,
        cfg: config,
        commandAuthorized: finalized.CommandAuthorized === true,
      });
      expect(authorization.senderIsOwner).toBe(false);
      expect(authorization.isAuthorizedSender).toBe(false);
      const tools = createOpenClawCodingTools({
        config,
        workspaceDir: "/tmp",
        sessionKey: String(finalized.SessionKey),
        agentId: "meshcore",
        messageChannel: "meshcore",
        senderIsOwner: authorization.senderIsOwner,
      });
      const names = tools.map((tool) => tool.name);
      for (const name of ["gateway", "automations"]) {
        if (!names.includes(name)) continue;
        // 2026.11.3 keeps definitions visible for prompt-prefix stability and
        // gates execution instead of removing them (2026.10.5 removes them).
        // Exercise the real wrapper with a read-only input; it must refuse
        // before any control-plane action can run.
        const tool = tools.find((candidate) => candidate.name === name)!;
        const result = await (tool.execute as unknown as (
          toolCallId: string,
          input: unknown,
        ) => Promise<unknown>)("pr2-owner-gate-probe", { action: "list" });
        expect(JSON.stringify(result)).toContain("owner");
        expect(JSON.stringify(result)).toContain("gated");
      }
    });

    it("does not admit legacy prefix, bare-key, or name approvals", async () => {
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      const runtime = createRuntimeEnv();
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);
      readAllowFromStoreMock.mockResolvedValue(["!aabbccdd1122", "TestNode"]);
      await handleMeshcoreInbound({
        message: createMessage(),
        account: createAccount({
          config: {
            dmPolicy: "allowlist",
            allowFrom: ["!aabbccdd1122", TEST_NODE_ID.slice(1), "TestNode"],
            groupPolicy: "disabled",
          },
        }),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime,
        sendReply: vi.fn(async () => undefined),
      });
      expect(inboundRunMock).not.toHaveBeenCalled();
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("legacy-dm-approvals-ignored"),
      );
    });

    it("reserves only three pairing attempts per account and enforces cooldown", async () => {
      const sendReply = vi.fn(async () => undefined);
      const keys = [1, 2, 3, 4].map((n) => "!" + n.toString(16).padStart(64, "0"));
      for (const nodeId of keys) {
        await handleMeshcoreInbound({
          message: createMessage({ senderNodeId: nodeId, target: nodeId }),
          account: createAccount(),
          config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
          runtime: createRuntimeEnv(),
          sendReply,
        });
      }
      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(3);
      expect(sendReply).toHaveBeenCalledTimes(3);
      expect(sendReply.mock.calls[0][3]).toBe("pairing");

      await handleMeshcoreInbound({
        message: createMessage({ senderNodeId: keys[0], target: keys[0] }),
        account: createAccount(),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply,
      });
      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(3);
    });

    it("coalesces concurrent same-key pairing challenges", async () => {
      let release!: (value: { code: string; created: boolean }) => void;
      const gate = new Promise<{ code: string; created: boolean }>((resolve) => {
        release = resolve;
      });
      upsertPairingRequestMock.mockReset().mockImplementation(() => gate);
      const sendReply = vi.fn(async () => undefined);
      const call = () => handleMeshcoreInbound({
        message: createMessage(),
        account: createAccount(),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply,
      });
      const first = call();
      const second = call();
      await vi.waitFor(() => expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1));
      release({ code: "CODE", created: true });
      await Promise.all([first, second]);
      expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
      expect(sendReply).toHaveBeenCalledTimes(1);
    });

    it("rejects maxSends:1 pairing before pending state and keeps challenge chunks within the default share", async () => {
      const sendReply = vi.fn(async () => undefined);
      await handleMeshcoreInbound({
        message: createMessage(),
        account: createAccount({
          config: {
            ...createAccount().config,
            sendRateLimit: { maxSends: 1 },
          },
        }),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply,
      });
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();

      await handleMeshcoreInbound({
        message: createMessage(),
        account: createAccount(),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply,
      });
      const challengeText = sendReply.mock.calls[0][1] as string;
      expect(chunkTextWithNumbering(challengeText, 127, true).length).toBeLessThanOrEqual(3);
      expect(sendReply.mock.calls[0][3]).toBe("pairing");
    });

    it("applies the separate native ping budget only to the explicit full-key exception", async () => {
      const sendReply = vi.fn(async () => undefined);
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);
      const account = createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: [TEST_NODE_ID],
          groupPolicy: "disabled",
          commandPingAllowFrom: [TEST_NODE_ID],
        },
      });
      for (let n = 0; n < 4; n += 1) {
        await handleMeshcoreInbound({
          message: createMessage({ text: "!ping" }),
          account,
          config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
          runtime: createRuntimeEnv(),
          sendReply,
        });
      }
      expect(sendReply).toHaveBeenCalledTimes(3);
      expect(inboundRunMock).not.toHaveBeenCalled();
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    });
  });

});


describe("durability redelivery (m7 / minor-1, adversarial re-check)", () => {
  it("m7: a plain-DM retry after a failed first dispatch is redelivered, not dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-beh-dur-"));
    const store = await openDurabilityStore({ dbPath: join(dir, "d.sqlite") });
    try {
      const msg = createMessage({ text: "hello", timestamp: 1700000001234 });
      store!.intake({
        accountId: "default",
        dedupeKey: meshcoreDedupeKey({
          senderNodeId: msg.senderNodeId,
          timestamp: msg.timestamp,
          body: msg.text,
        }),
        kind: "direct",
        peerId: msg.senderNodeId,
        senderTs: msg.timestamp,
        body: "hello",
        rawJson: JSON.stringify(msg),
      });
      const inboundRunMock = vi.fn(async () => ({ dispatched: true }));
      setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRunMock) as never);
      await handleMeshcoreInbound({
        message: msg,
        account: createAccount({
          config: { dmPolicy: "allowlist", allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"], groupPolicy: "disabled" },
        }),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply: vi.fn(async () => undefined),
        durability: store,
      });
      expect(inboundRunMock).toHaveBeenCalled();
    } finally {
      store?.close();
    }
  });

  it("minor-1: a duplicate command is dropped before it can re-air", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-beh-dur-"));
    const store = await openDurabilityStore({ dbPath: join(dir, "d.sqlite") });
    try {
      runRepeaterOpsCommandMock.mockClear();
      const msg = createMessage({ text: "!ping", timestamp: 1700000005678 });
      store!.intake({
        accountId: "default",
        dedupeKey: meshcoreDedupeKey({
          senderNodeId: msg.senderNodeId,
          timestamp: msg.timestamp,
          body: msg.text,
        }),
        kind: "direct",
        peerId: msg.senderNodeId,
        senderTs: msg.timestamp,
        body: msg.text,
        rawJson: JSON.stringify(msg),
      });
      const sendReply = vi.fn(async () => undefined);
      await handleMeshcoreInbound({
        message: msg,
        account: createAccount({
          config: { dmPolicy: "allowlist", allowFrom: ["!aabbccdd11220000000000000000000000000000000000000000000000000000"], groupPolicy: "disabled", commandPingAllowFrom: [TEST_NODE_ID] },
        }),
        config: { channels: { meshcore: { host: "192.0.2.10" } } } as CoreConfig,
        runtime: createRuntimeEnv(),
        sendReply,
        durability: store,
      });
      expect(runRepeaterOpsCommandMock).not.toHaveBeenCalled();
      expect(sendReply).not.toHaveBeenCalled();
    } finally {
      store?.close();
    }
  });
});


describe("group tool-policy route and command activation hardening", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/routing")>(
      "openclaw/plugin-sdk/routing",
    );
    vi.mocked(resolveAgentRoute).mockReset().mockImplementation(actual.resolveAgentRoute);
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    shouldHandleTextCommandsMock.mockReset().mockReturnValue(false);
    hasControlCommandMock.mockReset().mockReturnValue(false);
    buildMentionRegexesMock.mockReset().mockReturnValue([]);
    matchesMentionPatternsMock.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    clearMeshcoreRuntime();
    vi.mocked(resolveAgentRoute).mockReset().mockImplementation(({ peer }) => ({
      agentId: "meshcore",
      sessionKey: `meshcore:${peer?.kind === "group" ? "channel:0" : peer?.id ?? "unknown"}`,
      accountId: "default",
    }));
  });

  function groupAccount(group: MeshcoreGroupConfig = {}) {
    return createAccount({
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        channels: [0],
        groupAllowFrom: [],
        groups: { "channel:0": { requireMention: false, ...group } },
      },
    });
  }

  function routeConfig(
    groupScope: "main" | "per-group",
    bindingScope?: "main" | "per-group",
  ): CoreConfig {
    return {
      session: { groupScope },
      ...(bindingScope
        ? {
            bindings: [
              {
                agentId: "meshcore",
                match: {
                  channel: "meshcore",
                  accountId: "default",
                  peer: { kind: "group", id: "channel:0" },
                },
                session: { groupScope: bindingScope },
              },
            ],
          }
        : {}),
      channels: { meshcore: { host: "192.0.2.10" } },
    } as CoreConfig;
  }

  function groupMessage(text = "group turn") {
    return createMessage({
      isGroup: true,
      target: "channel:0",
      senderNodeId: "channel:0",
      text,
      timestamp: 1790000000000,
    });
  }

  function durabilityFake() {
    return {
      findDuplicate: vi.fn(() => null),
      intake: vi.fn(() => ({ id: 7, duplicate: false })),
      claim: vi.fn(() => "claimed"),
      releaseClaim: vi.fn(),
      deadLetter: vi.fn(),
      markDispatched: vi.fn(),
      markComplete: vi.fn(),
      metrics: vi.fn(() => ({ pending: 0, dead: 0, duplicates: 0, degraded: false })),
    };
  }

  async function runGroup(params: {
    account?: ResolvedMeshcoreAccount;
    config?: CoreConfig;
    replayOf?: number;
    onAdmittedGroup?: ReturnType<typeof vi.fn>;
  } = {}) {
    const inboundRun = vi.fn(async () => ({ dispatched: true }));
    setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRun) as never);
    const runtime = createRuntimeEnv();
    const durability = durabilityFake();
    await handleMeshcoreInbound({
      message: groupMessage(),
      account: params.account ?? groupAccount({ tools: { deny: ["write"] } }),
      config: params.config ?? routeConfig("main"),
      runtime,
      durability: durability as never,
      ...(params.replayOf !== undefined ? { replayOf: params.replayOf } : {}),
      ...(params.onAdmittedGroup ? { onAdmittedGroup: params.onAdmittedGroup } : {}),
    });
    return { inboundRun, runtime, durability };
  }

  it("refuses a main-scoped protected group before intake and logs account, channel, and remediation", async () => {
    const r = await runGroup();

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
    expect(r.runtime.log).toHaveBeenCalledWith(expect.stringContaining("account=default"));
    expect(r.runtime.log).toHaveBeenCalledWith(expect.stringContaining("channel:0"));
    expect(r.runtime.log).toHaveBeenCalledWith(expect.stringContaining('groupScope="per-group"'));
    expect(r.runtime.log).toHaveBeenCalledWith(expect.stringContaining("effective binding"));
  });

  it("refuses a main-scoped group protected only by wildcard tools", async () => {
    const account = createAccount({
      config: {
        ...groupAccount().config,
        groups: { "*": { requireMention: false, tools: { deny: ["write"] } } },
      },
    });

    const r = await runGroup({ account });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
  });

  it("refuses a main-scoped group whose single named account inherits root tools", async () => {
    const config = {
      ...routeConfig("main"),
      channels: {
        meshcore: {
          host: "192.0.2.10",
          groupPolicy: "open",
          groups: { "channel:0": { requireMention: false, tools: { deny: ["root-policy"] } } },
          accounts: {
            ops: { host: "192.0.2.11", groupPolicy: "open", groups: {} },
          },
        },
      },
    } as CoreConfig;
    const account = resolveMeshcoreAccount({ cfg: config, accountId: "ops" });

    const r = await runGroup({ account, config });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
    expect(r.runtime.log).toHaveBeenCalledWith(expect.stringContaining("account=ops"));
  });

  it("allows a protected group on a per-group route and resolves the route exactly once", async () => {
    const r = await runGroup({ config: routeConfig("per-group") });

    expect(r.inboundRun).toHaveBeenCalledTimes(1);
    expect(r.durability.intake).toHaveBeenCalledTimes(1);
    expect(r.durability.deadLetter).not.toHaveBeenCalled();
    expect(resolveAgentRoute).toHaveBeenCalledTimes(1);
  });

  it("honors a binding that overrides a per-group global default to main", async () => {
    const r = await runGroup({ config: routeConfig("per-group", "main") });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
    expect(r.runtime.log).toHaveBeenCalledWith(expect.stringContaining('groupScope="main"'));
  });

  it("honors a binding that restores per-group under a main global default", async () => {
    const r = await runGroup({ config: routeConfig("main", "per-group") });

    expect(r.inboundRun).toHaveBeenCalledTimes(1);
    expect(r.durability.intake).toHaveBeenCalledTimes(1);
    expect(r.durability.deadLetter).not.toHaveBeenCalled();
  });

  it("dead-letters a protected replay with the terminal group-scope-main reason", async () => {
    const r = await runGroup({ replayOf: 7 });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.durability.intake).not.toHaveBeenCalled();
    expect(r.durability.deadLetter).toHaveBeenCalledWith("default", 7, "group-scope-main");
    expect(r.durability.releaseClaim).not.toHaveBeenCalled();
  });

  it("allows an unprotected group to use a main route as a positive control", async () => {
    const r = await runGroup({ account: groupAccount({}) });

    expect(r.inboundRun).toHaveBeenCalledTimes(1);
    expect(r.durability.intake).toHaveBeenCalledTimes(1);
    expect(r.durability.deadLetter).not.toHaveBeenCalled();
  });

  function commandGroupAccount(requireMention = true) {
    return createAccount({
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        channels: [0],
        groupAllowFrom: ["*"],
        groups: { "channel:0": { requireMention } },
      },
    });
  }

  async function runGroupCommand(params: {
    text: string;
    mentioned?: boolean;
    requireMention?: boolean;
    disabled?: boolean;
    digest?: boolean;
  }) {
    const inboundRun = vi.fn(async () => ({ dispatched: true }));
    setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRun) as never);
    shouldHandleTextCommandsMock.mockReturnValue(true);
    hasControlCommandMock.mockImplementation((body) => body.startsWith("/status"));
    matchesMentionPatternsMock.mockImplementation((body) => body.includes("@verax"));
    const onAdmittedGroup = vi.fn();
    const account = params.disabled
      ? createAccount({
          config: {
            dmPolicy: "pairing",
            allowFrom: [],
            groupPolicy: "disabled",
            channels: [0],
            groupAllowFrom: ["*"],
            groups: { "channel:0": { requireMention: params.requireMention ?? true } },
          },
        })
      : commandGroupAccount(params.requireMention);
    await handleMeshcoreInbound({
      message: groupMessage(params.text),
      account,
      config: routeConfig("per-group"),
      runtime: createRuntimeEnv(),
      ...(params.digest ? { onAdmittedGroup } : {}),
    });
    return { inboundRun, onAdmittedGroup };
  }

  it("makes /status without a mention fail requireMention even for an admitted sender", async () => {
    const r = await runGroupCommand({ text: "/status" });

    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(r.onAdmittedGroup).not.toHaveBeenCalled();
  });

  it("suppresses command authority for a mentionless group slash command when mentions are optional", async () => {
    const r = await runGroupCommand({ text: "/status", requireMention: false });

    expect(r.inboundRun).toHaveBeenCalledTimes(1);
    const inbound = r.inboundRun.mock.calls[0][0];
    const turn = inbound.adapter.resolveTurn();
    expect(turn.ctxPayload).toEqual(
      expect.objectContaining({
        CommandAuthorized: false,
        CommandInterpretationSuppressed: true,
      }),
    );
  });

  it("keeps an authorized DM /status command authorized and unsuppressed", async () => {
    const inboundRun = vi.fn(async () => ({ dispatched: true }));
    setMeshcoreRuntime(makeRuntimeWithDispatch(inboundRun) as never);
    shouldHandleTextCommandsMock.mockReturnValue(true);
    hasControlCommandMock.mockImplementation((body) => body.startsWith("/status"));
    const account = createAccount({
      config: {
        dmPolicy: "allowlist",
        allowFrom: ["!aabbccdd1122"],
        groupPolicy: "disabled",
        groupAllowFrom: [],
        channels: [0],
      },
    });

    await handleMeshcoreInbound({
      message: createMessage({ text: "/status" }),
      account,
      config: routeConfig("per-group"),
      runtime: createRuntimeEnv(),
    });

    expect(inboundRun).toHaveBeenCalledTimes(1);
    const inbound = inboundRun.mock.calls[0][0];
    const turn = inbound.adapter.resolveTurn();
    expect(turn.ctxPayload.CommandAuthorized).toBe(true);
    expect(turn.ctxPayload.CommandInterpretationSuppressed).toBeUndefined();
  });

  it("dispatches a genuinely mentioned slash command as plain text with command authority suppressed", async () => {
    const r = await runGroupCommand({ text: "/status @verax", mentioned: true });

    expect(r.inboundRun).toHaveBeenCalledTimes(1);
    const inbound = r.inboundRun.mock.calls[0][0];
    const turn = inbound.adapter.resolveTurn();
    expect(turn.ctxPayload).toEqual(
      expect.objectContaining({
        Body: "/status @verax",
        RawBody: "/status @verax",
        CommandBody: "/status @verax",
        CommandAuthorized: false,
        CommandInterpretationSuppressed: true,
        GroupSubject: "channel:0",
        SenderName: "TestNode",
      }),
    );
    expect(turn.ctxPayload.Body).not.toContain("GroupSubject");
    expect(turn.ctxPayload.Body).not.toContain("SenderName");
  });

  it("keeps digest mode as one admitted entry with no route or agent turn", async () => {
    const r = await runGroupCommand({ text: "/status @verax", mentioned: true, digest: true });

    expect(r.onAdmittedGroup).toHaveBeenCalledTimes(1);
    expect(r.onAdmittedGroup).toHaveBeenCalledWith(
      expect.objectContaining({ text: "/status @verax", isGroup: true }),
    );
    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });

  it("keeps a disabled group from both digest intake and agent dispatch", async () => {
    const r = await runGroupCommand({
      text: "/status @verax",
      mentioned: true,
      disabled: true,
      digest: true,
    });

    expect(r.onAdmittedGroup).not.toHaveBeenCalled();
    expect(r.inboundRun).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
  });
});
