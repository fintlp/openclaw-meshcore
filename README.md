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
- `src/monitor.ts` — passive event loop + status sink. NOTE: meshcore.js emits response events by **numeric code** (`Constants.ResponseCodes`: ContactMsgRecv = 7, ChannelMsgRecv = 8, ChannelInfo = 18; the V3 variants 16/17 are normalised into 7/8 by the library). The plugin registers on the numeric codes — only `connected`/`disconnected`/`error`/`rx`/`tx` are string events. A 5 s `getWaitingMessages()` poll drains queued messages alongside push events.
- `src/inbound.ts` — OpenClaw ingress resolver: DM pairing, group policy, envelope building.
- `src/send.ts` — outbound DM sender; group sends are explicitly rejected.
- `src/normalize.ts` — node id / channel target parsing and allowlist normalization.
- `src/policy.ts` — group matching (`channel:0`, wildcard `*`).
- `src/message-adapter.ts` — OpenClaw message adapter exposing text + replyTo.
- `src/config-schema.ts` — Zod schema synced into `openclaw.plugin.json`.

## Library choice: `@liamcottle/meshcore.js`

We use [`@liamcottle/meshcore.js`](https://github.com/liamcottle/meshcore.js) (v1.15.0) for the MeshCore Companion Protocol implementation. It is the reference JavaScript library for the protocol and handles framing, command encoding, and event parsing. Local TypeScript declarations live in `src/meshcore-js.d.ts` so the build stays strict.

### Addressing & the advert contact cache

MeshCore DM frames carry only the sender's 6-byte pubkey **prefix**, but sending a DM requires the full 32-byte pubkey — and many nodes do not answer contact-sync queries. The plugin therefore maintains an advert-driven contact cache: `Advert` (0x80) and `NewAdvert` (0x8A) pushes carry full pubkeys and are cached prefix → full key. The cache is persisted to `~/.openclaw/state/meshcore-advert-contacts.json` (override via `MESHCORE_ADVERT_CACHE_PATH`) so addressability survives gateway restarts. A DM sender becomes reply-addressable after their first advert; until then their messages still arrive, and a failed reply is logged as non-fatal instead of breaking the inbound/pairing flow.

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
      "host": "192.0.2.10",
      "port": 5000,
      "dmPolicy": "pairing",
      "groupPolicy": "disabled"
    }
  }
}
```

You can also set the environment variable `MESHCORE_HOST` for the default account. (`192.0.2.10` above is an RFC 5737 documentation placeholder — use your node's real LAN address.)

## Config reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the channel. |
| `transport` | string | `"tcp"` | Only `"tcp"` is supported. |
| `host` | string | — | Hostname or IP of the MeshCore companion server. Port suffix (`host:5000`) is accepted. |
| `port` | number | `5000` | TCP port. Ignored when `host` includes a port. |
| `dmPolicy` | `"pairing" \| "allowlist" \| "open" \| "disabled"` | `"pairing"` | How direct messages are admitted. `"open"` requires `allowFrom: ["*"]`. |
| `allowFrom` | array of strings/numbers | `[]` | Allowed DM senders: full `!nodeId`, 12-hex prefix, advert name, or `"*"`. |
| `groupPolicy` | `"open" \| "allowlist" \| "disabled"` | `"disabled"` | How group/broadcast messages are admitted. `"open"` = deliver to agents as a read-only monitor (transmission stays locked regardless of policy). |
| `groupAllowFrom` | array of strings/numbers | `[]` | Allowed group senders (same formats as `allowFrom`). |
| `groups` | object | `{}` | Per-group config keyed by `channel:0` … `channel:7` or `"*"`. |
| `channels` | array of 0–7 | `[0]` | Mesh channel indices to listen for broadcasts. |
| `textChunkLimit` | number (40–500) | `133` | Max **UTF-8 bytes** per outbound text chunk (the wire frame limit is byte-based). Chunks split at word boundaries where possible and never inside a multibyte character. |
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
5. **Node contact requirement (firmware).** Current MeshCore node firmware **silently drops DMs from senders that are not in the node's own contact list** — no ACK, no queue, no companion signaling, no error anywhere. Add expected contacts on the node itself (MeshCore app, with the gateway channel temporarily disabled — one companion client at a time) or enable auto-add on the node. First thing to check when "nothing arrives".

## Verification procedure

1. Ensure the MeshCore node is reachable:
   ```bash
   nc -z 192.0.2.10 5000   # replace with your node's address
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

Live verification against a dedicated test node (companion server on TCP 5000):

- **Connected:** TCP established.
- **App-start handshake:** completed.
- **SelfInfo captured:** node pubkey (`!<64 hex chars>`), advert name, type `1`, TX power `22`, radio `869.618 MHz / BW 62500 / SF 8 / CR 8` (EU band example).
- **DeviceInfo / Battery / Contacts / Channels:** unavailable on this node (companion protocol subset).
- **Receive path:** proven live end-to-end (2026-10-01): DMs delivered to agent sessions with replies transmitted (two-way), and public-channel messages delivered for monitoring.

## Known limitations / upstream issues

- **`DeviceInfo` stale parsing.** The dependency returns `firmwareVer` as a signed 8-bit value and parses the remainder as a fixed-length `firmware_build_date` CString; some nodes return variable-length payloads that the library mis-aligns. Firmware/model fields are best-effort.
- **`console.error` socket errors.** The dependency's TCP transport logs socket errors to `console.error` instead of routing them through the gateway logger. Errors are still surfaced via the `disconnected` event and the monitor promise rejection.
- **SignedPlain DM workaround.** `@liamcottle/meshcore.js` v1.15.0 does not skip the 4 signature bytes before `readString()` for `txtType === 2` direct messages. The plugin strips the first 4 bytes of the decoded string before inbound handling, which is correct for valid UTF-8 signature prefixes. A durable fix belongs upstream in the dependency's frame parser.
- **TCP-only framing.** Only the companion protocol over TCP is implemented; BLE and serial transports are not supported.
- **Plugin `logger.info` is filtered from `gateway.log`.** When instrumenting, emit via `console.*` — it is captured raw, without an ISO timestamp, so grep by content, not by time. See branch `debug/rx-logging` for a full event/raw-socket tap example.
- **MeshOS interop.** MeshOS handhelds (tested: 1.3.6) interoperate for adverts and DMs once the sender is in the node's contacts; their auto-add may not populate the node's contact list by itself.
- **No wire-input watchdog.** The dependency rebuilds its read buffer with array spread plus one-byte resync, which is O(n²) under a garbage-byte stream and has no byte cap or frame watchdog. A plugin-side fix would require invasive surgery on the internal `TCPConnection` socket handler; the proper fix is upstream in the dependency's framing loop.

## Limitations & follow-ups

- **Companion protocol subset.** Some nodes do not respond to `DeviceQuery`, `GetBatteryVoltage`, or `GetContacts`; self-info and message events are the reliable baseline.
- **No BLE / serial transport.** Only TCP companion server mode is implemented.
- **No attachment support.** Text and reply threading only.
- **Group replies permanently disabled.** This is by design, not a missing feature.
- **Firmware version reporting** depends on the node answering `DeviceInfo`; when absent, firmware/model fields are `null`.

## License

MIT — see `LICENSE`.
