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

Hardening pointers:

- Keep `dmPolicy: "pairing"` (or an explicit `allowFrom` list).
- Keep group monitoring `disabled`, or in digest mode, unless you deliberately
  need channel-triggered sessions.
- Choose an advertised GPS position (`advertLat`/`advertLon`) that you are
  comfortable sharing with every node in range.
