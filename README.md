# openclaw-meshcore

OpenClaw channel plugin for MeshCore LoRa nodes via the Companion Protocol over TCP.

## What it does

This plugin connects OpenClaw to a MeshCore node acting as a companion server on your local network. It supports:

- **Direct messages (DMs):** full two-way chat, with pairing/allowlist/open access control.
- **Group / broadcast channels:** receive-only by design. The plugin can listen to mesh channel traffic and dispatch it to agents, but it will never transmit a reply back to a group.
- **Multi-account:** `channels.meshcore.accounts` lets you define more than one node connection.

## Safety by default: the danger zone and the guardrails

Connecting an AI agent to a LoRa mesh is a little different from connecting it to a conventional chat app. There is no network perimeter on the radio: anyone with an inexpensive LoRa board and a bit of curiosity can send your node a message. And everything transmitted on a public channel is heard by every node in range — there is no edit button and no delete button on the airwaves.

None of this should scare you off. The defaults in this plugin are deliberately cautious, and this section explains both what could go wrong and exactly which guardrails stand between your agent and the crowd. Once you understand these few ideas, you can experiment freely and safely.

### The danger zone: what a stranger could make your agent *do*

The radio itself is not the risky part. The risk begins when a message from an unknown sender is turned into an **agent session** — because that session runs with the agent's normal capabilities: reading files, calling tools, or messaging other channels, depending on how you configured it. Two configuration combinations deserve your respect:

- **`dmPolicy: "open"` together with `allowFrom: ["*"]`** admits every sender as a full DM session. A stranger in radio range can then have a conversation with your agent — and a persuasive stranger can ask your agent to do things on your behalf. Reserve this for demos, and only with an agent whose tools are tightly restricted.
- **`groupPolicy: "open"` with session dispatch enabled and no tool restrictions** lets public-channel traffic start agent sessions. Even then, the agent can never *reply* publicly (see guardrail 1 below) — but a crafted public message could still make the agent act silently in the background: running tools, spawning helpers, or burning tokens.

A true story from this plugin's early days makes the point: during testing, an agent session decided on its own that the helpful thing to do was to launch a configuration helper and modify files — all in good faith, all unnecessary, and all invisible until someone looked. Nothing broke, but the lesson shaped this plugin: **decide what a mesh-reachable session may do before someone else decides for you.**

One privacy note as well: if your node advertises a GPS position, that position is broadcast to every node in range. The `advertLat`/`advertLon` setting lets you choose *which* location you publish — pick one you are comfortable sharing with strangers.

### The guardrails: why the agent cannot speak in public

The most important safety property of this plugin is that **the agent can never transmit to a group channel** — and this does not depend on the AI's behavior, mood, or instructions. It is enforced in three independent layers:

1. **In the code.** The plugin's send path refuses every group-addressed message, unconditionally, no matter what any config file or any agent says. This is covered by automated tests, and removing it would take a deliberate code change.
2. **In the defaults.** Group monitoring starts `disabled`. If you enable it, the default is **digest mode**: public-channel traffic is quietly written to a log file and no agent session is started per message. Your agent can summarize the chatter when *you* ask — it never chimes in on its own.
3. **In your agent's instructions (recommended).** Give your agent a standing rule to never reply on mesh group channels. It is belt and suspenders on top of layer 1 — cheap insurance in case a future code change ever misbehaves.

Why so strict? Because LoRa airtime is a shared commons. Every transmission on a public channel is heard by everyone and occupies the frequency for everyone. A chatty agent would not just embarrass you — it would degrade the mesh for every other user in range. Being a good mesh citizen is part of the design.

### Radio parameters: read-only, on purpose

The node's radio parameters — frequency, bandwidth, spreading factor, coding rate — are the shared "meeting channel" the whole mesh agreed on. If your node changes its own settings, it does not get an error message; it simply stops hearing and being heard, and fixing it means physical access or a maintenance window with the companion app. Frequency choice is also regulated (for example, 869.618 MHz is the EU868 setting used in Austria), which makes it a matter of law rather than taste.

For that reason this plugin only ever **reads** radio parameters — they show up in the node-status snapshot, so your agent can *report* them, but never change them. The one node property you may set remotely is the advertised GPS position (`advertLat`/`advertLon`), because a wrong position is cosmetic and easy to correct. A wrong frequency is neither.

### What this means for your first experiments

Start with the defaults: `dmPolicy: "pairing"`, so every new contact needs your explicit approval, and group monitoring `disabled`. Send yourself a DM from a second device, watch the messages arrive, and get a feel for the pacing. When you grow curious about the public channel, switch on monitoring in digest mode and simply ask your agent what the mesh has been saying. You will learn the ropes without ever risking a public transmission — the code has your back, literally.

