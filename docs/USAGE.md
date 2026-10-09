# Using the plugin from within OpenClaw

QUICKSTART gets you to first contact; this page is what day-2 looks like:
the pairing lifecycle from the operator's side, where the agent finds node
data, group monitoring, position admin, and routine operations.

## The pairing lifecycle (operator's view)

MeshCore has no accounts — any node in radio range can DM your node. The
plugin's default `dmPolicy: "pairing"` turns each new sender into an
approval flow:

1. **A stranger DMs your node.** The message is dropped before it can start
   an agent session. The plugin registers a pairing request and replies
   once with a one-time code and the approve command. Repeat DMs from the
   same node get *no further reply* (create-if-missing), and pending
   requests are hard-capped at 3 per account — a flood cannot grow beyond
   3 junk entries and 3 reply frames.
2. **You see the request.** `openclaw pairing list` shows pending (and
   already-approved) senders, or watch the gateway log for
   `pairing requested` lines.
3. **You approve — or don't.**
   ```bash
   openclaw pairing approve meshcore <code>
   ```
   Only you can do this — the code printed to the requester is useless
   without an owner-side approval. Approvals live in the **pairing store**,
   not in `allowFrom`; your config can stay `allowFrom: []` and approvals
   still stick. To revoke, remove the store entry or tighten the policy.
4. **Their DMs now dispatch** to agent sessions like any other channel.

Stricter postures: `dmPolicy: "allowlist"` drops unknown senders silently
(no pairing reply at all — the nuclear option against contact-request
noise); `"open"` + `allowFrom: ["*"]` admits everyone (demos only, with a
tool-restricted agent — see the README safety section).

## What the agent can see and do

