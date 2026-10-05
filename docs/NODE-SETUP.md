# Node setup & operational behavior

Everything here was learned against a live dedicated node (Heltec V4, firmware 1.16) between 2026-10-01 and 2026-10-04. Where behavior is firmware-dependent, the verified version is noted.

---

## The one-companion-client rule

A MeshCore node serves **exactly one companion client** over TCP. When a second client connects (e.g. the MeshCore phone app), the first connection is dropped — the gateway channel flaps, reconnects a few seconds later, and gets kicked again for as long as the app holds the node.

**Consequence:** dedicate the node to the gateway. Any phone-app admin (adding contacts, changing settings) needs a maintenance window:

1. Set `channels.meshcore.enabled` to `false` in `openclaw.json` (hot-reloads; no gateway restart needed).
2. Connect the app, do your admin.
3. Disconnect the app, set `enabled` back to `true`.
4. Verify the channel re-established: gateway log shows the provider start line, and `lsof -nP -iTCP:5000 -sTCP:ESTABLISHED` on the gateway host shows the connection.

## Contact management — and the silent drop

**Firmware 1.16 (verified):** the node **silently drops DMs from senders that are not in its own contact list.** No ACK is sent, nothing is queued, and the companion client sees *nothing* — no error, no event. From the sender's side the message just vanishes.

Before DM testing:

- Either enable **auto-add contacts** on the node (`manualAddContacts = 0`), so new senders are added on first advert/contact;
- or add expected peers to the node's contact list **on the node itself** (MeshCore app, during a maintenance window as above).

If "nothing arrives," check this first — before suspecting the plugin, the network, or the gateway.

**MeshOS interop note (verified, MeshOS 1.3.6):** MeshOS handhelds interoperate for adverts and DMs *once the sender is in the node's contacts* — but MeshOS's own auto-add behavior may not populate the **node's** contact list by itself. Add the handheld manually if DMs don't arrive.

## The 35-minute idle reconnect cycle (expected, not a bug)

On an idle link you may see the TCP connection cycle on an almost perfect **35:00** cadence: drop, immediate reconnect, session continues. This is the **gateway's inactivity watchdog**, not the node and not the plugin:

- Any activity on the link resets the clock (the cycle visibly skips busy periods).
- The plugin's 5-second `getWaitingMessages()` poll keeps the TCP connection itself from ever being socket-idle; the watchdog triggers on a higher inactivity layer.
- Reconnect is automatic and state (the contact book) is persisted — no action needed.

Filed as issue #3; closed as wontfix-with-docs — this section *is* the documentation.

## What the plugin learns about your node

On connect, the plugin performs the app-start handshake and queries the node:

- **SelfInfo** — advert name, public key, own GPS position (if the node has GPS), TX power, radio parameters (frequency/BW/SF/CR). Verified live: 22 dBm TX, EU868 params read correctly.
- **Battery** — via `GetBatteryVoltage` (companion cmd 20). Verified answering (e.g. 4.157 V on a Heltec V4). Note: the *device-query/storage-style* battery path is ignored by some nodes; cmd 20 is the reliable one.
- **Contacts & channels** — synced at connect and debounced on advert pushes.
- **Stats** — `GetStats` answers on tested firmware (queue length, last RSSI/SNR, uptime, receive-error counts).

**Baseline expectation:** not every node answers every query. Self-info and message events are the reliable baseline everywhere; treat DeviceInfo/firmware-version fields as best-effort (some nodes return variable-length payloads the underlying library mis-parses).

## GPS adverts & the contact book

Nodes with GPS advertise their position. The plugin caches every advert in a persistent contact book (`~/.openclaw/state/meshcore-advert-contacts.json`), including:

- full public key (needed to reply — DM frames only carry a 6-byte prefix),
- advertised name, advert type/flags, routing path,
- position (`advLat`/`advLon`, fixed-point; **degrees = raw ÷ 1e6**),
- last-advert and last-modified timestamps.

A DM sender becomes reply-addressable after their first advert; before that, their messages still arrive but a reply has no full key to address (logged, non-fatal).

## Radio parameters (verified EU868 example)

| Parameter | Value |
|---|---|
| Frequency | 869.618 MHz |
| Bandwidth | 62.5 kHz |
| Spreading factor | SF8 |
| Coding rate | 4/8 |
| TX power | 22 dBm |

MeshCore stores CR as the **denominator** (`8` = 4/8) — keep this in mind when reading raw values or setting `sendPacing.defaultCr`.

Wire behavior that shapes the experience:

- **127-byte text frame cap** on the wire (firmware 1.16, root-caused with a position-encoded payload): longer text is chunked; the default `textChunkLimit` is 127 for this reason.
- **ACK round-trips dominate pacing:** measured 1.3–3.1 s per frame at the above settings. The default ACK-gated `sendPacing` handles this; if you disable pacing and send long replies, the node's TX queue drops tail frames silently.