For the operator-level detail (trust model, per-group tool policies, hardened examples), see [docs/AGENT-SCOPING.md](docs/AGENT-SCOPING.md).

## Documentation

- [docs/QUICKSTART.md](docs/QUICKSTART.md) — zero to first mesh DM in ~15 minutes.
- [docs/USAGE.md](docs/USAGE.md) — day-2 operation from within OpenClaw: pairing lifecycle, agent-visible node data, group digest monitoring, position admin.
- [docs/NODE-SETUP.md](docs/NODE-SETUP.md) — node preparation and operational behavior (the one-client rule, contact management, GPS adverts).
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — verified firmware/software matrix and interop quirks.
- [docs/AGENT-SCOPING.md](docs/AGENT-SCOPING.md) — what a mesh-reachable agent can do, and how to bound it.
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — releasing this plugin to ClawHub: metadata contract, the entrypoint trap, and the release flow.

The full config reference lives below in this README.

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

### Addressing & the contact book

MeshCore DM frames carry only the sender's 6-byte pubkey **prefix**, but sending a DM requires the full 32-byte pubkey — and many nodes do not answer contact-sync queries. The plugin therefore maintains an advert-driven contact book: `Advert` (0x80) and `NewAdvert` (0x8A) pushes carry full pubkeys and are cached prefix → full key. The contact book is persisted to `~/.openclaw/state/meshcore-advert-contacts.json` (override via `MESHCORE_ADVERT_CACHE_PATH`) so addressability survives gateway restarts. A DM sender becomes reply-addressable after their first advert; until then their messages still arrive, and a failed reply is logged as non-fatal instead of breaking the inbound/pairing flow.

Issue #11 extended the cache from a bare pubkey list into a full contact book. `NewAdvert` (0x8A) pushes are parsed by `@liamcottle/meshcore.js` and the following fields are stored per contact:

- `publicKey` — 32-byte full public key (used to resolve the 6-byte/12-hex DM prefix).
- `type` — advert type byte.
- `flags` — advert flags byte.
- `outPathLen` — signed 8-bit outbound path length.
- `outPath` — 64-byte outbound path.
- `advName` — advertised name (32-byte CString from the frame).
- `lastAdvert` — `UInt32LE` seconds-since-epoch of the last advert.
- `advLat` — `Int32LE` advertisement latitude (raw fixed-point value).
- `advLon` — `Int32LE` advertisement longitude (raw fixed-point value).
- `lastMod` — `UInt32LE` contact last-modified timestamp.

The local node's own `SelfInfo` is also captured (name, `advLat`, `advLon`) so the contact book includes the gateway node itself; fields that do not exist in `SelfInfo` (`type`, `flags`, `outPath`, `lastAdvert`, `lastMod`) are stored as zero.

#### Persistence format

The file is schema-versioned:

- **v1** was a plain array `[{ publicKeyHex, name? }, ...]`. v1 files still load cleanly; missing fields are defaulted to zero/empty and the file is rewritten as v2 on the next advert or SelfInfo.
- **v2** is an object `{ version: 2, contacts: [...] }` containing every field listed above. `outPath` is hex-encoded in the JSON file.

#### Group monitoring digest mode

By default (`groupMonitorMode: "digest"`), the plugin does **not** wake an agent session for every group/broadcast message. Instead, admitted group messages are appended as JSON lines to `~/.openclaw/state/meshcore-group-log.jsonl`:

```json
{"ts":"2026-10-05T09:00:00.000Z","channel":"channel:0","senderPubkeyPrefix":"aabbccdd1122","name":"TestNode","text":"hello mesh"}
```

- The log is rotated at approximately 1000 lines, keeping the newest entries.
- The never-transmit-to-groups rule is unchanged; digest mode only changes inbound routing.
- **Privacy:** the digest stores the **full text** of admitted group messages, on disk, in plain JSON. This is more content than the gateway log keeps when `logInboundMessageContent` is disabled — treat the file as sensitive.
- **Upgrading?** Digest is the default for every deployment, including existing ones. If you relied on group messages reaching agent sessions, set `groupMonitorMode: "session"` explicitly after upgrading.
- Use `"session"` mode to restore the previous behavior of routing each admitted group message to an agent session.

#### Latitude / longitude scaling