The plugin maintains four state files under `~/.openclaw/state/` (planned
move: issue #21) — your agent reads them like any file:

- `meshcore-node-status.json` — the node's SelfInfo snapshot: name, pubkey,
  radio parameters (freq/BW/SF/CR), TX power, advertised position,
  connection state, reconnect count, and the most recent self-advert
  (`lastAdvertAt`, `advertScope`). Refreshed on every connect.
- `meshcore-advert-contacts.json` — the contact book: every known peer's
  full pubkey, advert name, last-seen timestamp, and advertised GPS
  position. Persisted across restarts.
- `meshcore-discovery.json` — the agent-readable discovery surface: a
  summary of every known contact with `prefix`, `name`, `source`
  (`advert` | `contact-sync`), `discoveredAt`, `lastAdvert`, and
  `hasPosition`, plus totals by source. Rewritten automatically whenever
  the contact book changes.
- `meshcore-group-log.jsonl` — the digest log (see below), one JSON line
  per admitted group message, rotated at 1000 lines.

So "where is node X?", "who has been on the mesh lately?", "what's my
node's battery/radio state?" are all answerable from these files — the
agent never needs to transmit to find out. Radio parameters are read-only
by design: the agent can *report* them, never change them.

### Controlling your smart home from the mesh

A mesh DM session has the agent's real tools — if it can run your HomeMatic
from WhatsApp, it can do it off-grid over LoRa. That includes the garage
door — which is exactly why the recipe in
[AGENT-SCOPING.md](AGENT-SCOPING.md#recipe-controlling-your-smart-home-from-the-mesh)
splits actions into three risk tiers and treats **physical access as a
different risk class**: mesh DM identity is convenience-grade (48-bit
prefix, public adverts), so garage/lock/alarm actions belong behind a
second factor or off the mesh entirely. Read it before wiring any tool
into a mesh-facing agent.

## Discovery surface

`meshcore-discovery.json` is the zero-airtime way for an agent to answer
"who is on the mesh?". It is rebuilt from the contact book every time a
contact is added or updated, so it is always consistent with
`meshcore-advert-contacts.json` without exposing full public keys.

Each entry:

```json
{
  "prefix": "aabbccdd1122",
  "name": "TestNode",
  "source": "advert",
  "discoveredAt": 1234567890,
  "lastAdvert": 1234567890,
  "hasPosition": true
}
```

- `source`: `advert` when the contact was first seen from a passive
  `Advert`/`NewAdvert` push; `contact-sync` when it came from a node
  contact-list sync or SelfInfo.
- `discoveredAt`: epoch seconds when this gateway first learned about the
  contact. Existing contact-book entries without this field are backfilled
  to `contact-sync` with `discoveredAt` set to their `lastAdvert` (or the
  current time if no advert timestamp is known).
- `hasPosition`: true when non-zero coordinates are known.

## Active/scheduled self-adverts

The plugin can transmit self-adverts on your behalf. Because every advert
consumes shared LoRa airtime, the defaults are conservative:

```jsonc
channels: {
  meshcore: {
    advertOnConnect: false,       // send one advert immediately after connect
    advertIntervalHours: 0,       // hours between scheduled adverts; 0 = off
    advertScope: "zero-hop",      // "zero-hop" or "flood"
  }
}
```

- `advertOnConnect`: sends a single self-advert right after the node
  connects and any configured position correction has been applied.
- `advertIntervalHours`: while connected, sends a self-advert on this
  interval. Values greater than 0 are clamped to a minimum of 1 hour.
- `advertScope`: the MeshCore advert type sent by the node.
  - `"zero-hop"` (default) reaches only nodes in direct radio range.
    This is the polite, airtime-cheap default.
  - `"flood"` propagates across the whole mesh. Every relay retransmits
    it, so it consumes airtime for every node in the mesh — not just your
    immediate neighbours. Use it sparingly, and never with a short
    interval.

> **Airtime citizenship warning.** LoRa spectrum is a shared commons. A
> flooded advert on a 1-hour interval will be heard and relayed by every
> node that can reach you, directly or indirectly. Prefer `"zero-hop"`
> unless you have a concrete reason to announce yourself mesh-wide, and
> keep intervals long. The node-status snapshot records `lastAdvertAt` and
> `advertScope` so you (and your agent) can audit how often the gateway is
> advertising.

## Group monitoring (digest mode)

Groups are receive-only forever — the send path refuses group targets, in
code, regardless of policy. What you *can* do is listen:

- `groupPolicy: "disabled"` (default) — group traffic is dropped with a log
  line.
- `groupPolicy: "allowlist"` + `groups: { "channel:0": {} }` +
  `groupMonitorMode: "digest"` (default) — admitted group messages are
  appended to `meshcore-group-log.jsonl` **without waking an agent per
  message**. Ask your agent "what has the mesh been saying?" and it reads
  the log. No per-message sessions, no token burn, no accidental public
  replies.
- `groupMonitorMode: "session"` — routes admitted group messages to agent
  sessions like DMs. Replies still never transmit. Use with a
  tool-restricted agent (README safety section explains why).

## Position admin

The one node property you may set remotely is the advertised GPS position:

```jsonc
channels: {
  meshcore: {
    advertLat: 48.2082,   // decimal degrees
    advertLon: 16.3738,
  }
}
```

Both keys must be set; the plugin applies them on connect only when the
drift from the node's current advertised position exceeds 1e-5° (~1 m),
then reads the position back from SelfInfo into the status snapshot. Config
becomes the source of truth: any drift (e.g. set from the companion app) is
corrected at the next connect. Remove the keys to leave the position as-is.

Note the asymmetry: **adverts are public plaintext** — every node in range
sees your name and position. Advertise a location you are comfortable
sharing.

## Day-2 operations

- **Config changes** (policies, position, channels): edit config → hot
  reload applies them; on a busy gateway the reload can defer up to ~5 min
  and then fires anyway. No restart needed.
- **Plugin code changes** (upgrades): plugin code loads only at boot — a
  full gateway restart is required.
- **The node serves one companion client at a time.** The plugin holds it
  24/7; connecting the MeshCore app kicks the channel. For node-side
  maintenance, disable the channel first, do the work, re-enable —
  see [NODE-SETUP](NODE-SETUP.md).
- **Mesh-side UX:** replies arrive as 127-byte-max chunks (long answers =
  multiple messages), plain text only — handhelds render markdown literally.
  Keep agent responses to mesh users short and unformatted.

## Where the sharp edges live

Known firmware/dependency behaviors that look like bugs but aren't:
firmware drops DMs from non-contacts silently, known contacts' positions
refresh only on connect, MeshOS serves no telemetry, and a ~35-minute idle
reconnect cycle is expected. All documented with evidence in the README's
Known Limitations and [COMPATIBILITY](COMPATIBILITY.md).
