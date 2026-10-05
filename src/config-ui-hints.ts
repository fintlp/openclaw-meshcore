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
    help: "Maximum UTF-8 bytes per outbound mesh text message (default 127 — node firmware truncates frames at 127 bytes on the wire). Long replies are split into chunks and sent as separate messages.",
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
} satisfies Record<string, ChannelConfigUiHint>;
