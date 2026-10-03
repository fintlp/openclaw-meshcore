import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-message";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveMeshcoreAccount } from "./accounts.js";
import {
  attachSendConfirmedHandler,
  connectMeshcoreDevice,
  getMeshcoreDevice,
  nodeIdToPubkey,
  type MeshcoreDeviceHandle,
} from "./device-client.js";
import { rememberOutboundEcho } from "./echo-dedupe.js";
import {
  formatMeshcoreNodeId,
  isMeshcoreGroupTarget,
  normalizeMeshcoreMessagingTarget,
  parseMeshcoreChannelIndex,
  parseMeshcoreNodeId,
} from "./normalize.js";
import { withPacedSend } from "./pacing.js";
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

// Empirical (issue #5): node firmware 1.16 truncates text frames at 127 bytes
// on the wire; chunking larger silently loses each chunk's tail at the joins.
const DEFAULT_CHUNK_LIMIT = 127;

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

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function chunkText(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (utf8ByteLength(trimmed) <= limit) {
    return [trimmed];
  }
  // The wire frame limits BYTES, not characters: a code-point-sized chunk full
  // of multibyte runes (em-dashes, emoji, umlauts) overflows the frame and its
  // tail is truncated on air. Chunk by UTF-8 byte length, prefer whitespace
  // boundaries, and never split inside a multibyte character.
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  const pushCurrent = () => {
    const part = current.trim();
    if (part) {
      chunks.push(part);
    }
    current = "";
    currentBytes = 0;
  };
  for (const piece of trimmed.split(/(\s+)/)) {
    const pieceBytes = utf8ByteLength(piece);
    if (currentBytes > 0 && currentBytes + pieceBytes > limit) {
      pushCurrent();
    }
    if (pieceBytes > limit) {
      // Single word longer than the limit: hard-split at a byte-safe boundary.
      for (const ch of piece) {
        const chBytes = utf8ByteLength(ch);
        if (currentBytes > 0 && currentBytes + chBytes > limit) {
          pushCurrent();
        }
        current += ch;
        currentBytes += chBytes;
      }
    } else {
      current += piece;
      currentBytes += pieceBytes;
    }
  }
  pushCurrent();
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

  attachSendConfirmedHandler(handle.connection, account.accountId);

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

  return await withPacedSend(
    account.accountId,
    account.config.sendPacing as Record<string, unknown> | undefined,
    handle.selfInfo,
    async (ctx) => {
      let lastMessageId = "";
      for (const chunk of chunks) {
        const chunkBytes = utf8ByteLength(chunk);
        await ctx.beforeFrame(chunkBytes);
        rememberOutboundEcho(chunk);
        const response = await handle.connection.sendTextMessage(pubkey, chunk);
        lastMessageId = String(response.expectedAckCrc ?? response.estTimeout ?? Date.now());
        ctx.afterFrame(chunkBytes);
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
    },
  );
}
