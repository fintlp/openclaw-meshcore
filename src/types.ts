import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { BaseProbeResult } from "openclaw/plugin-sdk/core";

export type MeshcoreGroupConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type MeshcoreSendPacingConfig = {
  enabled?: boolean;
  mode?: "ack" | "time";
  minDelayMs?: number;
  maxDelayMs?: number;
  airtimeMargin?: number;
  ackTimeoutMs?: number;
  defaultSf?: number;
  defaultBw?: number;
  defaultCr?: number;
};

export type MeshcoreAccountConfig = {
  name?: string;
  enabled?: boolean;
  transport?: "tcp";
  host?: string;
  port?: number;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, MeshcoreGroupConfig>;
  channels?: number[];
  mentionPatterns?: string[];
  markdown?: MarkdownConfig;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
  sendPacing?: MeshcoreSendPacingConfig;
  /** When true, inbound info logs include up to 80 characters of message text (default: metadata only). */
  logInboundMessageContent?: boolean;
};

type MeshcoreConfig = MeshcoreAccountConfig & {
  accounts?: Record<string, MeshcoreAccountConfig>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    meshcore?: MeshcoreConfig;
  };
};

/** Inbound message emitted by the MeshCore monitor. */
export type MeshcoreInboundMessage = {
  messageId: string;
  /** Conversation peer: full/pubkey-prefixed node id for DMs, channel:N for groups. */
  target: string;
  /** Full public key hex when known from contacts; otherwise the 6-byte prefix. */
  senderNodeId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  meshChannel: number;
  replyToId?: string;
  snr?: number;
};

export type MeshcoreSelfInfo = {
  type: number;
  txPower: number;
  maxTxPower: number;
  publicKey: Uint8Array;
  advLat: number;
  advLon: number;
  reserved: Uint8Array;
  manualAddContacts: number;
  radioFreq: number;
  radioBw: number;
  radioSf: number;
  radioCr: number;
  name: string;
};

export type MeshcoreDeviceInfo = {
  firmwareVer: number;
  reserved: Uint8Array;
  firmware_build_date: string;
  manufacturerModel: string;
};

export type MeshcoreContact = {
  publicKey: Uint8Array;
  type: number;
  flags: number;
  outPathLen: number;
  outPath: Uint8Array;
  advName: string;
  lastAdvert: number;
  advLat: number;
  advLon: number;
  lastMod: number;
};

export type MeshcoreProbe = BaseProbeResult<string> & {
  transport: "tcp";
  host: string;
  port: number;
  latencyMs?: number;
  selfInfo?: {
    nodeId: string;
    longName: string;
    shortName?: string;
    firmwareVersion: string;
    hardwareModel: string;
    batteryMv?: number;
  };
};

export type { MeshcoreConfig };
