# Quickstart: OpenClaw on the MeshCore mesh in ~15 minutes

You have an OpenClaw gateway. You want your agent reachable over LoRa mesh. This is the shortest path from zero to first mesh DM.

---

## What you need

1. **A LoRa board supported by MeshCore companion firmware.** Verified: Heltec WiFi LoRa 32 (V3 and V4 both work, ~€20–30). Any ESP32 board with a MeshCore companion build is fine.
2. **The board flashed with MeshCore companion firmware *with WiFi*** — the build that exposes the Companion Protocol over TCP (default port **5000**). Use the official MeshCore flasher.
3. **The node on the same LAN as your OpenClaw gateway** (or otherwise TCP-reachable).
4. **OpenClaw ≥ 2026.5.26** (the plugin manifest's declared floor). Verified daily-driver: 2026.9.x (2026.9.6–2026.9.8).

> A second device (handheld with MeshCore firmware, or MeshOS) is recommended so you can actually send yourself a DM — the mesh needs two ends.

---

## Step 0 — Read the two gotchas before touching anything

These two cost real evenings. They are expanded in [NODE-SETUP.md](NODE-SETUP.md), but you need them *before* you start:

**⚠️ Gotcha 1 — one companion client at a time.**
The node serves exactly ONE companion client. If you connect the MeshCore phone app while the gateway is connected, the gateway channel gets kicked (and vice versa). Do node admin (like adding contacts) with the gateway channel temporarily disabled — or accept the flap.

**⚠️ Gotcha 2 — the silent drop.**
Current node firmware (verified: 1.16) **silently drops DMs from senders that are not in the node's own contact list.** No ACK, no error, no log line anywhere — the message just never exists. Before you test DMs, either enable auto-add contacts on the node, or add your handheld as a contact *on the node itself* (via the app — see gotcha 1). If "nothing arrives," this is the first thing to check.

---

## Step 1 — Node setup (~5 min)

1. Flash the companion firmware, name your node, set your region's band. EU868 example (verified working): **869.618 MHz / BW 62.5 kHz / SF8 / CR 4/8**.
2. Get the node's LAN IP (your router's DHCP list, or the serial console).
3. Verify reachability from the gateway host:

```bash
nc -z 192.0.2.10 5000   # replace with your node's IP — must succeed
```

## Step 2 — Install the plugin (~2 min)

Until registry distribution lands (the manifest is already npm-shaped; publishing is tracked in issue #2), install from a git checkout:

```bash
git clone https://github.com/fintlp/openclaw-meshcore.git
cd openclaw-meshcore
npm ci && npm run build
rsync -a --delete --exclude .git --exclude node_modules --exclude '*.test.ts' \
  ./ ~/.openclaw/plugins/openclaw-meshcore/
cd ~/.openclaw/plugins/openclaw-meshcore && npm install --omit=dev
```

## Step 3 — Configure (~2 min)

Minimal block in `openclaw.json`:

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

Restart the gateway:

```bash
openclaw gateway restart
```

Then verify the channel came up — `openclaw status`, or in the gateway log:

```
[default] starting MeshCore provider (tcp) at 192.0.2.10:5000
```

(Log-line prefixing varies by gateway version — grep for `starting MeshCore provider` if the literal line doesn't match.)

## Step 4 — First contact (~5 min)

1. From your handheld, send a DM to the node's advert name.
2. With `dmPolicy: "pairing"` (the default), unknown senders get a pairing challenge. Approve it in the **Control UI** (or via `openclaw pairing approve`).
3. Chat. A few things that are *normal*, not bugs:
   - Long agent replies arrive as several mesh messages — the plugin splits at **127 bytes** (the node's wire cap) and paces frames by LoRa airtime + ACK round-trips (~1–3 s per frame at SF8). A 300-character reply is three bubbles a few seconds apart.
   - Group channels are **receive-only by design**. Set `groupPolicy: "open"` to *monitor* public-channel traffic; the plugin will never transmit to a group, regardless of policy. LoRa airtime is a shared resource.

---

## Where next

- **[NODE-SETUP.md](NODE-SETUP.md)** — deeper node preparation: the one-client rule, contact management, the 35-minute idle reconnect cycle (expected, not a bug), GPS adverts.
- **[COMPATIBILITY.md](COMPATIBILITY.md)** — verified firmware / software matrix and known interop quirks.
- **[AGENT-SCOPING.md](AGENT-SCOPING.md)** — what an agent reachable over the mesh can do, and how to bound it (tool policies, group rules).
- **README.md** — the full config reference (`sendPacing`, `groups`, multi-account, allowlists).
