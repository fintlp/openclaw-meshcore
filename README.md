<p align="center">
  <img src="assets/icon.png" alt="openclaw-meshcore" width="128">
</p>

# openclaw-meshcore

**An AI agent on your mesh.** This plugin connects your [OpenClaw](https://docs.openclaw.ai) gateway to a MeshCore LoRa node and puts your agent on the radio: reachable by direct message from any node in range, with no internet anywhere in the loop.

## What you can do with it

- **Off-grid messaging assistant.** Your agent — the same one that knows your notes, your calendar, your home automation — answering DMs from a €25 LoRa handheld with zero internet in the path. Mesh in, answers out.
- **Emergency / backup channel.** When the internet dies, the mesh doesn't. A node in the attic keeps your agent reachable when everything else is dark.
- **Repeater-site and unattended-node monitor.** Put a node somewhere remote and ask it how it's doing — battery and radio state where the node answers, plus the mesh traffic it has heard.
- **Field-expedition comms hub.** A gateway at base camp, handhelds in the field. Everyone DMs the hub; the hub answers in DM — weather, schedules, "where is everybody."
- **Node map on demand.** Ask "show me the mesh" on WhatsApp or Telegram and get a link that opens a map of every station your gateway has heard, coloured by type. Zero airtime: the agent reads its state files and geojson.io draws the map in your browser.
- **Festival / mesh-community bot.** A pairing-gated assistant on your event's mesh. New contacts get a pairing challenge, you approve the ones you know, and the bot never spams the public channel — it can't, see below.

One thing shapes all of these: **the agent listens on group channels but never speaks on them.** Receive-only is enforced in the code, not in the AI's instructions, and everything two-way happens in DMs. That is deliberate, and it is what makes this plugin a good mesh citizen — the full story is in the safety section below, and honestly, it is worth the read.

### A circuit breaker for every agent session

**A runaway AI session cannot take your radio network down.** Every send passes through two circuit breakers: a per-session limit that stops one looping or compromised agent session before it can drain the shared allowance, and the existing account-wide backstop. An over-limit send is refused before radio I/O and logged with a retry delay—never queued to flood the mesh later. It is enabled by default, needs no extra service or setup, and does not change Telegram or any other channel. See [The flood guard](#the-flood-guard-the-agent-cannot-shout-in-dms-either) for the exact limits and the small print, including which older-host sends remain account-only and why plugin auto-replies are still covered.

## From a shrink-wrapped board to your first DM in ~15 minutes

The whole path is shorter than most people's first LoRa evening:

1. **Get a board.** A Heltec WiFi LoRa 32 (V3 or V4, ~€20–30) is the verified path; any ESP32 board with a MeshCore companion build works.
2. **Flash the MeshCore companion firmware with WiFi** — the build that speaks the Companion Protocol over TCP (port 5000). Set your region's band, name your node, put it on your LAN.
3. **Install the plugin and run the guided setup:** `openclaw plugins install clawhub:@fintlp/openclaw-meshcore` then `openclaw onboard` (choose MeshCore). The wizard **probes the node before writing anything** — with targeted fixes for the classic traps, including the one-client busy slot — and reads the node's identity (name, hardware, firmware, battery) as proof. Prefer one-liners? `openclaw channels add meshcore --host <node-ip>` works too (`--dm-policy pairing|allowlist|open|disabled` also available). Keep the defaults (`dmPolicy: "pairing"`, groups receive-only). `openclaw plugins inspect` will show Trust `provenance-invalid` for community ClawHub plugins — that is expected, not a fault (details in [docs/PUBLISHING.md](docs/PUBLISHING.md)).
4. **Send yourself a DM** from a second device — a handheld, or a phone app paired to another node. Watch your agent answer. Over LoRa.

Two gotchas cost real evenings, so they live at the top of the quickstart instead of the bottom: the node serves **one companion client at a time** (do node admin with the gateway channel disabled — the wizard's probe will fight the phone app for the slot, so disconnect it first), and current firmware **silently drops DMs from senders not in the node's contact list** (enable auto-add, or add your peer on the node itself). Five minutes of reading saves the evening: [docs/QUICKSTART.md](docs/QUICKSTART.md).

## What it does, in one breath

This plugin connects OpenClaw to a MeshCore node acting as a companion server on your local network. It supports:

- **Direct messages (DMs):** full two-way chat, with pairing/allowlist/open access control.
- **Group / broadcast channels:** receive-only by design. The plugin can listen to mesh channel traffic and dispatch it to agents, but it will never transmit a reply back to a group.
- **Multi-account:** `channels.meshcore.accounts` lets you define more than one node connection.

## Safety by default: the danger zone and the guardrails

Connecting an AI agent to a LoRa mesh is a little different from connecting it to a conventional chat app. There is no network perimeter on the radio: anyone with an inexpensive LoRa board and a bit of curiosity can send your node a message. And everything transmitted on a public channel is heard by every node in range — there is no edit button and no delete button on the airwaves.

None of this should scare you off. The defaults in this plugin are deliberately cautious, and this section explains both what could go wrong and exactly which guardrails stand between your agent and the crowd. Once you understand these few ideas, you can experiment freely and safely.

### The danger zone: what a stranger could make your agent *do*

The radio itself is not the risky part. The risk begins when a message from an unknown sender is turned into an **agent session** — because that session runs with the agent's normal capabilities: reading files, calling tools, or messaging other channels, depending on how you configured it. Two configuration combinations deserve your respect:

- **`dmPolicy: "open"` together with `allowFrom: ["*"]`** admits every uniquely addressable sender as a full DM session. A stranger in radio range can then have a conversation with your agent — and a persuasive stranger can ask your agent to do things on your behalf. Reserve this for demos, and only with an agent whose tools are tightly restricted. The wildcard grants chat access only, never owner or command authority.
- **`groupPolicy: "open"` with session dispatch enabled and no tool restrictions** lets public-channel traffic start agent sessions. Even then, the agent can never *reply* publicly (see guardrail 1 below) — but a crafted public message could still make the agent act silently in the background: running tools, spawning helpers, or burning tokens.

A true story from this plugin's early days makes the point: during testing, an agent session decided on its own that the helpful thing to do was to launch a configuration helper and modify files — all in good faith, all unnecessary, and all invisible until someone looked. Nothing broke, but the lesson shaped this plugin: **decide what a mesh-reachable session may do before someone else decides for you.**

One privacy note as well: if your node advertises a GPS position, that position is broadcast to every node in range. The `advertLat`/`advertLon` setting lets you choose *which* location you publish — pick one you are comfortable sharing with strangers.

### The guardrails: why the agent cannot speak in public

The most important safety property of this plugin is that **the agent can never transmit to a group channel** — and this does not depend on the AI's behavior, mood, or instructions. It is enforced in three independent layers:

1. **In the code.** The plugin's send path refuses every group-addressed message, unconditionally, no matter what any config file or any agent says. This is covered by automated tests, and removing it would take a deliberate code change.
2. **In the defaults.** Group monitoring is **opt-in** and starts `disabled` — no group traffic is admitted or recorded at all. If you deliberately enable it, the default is **digest mode**: public-channel traffic is quietly written to a log file and no agent session is started per message. Your agent can summarize the chatter when *you* ask — it never chimes in on its own.
3. **In your agent's instructions (recommended).** Give your agent a standing rule to never reply on mesh group channels. It is belt and suspenders on top of layer 1 — cheap insurance in case a future code change ever misbehaves.

Why so strict? Because LoRa airtime is a shared commons. Every transmission on a public channel is heard by everyone and occupies the frequency for everyone. A chatty agent would not just embarrass you — it would degrade the mesh for every other user in range. Being a good mesh citizen is part of the design.

> **Sibling-plugin note:** this never-transmit rule is specific to MeshCore. The Meshtastic plugin can transmit to channels when you enable its `groupTransmit` setting, so this rule and these defaults do not carry over to that plugin.

### The flood guard: the agent cannot shout in DMs either

Even in direct messages, airtime is shared — so a second code-level rail caps how much the agent may transmit at all. Outbound sends are budgeted in airtime packets per rolling window (**20 packets per 10 minutes** by default), and the send path refuses a message when the budget is exhausted — before the first frame goes on air, with a retry-after hint in the error. A message is always sent whole or refused whole, never partially aired. Tune normal DM traffic via `sendRateLimit` (`maxSends`, `windowMs`, or `enabled: false` to disable the general limiter) — but think twice before raising it: this limit exists for the mesh, not for you. The optional delivery retry (`sendRetry`, below) spends from this same budget: every retransmission is an airtime purchase, accounted like any other.

A separate **per-producing-session low-level guard** stops one runaway conversation before it can consume the whole account budget. `sessionSendRateLimit` defaults to **10 radio packets and 1270 trimmed UTF-8 text bytes per producing session per 10 minutes**. Enforcement runs synchronously after final production chunking (including `textChunkLimit`, `chunkNumbering` and `outboundSignedPlain`) and before device connect or the old account guard, using the resolved account and host-producing `sessionKey` — never the target or text as identity. Fanout from one producing session therefore shares one budget; in particular, `dmScope: "main"` can make this a tighter shared DM cap across otherwise separate DM conversations. Named accounts inherit the top-level object, and explicit partial account overrides deep-merge field-by-field; only an account-level `enabled: true` deliberately re-enables a top-level opt-out. Accepted sends are charged at admission with no refund after later delivery failure. Excess throws a typed `SendRateLimitExceededError` subtype with `retryAfterMs` and emits one metadata-only plugin warning (the host `onError` may additionally log that typed failure); nothing is queued, so refusal deliberately replaces the original queue/backpressure request. A single send over the packet/byte cap must be split or tuned because waiting alone will not admit it. Pairing/native replies stay exempt. Delivery retries spend the **account** budget per attempt while the session layer charges the admitted send once. Missing, empty, or whitespace-only keys are account-only. On **2026.10.5**, host-driven adapter sends without a producing key are account-only too, but plugin auto-replies still carry the route key and remain session-limited. `sessionSendRateLimit.enabled: false` disables only this layer. The plugin registers **zero `message_sending` or `reply_payload_sending` hooks**, so Telegram preview gates and legacy auto-reply cancellation are untouched.

Pairing has its own size-aware packet partition: at most **min(3 × challengePackets, maxSends − 1)** chunks plus retries per accounting window, preserving at least one packet for normal DMs. The real stock challenge is three chunks, so the default partition is **9 packets** and three new challenges are realizable without retries. This ceiling remains even with `sendRateLimit.enabled: false`. The real three-chunk challenge is rejected at intake for `maxSends` 1–3; `maxSends: 4` fits one no-retry challenge. General pacing, airtime accounting, and multi-account radio sharing are unchanged. Explicitly authorized native `!ping` replies have a separate **3 replies per 10 minutes per account** budget.

### Radio parameters: read-only, on purpose

The node's radio parameters — frequency, bandwidth, spreading factor, coding rate — are the shared "meeting channel" the whole mesh agreed on. If your node changes its own settings, it does not get an error message; it simply stops hearing and being heard, and fixing it means physical access or a maintenance window with the companion app. Frequency choice is also regulated (for example, 869.618 MHz is the EU868 setting used in Austria), which makes it a matter of law rather than taste.

For that reason this plugin only ever **reads** radio parameters — they show up in the node-status snapshot, so your agent can *report* them, but never change them. The one node property you may set remotely is the advertised GPS position (`advertLat`/`advertLon`), because a wrong position is cosmetic and easy to correct. A wrong frequency is neither.

### What this means for your first experiments

Start with the defaults: `dmPolicy: "pairing"`, so every new contact needs your explicit approval, and group monitoring `disabled` — nothing is listened to, nothing is recorded. Send yourself a DM from a second device, watch the messages arrive, and get a feel for the pacing. When you grow curious about the public channel, switch on monitoring in digest mode and simply ask your agent what the mesh has been saying. You will learn the ropes without ever risking a public transmission — the code has your back, literally.

For the operator-level detail (trust model, per-group tool policies, hardened examples), see [docs/AGENT-SCOPING.md](docs/AGENT-SCOPING.md).

## Documentation

- [docs/QUICKSTART.md](docs/QUICKSTART.md) — zero to first mesh DM in ~15 minutes.
- [docs/USE-CASES.md](docs/USE-CASES.md) — the recipe catalog: seven ways to use a mesh-reachable agent, with the config for each.
- [docs/USAGE.md](docs/USAGE.md) — day-2 operation from within OpenClaw: pairing lifecycle, agent-visible node data, group digest monitoring, position admin.
- [docs/NODE-SETUP.md](docs/NODE-SETUP.md) — node preparation and operational behavior (the one-client rule, contact management, GPS adverts).
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — verified firmware/software matrix and interop quirks.
- [docs/AGENT-SCOPING.md](docs/AGENT-SCOPING.md) — what a mesh-reachable agent can do, and how to bound it.
- [docs/MIGRATION.md](docs/MIGRATION.md) — required operator steps for the PR 2 DM approval, replay, command, owner-route, and pairing-budget changes.
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — releasing this plugin to ClawHub: metadata contract, the entrypoint trap, and the release flow.

**Sibling:** running Meshtastic hardware instead of MeshCore? Same agent, other mesh — [openclaw-meshtastic](https://github.com/fintlp/openclaw-meshtastic) (`openclaw plugins install clawhub:@fintlp/openclaw-meshtastic`).

The full config reference lives below in this README.

## Compatibility & maintenance policy

OpenClaw core ships often, and its plugin SDK evolves with it. This plugin is maintained against that reality under an explicit policy, so you can rely on it long-term:

- **Tracked surface.** The plugin builds exclusively against the public `openclaw/plugin-sdk/*` subpath exports — no deep imports into OpenClaw internals. The exact set is auditable at any time:
  ```bash
  grep -rhoE "openclaw/plugin-sdk[a-z/-]*" src/ *.ts | sort -u
  ```
  Today it spans ~30 subpaths covering the channel lifecycle (inbound, outbound, pairing, setup, status), account & config contracts, routing, and runtime helpers.
- **Deprecation response.** When OpenClaw announces the retirement of an SDK surface we use, we migrate off it **before the removal date** and record the migration in the [changelog](CHANGELOG.md). Precedent: the `plugin-sdk/inbound-envelope` module was deprecated with a removal window ending 2026-12-31 — the plugin migrated to the modern explicit sequence in **v2026.10.7** (issue #43), ahead of the deadline, with golden-format tests pinning the agent-visible message format so the migration could not silently change behavior. OpenClaw 2026.10.5 removed the `runStoppablePassiveMonitor` helper from `extension-shared` — the plugin migrated to `runPassiveAccountLifecycle` (`channel-outbound`) in **v2026.10.13**, the same day.
- **Stable-tracking releases.** Plugin releases track OpenClaw **stable**. SDK surfaces that exist only in beta releases are adopted only after they reach stable (decision recorded 2026-10-18: the Async inbound-envelope APIs shipping in 2026.10.10-beta.1 land here with the first stable that carries them — not before). We don't run beta hosts on the production path, and we don't ship plugin releases that require them.
- **Host support window.** The declared floor is **OpenClaw ≥ 2026.10.5** (enforced via `peerDependencies` and the install manifest). Raised from ≥ 2026.5.26 to ≥ 2026.10.1 in v2026.10.13 (the replacement lifecycle API does not exist on 2026.5.26), and from ≥ 2026.10.1 to ≥ 2026.10.5 in **v2026.10.14**: that release migrated the inbound envelope to the Async session-envelope APIs (`resolveInboundSessionEnvelopeContextAsync` / `createChannelInboundEnvelopeBuilderAsync`), which exist only from 2026.10.5 — the sync predecessors retire 2026-12-31 and are removed in the first January 2027 stable. When the floor moves, it follows the oldest stable still inside its compatibility window, ships in a minor release, and gets a changelog callout — never silently in a patch.
- **Load-path installs.** If the plugin runs from a copy under `~/.openclaw/plugins/`, its `node_modules/openclaw` must resolve to the host install via the **stable global link** (`~/Library/pnpm/global/5/node_modules/openclaw` on a pnpm-global setup) — never a real copy and never the versioned `.pnpm/openclaw@x.y.z` directory, which host upgrades delete (a deleted versioned dir took this plugin down once). Registry installs manage this themselves.
- **Where you see breakage first.** Verified host/plugin combinations live in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md); known incompatibilities are filed on the [issues page](https://github.com/fintlp/openclaw-meshcore/issues); the ClawHub page reflects the current state of this README.

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
- `src/inbound.ts` — inbound orchestrator: wires the pipeline steps together (admission → commands → durability → dispatch) and owns every side effect.
- `src/inbound-decisions.ts` — pure policy & routing decisions (DM identity admission, group access, drop classification, main-scope refusal). No side effects.
- `src/inbound-commands.ts` — native command parsing, authorization, and execution (`!ping`, `!status`, repeater ops); reply delivery and durability steps are injected by the orchestrator.
- `src/inbound-durability.ts` — durable intake/claim, duplicate detection, replay dead-letters, finalize/release. Deliberately thin; see issue #51 for the possible host-queue successor.
- `src/send.ts` — outbound DM sender; group sends are explicitly rejected.
- `src/normalize.ts` — node id / channel target parsing and allowlist normalization.
- `src/policy.ts` — group matching (`channel:0`, wildcard `*`).
- `src/message-adapter.ts` — OpenClaw message adapter exposing text + replyTo.
- `src/config-schema.ts` — Zod schema synced into `openclaw.plugin.json`.

## Library choice: `@liamcottle/meshcore.js`

We use [`@liamcottle/meshcore.js`](https://github.com/liamcottle/meshcore.js) (v1.15.0) for the MeshCore Companion Protocol implementation. It is the reference JavaScript library for the protocol and handles framing, command encoding, and event parsing. Local TypeScript declarations live in `src/meshcore-js.d.ts` so the build stays strict.

### Addressing & the contact book

MeshCore DM frames carry only the sender's 6-byte pubkey **prefix**, but sending a DM requires the full 32-byte pubkey. Inbound attribution therefore requires exactly six valid wire bytes and a unique match in the **receiving account's live synchronized contacts**. Candidates must have full 32-byte keys; duplicate records for the same key are deduplicated. Multiple live keys, or a conflicting same-prefix key in that account's contact book, are ambiguous and refused. Rows from other accounts never participate. A cache-only match cannot establish inbound identity.

For an unresolved or ambiguous initial snapshot, the plugin makes one bounded, account-coalesced contact refresh and re-decides once. It does not keep retrying until some attacker-controlled answer fits. The selected full key is used for the canonical route, security facts, and reply target. Detected identity `mismatch` is refused; `prefix-only` and `extended` grades are diagnostics, never authority.

The advert-driven contact book still persists address metadata: `Advert` (0x80) and `NewAdvert` (0x8A) pushes carry full pubkeys and are cached prefix → full key. The contact book is persisted to `~/.openclaw/state/meshcore-advert-contacts.json` (override via `MESHCORE_ADVERT_CACHE_PATH`) so addressability survives gateway restarts. Outbound exact full-key targets remain usable without a lookup. Abbreviated outbound targets must resolve uniquely within the account and are rejected when unresolved, ambiguous, or conflicting; use the canonical full key to remove that ambiguity.

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

#### Group monitoring (opt-in, digest by default)

Group monitoring is **opt-in**: the default `groupPolicy: "disabled"` drops every group/broadcast message with a log line, and nothing is recorded. When you deliberately enable monitoring, `groupPolicy` decides *what is admitted* and `groupMonitorMode` decides *what happens to it*:

- `groupPolicy: "disabled"` (default) — drop all group traffic with a log line.
- `groupPolicy: "allowlist"` — admit only the groups listed under `groups` (for example `groups: { "channel:0": {} }`).
- `groupPolicy: "open"` — admit every broadcast channel the node hears. The gateway logs a startup warning recommending `"allowlist"`; for receive-only digest monitoring that warning is expected (see [docs/AGENT-SCOPING.md](docs/AGENT-SCOPING.md)).
- `groupMonitorMode: "digest"` (default) — admitted messages are appended as JSON lines to `~/.openclaw/state/meshcore-group-log.jsonl` and **no agent session is woken** per message. Ask your agent "what has the mesh been saying?" when you want a summary.
- `groupMonitorMode: "session"` — routes each admitted group message to an agent session like a DM. Replies still never transmit. Use only with a tool-restricted agent (see the safety section above).

In every policy and every mode the plugin **never transmits to a group** — monitoring only changes inbound routing.

Example digest line:

```json
{"ts":"2026-10-05T09:00:00.000Z","channel":"channel:0","senderPubkeyPrefix":"aabbccdd1122","name":"TestNode","text":"hello mesh"}
```

- The log is rotated at approximately 1000 lines, keeping the newest entries.
- **Privacy:** the digest stores the **full text** of admitted group messages, on disk, in plain JSON. This is more content than the gateway log keeps when `logInboundMessageContent` is disabled — treat the file as sensitive.
- **Upgrading?** Digest is the default for every deployment, including existing ones. If you relied on group messages reaching agent sessions, set `groupMonitorMode: "session"` explicitly after upgrading.

Switch monitoring on or off with the gateway **stopped**:

```bash
openclaw gateway stop
openclaw config set channels.meshcore.groupPolicy '"allowlist"'      # or '"open"' / '"disabled"'
openclaw config set channels.meshcore.groupMonitorMode '"digest"'    # or '"session"'
openclaw config set channels.meshcore.groups '{ "channel:0": {} }'   # allowlist only: declare the groups
openclaw gateway start
```

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

`"groupPolicy": "disabled"` is the shipped default and shown for clarity — group monitoring is opt-in. To deliberately listen to public-channel traffic, see [Group monitoring](#group-monitoring-opt-in-digest-by-default).

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
| `dmPolicy` | `"pairing" \| "allowlist" \| "open" \| "disabled"` | `"pairing"` | How direct messages are admitted. `"open"` requires `allowFrom: ["*"]` and admits only uniquely addressable peers. |
| `allowFrom` | array of strings/numbers | `[]` | DM chat approvals: canonical `!` + 64 hex (full 32-byte key), or `"*"` for chat access only. Legacy prefixes, bare keys, names, and numbers are ignored with a bounded warning; see [docs/MIGRATION.md](docs/MIGRATION.md). |
| `groupPolicy` | `"open" \| "allowlist" \| "disabled"` | `"disabled"` | Group/broadcast admission. Monitoring is **opt-in**: `"disabled"` drops all group traffic with a log line (nothing recorded); `"allowlist"` admits only the groups listed under `groups`; `"open"` admits every broadcast channel the node hears. Transmission to groups stays locked in every policy. |
| `groupAllowFrom` | array of strings/numbers | `[]` | Existing group-admission filter, separate from canonical DM approval validation. Group frames expose the channel target, not the radio author; this is not a per-author boundary. |
| `groups` | object | `{}` | Per-group config keyed by `channel:0` … `channel:7` or `"*"`. |
| `channels` | array of 0–7 | `[0]` | Mesh channel indices to listen for broadcasts. |
| `textChunkLimit` | number (40–500) | `127` | Max **UTF-8 bytes** per outbound text chunk (the wire frame limit is byte-based). Chunks split at word boundaries where possible and never inside a multibyte character. Default 127 matches the observed wire cap — see Known Limitations. |
| `outboundSignedPlain` | boolean | `false` | When `true`, outbound DMs are sent as SignedPlain (`txtType 2`) instead of Plain. Reserves 4 bytes from the chunk limit for the SignedPlain `sender_prefix`. Group sends always stay Plain. |
| `commandRepliesEnabled` | boolean | `true` | Feature toggle for plugin-native command replies. It never grants identity, owner, host-command, or native-command authorization. |
| `commandPingAllowFrom` | array of strings/numbers | `[]` | Sole native-command compatibility exception: canonical full keys eligible for budgeted `!ping` replies after unique identity resolution and normal DM admission. |
| `sendRateLimit` | object | 20 packets / 10 min | Normal DM packet limit plus the size-aware pairing partition `min(3 × challengePackets, maxSends − 1)` (9 packets for the stock reply). Pairing ceilings remain when the general limiter is disabled. |
| `sessionSendRateLimit` | object | 10 packets + 1270 UTF-8 bytes / 10 min / producing session | Low-level pre-device guard (`enabled`, `maxSends`, `maxBytes`, `windowMs`). Named accounts inherit the root; partial overrides deep-merge. No-key sends are account-only; auto-replies retain their route key on 2026.10.5. |
| `sendPacing` | object | see below | Outbound airtime pacing for multi-chunk sends. |
| `sendRetry` | object | see below | DM delivery-report auto-retry (default **off**). |
| `durability` | object | see below | Inbound at-least-once delivery across gateway restarts (default **on**). |
| `logInboundMessageContent` | boolean | `false` | When `true`, inbound log lines include up to 80 chars of text. |
| `advertLat` | number (-90..90) | — | Override the node's advertised latitude. Requires `advertLon` and a difference >1e-5° from current position. |
| `advertLon` | number (-180..180) | — | Override the node's advertised longitude. Requires `advertLat` and a difference >1e-5° from current position. |
| `groupMonitorMode` | `"digest" \| "session"` | `"digest"` | How admitted group/broadcast messages (see `groupPolicy`) are handled. `"digest"` appends them to `state/meshcore-group-log.jsonl` without waking an agent session (the default); `"session"` routes each to an agent session like a DM. Groups remain receive-only in both modes. |
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

#### `sendRetry`

By default the send path is **fire-and-forget**: a message is considered sent once its frames are transmitted, and whether the mesh actually delivered it is not tracked. `sendRetry` (issue #25) opts into **delivery-report auto-retry** for DMs — the plugin equivalent of the MeshOS app's red cross: when the node never confirms delivery, the message is retransmitted, bounded and backed off.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable delivery-report auto-retry for DMs. Off by default (conservative send doctrine). |
| `maxAttempts` | integer 1–5 | `2` | Maximum **total** transmission attempts, including the initial send. `2` = one retry. |
| `backoffMs` | integer 1000–600000 | `30000` | Fixed wait between attempts. |

**How it works.** After the final frame is transmitted, the plugin awaits the node's delivery report — the `SendConfirmed` (0x82) push carrying that frame's ack tag — for the firmware's own estimated ACK window (`estTimeout`, clamped to 0.5–30 s; the same window the MeshOS app uses before flagging non-delivery). A report in time means delivered. No report in time is the protocol's definitive non-delivery signal, and only then is the message retransmitted — never on success, and never when the node returned no ack tag to correlate (that case stays fire-and-forget, because retrying blind would be timeout-ambiguous). The backoff window doubles as a **late-ACK guard**: a tardy confirm arriving during the backoff cancels the retry, so a late report never causes a duplicate send. Retries retransmit the whole message (the protocol confirms per frame; there is no way to know which frames of a multi-chunk message arrived).

**Airtime accounting.** Every attempt passes through the `sendRateLimit` flood guard again — retries burn the same rolling airtime budget as first sends, and a retry refused by the budget stops the loop whole, before any frame goes on air. If no attempt is confirmed after `maxAttempts`, the send fails with a `MeshcoreDeliveryFailedError` so the caller (and your agent) learns the DM was not delivered, instead of silently assuming success.

#### `durability`

**Why this exists.** A mesh message that reaches your gateway but dies in a restart is gone — the sender's radio got no NAK, they think you read it, you never see it. That used to happen on every OpenClaw update, every config reload, every crash at the wrong second. Durability (issue #48) closes that gap: **frames admitted for an agent turn are logged before dispatch and replayed after a restart, at-least-once between the radio and the agent.**

**Use cases it covers:**

- **Updates and restarts mid-conversation.** A DM arrives, the gateway restarts for an update seconds later — after boot, undispatched messages are replayed to the agent in log order.
- **Crash recovery.** Frames received but not yet dispatched are re-delivered on the next start instead of vanishing. A turn that was running when the process died counts as an attempt and is retried (bounded — see below), so a crash loop cannot replay forever.
- **Sender retries.** Nodes retransmit when an acknowledgement is lost, and a reconnecting node drains its receive queue. Persistent dedupe collapses those re-deliveries into one turn, so a flaky link does not produce duplicate answers.

**The honest limits (read these before relying on it):**

- **At-least-once, not exactly-once.** A restart while the agent is mid-turn can produce a *duplicate* reply when the event replays. On a shared medium, that is the right trade — a duplicated answer beats a lost question.
- **A queued follow-up is only as durable as the host process.** When the peer's session is busy, the host accepts the message into its in-memory follow-up queue (`deferredToActiveRun`) and the plugin marks it delivered — the queue belongs to the host from that point. A host crash before the drain loses that one follow-up; no plugin can close that gap.
- **Replays are not fresh turns.** Anything older than `maxReplayAgeMs` (default **1 hour**) is dead-lettered as stale instead of replayed — a day-old "open the garage" must not fire on Tuesday's reboot. Replayed turns are tagged for the agent with their original receive time.

**What it does not cover** (honest scope): while the gateway is fully disconnected from the node, nothing is *received* — short disconnects are bridged by the node's own RX queue and our dedupe cleans up the drain, but a gateway that is down for hours loses messages at the radio layer, before this feature ever sees them.

**Setup: none.** It is on by default and needs no configuration. The event log lives at `state/meshcore-durability-<accountId>.sqlite` (SQLite WAL, no native dependency — requires Node ≥ 22.13; older runtimes fall back to pre-durability behavior with one log line). Opt out with `durability.enabled: false` — and delete the `.sqlite` file and its `-wal`/`-shm` sidecars if you do not want the kept copy. Native `!status` is now default-deny, so its queue counters are not a generally available DM diagnostic; see [DM commands](#dm-commands).

How it works, briefly: admitted frames are appended to the log and claimed with a lease *before* dispatch; the attempt counts at claim, so a dead process is a counted attempt, and a running turn keeps its lease renewed. On startup, every in-flight row owned by another process is reclaimed, stale rows are dead-lettered, and the pending backlog replays in id order (abort- and disconnect-aware, time-capped, after all listeners are registered). Dispatch failures release the claim and retry next start; `maxDispatchAttempts` (3) dead-letters with a log line. Pruning removes only completed rows — never pending work — at startup and hourly, on a 30-day / 50 000-event budget, looping until under budget. Admission drops, pairing challenges, and digest-mode group traffic stay out of the store (the runtime log and the digest jsonl are their records); an authorized answered native command is recorded key-only so a re-aired copy is dropped as a duplicate instead of costing airtime twice. Fields: `enabled`, `retentionDays`, `maxEvents`, `pruneBatch`, `maxReplayAgeMs`, `maxDispatchAttempts`, `leaseMs`, `dbPath`.

**Replay identity revalidation.** New DM rows carry `rawJson.dmIdentityEvidence` version 1: `wirePrefixHex` (12 lowercase hex characters for the exact six wire bytes) and `fullKeySha256`, the SHA-256 digest of the selected raw 32-byte full key. Replay requires a current unique account mapping, matching digest, matching canonical route, and current DM/config/command policy before dispatch. Missing evidence dead-letters as `dm-identity-no-evidence`; ambiguous and changed/mismatched mappings dead-letter as `dm-identity-ambiguous` or `dm-identity-stale`. Temporary contact-sync failure releases the claim for bounded retry under the existing attempt/replay limits. **Pre-upgrade queued DMs lack evidence and must be resent by their senders.** Group rows keep their existing behavior, and native command markers remain non-replayable. Evidence records the intake mapping; it is not cryptographic sender proof. See [docs/MIGRATION.md](docs/MIGRATION.md).

**Exposure note.** The log keeps message bodies only while work is pending; dispatched and dead rows are blanked, leaving dedupe keys and metadata. Pending bodies share the exposure class of the host session store. Wire encryption is unchanged; the log holds no keys.

### Group config (`groups["channel:0"]`)

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether this group is active. |
| `requireMention` | boolean | Only dispatch when the agent is mentioned. |
| `allowFrom` | array | Existing group-admission filter; it cannot identify individual radio authors on this transport. |
| `skills` | array of strings | Skill allowlist for this group. |
| `systemPrompt` | string | Extra system prompt for this group. |
| `tools` | object | Group-wide tool policy. Exact-group `tools` override wildcard-group `tools`; `allow`, `alsoAllow`, and `deny` are preserved. The former MeshCore group `toolsBySender` setting was removed; OpenClaw's separate top-level `tools.toolsBySender` cannot authenticate a peer. |

**Group author identity and tool-policy migration.** MeshCore group frames carry no radio-author identity: `groupAllowFrom` and `groups.*.allowFrom` retain their existing channel-admission behavior, but cannot distinguish the person or node that authored a group message. The unenforceable group-local `toolsBySender` setting has therefore been removed. Runtime and manifest validation now reject it in exact groups, wildcard groups, and named accounts. Move its restrictions to a deliberate group-wide `groups["channel:N"].tools.deny` policy or to the receiving agent's policy. If the old sender entries differed, choose the single group-wide policy explicitly; no per-author distinction is possible. The gateway-wide `tools.toolsBySender` recipe for **DMs** is unchanged.

A group with configured `tools` must use `session.groupScope: "per-group"`, either globally or in the effective binding's `session` override. Main-scoped group sessions drop the group id that OpenClaw needs to resolve the policy, so the plugin refuses those turns before durability intake and logs the account, channel, and remediation. A queued replay is dead-lettered as `group-scope-main`. Unprotected groups may still use `main`.

Group slash commands are plain text. A recognized command without a real mention cannot bypass `requireMention`; a genuinely mentioned command reaches the agent with command interpretation suppressed. Digest mode still writes each admitted group message once without resolving a route or starting a turn, and disabled groups produce neither an entry nor a turn.

## DM commands

**OpenClaw host text commands are disabled for ALL MeshCore DMs pending #31.** That remains true after unique full-key resolution and even when the peer is explicitly allowlisted for ordinary chat. A unique mapping is routing evidence, not independent command proof. Suppressed slash-command text may enter an ordinarily admitted DM as plain text with `CommandAuthorized: false` and `CommandInterpretationSuppressed: true`; it is not executed as a host command. This state-intent item 6 change is **DM-only**: group command handling is unchanged and remains governed by `groupAllowFrom` together with the channel target.

The plugin recognizes the native commands `!ping`, `!status`, `!neighbours`, `!rstatus`, and `!trace`, but **all are default-deny**, including for uniquely mapped and full-key-chat-allowlisted peers. `commandRepliesEnabled` (default `true`) is only a feature toggle: it never confers authorization. There is no config option in this release that re-enables native `!status` or the repeater-ops commands.

A recognized blocked native command ends quietly before pairing, durable intake, a radio reply, or an agent/model turn. Native command marker rows are not replayed after a restart.

### Sole compatibility exception: explicit full-key `!ping`

An operator can opt a verified peer into native `!ping` **and nothing else**:

```json
{
  "commandRepliesEnabled": true,
  "commandPingAllowFrom": [
    "!0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ]
}
```

Every `commandPingAllowFrom` entry must be canonical `!` + 64 hex. A reply is possible only when that exact full key has a **unique current mapping on the receiving account**, the peer passes **normal DM admission**, and command replies are enabled. The reply is "pong" plus the local node name when available. It has a separately enforced budget of **3 native ping replies per 10 minutes per account**, independent of pairing and normal DM sends. Removing the allowlist entry or setting `commandRepliesEnabled: false` disables the exception.

## Security model

1. **Groups are receive-only.** The plugin will never call `sendCommandSendChannelTxtMsg` or any other group transmit primitive. Attempting to send to `channel:N` or `broadcast` throws `"receive-only"`.
2. **LoRa airtime rule.** Replies are never generated in response to group messages. This is enforced in `monitor.ts` (group `sendReply` is a no-op logger) and in `send.ts` (group targets rejected at the transport layer).
3. **DM access control and unique identity.** `dmPolicy` defaults to `"pairing"`, which issues a pairing challenge to unknown, uniquely mapped senders when budgets permit. Config `allowFrom` and pairing-store DM approvals require canonical `!` + 64 hex full keys; legacy prefixes, bare keys, names, and numbers are ignored with a bounded warning. Full-key chat allowlisting still works. Use `"open"` with `allowFrom: ["*"]` only when you accept unsolicited DMs from uniquely addressable peers; the wildcard is chat access only, never owner or command proof.
4. **No private-key exposure.** The plugin never requests or exports the node's private key.
5. **Node contact requirement (firmware).** Current MeshCore node firmware **silently drops DMs from senders that are not in the node's own contact list** — no ACK, no queue, no companion signaling, no error anywhere. Add expected contacts on the node itself (MeshCore app, with the gateway channel temporarily disabled — one companion client at a time) or enable auto-add on the node. First thing to check when "nothing arrives".
6. **Identity grades never grant authority.** Every admitted DM has exactly six valid wire prefix bytes and one unique full-key mapping in the receiving account's live synchronized contacts. `prefix-only` and `extended` are diagnostics only; a detected `mismatch` is refused. No grade, chat approval, or wildcard grants host or native command authority.
7. **Unverified mesh owner routes are refused before a host turn.** `commands.ownerAllowFrom` bare IDs/prefixes, `!`-prefixed IDs/prefixes, and explicit `meshcore:` entries are matched only against current validated full-key facts. A match refuses the whole route, including ordinary chat, because OpenClaw owner-only tools depend on `senderIsOwner` rather than `CommandAuthorized` alone. This deliberately protects gateway, automation, and similarly privileged tools. Non-mesh owner semantics are unchanged.
8. **Mesh DM sessions inherit the agent's toolset unless you scope it.** Bind mesh traffic to a **dedicated agent with an isolated workspace and narrow tools**, with safety-critical denials in the agent baseline. For multi-account installations, use `session.dmScope: "per-account-channel-peer"`. OpenClaw's top-level `tools.toolsBySender` can provide defense-in-depth filtering, but it is separate from the removed MeshCore group setting and cannot authenticate a peer. There is no SDK plugin-native direct per-DM tool-policy callback today ([openclaw/openclaw#176348](https://github.com/openclaw/openclaw/issues/176348)). See docs/AGENT-SCOPING.md for operator recipes.
9. **Group tools are group-wide and route-sensitive.** Group-local `toolsBySender` is rejected because MeshCore group frames have no radio-author identity. Configure `groups["channel:N"].tools` instead and keep protected groups on `groupScope: "per-group"`; main-scoped protected turns are refused, with replay dead-letter reason `group-scope-main`. Group commands cannot bypass mention gating.

### Pairing: request and airtime containment

With the default `dmPolicy: "pairing"`, a DM from an unknown, uniquely mapped node can produce a pairing request and a challenge reply. The message itself is dropped before it can start an agent session. Approval remains owner-side: a stranger who receives the instructions cannot self-approve. Pairing now has independent request-attempt and radio-packet budgets:

- **Request attempts:** at most **3 successfully replied-to new challenges per 10 minutes per account**, plus a **60-second cooldown per full key**. Concurrent requests for the same key coalesce. The reservation happens synchronously before OpenClaw can persist pending pairing state, then is reconciled with the host outcome: already-pending results and failed reply delivery release it. A pre-host refusal creates **no pending record, reply, or agent turn**.
- **Radio packets:** pairing may spend at most **min(3 × challengePackets, maxSends − 1)** chunks plus retries per accounting window, while normal DMs retain at least one packet. The stock challenge is three chunks, so the default partition is **9 packets** and three challenges fit without retries. The ceiling remains with `sendRateLimit.enabled: false`; every delivery retry consumes the same partition and can reduce capacity for later challenges.
- **Low caps:** the real three-chunk challenge is rejected before host pending state for `maxSends` **1, 2, or 3** (`max-sends-too-low` at 1, `pairing-reply-too-large` at 2–3). `maxSends: 4` fits one no-retry challenge and preserves one normal packet. Explicit full-key allowlisting remains available when pairing cannot fit.
- **Unchanged radio controls:** general send pacing, airtime accounting, and multi-account radio sharing continue to apply. Native `!ping` replies use their separate 3/10-minute account budget, not the pairing budget. Both in-memory pairing budgets reset on gateway restart, consistent with the existing limiter design.

On both supported hosts, a reply-delivery failure is caught by the host, reported through `onReplyError`, and followed by `created: true`: **the pending record persists until the host TTL**. The plugin logs the failure and releases the attempt reservation; subsequent attempts coalesce into that pending record (`created: false`), send no reply, and spend no account-attempt slot. Neither supported host SDK exposes a pending-record revoke/expire method to the plugin. If unsolicited contact attempts are a nuisance, `dmPolicy: "allowlist"` drops unknown senders without any reply — not even a pairing challenge.

Encryption note: MeshCore DMs are encrypted to the recipient's node key, so message content is protected on the air. **Adverts are not** — your node's name and advertised GPS position are broadcast in plaintext to every node in range. Choose `advertLat`/`advertLon` accordingly.

**Residual risk — sender identity on the wire.** Inbound DM frames carry only a 6-byte pubkey prefix in their header. The plugin requires a unique full-key mapping in the receiving account's live synchronized contacts, uses the account contact book only to detect conflicts, and applies `allowFrom` admission to the selected canonical full key. Contact refresh runs only on unresolved/ambiguous (non-unique) results: a colliding contact learned only radio-side can therefore leave attribution on the old key while firmware decrypts with one of the colliding keys. Any malformed synchronized live row invalidates the whole snapshot and refuses DMs until a clean resync; that availability trade-off is deliberate fail-closed behavior. MeshCore DMs are encrypted to the recipient's node key, so message content is protected on the air, but **adverts are not** — your node's name and advertised GPS position are broadcast in plaintext to every node in range.

**Hardening follow-up:** DM ingress match candidates still include `senderName` for host compatibility, even though names cannot become canonical DM approvals. Dropping that candidate is deferred; it is not being used as cryptographic identity evidence.

For SignedPlain messages (`txtType === 2`), the decrypted DM payload begins with a 4-byte `sender_prefix` followed by the UTF-8 text. Only those 4 signature bytes are available on the companion side; full Ed25519 DM verification is impossible from the plugin (the firmware verifies advert signatures at admission, but the companion protocol never forwards signature material). The plugin therefore classifies each SignedPlain prefix:

- `meshSecurity.prefixMatch` — whether the 4-byte prefix equals the first 4 bytes of the resolved contact's pubkey (`pubkey-first4`), the last 4 bytes (`pubkey-last4`), neither (`none`), could not be classified (`unresolved`), or was corrupted by the companion library's non-fatal UTF-8 decoder (`lossy`).
- `meshSecurity.identityBinding` — `extended` when the prefix is `pubkey-last4` or when the contact has used the same unknown prefix in at least 3 consecutive SignedPlain observations; `mismatch` when a previously consistent prefix is contradicted; otherwise `prefix-only`.

**Node signing oracle (live-proven 2026-10-11).** The companion protocol exposes a signing oracle (`CMD_DEVICE_SIGN`): the node produces real Ed25519 signatures over arbitrary data with its private key. Verified live against production hardware: a 64-byte signature over a known 50-byte message verified against the node's own pubkey, with the same signature correctly failing against a tampered message (negative control). This proves node-side crypto end-to-end and is the foundation for any future challenge-response identity flow (issue #31 cycle 3, deferred). It is *not* wired into DM sends — SignedPlain remains a room-server-originated frame class (see the #31 research notes), and whether a companion radio attaches a signature to outbound `txtType 2` DMs is the separate live-test tracked in issue #40.

A unique prefix mapping still does not prove who transmitted the frame. Prefix evidence is **routing evidence, not cryptographic authentication**; the binding fields and intake digest provide consistency diagnostics, not owner or command proof. Full SignedPlain verification remains follow-up work in [issue #31](https://github.com/fintlp/openclaw-meshcore/issues/31) and is required before mesh owner/command authority can be granted safely. Until then, keep owner-only operations on an independently authenticated non-mesh channel and re-verify suspicious contacts out of band.

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
- **Outbound SignedPlain chunk budget.** The library passes the supplied text through to the firmware unchanged; it is not statically provable whether the firmware prepends the 4-byte `sender_prefix` automatically or expects the caller to reserve it. The plugin therefore reduces the effective chunk limit by 4 bytes when `outboundSignedPlain` is enabled and documents this as a live-test verification item (issue #40).
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
