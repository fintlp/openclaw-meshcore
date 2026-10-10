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
import type { IdentityBinding, PrefixConsistency, PrefixMatch } from "./identity-binding.js";

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
  /** When true (default), multi-chunk DM replies are prefixed with [n/N]. Single-chunk replies are never prefixed. */
  chunkNumbering?: boolean;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
  sendPacing?: MeshcoreSendPacingConfig;
  /** When true, inbound info logs include up to 80 characters of message text (default: metadata only). */
  logInboundMessageContent?: boolean;
  /** Override the node's advertised latitude, decimal degrees (-90..90). Both advertLat and advertLon must be set to apply. */
  advertLat?: number;
  /** Override the node's advertised longitude, decimal degrees (-180..180). Both advertLat and advertLon must be set to apply. */
  advertLon?: number;
  /** Group/broadcast monitoring mode. "digest" appends admitted group messages to a JSONL log without waking sessions (default). "session" routes them to agent sessions as before. */
  groupMonitorMode?: "digest" | "session";
  /** Send a self-advert immediately after connecting (default: false). */
  advertOnConnect?: boolean;
  /** Hours between scheduled self-adverts while connected. 0 disables scheduled adverts (default). Values >0 are clamped to a minimum of 1 hour. */
  advertIntervalHours?: number;
  /** Self-advert scope: "zero-hop" (direct-range only, default) or "flood" (mesh-wide). */
  advertScope?: "zero-hop" | "flood";
  /** When true (default), the plugin answers exact !ping and !status DMs directly without dispatching an agent session. Only for senders that pass the DM gate. */
  commandRepliesEnabled?: boolean;
  /** Maximum number of entries in the persisted advert contact book (default 500, 0=unbounded). */
  contactBookMaxEntries?: number;
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

export type MeshcoreMessageSecurity = {
  /** MeshCore text type: 0=Plain, 1=CliData, 2=SignedPlain. */
  txtType: number;
  /** True when the message arrived as a SignedPlain (txtType === 2) DM. */
  signedPlain: boolean;
  /** Hex of the 4-byte SignedPlain sender_prefix, when signedPlain is true and not lossy. */
  senderPrefixHex?: string;
  /** True when the SignedPlain prefix region was corrupted by the library's non-fatal decoder. */
  lossy?: boolean;
  /** How the sender_prefix relates to the resolved contact's full pubkey. */
  prefixMatch?: PrefixMatch;
  /** Tracked prefix consistency for the resolved contact (pre-observation window). */
  consistency?: PrefixConsistency;
  /** Identity binding classification for this message. */
  identityBinding: IdentityBinding;
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
  /** Security metadata derived from the wire frame and the contact book. */
  meshSecurity: MeshcoreMessageSecurity;
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
