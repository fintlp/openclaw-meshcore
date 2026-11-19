# Security Policy

## Supported versions

This plugin uses date-based versioning (`2026.M.P`), and security fixes ship
on the latest release line. Only the newest release (the `latest` tag on
ClawHub) receives fixes — older releases are not patched individually. Please
upgrade before reporting issues against old versions.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub's private vulnerability
reporting:

- This repository → **Security** tab → **Advisories** → **Report a vulnerability**
- Direct link: <https://github.com/fintlp/openclaw-meshcore/security/advisories/new>

Please **do not open a public issue** for a vulnerability.

Helpful details to include:

- The plugin version you tested, and the OpenClaw host version.
- Steps to reproduce, or a proof of concept.
- The impact you see — in particular, what an attacker could make the agent
  or the node *do*.
- Whether triggering the issue requires radio access (being in LoRa range) or
  can be done remotely through the host.

What to expect:

- **Acknowledgment within 72 hours.**
- An assessment and a fix plan after triage. We practice coordinated
  disclosure: we agree on a public-advisory date with you once a fix is
  available, and we credit reporters in the advisory (unless you prefer
  otherwise).

If private reporting is unavailable for some reason, open a public issue that
says only that you would like a private contact — no technical details.

## Scope

In scope:

- This plugin's code: the outbound send path (including the group-transmit
  refusal), inbound message handling, pairing and allowlist enforcement,
  group-monitoring policy, and config validation.
- The release metadata and publish flow described in
  [docs/PUBLISHING.md](docs/PUBLISHING.md).

Out of scope:

- **OpenClaw core / the Gateway host** — please report to the OpenClaw project.
- **Radio firmware and the MeshCore protocol itself.**
- **Third-party dependencies** (for example `@liamcottle/meshcore.js`) — please
  report those upstream. We still want to hear about them when they affect
  this plugin.

## Security design

The headline safety property of this plugin is enforced in code, not in the
AI's instructions: **the agent can never transmit to a group channel.** The
send path refuses every group-addressed message unconditionally, and automated
tests pin the refusal. See the README's "Safety by default" and "Security
model" sections, and [docs/AGENT-SCOPING.md](docs/AGENT-SCOPING.md) for the
operator-level trust model.

### Group tool policy and activation

MeshCore group frames carry no radio-author identity. `groupAllowFrom` and
`groups.*.allowFrom` therefore retain only their existing channel-admission
behavior; they cannot authenticate individual group authors. The former
unenforced group-local `toolsBySender` key is rejected by runtime and manifest
validation in exact groups, wildcard groups, and named accounts. Migrate to a
single deliberately chosen `groups["channel:N"].tools` policy or the receiving
agent's policy.

OpenClaw's `groupScope: "main"` removes the group id required to resolve that
policy. Protected main-scoped turns are refused before durability intake, with
an operator log naming the account and channel; protected replays dead-letter
as `group-scope-main`. Set `session.groupScope: "per-group"` globally or in the
effective binding. Binding overrides are honored in both directions, and
unprotected groups remain eligible for main scope.

Group text commands cannot bypass `requireMention`. They are excluded from
command authorization before mention gating; a genuinely mentioned command is
passed to the agent as plain text with `CommandAuthorized: false` and
`CommandInterpretationSuppressed: true`. The production digest early return,
default-disabled group policy, and receive-only outbound guard are unchanged.

### DM identity and approval enforcement

A stock MeshCore DM supplies only a six-byte public-key prefix. The plugin
accepts exactly six valid wire bytes and resolves them only against the
**receiving account's live synchronized contacts**, using full 32-byte keys.
Duplicate records for one key are deduplicated. Multiple candidate keys, a
conflicting same-prefix account-contact-book row, or a cross-account attempt
cannot establish identity. One bounded, account-coalesced refresh may update a
stale snapshot, followed by one new decision. A cache-only match never
establishes inbound identity.

The selected full key drives the canonical route, security facts, and reply
target. Outbound exact full-key targets remain usable without resolution;
abbreviated targets require unique account-scoped resolution and reject
ambiguity. `prefix-only` and `extended` identity grades are diagnostics only,
and a detected `mismatch` is refused.

