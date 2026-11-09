# Use cases & recipes

What to actually do with a mesh-reachable agent — each recipe names the scenario, the config that makes it work, what the agent can and cannot do in it, and where to read next. The README's "What you can do with it" is the pitch; this is the cookbook.

Agent-facing note: the same recipes live in compressed form in the bundled meshcore-connect skill (what a fresh OpenClaw instance reads when a user asks for mesh ideas). Keep the two in sync — they live in the same repo for exactly that reason.

---

## 1. Off-grid messaging assistant (the default)

Your agent — same one that knows your notes, calendar, home automation — answering DMs from a EUR 25 LoRa handheld with no internet in the path.

~~~jsonc
// nothing to configure beyond onboarding
{ "channels": { "meshcore": { "host": "192.168.1.20", "dmPolicy": "pairing" } } }
~~~

- **Can:** full agent session per admitted peer (tools, memory, skills — whatever your agent has).
- **Cannot:** speak in group channels (code-enforced); reach a peer the node cannot hear.
- **Read next:** docs/AGENT-SCOPING.md before letting strangers past pairing.

## 2. Emergency / backup channel

When the internet dies, the mesh does not. A powered node in the attic keeps the agent reachable when everything else is dark.

~~~jsonc
{
  "channels": { "meshcore": {
    "host": "192.168.1.20",
    "sendRetry": { "enabled": true, "maxAttempts": 3 }   // durability is on by default — the point of this recipe
  } }
}
~~~

- **Can:** survive gateway updates/crashes mid-conversation (undispatched inbound messages replay at-least-once), retransmit DMs the mesh never confirmed.
- **Cannot:** receive anything while the gateway itself is down — durability covers the receive-to-dispatch gap, not a dead gateway. Pair with a UPS for the full story.
- **Read next:** README durability + sendRetry sections.

## 3. Unattended-node & repeater monitor

A node on a hill (or in the attic) you can interrogate: how is it doing, what does it hear.

~~~jsonc
{
  "channels": { "meshcore": {
    "host": "192.168.1.20",
    "groupPolicy": "allowlist",
    "groups": { "channel:0": { "enabled": true } },
    "groupMonitorMode": "digest"
  } }
}
~~~

- **Can:** answer !status / !neighbours <node> / !rstatus <node> / !trace <node> in DM (repeater-class targets answer more), plus a digest log of heard channel traffic you can ask the agent to summarize.
- **Cannot:** manage a repeater that refuses remote ops (firmware-dependent); transmit to the channel it monitors.
- **Read next:** README "DM commands"; telemetry roadmap is issue #13.

## 4. Field-expedition comms hub

Gateway at base camp, handhelds in the field. Everyone DMs the hub; the hub answers in DM — weather, schedules, "where is everybody".

~~~jsonc
{
  "channels": { "meshcore": {
    "host": "<base-camp-node>",
    "dmPolicy": "pairing",
    "groupMonitorMode": "digest",
    "sendPacing": { "mode": "ack" }
  } }
}
~~~

- **Can:** brief N people independently at DM pace; remember per-person context across the trip (sessions per sender).
- **Cannot:** broadcast to the group at once (by design — and on a busy expedition channel, you do not want it to).
- **Read next:** README "Safety by default".

## 5. Festival / mesh-community bot

A pairing-gated assistant on your event's mesh. Strangers get a challenge; you approve the ones you know.

~~~jsonc
{
  "channels": { "meshcore": {
    "host": "<event-node>",
    "dmPolicy": "pairing",
    "commandRepliesEnabled": true
  } }
}
~~~

- **Can:** greet (capped pairing auto-replies), answer approved guests fully, prove to the crowd it cannot spam the public channel — that boundary is code, not a promise.
- **Cannot:** be a public-address bot (see recipe 4); lift the 3-reply pairing cap for strangers (by design).
- **Read next:** docs/AGENT-SCOPING.md layers 1-2.

## 6. Cross-channel bridge (the quiet superpower)

A DM from the mesh can produce effects on any other OpenClaw channel the agent has — the reply can land on WhatsApp, the note in Obsidian, the reminder in iCloud.

~~~jsonc
// no meshcore-specific config; this is the agent using its normal tools
~~~

- **Can:** "text Peter that I am at the trailhead" from a node with no SIM — the agent relays through its other channels.
- **Cannot:** bypass the other channels' own policies (WhatsApp allowlists etc. still apply); do any of this for unpaired strangers.
- **Read next:** docs/AGENT-SCOPING.md — this power is exactly why layer 1 exists.

## 7. Node map on demand ("show me the mesh")

Ask on WhatsApp or Telegram and get back a link that opens a map of every station your gateway knows, coloured by type. Zero airtime: the agent only reads the state files, and the map itself is drawn by [geojson.io](https://geojson.io) in your browser. No new modules, no image rendering.

~~~jsonc
// no meshcore-specific config; the agent reads ~/.openclaw/state and replies with a link
~~~

How the agent builds the link (or run `python3 docs/recipes/meshcore-map.py --out '' --link`, which follows the same rules):

1. Read `meshcore-advert-contacts.json` (v2: `{ version, contacts: [...] }`).
2. Keep only entries whose `accountId` is the account you want (`default` unless you run named accounts). Test or other-account entries must not appear on the map.
3. Skip entries whose `lat` and `lon` are both 0 (no advertised position), and duplicates of the same `publicKeyHex`.
4. Place your own node from `meshcore-node-status.json` (`name`, `position`) and drop its own contact-book entry (same pubkey); in the contact book it carries `type 0`.
5. Map `type`: 1 companion, 2 repeater, 3 room server, 4 sensor.
6. "Last heard" is `lastAdvert` (epoch seconds). Do not use `lastHeardAt`: it moves on every reconnect. Mark stations older than 7 days as stale.
7. Build a GeoJSON `FeatureCollection` of `Point` features. Coordinates are `[lon, lat]` (longitude first), rounded to 5 decimals. Properties: `name`, `type`, `last advert`, `marker-color` (repeater `#dc2626`, companion `#16a34a`, gateway `#2563eb`).
8. Link: `https://geojson.io/#data=data:application/json,` followed by `encodeURIComponent(JSON.stringify(collection))`.
9. Reply with the link plus a one-line summary ("4 stations, 2 repeaters, 1 stale").

- **Can:** show every positioned station the gateway has heard, with type and age, on any phone or laptop. Optional: known routes from the gateway as `LineString` features (the script draws them only when every hop hash resolves to exactly one contact).
- **Cannot:** go back over LoRa (the link is far longer than a 127-byte frame); show repeater-to-repeater links (those need `!neighbours`, which costs airtime); verify positions: every station advertises its own, many companions send none, some send a deliberately wrong one.
- **Privacy:** the map data sits after the `#`, which browsers never send to the geojson.io server; the page decodes it locally. The basemap tiles still come from a tile server, which sees the map area. Anyone holding the link sees the stations, your own node included, so send it to the owner only and never in reply to a mesh DM session.
- **Read next:** docs/USAGE.md (what each state file holds), docs/AGENT-SCOPING.md (keep mesh senders away from file tools).

---

*Sync rule: recipe set = README "What you can do with it" + this file + skills/meshcore-connect "Suggest a use". Change one, change all three.*
