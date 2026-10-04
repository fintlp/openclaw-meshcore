import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { meshcoreChannelConfigUiHints } from "../src/config-ui-hints.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "openclaw.plugin.json");
const packageJsonPath = path.join(repoRoot, "package.json");
const canonicalSchemaPath = path.join(repoRoot, "src/meshcore-channel-config.schema.json");

export function buildChannelConfigSchemaFromCanonical(): {
  root: Record<string, unknown>;
  account: Record<string, unknown>;
} {
  const canonical = JSON.parse(fs.readFileSync(canonicalSchemaPath, "utf8")) as Record<string, unknown>;
  const canonicalProperties = canonical.properties as Record<string, unknown>;
  const account = (canonical.$defs as Record<string, Record<string, unknown>>).account;

  // Root channel config schema: everything except the internal $defs block.
  const root: Record<string, unknown> = { ...canonical };
  delete root.$defs;

  // Per-account schema is the canonical account definition. The sync script
  // injects it under channelConfigs.meshcore.schema.properties.accounts.additionalProperties.
  return { root, account };
}

export function buildManifest(): Record<string, unknown> {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    openclaw?: {
      channel?: {
        label?: string;
        blurb?: string;
      };
    };
  };

  const channelMeta = packageJson.openclaw?.channel ?? {};
  const { root, account } = buildChannelConfigSchemaFromCanonical();

  // Stitch the account schema into the root schema's accounts property.
  const rootProperties = { ...(root.properties as Record<string, unknown>) };
  const accountsProperty = { ...(rootProperties.accounts as Record<string, unknown>) };
  accountsProperty.additionalProperties = account;
  rootProperties.accounts = accountsProperty;
  root.properties = rootProperties;

  manifest.channelConfigs = {
    ...(typeof manifest.channelConfigs === "object" && manifest.channelConfigs
      ? manifest.channelConfigs
      : {}),
    meshcore: {
      label: channelMeta.label ?? "MeshCore",
      description:
        channelMeta.blurb ?? "LoRa mesh messaging via MeshCore Companion Protocol over TCP.",
      schema: root,
      uiHints: meshcoreChannelConfigUiHints,
    },
  };

  return manifest;
}

const manifest = buildManifest();

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("synced channelConfigs.meshcore in openclaw.plugin.json");
