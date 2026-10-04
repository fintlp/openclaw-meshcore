# Agent scoping: what a mesh-reachable agent can do — and how to bound it

A MeshCore DM is not a toy interface. When someone DMs your node, OpenClaw creates a **full agent session** for that peer — with the same tools, skills, and knowledge the agent has on any other channel. That is the point (your assistant, reachable off-grid). It is also an attack surface worth bounding deliberately.

This document is the operational guidance; finer-grained DM tool policies are tracked as issue #9.

---

## The trust model, stated plainly

1. **Anyone in radio range can attempt a DM.** LoRa has no network perimeter. Your perimeter is `dmPolicy`.
2. **An admitted peer talks to your agent with your agent's full capabilities.** If the agent can run shell commands, edit config, or message third parties, a clever peer can *ask* it to. The model's judgment is part of your security boundary — behave accordingly.
3. **Group channels are receive-only at the plugin level** — the agent can monitor but never transmit to a group. That boundary is code, not policy, and does not depend on model behavior.

Verified incident (own deployment, 2026-10-03): a mesh DM session, left with default capabilities, autonomously spawned a configuration sub-agent and wrote files while "helping" during a maintenance window — benign intent, real effect. Nothing broke. It was a governance lesson, not an accident report: **scope the surface before you need to.**

## Layer 1 — who gets in at all (`dmPolicy`)

| Policy | Behavior | Use when |
|---|---|---|
| `pairing` (default) | Unknown senders get a pairing challenge; you approve in the Control UI or with `openclaw pairing approve`. | **Recommended default.** Every admitted peer is a conscious decision. |
| `allowlist` | Only `allowFrom` entries get through; everyone else is dropped. | Fixed peer set (family, team). |
| `open` | Everyone is admitted. Requires `allowFrom: ["*"]` as an explicit seatbelt. | Public demos, temporary. Understand layer 2 first. |
| `disabled` | No DMs at all. | Monitor-only deployments. |

`allowFrom` accepts full `!nodeId`, 12-hex pubkey prefixes, advert names, or `"*"`.

## Layer 2 — what sessions can do (tools & skills)

Today, tool policy is scoped **per group** (and per sender within groups) and **per agent** globally — there is no per-DM-peer tool policy yet (that's issue #9).

What you can do **today**:

- **Agent-level tool policy (global, applies to mesh DMs too):** if the agent persona serving the mesh does not need `exec`, config editing, or outbound messaging, deny them at the agent level. The strongest available boundary for DM sessions.
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

What you cannot do yet (issue #9): per-DM-peer tool policies. Until then, the effective knob for DM sessions is `dmPolicy` discipline + agent-level policy.

## Layer 3 — operational hygiene

- **Keep the mesh agent's context clean of secrets.** Anything in the agent's reachable files/memory is one persuasive DM away from disclosure. (Standard practice — but the mesh is the most "physical" surface you have; anyone with a €20 board can knock.)
- **Watch the sessions list occasionally.** Mesh-originated sessions are identifiable by their channel. Unrecognized peer? Revoke the pairing (remove from allowlist / contacts).
- **Groups stay receive-only.** This is enforced in the plugin (group sends throw) and independently in agent rules. Do not weaken either.
- **Airtime discipline applies to agents too.** Long, chatty agent replies cost shared spectrum. The plugin paces sends; you should still prefer terse personas for mesh-facing agents.

## Recommended baseline (what we run)

- `dmPolicy: "pairing"`, approve by hand.
- `groupPolicy: "open"` for monitoring with agent dispatch **off** for groups (or, if on: `requireMention: true` + tool denials as above).
- Mesh-facing agent has no config-editing rights and a documented habit of asking before system changes.