Config `allowFrom` and pairing-store DM approvals require canonical `!` + 64
hex. Legacy prefixes, bare keys, names, and numbers are ignored with a bounded
warning and require operator reverification. Full-key chat allowlisting still
works. The wildcard remains chat access only: `dmPolicy: "open"` works only
for uniquely addressable peers and never proves owner or command authority.
See [docs/MIGRATION.md](docs/MIGRATION.md) for the required upgrade steps.

### Host commands, native commands, and owner routes

OpenClaw host text commands are disabled for **all MeshCore DMs pending #31**.
This item-6 change is DM-only: group command behavior is unchanged and remains
governed by `groupAllowFrom` together with the channel target. The native
`!ping`, `!status`, `!neighbours`, `!rstatus`, and `!trace`
surface is default-deny even for uniquely mapped or full-key-chat-allowlisted
peers. `commandRepliesEnabled` is only a feature toggle, never authorization.
The sole compatibility exception is an explicitly configured canonical
`commandPingAllowFrom` entry plus a unique current mapping, normal DM
admission, and enabled replies. Native ping replies have a separate budget of
3 per 10 minutes per account; no other native command inherits the exception.

A recognized blocked native command ends before pairing, durable intake, a
radio reply, or an agent/model turn. Suppressed slash-command text may enter
ordinary admitted chat as plain text with `CommandAuthorized: false` and
`CommandInterpretationSuppressed: true`. Native command rows are not replayed.

`commands.ownerAllowFrom` bare IDs/prefixes, `!`-prefixed IDs/prefixes, and
explicit `meshcore:` entries are matched only against current validated full-key facts. A match
refuses the whole mesh route **before a host turn** because owner-only tools
depend on `senderIsOwner`, not just `CommandAuthorized`. This intentionally
protects gateway, automation, and similarly privileged tools; a chat allowlist
or `CommandAuthorized: false` alone is not an adequate owner-tool boundary.
Non-MeshCore owner semantics are unchanged.

### Replay revalidation and upgrade dead-letters

Durable DM rows carry `rawJson.dmIdentityEvidence` version 1 with
`wirePrefixHex` (12 lowercase hex characters for the exact six wire bytes) and
`fullKeySha256`, the SHA-256 digest of the selected raw 32-byte full key. Replay
revalidates the current unique account mapping, digest, canonical route, and
current DM/config/command policy. Missing evidence dead-letters as
`dm-identity-no-evidence`; ambiguity and stale/changed mappings use
`dm-identity-ambiguous` and `dm-identity-stale`. Temporary contact-sync
failure releases the claim for bounded retry under existing attempt/replay
limits.

**Pre-upgrade queued DMs have no evidence and must be resent.** They are not
dispatched and cannot initiate pairing or execute a native command on replay.
Group-row behavior is unchanged, and native-command markers remain
non-replayable. Evidence records the mapping used at intake; it is not a
signature or cryptographic proof of origin.

### Per-session outbound load containment

`sessionSendRateLimit` is enforced inside the plugin's low-level send path after final SignedPlain/chunk-numbering packet computation, trimmed UTF-8 byte measurement, and target identity resolution (which may first connect to the node and sync contacts), before any radio frame and before the unchanged account guard. Defaults are 10 packets and 1270 bytes per resolved account + producing session per 10 minutes. Named accounts inherit the root object, while explicit partial overrides deep-merge field-by-field; only an explicit account `enabled: true` reverses a root opt-out. Synchronous admission charging makes concurrent bursts atomic and is deliberately not refunded after later delivery failure. Excess throws a typed error carrying `retryAfterMs` and emits exactly one metadata-only plugin warning (no body, session key, or full target); the host `onError` may additionally log that typed failure. Nothing is queued. One producing key shares its budget across fanout, so `dmScope: "main"` can be a tighter shared DM cap. Oversized single sends must be split or tuned because waiting alone will not admit them. Pairing/native replies remain exempt. Delivery retries spend the account budget per attempt while the session layer charges the admitted send once. Missing, empty, and whitespace-only keys are account-only. On 2026.10.5, host-driven adapter sends without a producing key are account-only, but plugin auto-replies still carry the route key and remain session-limited. Disabling this layer never affects account, pairing, native-ping, pacing, or retry guards. Usage is in memory and resets on restart. The entry registers no global message hooks, so it cannot flip Telegram's provider-preview gate or suppress legacy auto-replies with a lost cancellation reason.

