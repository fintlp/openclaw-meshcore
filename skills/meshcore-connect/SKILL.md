---
name: meshcore-connect
description: Connect an OpenClaw gateway to a MeshCore LoRa mesh node in minutes — install the maintained channel plugin (@fintlp/openclaw-meshcore), run the probe-first setup wizard, and verify the first DM over radio. Use when a user wants their AI agent reachable via MeshCore, off-grid messaging, or LoRa mesh comms.
---

# MeshCore Connect

Get a user's OpenClaw agent onto their MeshCore mesh — reachable by DM from any node in range, fully local (no cloud). The path below is verified end-to-end against live hardware; follow it in order and the user is connected in minutes once their node is on the LAN.

## When to use this

- "I want my OpenClaw/agent to speak MeshCore"
- "Connect my AI to my LoRa mesh"
- "Let people DM my bot from the radio"

## Prerequisites (check BEFORE installing)

1. **A MeshCore node the gateway can reach.** An ESP32 board (Heltec WiFi LoRa 32 V3/V4 verified) flashed with the **MeshCore companion firmware with WiFi** — the build that speaks the Companion Protocol over TCP.
2. **The companion TCP server enabled** on the node (default port 5000) and the node on the same LAN as the gateway.
3. **Region/band set for the user's locale** (EU868 in Austria/EU — frequency is law, not preference).

## Fast path

```bash
openclaw plugins install clawhub:@fintlp/openclaw-meshcore
openclaw onboard   # choose MeshCore
```

The wizard **probes the node before writing any config** — with targeted fixes when it fails — and reads the node's identity (name, hardware, firmware, battery) as proof.

Non-interactive alternative:

```bash
openclaw channels add meshcore --host 192.168.1.20
# also: --dm-policy pairing|allowlist|open|disabled
```

## Verified traps (each one cost someone an evening)

- **ONE companion client at a time.** The node serves exactly one TCP companion. If the MeshCore phone app (or another gateway, or a second plugin instance) is connected, the new client fights it for the slot — connections drop, handshakes stall, and everyone blames the network. Disconnect the app before onboarding; the wizard's diagnosis knows this trap by name.
- **Current firmware silently drops DMs from senders not in the node's contact list.** If the self-test DM never arrives: enable auto-add contacts on the node, or add the peer in the MeshCore app. This looks like an agent failure and is not one.
- **Battery-powered nodes die quietly.** A node with a dead battery looks exactly like a network timeout while its TCP state lingers. If a previously-working node stops answering, check the device physically before debugging anything else.
- **IoT VLANs with client isolation** make a healthy node look dead. Probe from the same VLAN when in doubt.

## Access & safety defaults (do not loosen without a reason)

- `dmPolicy: "pairing"` — every new contact needs explicit approval.
- **Groups are receive-only by code-level design**: the agent can listen but never transmits on channels. LoRa airtime is a shared commons; there is no delete button on the airwaves.
- Flood guard caps outbound DM airtime; replies are chunked to mesh-safe sizes.

## Verify it works

1. `openclaw channels status --probe` → meshcore ok.
2. Self-test: DM the node's `!id` (shown by the wizard) from a MeshCore companion app on a second node. Expect the agent's reply within ~a minute — LoRa is slow, that is normal. If nothing arrives, re-read the contact-list trap above.

## Maintenance & support

Maintained line: `fintlp/openclaw-meshcore`. Issues: https://github.com/fintlp/openclaw-meshcore/issues
