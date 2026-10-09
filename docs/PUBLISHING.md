# Publishing to ClawHub

How this plugin is released to the ClawHub registry, written down the day the
first release shipped (2026-10-08, `@fintlp/openclaw-meshcore@2026.10.1`).
Everything on this page was learned by doing it — including the one attempt
the registry **rejected**, and why.

## Prerequisites

- The `clawhub` CLI: `npm i -g clawhub` (or `pnpm add -g clawhub`).
- A ClawHub account with the publisher handle matching the package scope
  (ours: `@fintlp`). Authenticate with `clawhub login` — the default is an
  interactive **device flow**: it prints a verification URL + short code, you
  approve in any browser, the token is stored on the machine. On a headless
  box use `clawhub login --no-browser` and relay the URL/code to a human.
  `clawhub whoami` verifies the token.

## The metadata contract (all required, all verified by the inspector)

ClawHub validates the **packed artifact**, not the source tree. A package can
pass `clawhub package validate .` and still be blocked at publish time —
that is exactly what happened to our first attempt.

1. **Scope = owner.** The package name must be scoped and the scope must be
   the publish owner: `@fintlp/openclaw-meshcore`. An unscoped
   `openclaw-meshcore` cannot publish as `@fintlp`. Also update
   `openclaw.install.npmSpec` / `clawhubSpec` to the scoped name.
2. **Runtime entrypoints for built packages.** `openclaw.extensions` and
   `openclaw.setupEntry` point at TypeScript *sources* (`./index.ts`,
   `./setup-entry.ts`) — those files are **not** in the published tarball
   (`files` ships only `dist/**`, the manifest, README, LICENSE). The
   inspector rejects this as `package-entrypoint-missing`. The fix is **not**
   to rewrite the source entries — it is to declare the built-JS entries in
   the parallel fields:
   ```json
   "runtimeExtensions": ["./dist/index.js"],
   "runtimeSetupEntry": "./dist/setup-entry.js"
   ```
3. **Manifest display name.** `openclaw.plugin.json` needs a human-readable
   `name` (ours: `"MeshCore"`); `id` stays the stable machine id.
4. **Install metadata.** `openclaw.release.publishToClawHub: true` requires
   `openclaw.install.clawhubSpec` — otherwise
   `package-install-metadata-incomplete`.
5. **Compat fields.** `openclaw.compat.pluginApi` and
   `openclaw.build.openclawVersion` (both `>=2026.5.26` / `2026.5.26` here).
6. **Intentional warning we keep.** `channel-env-vars` (deprecation): the
   legacy `channelEnvVars` manifest field must *stay* while the supported
   host range (≥2026.5.26) still needs it. This warning is expected; do not
   "fix" it by deleting the field.

## The release flow

```bash
npm run build                       # fresh dist/ (prepack also does this)
clawhub package validate .          # inspector: expect PASS, only the intentional warning above
clawhub package publish . --dry-run # shows exact payload + source commit; nothing is published
# changelog: the versions page reads --changelog text (NO retroactive edit exists —
# forget it and the release shows "No changelog provided" forever). Source: CHANGELOG.md.
clawhub package publish . --changelog "$(awk '/^## <VERSION>/{f=1;next} /^## /{f=0} f' CHANGELOG.md)"
```

- Keep CHANGELOG.md current as features land (it is the canonical source for
  the `--changelog` text); versions before 2026.10.4 predate the flag and
  permanently show no changelog on the registry.

- The publish reads the **GitHub source** (`github:fintlp/openclaw-meshcore@main`),
  so commit + push everything first — the dry-run prints the exact commit it
  will package.
- **Asymmetry #2 (learned 2026-10-08, v2026.10.2):** the SERVER-side publish
  inspector can warn on things the local `validate` never reports (it flagged
  `manifest-unknown-fields` while local validate was clean — CLI-bundled
  inspector vs newer server schema). Always read the real publish output even
  when validate is clean; warnings are P2 and non-blocking.
- After a blocked attempt there is a short **rate-limit window** (~1 min,
  the error prints the reset time). Wait it out; do not hammer.
- Inspector reports land in `reports/` — gitignored, do not commit.
- Versioning is date-based: `2026.10.x` (bump `package.json#version` per release).

## After publishing

New releases are **not immediately public**: ClawHub runs automated security
scans and keeps the release off install surfaces until they pass. That review
window is normal — check status with `clawhub package explore` /
`clawhub package inspect @fintlp/openclaw-meshcore`. Once live:

```bash
openclaw plugins install clawhub:@fintlp/openclaw-meshcore
```

Record each release in the tracker (issue #2 is the release hub) with the
commit SHA and the inspector state.

## First-release timeline (2026-10-08, for reference)

1. Pre-flight: adversarial security sweep (SHIP, zero MUST), privacy gate
   re-verified, position-admin live-proven, repo flipped public.
2. `validate` → PASS with 3 metadata warnings → fixed (display name,
   clawhubSpec; scope rename) → PASS with the 1 intentional warning.
3. `publish` attempt 1 → **blocked**: `package-entrypoint-missing`
   (TS source entries not in the packed artifact) → fixed via
   `runtimeExtensions`/`runtimeSetupEntry`.
4. `publish` attempt 2 → submitted; pending security scans.
5. Release commits: security docs `9ee0337`/`7d804cd`, scope `daa26ce`,
   inspector metadata `d2e609b`, runtime entries `5108199`.