### Pairing and reply load containment

Pairing is limited to 3 successfully replied-to new challenges per 10 minutes
per account, with a 60-second per-full-key cooldown and concurrent same-key
coalescing. The attempt is reserved synchronously before host pending state
exists, then released when the host reports already-pending or reply delivery
fails. Pre-host refusal creates no pending record, radio reply, or agent turn.

The pairing radio share is `min(3 × challengePackets, maxSends − 1)` chunks
plus retries per accounting window, preserving at least one normal-DM packet.
The real stock reply measures three chunks with the production chunker, so the
default share is 9 packets and three no-retry challenges fit. The ceiling
remains with `sendRateLimit.enabled: false`; retries draw down the same share.
The real reply is rejected before pending state for `maxSends` 1–3, while 4
fits one no-retry challenge. General send pacing, airtime accounting, and
multi-account radio sharing are unchanged. Native ping's 3/10-minute reply
budget is separate. Both pairing containment maps are in-memory and reset on
gateway restart, consistent with the existing limiter design.

On 2026.10.5 and 2026.11.3, the host catches `sendPairingReply` errors, calls
`onReplyError`, returns `created: true`, and retains the pending record until
its TTL; no plugin-facing pending-record revoke/expire API exists. The plugin
logs the failure and releases the reservation. Later attempts receive
`created: false`, coalesce without another reply, and do not consume the
account challenge budget.

### Recommended deployment boundary and residual risk

Bind mesh traffic to a **dedicated agent with an isolated workspace and a
narrow tool profile**, and keep safety-critical denials in the agent baseline.
For multi-account installations, use
`session.dmScope: "per-account-channel-peer"` so identities cannot share a DM
session across account/channel/peer boundaries.

OpenClaw's top-level `tools.toolsBySender` is separate from the removed
MeshCore group setting and can filter tools only as defense-in-depth; it
cannot authenticate a peer. The SDK currently exposes no plugin-native direct
per-DM tool-policy callback
([openclaw/openclaw#176348](https://github.com/openclaw/openclaw/issues/176348)).

A unique prefix mapping is routing evidence, **not cryptographic sender
authentication**. Contact refresh runs only for non-unique decisions, so a
colliding contact learned only radio-side can leave attribution on the old key
while firmware decrypts with one of the colliding keys. A malformed live
contact row invalidates the whole snapshot and refuses DMs until a clean
resync; this is deliberate fail-closed behavior, not a partial-identity
fallback. Identity grades and the replay digest do not supply owner or command
proof. Full SignedPlain verification remains necessary follow-up work in
[fintlp/openclaw-meshcore#31](https://github.com/fintlp/openclaw-meshcore/issues/31);
this release does not claim it. Keep owner-only operations on an independently
authenticated non-mesh channel and verify sensitive contacts out of band.

Hardening follow-up: DM ingress matching still includes `senderName` as a
compatibility candidate, although names cannot become canonical DM approvals.
Dropping that candidate is deferred and must not be mistaken for sender proof.

### Data at rest

The inbound durability log (issue #48, default on) stores admitted message
bodies in `state/meshcore-durability-<accountId>.sqlite` **only while work
is pending**: dispatched and dead-lettered rows are blanked in place
(SQLite `secure_delete` plus a WAL truncate checkpoint every hour — the
store lives for the process lifetime, so the checkpoint, not close, is the
real mechanism), leaving dedupe keys and metadata (sender, timestamps,
attempts) on a 30-day / 50 000-event pruning budget. Pending bodies share the exposure class of the
host session store. Wire encryption (SignedPlain, channel PSKs) is unchanged
— the log never holds keys. Set `durability.enabled: false` to opt out, and
delete the `.sqlite` file and its `-wal`/`-shm` sidecars to remove any kept
copy.

Hardening pointers:

- Keep `dmPolicy: "pairing"` (or an explicit `allowFrom` list).
- Keep group monitoring `disabled`, or in digest mode, unless you deliberately
  need channel-triggered sessions.
- Choose an advertised GPS position (`advertLat`/`advertLon`) that you are
  comfortable sharing with every node in range.
