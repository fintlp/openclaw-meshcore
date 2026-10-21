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

---

*Sync rule: recipe set = README "What you can do with it" + this file + skills/meshcore-connect "Suggest a use". Change one, change all three.*