The raw `advLat`/`advLon` values are stored as-is. Per the MeshCore Companion Protocol documentation, the wire values are 32-bit little-endian fixed-point coordinates scaled by `1e6` (i.e. `degrees = raw / 1e6`). The persisted v2 contact book also includes `lat` and `lon` in decimal degrees so consumers can read coordinates without doing the fixed-point conversion (issue #12). See [MeshCore Companion Protocol — Device Config](https://docs.meshcore.io/companion_protocol/) (issue #11).

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

> To add or change a config field, see [`CONTRIBUTING.md`](CONTRIBUTING.md) —
> the manifest is generated from a single canonical JSON Schema.

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
| `textChunkLimit` | number (40–500) | `127` | Max **UTF-8 bytes** per outbound text chunk (the wire frame limit is byte-based). Chunks split at word boundaries where possible and never inside a multibyte character. Default 127 matches the observed wire cap — see Known Limitations. |
| `sendPacing` | object | see below | Outbound airtime pacing for multi-chunk sends. |
| `logInboundMessageContent` | boolean | `false` | When `true`, inbound log lines include up to 80 chars of text. |
| `advertLat` | number (-90..90) | — | Override the node's advertised latitude. Requires `advertLon` and a difference >1e-5° from current position. |
| `advertLon` | number (-180..180) | — | Override the node's advertised longitude. Requires `advertLat` and a difference >1e-5° from current position. |
| `groupMonitorMode` | `"digest" \| "session"` | `"digest"` | Group/broadcast monitoring mode. `"digest"` writes admitted group messages to `state/meshcore-group-log.jsonl` without waking sessions; `"session"` routes them to agent sessions. Groups remain receive-only in both modes. |
| `advertOnConnect` | boolean | `false` | Send one self-advert immediately after the node connects. |
| `advertIntervalHours` | number ≥ 0 | `0` | Hours between scheduled self-adverts while connected. `0` disables scheduled adverts. Values > 0 are clamped to a minimum of 1 hour. |
| `advertScope` | `"zero-hop" \| "flood"` | `"zero-hop"` | Self-advert scope. `"zero-hop"` reaches only direct-range neighbours; `"flood"` propagates mesh-wide and consumes shared airtime on every relay. |

#### `sendPacing`

Long replies are split into multiple MeshCore text messages. Sending them back-to-back can saturate the node tx queue and drop tail frames (issue #10). Pacing serializes multi-frame sequences by awaiting node SendConfirmed pushes (ACK mode, default) or estimating LoRa airtime (time mode). Single-chunk sends are never delayed.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable inter-chunk pacing. |
| `mode` | string (`"ack"` \| `"time"`) | `"ack"` | Pacing mode: `"ack"` awaits node `SendConfirmed` (0x82) push before sending next frame (with timeout fallback to airtime); `"time"` delays solely by estimated LoRa airtime. |
| `minDelayMs` | number | `200` | Minimum delay between chunks, even if the airtime estimate is smaller. |
| `maxDelayMs` | number | `5000` | Maximum delay between chunks, even if the airtime estimate is larger. |
| `airtimeMargin` | number ≥ 1.0 | `1.25` | Multiplier applied to the raw LoRa airtime estimate. |
| `ackTimeoutMs` | number | `6000` | In `"ack"` mode, maximum milliseconds to await `SendConfirmed` before falling back to airtime pacing. |
| `defaultSf` | integer 6–12 | `8` | Fallback spreading factor when the node does not report live radio params. |
| `defaultBw` | integer (Hz) | `62500` | Fallback bandwidth when live radio params are unavailable. |
| `defaultCr` | integer | `8` | Fallback coding-rate denominator (5–8) when live radio params are unavailable. MeshCore stores CR as the denominator (`8` = 4/8). |

**How pacing works (design).** In `"ack"` mode (default), each frame of a multi-frame sequence awaits the node's `SendConfirmed` push (opcode `0x82`) before the next frame is sent. Matching is **per-frame**: the tag returned by the send call is compared against the incoming `ackCode`; a confirm that matches no pending frame is dropped, never credited to another frame (fail-closed). If no confirm arrives within `ackTimeoutMs`, pacing falls back to the time-based estimate (`airtime × airtimeMargin`, clamped to `[minDelayMs, maxDelayMs]`). Frames whose send resolved without a tag skip the ack wait and take the time-based floor.

This design came out of issue #10, where the node's tx path waits on the over-the-air ACK before draining its queue: measured ACK round-trips at 869.618 MHz / SF8 / BW 62.5 kHz are **1.3–3.1 s**, far above the LoRa airtime alone (~1.2 s per 127-byte frame). An airtime-only gap of ~1.45 s therefore enqueued frame 3 while the node still held frames 1–2 awaiting ACK — the tail frame was silently dropped (reproduced twice). With per-frame ACK-gated pacing the same 300-byte payload (3 frames) delivers completely.

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

### Pairing: what an unknown sender can and cannot do

With the default `dmPolicy: "pairing"`, a DM from an unknown node produces exactly one thing: a pairing request plus a single reply containing a one-time code and the `openclaw pairing approve` command. The message itself is dropped before it can start an agent session. The code is only meaningful to the **gateway owner** — approval runs on the gateway (CLI or an owner-authorized chat), so a stranger who receives the instructions cannot self-approve, cannot reach an agent, and cannot make the gateway spend a single model token.

Flood resistance is structural, and verified against the OpenClaw pairing store (2026.9.x):

- **Same sender, repeated DMs:** the challenge is create-if-missing. Once a request is pending for a node id, further DMs from that node get **no reply at all** — no extra airtime, no store growth.
- **Many unique fake nodes:** pending requests are **hard-capped at 3 per account** — and the cap bites *before* any reply is sent: the 4th distinct fake node gets no pending entry and **zero reply frames**. Expired requests are pruned automatically. Total worst-case cost of a flood attempt: 3 junk entries and 3 LoRa reply frames, ever.
- **Radio reality:** EU868 duty-cycle regulation throttles how fast anyone can transmit, and a genuine flood degrades the shared channel for every node in range — which is itself illegal. The gateway-side cost stays capped regardless.
- **Silent mode:** if unsolicited contact attempts ever become a nuisance, `dmPolicy: "allowlist"` drops unknown senders without any reply — not even the pairing challenge.

Encryption note: MeshCore DMs are encrypted to the recipient's node key, so message content is protected on the air. **Adverts are not** — your node's name and advertised GPS position are broadcast in plaintext to every node in range. Choose `advertLat`/`advertLon` accordingly.

**Residual risk — sender identity on the wire.** Inbound DM frames carry only a 6-byte pubkey prefix in their header. The plugin resolves that prefix to a full key via the advert cache, and `allowFrom` admission happens on the resolved identity. MeshCore DMs are encrypted to the recipient's node key, so message content is protected on the air, but **adverts are not** — your node's name and advertised GPS position are broadcast in plaintext to every node in range.

For SignedPlain messages (`txtType === 2`), the encrypted payload begins with a 4-byte `sender_prefix` followed by the UTF-8 text. Only those 4 signature bytes are available on the companion side; full Ed25519 DM verification is impossible from the plugin (the firmware verifies advert signatures at admission, but the companion protocol never forwards signature material). The plugin therefore classifies each SignedPlain prefix:

- `meshSecurity.prefixMatch` — whether the 4-byte prefix equals the first 4 bytes of the resolved contact's pubkey (`pubkey-first4`), the last 4 bytes (`pubkey-last4`), neither (`none`), or could not be classified (`unresolved`).
- `meshSecurity.identityBinding` — `extended` when the prefix is `pubkey-last4` or when the contact has used the same unknown prefix in at least 3 consecutive SignedPlain observations; `mismatch` when a previously consistent prefix is contradicted; otherwise `prefix-only`.

A header prefix collision still admits an attacker *as* the contact, so treat mesh DM identity as convenience-grade, not cryptographic. The binding fields give you observability, not a cryptographic guarantee. If a contact ever starts behaving strangely, re-verify out-of-band.

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

- **Text frame wire cap: 127 bytes.** Observed on node fw 1.16 (issue #5, root-caused with a position-encoded payload test): text frames are truncated at 127 bytes on the wire. The default `textChunkLimit` is therefore 127 — raising it re-introduces silent tail loss (~6 bytes per chunk) at every message join.
- **`DeviceInfo` stale parsing.** The dependency returns `firmwareVer` as a signed 8-bit value and parses the remainder as a fixed-length `firmware_build_date` CString; some nodes return variable-length payloads that the library mis-aligns. Firmware/model fields are best-effort.
- **`console.error` socket errors.** The dependency's TCP transport logs socket errors to `console.error` instead of routing them through the gateway logger. Errors are still surfaced via the `disconnected` event and the monitor promise rejection.
- **SignedPlain DM parsing.** `@liamcottle/meshcore.js` v1.15.0 does not skip the 4-byte `sender_prefix` before `readString()` for `txtType === 2` direct messages. The plugin parses the decoded string, strips the prefix, and captures its hex value in `meshSecurity.senderPrefixHex`. If the prefix bytes are not valid UTF-8 (common for random byte values ≥ 0x80), the library's non-fatal TextDecoder replaces them with `U+FFFD`; the parser detects this, marks the result as `lossy` internally, and classifies the prefix as `unresolved`. Clean UTF-8 prefixes are parsed byte-identically to the previous strip behavior.
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
