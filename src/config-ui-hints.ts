import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const meshcoreChannelConfigUiHints = {
  "": {
    label: "MeshCore",
    help: "MeshCore mesh channel via Companion TCP protocol (port 5000). Receive-only for groups; direct messages support full two-way communication.",
  },
  transport: {
    label: "MeshCore Transport",
    help: 'Connection mode: "tcp" (Companion TCP protocol, port 5000).',
  },
  host: {
    label: "MeshCore Host",
    help: "Hostname or IP for TCP connection. Optional port suffix (host:5000) is supported.",
  },
  port: {
    label: "MeshCore Port",
    help: "Port for TCP transport (default 5000). Ignored when host includes a port.",
  },
  channels: {
    label: "MeshCore Mesh Channels",
    help: "Mesh channel indices (0-7) to listen for broadcast messages.",
  },
  dmPolicy: {
    label: "MeshCore DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.meshcore.allowFrom=["*"].',
  },
  groupPolicy: {
    label: "MeshCore Group Policy",
    help: 'Broadcast channel access control. "disabled" (default) drops all inbound group messages with a log line. "allowlist" requires channels.meshcore.groups keys such as "channel:0".',
  },
  textChunkLimit: {
    label: "MeshCore Text Chunk Limit",
    help: "Maximum UTF-8 bytes per outbound mesh text message. Values above 127 are clamped to 127 because the node firmware kicks the TCP companion session on oversized frames. Default 127; long replies are split into numbered chunks.",
  },
  chunkNumbering: {
    label: "Chunk Numbering",
    help: "When true (default), multi-chunk DM replies are prefixed with [n/N]. The prefix is budgeted inside the chunk limit so it never pushes a frame over the wire cap. Single-chunk replies are never prefixed.",
  },
  sendPacing: {
    label: "Send Pacing",
    help: "Outbound chunk pacing: delays between multi-chunk sends by the estimated LoRa frame airtime plus a safety margin, so the node can drain its tx queue. Default enabled; single-chunk sends are unaffected.",
  },
  logInboundMessageContent: {
    label: "Log Inbound Message Content",
    help: "When true, Gateway logs include up to 80 characters of inbound mesh text. Default is false (metadata only: sender, target, message id, length).",
  },
  advertLat: {
    label: "Advertised Latitude",
    help: "Override the node's advertised latitude in decimal degrees (-90..90). Both Advertised Latitude and Advertised Longitude must be set to apply; difference must exceed 1e-5° from the node's current position.",
  },
  advertLon: {
    label: "Advertised Longitude",
    help: "Override the node's advertised longitude in decimal degrees (-180..180). Both Advertised Latitude and Advertised Longitude must be set to apply; difference must exceed 1e-5° from the node's current position.",
  },
  groupMonitorMode: {
    label: "Group Monitor Mode",
    help: '"digest" (default) writes admitted group messages to state/meshcore-group-log.jsonl without waking sessions. "session" routes them to agent sessions as before. Groups remain receive-only in both modes.',
  },
  advertOnConnect: {
    label: "Advert on Connect",
    help: "Send one self-advert immediately after the node connects (default: false). Respect shared airtime — see docs/USAGE.md.",
  },
  advertIntervalHours: {
    label: "Advert Interval (hours)",
    help: "Hours between scheduled self-adverts while connected. 0 disables scheduled adverts (default). Values greater than 0 are clamped to a minimum of 1 hour.",
  },
  advertScope: {
    label: "Advert Scope",
    help: '"zero-hop" (default) advertises only to nodes in direct radio range. "flood" advertises mesh-wide and consumes shared airtime on every relay — use sparingly.',
  },
  commandRepliesEnabled: {
    label: "Command Replies",
    help: "When true (default), exact !ping and !status DMs are answered directly by the plugin without waking an agent session. Only senders that pass the DM gate receive replies; groups are always ignored.",
  },
  contactBookMaxEntries: {
    label: "Contact Book Max Entries",
    help: "Maximum number of entries persisted in the advert contact book (default 500, 0=unbounded). When full, the oldest advert-sourced entry is evicted; contact-sync entries are never evicted.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
