# Agent scoping: what a mesh-reachable agent can do — and how to bound it

A MeshCore DM is not a toy interface. When someone DMs your node, OpenClaw creates a **full agent session** for that peer — with the same tools, skills, and knowledge the agent has on any other channel. That is the point (your assistant, reachable off-grid). It is also an attack surface worth bounding deliberately.

This document is the operational guidance; finer-grained DM tool policies are tracked as issue #9.

---

## The trust model, stated plainly

1. **Anyone in radio range can attempt a DM.** LoRa has no network perimeter. Your perimeter is `dmPolicy`.
2. **An admitted peer talks to your agent with your agent's full capabilities.** If the agent can run shell commands, edit config, or message third parties, a clever peer can *ask* it to. The model's judgment is part of your security boundary — behave accordingly.
3. **Group channels are receive-only at the plugin level** — the agent can monitor but never transmit to a group. That boundary is code, not policy, and does not depend on model behavior.
4. **The wire parser has no garbage-stream watchdog yet.** The underlying library's frame reassembly is O(n²) under a garbage-byte stream, with no byte cap or frame watchdog (see README Known Limitations; upstream hardening tracked as issue #6). A hostile or malfunctioning TCP peer could burn gateway CPU — one more reason the node belongs on a trusted LAN segment.

Verified incident (own deployment, 2026-10-03): a mesh DM session, left with default capabilities, autonomously spawned a configuration sub-agent and wrote files while "helping" during a maintenance window — benign intent, real effect. Nothing broke. It was a governance lesson, not an accident report: **scope the surface before you need to.**

---

## What the agent can promise about reliability

