# Changelog

All notable changes to `openclaw-meshcore`. Date-based versioning: `2026.M.P`.

The ClawHub versions page sources its per-release text from the publish
command's `--changelog` flag (see docs/PUBLISHING.md) — this file is the
canonical source for that text.

## Unreleased

Features

- Neighbours query, issue #35: new DM command !neighbours <node> asks a repeater-class contact which nodes it currently hears and replies with the edge list — pubkey prefix, last-heard age, SNR, and the contact name when the prefix resolves in the contact book. Airtime honesty: the query rides an on-air SendBinaryReq frame to the target node (meshcore.js getNeighbours is not a local query), so each call counts one packet against the sendRateLimit budget, and the command is DM-admission-gated and group-silent like !ping/!status. Targets that ignore the request fail soft with a timeout answer. Live verification against a real repeater is deferred to a maintenance window (blocked on node discovery, issue #24); all coverage here is mock-based.
- Remote status request, issue #34: new DM command !rstatus <node> pulls a remote node's status frame and replies with its stack/radio health — battery, tx queue depth, noise floor, RSSI, packet counters, total airtime, uptime, error events, SNR, duplicate counts. On air like the neighbours query (SendStatusReq frame, one packet against the sendRateLimit budget), DM-admission-gated and group-silent. The last_snr field is scaled from quarter-dB following the protocol convention used by every other SNR field; verify against live repeater firmware when one is reachable (issue #24). On-demand only, never scheduled.
- Path trace, issue #33: new DM command !trace <node> runs a MeshCore traceroute toward a contact and replies with the route the frame took — the hop list (1-byte path hashes, contact names when a hash byte resolves unambiguously in the contact book, per-hop SNR) plus the final-link SNR, or direct when no relay was involved. On air like the other two (SendTracePath frame plus forwarding airtime on every relay along the path, one packet against the sendRateLimit budget), DM-admission-gated and group-silent. The library leaves pathSnrs as raw quarter-dB bytes, so normalization (including negative-SNR int8 conversion) is pinned by known-answer tests built from realistic wire-frame bytes. Targets that never answer fail soft with a timeout. On-demand only, never scheduled.

## 2026.10.10 — 2026-10-18

Airtime protection and a responsible-disclosure policy.

Features

- Outbound flood guard. The send path now budgets airtime packets per rolling window (default 20 per 10 minutes per account) and refuses a message with a retry hint when the budget is exhausted — before the first frame is transmitted, never partially aired. Tune via channels.meshcore.sendRateLimit (maxSends / windowMs / enabled false to disable). Tests pin the cap, the whole-message refusal, per-account isolation, and window sliding.

Docs

- SECURITY.md: responsible-disclosure policy (private reporting via GitHub Security Advisories, scope, response expectations).

## 2026.10.9 — 2026-10-18

Install metadata pass — no code or behavior changes since 2026.10.8.

Docs / install metadata

- package.json gains keywords (openclaw, meshcore, lora, mesh, radio,
  off-grid and friends) and a homepage link for registry and search
  surfaces.
- install.defaultChoice flipped from npm to clawhub: the package is not
  published on npm, so an npm-preferred install path would fail. The
  documented install command was already the ClawHub one; now the
  metadata agrees. Twin of the same fix in openclaw-meshtastic v2026.10.21.
- README now cross-links the Meshtastic sibling plugin.

## 2026.10.8 — 2026-10-18

Docs-only release — no code or behavior changes since 2026.10.7.

