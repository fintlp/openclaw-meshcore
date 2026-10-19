# Contributing to openclaw-meshcore

## Testing

```bash
npm run typecheck && npm run test && npm run build
```

The suite carries three guards that exist because each of them once burned
production — keep them green, and extend them instead of deleting:

- **SDK surface guard** (`src/sdk-surface.test.ts`) — scans the shipped
  sources at test time and asserts every `openclaw/plugin-sdk/*` value
  import exists as a real export of the installed host package. A host
  release that removes an export fails this test before release, not at
  gateway boot. Before upgrading a gateway host, run it against the target
  release: `npm i -D openclaw@<target> && npx vitest run sdk-surface`.
- **Gateway lifecycle test** (`src/gateway.lifecycle.test.ts`) — the
  monitor handle contract: start resolves a handle with `stop()`, abort
  calls it exactly once, the lifecycle resolves after the stop.
- **State isolation** (`tests/setup.ts` via vitest `setupFiles`, plus
  `src/test-isolation.guard.test.ts`) — every test worker redirects
  `OPENCLAW_STATE_DIR` and `TMPDIR` into a per-run root that is deleted
  in `afterAll`, pass or fail; a tripwire fails the file if anything
  lands in the inherited temp dir. Never let a test write into the
  operator's real `~/.openclaw` state — the gateway exports
  `TMPDIR=~/.openclaw/tmp` to child processes, so an unredirected
  `mkdtemp` lands inside live state.


## Adding or changing a channel config field

The MeshCore channel config is defined in **two** places that must stay in sync:

1. **`src/meshcore-channel-config.schema.json`** — the canonical JSON Schema source.
   - `properties` describes the root `channels.meshcore` object.
   - `$defs.account.properties` describes each entry in `channels.meshcore.accounts`.
2. **`src/config-schema.ts`** — the hand-written Zod schema used at runtime.
   - `MeshcoreConfigSchema` describes the root config.
   - `MeshcoreAccountSchema` describes each per-account config.

The manifest (`openclaw.plugin.json`) is **generated**. Do not edit its
`channelConfigs.meshcore.schema` block by hand.

### Workflow

1. Edit the canonical JSON Schema in `src/meshcore-channel-config.schema.json`.
   - Add the field to `properties` for the root config.
   - Add it to `$defs.account.properties` too if it also belongs on per-account configs.
   - Keep both copies identical for shared fields.

2. Mirror the change in `src/config-schema.ts`:
   - Add the field to `MeshcoreAccountSchemaBase` so it appears in both the root
     and per-account Zod schemas (unless it is root-only, like `accounts` or
     `defaultAccount`).

3. Regenerate the manifest:
   ```bash
   npm run sync-manifest
   ```

4. Verify the drift guards pass:
   ```bash
   npm run typecheck
   npm run test
   npm run build
   ```

The test `committed manifest matches sync-manifest output` will fail if you
forget to run `npm run sync-manifest`. The test `canonical and manifest schemas
match zod keys` will fail if the Zod schema and canonical JSON Schema disagree
on which keys exist.

### Why two sources?

- The JSON Schema is the single source of truth for the plugin manifest and for
  any external JSON-Schema consumers (OpenClaw Control UI, validation tools).
- The Zod schema is the runtime source of truth: it supplies defaults, performs
  cross-field refinement (e.g. `dmPolicy="open"` requires `allowFrom: ["*"]`),
  and gives TypeScript types to the rest of the plugin.

Keeping them aligned is enforced by tests, not by a heavy Zod-to-JSON-Schema
converter.

## Releasing

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for the ClawHub release flow and
the metadata contract the registry inspector enforces (including the
runtime-entrypoint trap that blocked the first attempt).
