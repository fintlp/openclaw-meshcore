import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-message";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveMeshcoreAccount } from "./accounts.js";
import { connectMeshcoreDevice, getMeshcoreDevice, nodeIdToPubkey, type MeshcoreDeviceHandle } from "./device-client.js";
import { rememberOutboundEcho } from "./echo-dedupe.js";
import {
  formatMeshcoreNodeId,
  isMeshcoreGroupTarget,
  normalizeMeshcoreMessagingTarget,
  parseMeshcoreChannelIndex,
  parseMeshcoreNodeId,
} from "./normalize.js";
import { getMeshcoreRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type SendMeshcoreOptions = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
  target?: string;
  deviceHandle?: MeshcoreDeviceHandle;
};

type SendMeshcoreResult = {
  messageId: string;
  target: string;
  receipt: MessageReceipt;
};

const DEFAULT_CHUNK_LIMIT = 133;

function recordMeshcoreOutboundActivity(accountId: string): void {
  try {
    getMeshcoreRuntime().channel.activity.record({
      channel: "meshcore",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "MeshCore runtime not initialized") {
      throw error;
    }
  }
}

function chunkText(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const chars = Array.from(trimmed);
  if (chars.length <= limit) {
    return [trimmed];
  }
  const chunks: string[] = [];
  for (let cursor = 0; cursor < chars.length; cursor += limit) {
    chunks.push(chars.slice(cursor, cursor + limit).join(""));
  }
  return chunks;
}

function resolveTarget(to: string, opts?: SendMeshcoreOptions): string {
  const fromArg = normalizeMeshcoreMessagingTarget(to);
  if (fromArg) {
    return fromArg;
  }
  const fromOpt = normalizeMeshcoreMessagingTarget(opts?.target ?? "");
  if (fromOpt) {
    return fromOpt;
  }
  throw new Error(`Invalid MeshCore target: ${to}`);
}

export async function sendMessageMeshcore(
  to: string,
  text: string,
  opts: SendMeshcoreOptions,
): Promise<SendMeshcoreResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "MeshCore send") as CoreConfig;
  const account = resolveMeshcoreAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `MeshCore is not configured for account "${account.accountId}" (need host in channels.meshcore).`,
    );
  }

  const target = resolveTarget(to, opts);
  const chunkLimit = account.config.textChunkLimit ?? DEFAULT_CHUNK_LIMIT;
  const chunks = chunkText(text, chunkLimit);
  if (chunks.length === 0) {
    throw new Error("Message must be non-empty for MeshCore sends");
  }

  const handle =
    opts.deviceHandle ??
    getMeshcoreDevice(account.accountId) ??
    (await connectMeshcoreDevice({
      accountId: account.accountId,
      host: account.host,
      port: account.port,
    }));

  if (isMeshcoreGroupTarget(target)) {
    throw new Error(
      `MeshCore group sends are disabled: ${target} is receive-only (LoRa airtime rule)`,
    );
  }

  const nodeId = parseMeshcoreNodeId(target);
  if (!nodeId) {
    throw new Error(`Invalid MeshCore DM target: ${target}`);
  }
  const pubkey = nodeIdToPubkey(nodeId);

  let lastMessageId = "";
  for (const chunk of chunks) {
    rememberOutboundEcho(chunk);
    const response = await handle.connection.sendTextMessage(pubkey, chunk);
    lastMessageId = String(response.expectedAckCrc ?? response.estTimeout ?? Date.now());
  }

  recordMeshcoreOutboundActivity(account.accountId);

  return {
    messageId: lastMessageId,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "meshcore",
          messageId: lastMessageId,
          conversationId: target,
        },
      ],
      kind: "text",
      ...(opts.replyTo ? { replyToId: opts.replyTo } : {}),
    }),
  };
}