- README reworked to be use-case-forward (issue #44): new opening with the plugin icon, a use-case tour (off-grid messaging assistant, emergency/backup channel, repeater-site monitor, field-expedition comms hub, festival/community bot), and a story-style lead-in to the quickstart with the two gotchas flagged up front. The safety-by-default section is unchanged — it is a selling point, not a caveat.
- New Compatibility and maintenance policy section in the README (issue #45): the tracked plugin-sdk surface with an audit one-liner, the deprecation-response precedent (inbound-envelope migration shipped in 2026.10.7, removal window ends 2026-12-31), the stable-tracking release rule (beta-only SDK surfaces are adopted only after they reach stable), the host-floor bump policy (floor is OpenClaw 2026.5.26 or newer; moves ship in a minor release with a changelog callout), and where breakage surfaces first. Cross-linked from docs/COMPATIBILITY.md.
- package.json description is now use-case-led. npm-shrinkwrap version fields re-synced (they had drifted behind at 2026.10.6).

## 2026.10.7 — 2026-10-17

**Fixes**

- **Connect-advert stale guard no longer defeated by snapshot rewrite** (#42):
  `writeNodeStatusSnapshot` now carries `lastAdvertAt`/`advertScope` forward
  from the previous snapshot when rebuilding from SelfInfo on a clean
  reconnect handshake. The monitor's `shouldSkipConnectAdvert` guard can
  again prove freshness, stopping zero-hop advert spam on every ~35-minute
  stale-socket reconnect.

**Refactors**

- **Migrated off deprecated `openclaw/plugin-sdk/inbound-envelope`** (#43):
  replaced the single `resolveInboundRouteEnvelopeBuilderWithRuntime` call
  with the explicit modern sequence — `resolveAgentRoute` for routing,
  `resolveInboundSessionEnvelopeContext` for session store path / previous
  timestamp / envelope options, and `createChannelInboundEnvelopeBuilder`
  for envelope formatting. The deprecated module is no longer imported
  anywhere in the plugin.

**Tooling / tests**

- **Connect-advert integration coverage** (#41): two monitor-level tests now
  simulate the real reconnect snapshot rewrite and assert the correct send
  (stale/absent `lastAdvertAt`) or skip (fresh `lastAdvertAt`) outcome.
- **Envelope golden-format tests** (#43): direct-DM and group envelope
  strings are pinned so the SDK migration cannot silently change the
  agent-visible message format and shift existing sessions/history.

## 2026.10.6 — 2026-10-15

**Features**

- **Ed25519 challenge-response verification machinery** (#31, cycle 3): the
  verifier half of the tier-3 challenge-response design —
  `verifyEd25519Signature` (length-guarded, **strict RFC 8032** verification
  with `zip215: false`, after adversarial review proved noble's cofactored
  default accepts small-order-key forgeries), canonical single-use
  challenges (domain separator + 16-byte nonce + timestamp + verifier-pubkey
  binding), and `verifyChallengeResponse` with a ±10 min freshness window.
  Proven by 16 known-answer/tamper/forgery tests and a maintenance-window
  self-test against the node's signing oracle. Intentionally not wired into
  the inbound DM path yet — no signing-capable peer exists today.

**Fixes**

- **Advert log lines now reach gateway.log** (#38): scheduler send/skip/fail
  lines were wired to the plugin child logger, which never reached
  gateway.log; they now route via console.*, and every send carries a
  trigger tag (`connect` / `interval` / `manual`) so scheduled sends are
  distinguishable from connect sends. Failure lines carry the trigger too.
- **V1 contact-book migration no longer writes a stale cross-account
  discovery summary** (#37): migration persisted with an accountId-less
  change event, producing a permanently stale `meshcore-discovery.json` on
  multi-account installs.
- **Pre-connect SelfInfo listener disposed on TCP-connect failure** (#22):
  the fetcher's early listener no longer leaks on discarded connections
  after refused or timed-out connects.
- **Discovery summary flushes on channel stop** (#37): pending throttled
  writes are flushed during cleanup instead of being lost to shutdown.
- **State files pretty-printed uniformly** (#37): contact book and identity
  bindings now match node-status and discovery-summary formatting.

**Tooling / tests**

- openclaw devDependency exact-pinned at 2026.10.1; @noble/curves added as an
  exact-pinned direct dependency (1.9.7).
- Test infrastructure: node-status path override is now reset *before* being
  set in the monitor and advert-scheduler test hooks, eliminating cross-test
  state leakage through the shared vitest-state file.
- Regression pins: console-routing spies for the advert log path (#38 M1),
  connect-failure listener-count test (#22), V1-migration stale-summary
  test (#37), connect-advert stale-guard unit tests (#37).

**Docs**

- USAGE.md: discovery-summary throttle semantics; advert send/skip/fail
  audit trail with trigger tags.

## 2026.10.5 — 2026-10-11

**Fixes**

- **OpenClaw 2026.10.1+ compatibility: migrated off removed SDK compat
  aliases.** `channel-lifecycle`, `channel-message`, and `infra-runtime` were
  retired in OpenClaw 2026.10.1 (October 1 SDK subpath window); the plugin
  failed to load on current stable. All four affected imports
  (`createAccountStatusSink`, `defineChannelMessageAdapter`,
  `createMessageReceiptFromOutboundResults`/`MessageReceipt`,
  `sanitizeForPlainText`) now come from the canonical
  `openclaw/plugin-sdk/channel-outbound`, which exports them on both pre- and
  post-2026.10 hosts — verified by exports-map resolution of all 27 SDK
  subpaths in the built artifact against openclaw@2026.10.1.

## 2026.10.4 — 2026-10-11

**Features**

- **Inbound SignedPlain identity hardening** (#31, cycle 2): the plugin now
  captures and classifies the 4-byte sender prefix on SignedPlain (txtType 2)
  DMs — `pubkey-first4` / `pubkey-last4` / `constant-unknown` / `varying` —
  and exposes an `identityBinding` verdict (`extended` / `prefix-only` /
  `mismatch`) plus trust provenance in the agent-visible message envelope
  (via `ChannelStructuredContext`). Per-account v2 identity store with
  automatic legacy v1 migration; lossy frames never poison the observation
  window. Groundwork for cryptographic sender consistency on mesh DMs.
- **Outbound SignedPlain support** (#40): new config-gated
  `outboundSignedPlain` (default **off**) sends DMs as txtType 2 and reserves
  4 bytes of chunk budget for the sender-prefix field. Live-proven capable
  (signed DM received on MeshOS); reliability across the air path is still
  being characterized — enable for testing, not production.

**Docs**

- Node signing oracle **live-proven** (CMD_DEVICE_SIGN: Ed25519 signature over
  a known message verified against the node pubkey; tamper control correctly
  fails) — README security model + AGENT-SCOPING tier-3 foundation note.
- Changelog-driven publish flow: this file now feeds `clawhub package
  publish --changelog` (docs/PUBLISHING.md).

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
