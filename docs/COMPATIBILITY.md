# Compatibility

Verified combinations, with the date and evidence class. "Verified" = exercised live against real hardware; "expected" = follows from the protocol but untested by us.

## Plugin ↔ OpenClaw

| OpenClaw | Plugin | Status |
|---|---|---|
| 2026.9.6 | 2026.10.1 | ✅ verified (2026-10-01 → 10-03) |
| 2026.9.8 | 2026.10.1 | ✅ verified (2026-10-04) |

## Node firmware

| Device | Firmware | Status | Notes |
|---|---|---|---|
| Heltec WiFi LoRa 32 V4 | MeshCore companion 1.16 (TCP) | ✅ verified (2026-10-01 → 10-04) | Full two-way DM, contact sync, GPS adverts, battery (cmd 20), GetStats. Telemetry self-request is out of spec (expected — telemetry requests target *remote* nodes). |
| Heltec WiFi LoRa 32 V3 | MeshCore companion (TCP) | 🟡 expected | Same firmware family; untested by us. |
| LilyGo handheld | MeshOS 1.3.6 | ✅ verified as peer (2026-10-01 → 10-03) | Adverts + DMs work once in the node's contact list. Quirks below. |

## Known interop quirks

- **Node firmware 1.16 silent drop** — DMs from senders not in the node contact list are silently discarded (see [NODE-SETUP.md](NODE-SETUP.md)). First thing to check when "nothing arrives."
- **MeshOS 1.3.6 auto-add gap** — its auto-add may not populate the *node's* contact list. Add the handheld on the node manually.
- **MeshOS 1.3.6 display quirk** — timestamps can render over message text on the handheld. Cosmetic, device-side, not the plugin.
- **MeshOS 1.3.6 telemetry** — does not answer Cayenne LPP telemetry requests (both the legacy cmd 39 and the recommended cmd 50/0x03 paths were probed with the device confirmed reachable; no answer). Treat remote telemetry as unsupported until a MeshOS update.
- **DeviceInfo parsing** — some nodes return variable-length DeviceInfo payloads the underlying library mis-aligns; firmware/model fields are best-effort.

## Transport

- **TCP companion protocol only.** BLE and serial transports are not implemented.
- One companion client per node (see [NODE-SETUP.md](NODE-SETUP.md)).

## Wire limits (firmware 1.16)

- **127-byte text frame cap** — longer text is chunked by the plugin (`textChunkLimit` default 127). A limit configured above 127 is clamped back to 127 bytes; an oversized frame causes the node to **kick the TCP companion session** rather than truncating silently (observed live 2026-10-09 with MeshCore companion 1.16-class firmware).
- **Group channels: receive-only** by design, at the plugin level. Not a firmware limitation.

## What we recommend for new deployments (2026-10)

- Node: Heltec V3/V4-class board, current MeshCore companion firmware, dedicated to the gateway.
- Peers: current MeshCore companion app or current MeshOS (≥ 1.3.6 recommended for the fixes since).
- Gateway: OpenClaw ≥ 2026.9.8 (tested). The plugin's declared minimum is ≥ 2026.5.26 — older-than-tested may work, but we only stand behind the matrix above.
