# Changelog

All notable changes to `openclaw-meshcore`. Date-based versioning: `2026.M.P`.

The ClawHub versions page sources its per-release text from the publish
command's `--changelog` flag (see docs/PUBLISHING.md) — this file is the
canonical source for that text.

## 2026.10.3 — 2026-10-09

**Features**

- **Passive node discovery** (#24): contact-book entries gain `source`
  (advert / contact-sync) and `discoveredAt`; new per-account
  `meshcore-discovery.json` summary as the agent-readable discovery surface.
  Zero airtime.
- **Scheduled self-adverts** (#36): opt-in `advertOnConnect`,
  `advertIntervalHours` (clamped ≥ 1 h), `advertScope` `zero-hop` (default) /
  `flood`; stale-guard skips connect adverts when the last one is fresh;
  every send logged and reflected in the node-status snapshot.
- **Plugin-level `!ping` / `!status`** (#29): answered directly by the plugin
  — no agent session — only for senders who pass normal DM admission;
  group channels stay silent. `commandRepliesEnabled` opt-out.
- **DM chunk splitting with `[n/N]` numbering** (#28): multi-chunk replies
  carry ordered prefixes, budgeted inside the wire limit.
- **Contact-book cap + eviction** (#27): `contactBookMaxEntries` (default
  500); eviction is advert-sourced only (oldest `lastAdvert`, then
  `discoveredAt`); contact-sync and legacy entries protected.

**Fixes**

- **#39 — chunk numbering now actually reaches the wire.** The OpenClaw host
  pre-chunked outbound text at `textChunkLimit`, so the plugin only ever saw
  single chunks and never prefixed them. The plugin now declares
  `chunker: null` (host passes full text) and self-chunks at a **hard 127-byte
  wire clamp** (`min(configured, 127)`); `textChunkLimit` remains on the
  adapter for host block-streaming sizing. Side effect defused: a configured
  limit above 127 made the companion firmware **kick the TCP session** on the
  oversized frame (documented in COMPATIBILITY.md).
- Per-account discovery summaries (multi-account installs no longer merge
  networks into one file).
- Advert sends: 5 s timeout + in-flight guard (no more listener leaks on
  stalled sends), informative error logs.
- Contact-book writes: atomic (tmp+rename), throttled; V1-migration
  `discoveredAt` edge fixed.
- Node-status snapshot gains `batteryMv`; `!status` reports from the
  snapshot only (never re-queries the node).

**Verification**: suite 242/242, incl. integration tests that drive the
registered outbound send path with multibyte (umlaut/CJK/emoji) payloads and
assert every frame ≤ 127 bytes with ordered `[n/N]` prefixes. Features
live-proven on hardware (EU868, fw 1.16-class).

## 2026.10.2 — 2026-10-08

- Catalog icon (stylized lobster with antenna radio waves).
- `npm-shrinkwrap.json` added: full transitive dependency tree pinned for
  installers.
- Documentation refresh (publishing runbook, server-inspector asymmetry
  note as #32).

## 2026.10.1 — 2026-10-08

First public release.

- Direct messages with `pairing` / `allowlist` / `open` access policies.
- Group / broadcast channels: receive-only by design (triple-enforced), with
  digest-mode monitoring to a log file.
- Advert-driven contact book: full pubkeys, names, GPS positions, outbound
  paths — persisted across restarts.
- Node-status snapshot: radio parameters, battery, device info, connection
  ops fields.
- Config-driven advertised-position admin (`advertLat`/`advertLon`) with
  drift auto-correct on connect.
- Multi-account: more than one node connection.
