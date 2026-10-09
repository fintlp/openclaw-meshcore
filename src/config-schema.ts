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
    sendPacing: z
      .object({
        enabled: z.boolean().optional().default(true),
        mode: z.enum(["ack", "time"]).optional().default("ack"),
        minDelayMs: z.number().int().min(0).optional().default(200),
        maxDelayMs: z.number().int().min(0).optional().default(5000),
        airtimeMargin: z.number().min(1.0).optional().default(1.25),
        ackTimeoutMs: z.number().int().min(0).optional().default(6000),
        defaultSf: z.number().int().min(6).max(12).optional().default(8),
        defaultBw: z.number().int().min(1).optional().default(62_500),
        defaultCr: z.number().int().min(1).max(8).optional().default(8),
      })
      .optional()
      .default({
        enabled: true,
        mode: "ack",
        minDelayMs: 200,
        maxDelayMs: 5000,
        airtimeMargin: 1.25,
        ackTimeoutMs: 6000,
        defaultSf: 8,
        defaultBw: 62_500,
        defaultCr: 8,
      }),
    advertLat: z.number().min(-90).max(90).optional(),
    advertLon: z.number().min(-180).max(180).optional(),
    groupMonitorMode: z.enum(["digest", "session"]).optional().default("digest"),
    logInboundMessageContent: z.boolean().optional(),
    advertOnConnect: z.boolean().optional().default(false),
    advertIntervalHours: z.number().min(0).optional().default(0).transform((value) => {
      // 0 means disabled; any positive value is clamped to a minimum of 1 hour.
      if (value === 0) return 0;
      return Math.max(1, value);
    }),
    advertScope: z.enum(["zero-hop", "flood"]).optional().default("zero-hop"),
  })
  .strict();

export const MeshcoreAccountSchema = MeshcoreAccountSchemaBase.superRefine((value, ctx) => {
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