If a peer asks "did my message get through?", the honest answer since v2026.10.15 is: **once the gateway admitted it for an agent turn, it is retried until delivered or explicitly dead-lettered — it is not silently dropped.** The inbound durability log (README `durability`, issue #48) records admitted frames before dispatch and replays whatever was left undispatched after a restart, at-least-once. `!status` shows the live queue (`queue:<pending> dead:<n> dup:<d>`).

The boundaries of that promise, all three worth stating when it matters: a message sent while the gateway was *disconnected from the node* was never received (suggest a resend); a restart while your turn was running can produce a *duplicate* reply (at-least-once cuts both ways); and a follow-up queued behind a busy session is only as durable as the host process. Never promise exactly-once. If `dead:` in `!status` is non-zero, tell the operator: those events failed three dispatch attempts (or went stale past maxReplayAgeMs) and were set aside; inspect them with sqlite3 on the durability db (`SELECT id, received_at, peer_id, dead_reason, last_error FROM events WHERE dispatch_state='dead'`).

## Layer 1 — who gets in at all (`dmPolicy`)

| Policy | Behavior | Use when |
|---|---|---|
| `pairing` (default) | Unknown senders get a pairing challenge; you approve in the Control UI or with `openclaw pairing approve`. | **Recommended default.** Every admitted peer is a conscious decision. |
| `allowlist` | Only `allowFrom` entries get through; everyone else is dropped. | Fixed peer set (family, team). |
| `open` | Everyone is admitted. Requires `allowFrom: ["*"]` as an explicit seatbelt. | Public demos, temporary. Understand layer 2 first. |
| `disabled` | No DMs at all. | Monitor-only deployments. |

`allowFrom` accepts full `!nodeId`, 12-hex pubkey prefixes, advert names, or `"*"`.

## Layer 2 — what sessions can do (tools & skills)

Admission is not authorization: `dmPolicy` decides who gets in, tool policy decides what they can make the agent do. The layers available **today**, weakest-to-strongest operational effort:

- **Per-DM-sender denies via the gateway's global `tools.toolsBySender` (works now, recommended).** The core sender-policy layer applies to mesh DM turns — keys are `channel:meshcore:<nodeId>` where the node id is the sender id this plugin stamps (also shown in the pairing flow and sessions list). Example — every mesh contact loses shell and filesystem tools, your own handheld keeps them:

```json5
{
  tools: {
    toolsBySender: {
      "channel:meshcore:AB12CD34EF56": {}, // your handheld: no extra restriction
      "channel:meshcore:DEADBEEF0102": { deny: ["exec", "process", "write", "edit", "apply_patch", "gateway"] },
    },
  },
}
```

Match order is channel+id, id, e164, username, name, then wildcard — put specific node ids first. Caveat, stated plainly: this filters what a sender may *invoke*; it does not *authenticate* them (mesh DM identity stays convenience-grade, see the trust model above). It is defense-in-depth, not a lock.

- **A dedicated restricted agent for the mesh (strongest isolation).** `multiAgent` bindings route mesh DMs to their own agent entry — separate workspace, model policy, and tool allow/deny — so a mesh-originated session never shares blast radius with your primary agent:

```json5
{
  agents: {
    ownership: "explicit",
    entries: {
      main: { workspace: "~/.openclaw/workspace" },
      mesh: {
        workspace: "~/.openclaw/workspace-mesh",
        tools: { deny: ["exec", "process", "write", "edit", "apply_patch", "gateway", "sessions_spawn"] },
        systemPrompt: "You are the mesh-facing persona. Terse. No system changes, ever.",
      },
    },
  },
  bindings: [
    { agentId: "mesh", match: { channel: "meshcore", accountId: "*" } },
    { agentId: "main", match: { channel: "*", accountId: "*" } },
  ],
}
```

- **Group sessions** (if you enable `groupPolicy` monitoring with agent dispatch): full per-group control —

```json
"groups": {
  "channel:0": {
    "enabled": true,
    "requireMention": true,
    "tools": { "deny": ["exec", "sessions_spawn", "gateway"] },
    "skills": [],
    "systemPrompt": "Read-only monitor. Summarize mesh traffic when asked. Never perform system changes."
  }
}
```

- **`toolsBySender`** for known peers inside groups — e.g. your own handheld gets more reach than everyone else.
- **Smart-home control from the mesh** — see the recipe below: a dedicated mesh-facing agent with a minimal tool set, and the three risk tiers (read-only / reversible / physical access).

What does not exist yet (issue #9): **plugin-native** per-DM tool config — a `channels.meshcore...toolsBySender` mirroring the group shape, resolved by the plugin. Blocked on a core hook: the gateway's tool-policy resolution only consults channel plugins for group scopes, never for DM turns (upstream feature request openclaw/openclaw#176348). Until it lands, the two recipes above are the supported path.

## Layer 3 — operational hygiene

- **Keep the mesh agent's context clean of secrets.** Anything in the agent's reachable files/memory is one persuasive DM away from disclosure. (Standard practice — but the mesh is the most "physical" surface you have; anyone with a €20 board can knock.)
- **Watch the sessions list occasionally.** Mesh-originated sessions are identifiable by their channel. Unrecognized peer? Revoke the pairing (remove from allowlist / contacts).
- **Groups stay receive-only.** This is enforced in the plugin (group sends throw) and independently in agent rules. Do not weaken either.
- **Airtime discipline applies to agents too.** Long, chatty agent replies cost shared spectrum. The plugin paces sends; you should still prefer terse personas for mesh-facing agents.

## Recipe: controlling your smart home from the mesh

The powerful version of "AI on the mesh": if your agent can control your
smart home (HomeMatic, lights, heating) from WhatsApp, it can do it from a
mountaintop with zero internet, over LoRa — because a mesh DM session has
the agent's *real tools*. No extra plugin code: admission + tool scoping
is configuration. The scoping is where you must be deliberate.

**What exists today:** per-DM-peer tool policies do NOT exist yet
(issue #9). The available pattern is a **dedicated mesh-facing agent** with
an agent-level tool policy: allow exactly the home-control tools it needs,
deny `exec`, config editing, and outbound messaging to other channels. That
agent's tool set *is* the blast radius of every mesh session it serves.

**Risk tiers — not everything belongs on the mesh:**

| Tier | Examples | Verdict |
|---|---|---|
| 1 — Read-only | "Is the heating on?", temperatures, door STATUS | Fine. Worst case of a spoofed peer: information leak — mind layer 3 hygiene anyway. |
| 2 — Reversible state | Lights, heating setpoints | OK with a dedicated, narrowly-scoped agent. Blast radius is an annoyance, not an incident. |
| 3 — Physical access | **Garage door, door locks, alarm OFF** | Different risk class. Mesh DM identity is **convenience-grade, not cryptographic**: V3 frames carry only a 6-byte pubkey prefix, and adverts broadcast full pubkeys in plaintext — a determined attacker who grinds a 48-bit prefix collision would be admitted *as your node* (see README Security model, residual risk). Do not expose tier-3 tools without a **second factor**: a per-action confirmation code only you know (never stored on the handheld), a time-limited arming window ("garage enabled for 10 min"), or keep tier 3 off the mesh entirely. |

The garage door is the canonical tier-3 case: a spoofed chat is
embarrassing; a spoofed *garage door opening* is a physical breach. The
plugin can guarantee who knocked at the gate (pairing); it cannot
cryptographically prove who is speaking after admission. Design tier 3
accordingly.

### The double-confirmation challenge (tier-3 gating)

The property that makes a challenge work over an imperfect identity layer:
**a prefix-spoofer is blind.** Replies encrypt to the resolved *real*
pubkey, so an attacker who collided a 48-bit prefix can inject commands but
cannot read a single response. A challenge they cannot read is a challenge
they cannot answer.

Protocol for every tier-3 request (garage, locks, alarm):

1. The agent does NOT act on the first request. It issues a per-request
   challenge and waits.
2. Confirmation variant A (in-band secret): a pre-agreed code word known
   only to you — never stored on the handheld, never sent anywhere else —
   preceded by a random challenge phrase the agent invents per request
   (defeats replay if the code ever leaks). Even a fixed code defeats
   blind injectors; the random phrase defeats eavesdroppers of past
   *plaintext* channels (DMs are encrypted, but habits are cheap).
3. Confirmation variant B (out-of-band, strongest): the agent asks on an
   independent channel — e.g. your normal WhatsApp DM: "mesh request:
   open garage. Reply YES to confirm." Defeats everything short of two
   independent compromises; requires the agent to actually have the second
   channel.
4. Alternative: time-limited arming ("garage control enabled for 10 min") —
   but note that *arming itself* is a tier-3 action and needs the same
   challenge.

**Gate on `meshSecurity.identityBinding`.** Issue #31 cycle 2 added
SignedPlain prefix capture and classification. The inbound DM envelope now
includes `meshSecurity.identityBinding`:

- `extended` — SignedPlain is present and the prefix either matches the
  resolved contact's pubkey last 4 bytes (`pubkey-last4`) or has been
  consistent for at least 3 observations (`constant-unknown`). This is the
  strongest identity signal available on the companion wire, but it is still
  not a cryptographic proof.
- `prefix-only` — default for Plain/CliData messages or when SignedPlain
  classification is inconclusive.
- `mismatch` — SignedPlain is present but the current prefix contradicts a
  previously consistent prefix for the resolved contact.

Tier-3 actions should require the in-band secret or out-of-band confirmation
regardless of binding; `extended` may shorten the challenge but must not
replace it. A challenge-response cycle remains the documented follow-up for
issue #31.

The node's signing oracle is live-proven (2026-10-11): the companion radio
produces real Ed25519 signatures over arbitrary data (`CMD_DEVICE_SIGN`),
verified locally against its own pubkey with a tamper negative control. That
is the our-side foundation for the deferred challenge-response cycle — the
missing half is a peer that can sign (companion clients cannot; room servers
can).

## Recommended baseline (what we run)

- `dmPolicy: "pairing"`, approve by hand.
- `groupPolicy: "open"` for monitoring with agent dispatch **off** for groups (or, if on: `requireMention: true` + tool denials as above).
- Mesh-facing agent has no config-editing rights and a documented habit of asking before system changes.

**Heads-up on the open-policy warning:** with `groupPolicy: "open"` the gateway logs a startup warning recommending `"allowlist"` instead. That warning exists for the dispatch-on case — open + agent dispatch means any mesh stranger gets a session. If you run `open` strictly for receive-only monitoring (dispatch off), the warning is expected: acknowledge it, don't obey it. If you turn dispatch on, either set `groupPolicy: "allowlist"` with explicit `groups` entries, or accept the warning knowingly with `requireMention` + tool denials in place.
