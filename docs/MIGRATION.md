# Migrating to the PR 2 DM security release

This release changes how MeshCore DMs are attributed, admitted, replayed, and
allowed to invoke commands. It is intentionally **not** a transparent upgrade
for every existing installation.

> **Before upgrading:** reverify your DM approvals, plan to resend old queued
> DMs, review native-command and owner-route usage, and check your pairing
> packet cap. There is no automatic config or pairing-store rewrite.

## 1. Reverify every legacy DM approval

DM approvals in both `channels.meshcore.allowFrom` (including per-account
configuration) and the OpenClaw pairing store now use one canonical form:

```text
!<64 hexadecimal characters>
```

That is `!` followed by the full 32-byte public key. For example:

```text
!0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Legacy 12-hex prefixes, bare public keys, advert names, numbers, and other
noncanonical entries are ignored for DM admission. The plugin emits a bounded
warning when it ignores them; it does not guess which peer you meant and does
not rewrite the entry.

1. For each still-trusted peer, obtain its **current full 32-byte key from the
   receiving account's synchronized contacts**. Verify that key with the peer
   out of band. A contact name, a cached prefix, or a key copied from another
   account is not sufficient verification.
2. Replace each legacy `allowFrom` entry with the canonical `!` + 64-hex form.
   Full-key chat allowlisting continues to work normally after this change.
3. For pairing-store approvals, have the peer send a fresh DM after the
   upgrade. Run `openclaw pairing list`, verify the pending full key out of
   band, and approve it through the normal owner-side flow:

   ```bash
   openclaw pairing approve meshcore <code>
   ```

   Old noncanonical store entries remain inert. Reapproving creates a current
   canonical approval; there is no automatic migration of the old entry.
4. Repeat this check for every configured MeshCore account. Identity and
   approvals are account-scoped.

The wildcard is unchanged only as a **chat-admission** setting:
`dmPolicy: "open"` still requires `allowFrom: ["*"]`, and it admits only
peers whose current identity resolves uniquely on the receiving account. The
wildcard never proves ownership and never grants host or native command
authority.

## 2. Resend pre-upgrade queued DMs

Durable DM rows written by an older release do not contain the required
versioned identity evidence. On replay after this upgrade they dead-letter as:

```text
dm-identity-no-evidence
```

They are not dispatched, do not start pairing, and do not execute a command.
**Ask the senders to resend every pre-upgrade queued DM that still matters.**
Do not synthesize evidence or restore the old rows as a substitute for a fresh
message.

New DM rows store `rawJson.dmIdentityEvidence` version 1 with
`wirePrefixHex` (12 lowercase hex characters for the exact six wire bytes) and
`fullKeySha256`, the SHA-256 digest of the raw 32-byte full key.
Replay revalidates the current unique account mapping, digest, canonical
route, and current DM/command policy before dispatch:

- `dm-identity-ambiguous` means the prefix no longer has one unambiguous
  candidate.
- `dm-identity-stale` covers a missing, changed, mismatched, or noncanonical
  mapping/route.
- A temporary contact-sync failure releases the claim for bounded retry under
  the existing attempt and replay limits; it is not treated as valid evidence.

Group-row behavior is unchanged. Native-command marker rows remain
non-replayable. Evidence records which mapping was used at intake; it is not a
signature and is not cryptographic proof of who transmitted the frame.

## 3. Review native commands and suppressed host commands

Stock prefix-addressed MeshCore DMs now have **no OpenClaw host command
authority**. A unique mapping, an extended/prefix-only diagnostic grade, or a
full-key chat allowlist entry does not change that.

The plugin-native commands `!ping`, `!status`, `!neighbours`,
`!rstatus`, and `!trace` are default-deny, including for uniquely mapped
and full-key-chat-allowlisted peers. `commandRepliesEnabled` is only a
feature toggle; setting it to `true` never authorizes a peer. There is no
config switch that re-enables the other native commands in this release.

A recognized blocked native command ends quietly before pairing, durable
intake, a radio reply, or an agent turn. Suppressed slash-command text may
still enter an ordinarily admitted DM as plain text, with
`CommandAuthorized: false` and `CommandInterpretationSuppressed: true`.

### Optional: retain only the explicit `!ping` compatibility exception

If you consciously need native `!ping`, add each verified full key to the
receiving account's `commandPingAllowFrom`:

```json
{
  "commandRepliesEnabled": true,
  "commandPingAllowFrom": [
    "!0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ]
}
```

The exception works only when **all** of these remain true:

- the entry is canonical `!` + 64 hex for the selected full key;
- the current receiving-account mapping is unique;
- the sender passes normal DM admission; and
- `commandRepliesEnabled` is enabled.

Native ping replies have a separate budget of **3 replies per 10 minutes per
account**. Removing an entry or setting `commandRepliesEnabled: false`
disables the exception. No other native command inherits this exception.

## 4. Remove reliance on mesh owner routes

`commands.ownerAllowFrom` bare IDs/prefixes, `!`-prefixed IDs/prefixes, and
explicit `meshcore:` entries are compared only with the current validated
full-key facts. If such an entry matches a MeshCore DM peer, the **whole DM route is
refused before a host turn**, including what would otherwise be ordinary chat.

This is intentional: OpenClaw owner-only tools depend on `senderIsOwner`,
not just `CommandAuthorized`. Without independent cryptographic proof,
allowing the session could expose gateway, automation, and similarly
privileged tools. Non-MeshCore owner semantics are unchanged.

Review your owner allowlist before upgrading. Use an independently
authenticated non-mesh owner channel for owner-only operations. Do not replace
a refused mesh owner entry with a wildcard or a chat allowlist and expect
owner authority; neither supplies it. SignedPlain verification is follow-up
work in
[fintlp/openclaw-meshcore#31](https://github.com/fintlp/openclaw-meshcore/issues/31),
not a proof mechanism in this release.

## 5. Check pairing request and packet budgets

Pairing now has two independent forms of containment.

### Request attempts

Each account permits at most **3 pairing attempts per 10 minutes**, with a
**60-second cooldown per full key**. Concurrent requests for the same key are
coalesced. The attempt is reserved synchronously before OpenClaw can create
pending pairing state. A refused attempt creates no pending record, radio
reply, or agent turn.

### Radio packets

Within each `sendRateLimit` accounting window, pairing may use at most:

```text
min(3, maxSends - 1)
```

This counts every pairing chunk and retry and preserves at least one packet
for normal DM traffic. The pairing ceiling still applies when
`sendRateLimit.enabled` is `false`. General send pacing, airtime
accounting, and multi-account radio sharing are otherwise unchanged; native
`!ping` has its own separate 3/10-minute reply budget.

Check low-cap configurations explicitly:

- `maxSends: 1` rejects pairing at intake, before pending state is created.
  Use explicit full-key allowlisting instead, or raise the cap.
- `maxSends: 2` permits one pairing packet in the window.
- Larger low caps can still be too small for a multi-chunk challenge or its
  retries. The real default challenge fits in at most three chunks, but a cap
  below three does not guarantee room for it.

Choose a cap that leaves the normal-DM allocation you need as well as the
pairing allocation you intend to use. A failed delivery after a live challenge
was accepted follows the existing host expiry and reply-error path; it does
not rewind the attempt budget.

## 6. Reconfirm the deployment boundary

Before returning the channel to service:

- Bind MeshCore traffic to a **dedicated agent** with an isolated workspace
  and a narrow tool profile. Keep safety-critical denials in the agent
  baseline rather than relying only on message text or admission policy.
- For multi-account installations, set
  `session.dmScope: "per-account-channel-peer"` so sessions do not mix
  account/channel/peer identities.
- Use OpenClaw's top-level `tools.toolsBySender` only as defense-in-depth
  tool filtering. It is separate from the removed MeshCore group setting and
  cannot authenticate a peer. The SDK currently has no plugin-native direct
  per-DM tool-policy callback
  ([openclaw/openclaw#176348](https://github.com/openclaw/openclaw/issues/176348)).
- Treat prefix mappings and `prefix-only` / `extended` grades as routing
  diagnostics, never as authentication. A detected `mismatch` is refused.
- Verify trusted peers out of band, resend old queued DMs, test that blocked
  native commands stay silent, and test any explicitly configured ping
  exception and pairing cap before relying on the channel.
