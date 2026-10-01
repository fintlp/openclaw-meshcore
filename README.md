# openclaw-meshcore

OpenClaw channel plugin for MeshCore LoRa nodes via the Companion Protocol over TCP.

## What it does

This plugin connects OpenClaw to a MeshCore node acting as a companion server on your local network. It supports:

- **Direct messages (DMs):** full two-way chat, with pairing/allowlist/open access control.
- **Group / broadcast channels:** receive-only by design. The plugin can listen to mesh channel traffic and dispatch it to agents, but it will never transmit a reply back to a group.
- **Multi-account:** `channels.meshcore.accounts` lets you define more than one node connection.

## Architecture

```
┌─────────────┐     TCP 5000      ┌─────────────────┐     LoRa     ┌──────────────┐
│   OpenClaw  │ ◄──────────────► │  MeshCore node  │ ◄──────────► │  Mesh peers  │
│  (this plugin)│  Companion Protocol│  (companion server)│            │              │
└─────────────┘                   └─────────────────┘            └──────────────┘
```

Key source files:

- `src/channel.ts` — plugin registration and surface wiring.
- `src/device-client.ts` — TCP connection lifecycle, handshake, contact/channel sync.
- `src/monitor.ts` — passive event loop: `ContactMsgRecv`, `ChannelMsgRecv`, status sink.
- `src/inbound.ts` — OpenClaw ingress resolver: DM pairing, group policy, envelope building.
- `src/send.ts` — outbound DM sender; group sends are explicitly rejected.
- `src/normalize.ts` — node id / channel target parsing and allowlist normalization.
- `src/policy.ts` — group matching (`channel:0`, wildcard `*`).
- `src/message-adapter.ts` — OpenClaw message adapter exposing text + replyTo.
- `src/config-schema.ts` — Zod schema synced into `openclaw.plugin.json`.

## Library choice: `@liamcottle/meshcore.js`

We use [`@liamcottle/meshcore.js`](https://github.com/liamcottle/meshcore.js) (v1.15.0) for the MeshCore Companion Protocol implementation. It is the reference JavaScript library for the protocol and handles framing, command encoding, and event parsing. Local TypeScript declarations live in `src/meshcore-js.d.ts` so the build stays strict.

## Install

```bash
openclaw channels add meshcore
# or, from a checkout:
npm install
npm run build
```

Minimal `channels.meshcore` config:

```json
{
  "channels": {
    "meshcore": {
      "enabled": true,
      "host": "192.168.1.226",
      "port": 5000,
      "dmPolicy": "pairing",
      "groupPolicy": "disabled"
    }
  }
}
```

You can also use the environment variable `MESHCORE_HOST=192.168.1.226` for the default account.

## Config reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the channel. |
| `transport` | string | `"tcp"` | Only `"tcp"` is supported. |
| `host` | string | — | Hostname or IP of the MeshCore companion server. Port suffix (`host:5000`) is accepted. |
| `port` | number | `5000` | TCP port. Ignored when `host` includes a port. |
| `dmPolicy` | `"pairing" \| "allowlist" \| "open" \| "disabled"` | `"pairing"` | How direct messages are admitted. `"open"` requires `allowFrom: ["*"]`. |
| `allowFrom` | array of strings/numbers | `[]` | Allowed DM senders: full `!nodeId`, 12-hex prefix, advert name, or `"*"`. |
| `groupPolicy` | `"open" \| "allowlist" \| "disabled"` | `"disabled"` | How group/broadcast messages are admitted. |
| `groupAllowFrom` | array of strings/numbers | `[]` | Allowed group senders (same formats as `allowFrom`). |
| `groups` | object | `{}` | Per-group config keyed by `channel:0` … `channel:7` or `"*"`. |
| `channels` | array of 0–7 | `[0]` | Mesh channel indices to listen for broadcasts. |
| `textChunkLimit` | number (40–500) | `133` | Max characters per outbound text chunk. |
| `logInboundMessageContent` | boolean | `false` | When `true`, inbound log lines include up to 80 chars of text. |

### Group config (`groups["channel:0"]`)

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether this group is active. |
| `requireMention` | boolean | Only dispatch when the agent is mentioned. |
| `allowFrom` | array | Allowed senders for this specific group. |
| `skills` | array of strings | Skill allowlist for this group. |
| `systemPrompt` | string | Extra system prompt for this group. |
| `tools` / `toolsBySender` | object | Tool policy for the group. |

## Security model

1. **Groups are receive-only.** The plugin will never call `sendCommandSendChannelTxtMsg` or any other group transmit primitive. Attempting to send to `channel:N` or `broadcast` throws `"receive-only"`.
2. **LoRa airtime rule.** Replies are never generated in response to group messages. This is enforced in `monitor.ts` (group `sendReply` is a no-op logger) and in `send.ts` (group targets rejected at the transport layer).
3. **DM access control.** `dmPolicy` defaults to `"pairing"`, which issues a pairing challenge to unknown senders. Use `"allowlist"` with explicit `allowFrom` entries, or `"open"` with `allowFrom: ["*"]` only when you accept unsolicited DMs.
4. **No private-key exposure.** The plugin never requests or exports the node's private key.

## Verification procedure

1. Ensure the MeshCore node is reachable:
   ```bash
   nc -z 192.168.1.226 5000
   ```
2. Build and test:
   ```bash
   npm run typecheck
   npm run test
   npm run build
   ```
3. Run a receive-only handshake against the node:
   ```bash
   node /tmp/meshcore-verify.mjs
   ```
   This connects, performs the app-start handshake (`sendCommandAppStart`), queries `SelfInfo`, optionally queries `DeviceInfo`/`BatteryVoltage`, syncs contacts/channels, and listens for inbound traffic without transmitting.

### Verified node example

Live verification against the dedicated test node `192.168.1.226:5000`:

- **Connected:** TCP established.
- **App-start handshake:** completed.
- **SelfInfo captured:**
  - Pubkey: `!a434065914a39c98c9adb406d6258e230a630a15c7f090bc39d914b8e4ab58bb`
  - Name: `AT-GU-Weinitzen`
  - Type: `1`, TX power: `22`, Radio: `869.618 MHz / BW 62500 / SF 8 / CR 8`
- **DeviceInfo / Battery / Contacts / Channels:** unavailable on this node (companion protocol subset).
- **Receive path:** listener active for 30 s; no traffic received during the window.

## Limitations & follow-ups

- **Companion protocol subset.** Some nodes do not respond to `DeviceQuery`, `GetBatteryVoltage`, or `GetContacts`; self-info and message events are the reliable baseline.
- **No BLE / serial transport.** Only TCP companion server mode is implemented.
- **No attachment support.** Text and reply threading only.
- **Group replies permanently disabled.** This is by design, not a missing feature.
- **Firmware version reporting** depends on the node answering `DeviceInfo`; when absent, firmware/model fields are `null`.

## License

MIT — see `LICENSE`.
