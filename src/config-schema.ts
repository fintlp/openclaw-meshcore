import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ToolPolicySchema,
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { meshcoreChannelConfigUiHints } from "./config-ui-hints.js";

const MeshcoreGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

const MeshcoreTransportSchema = z.enum(["tcp"]);

const MeshcoreAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    transport: MeshcoreTransportSchema.optional().default("tcp"),
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    groupPolicy: GroupPolicySchema.optional().default("disabled"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), MeshcoreGroupSchema.optional()).optional(),
    channels: z.array(z.number().int().min(0).max(7)).optional(),
    mentionPatterns: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    ...ReplyRuntimeConfigSchemaShape,
    textChunkLimit: z.number().int().min(40).max(500).optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: z
      .object({
        minChars: z.number().int().positive().optional(),
        maxChars: z.number().int().positive().optional(),
        idleMs: z.number().int().min(0).optional(),
      })
      .optional(),
    responsePrefix: z.string().optional(),
    logInboundMessageContent: z.boolean().optional(),
  })
  .strict();

const MeshcoreAccountSchema = MeshcoreAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.meshcore.dmPolicy="open" requires channels.meshcore.allowFrom to include "*"',
  });
});

export const MeshcoreConfigSchema = MeshcoreAccountSchemaBase.extend({
  accounts: z.record(z.string(), MeshcoreAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.meshcore.dmPolicy="open" requires channels.meshcore.allowFrom to include "*"',
  });
});

export const MeshcoreChannelConfigSchema = buildChannelConfigSchema(MeshcoreConfigSchema, {
  uiHints: meshcoreChannelConfigUiHints,
});
