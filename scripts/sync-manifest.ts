import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "./manifest-builder.js";
import { meshcoreChannelConfigUiHints } from "../src/config-ui-hints.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "openclaw.plugin.json");
const packageJsonPath = path.join(repoRoot, "package.json");
const canonicalSchemaPath = path.join(repoRoot, "src/meshcore-channel-config.schema.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Parameters<
  typeof buildManifest
>[1];
const canonicalSchema = JSON.parse(
  fs.readFileSync(canonicalSchemaPath, "utf8"),
) as Parameters<typeof buildManifest>[2];

const updatedManifest = buildManifest(manifest, packageJson, canonicalSchema, meshcoreChannelConfigUiHints);

fs.writeFileSync(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`);
console.log("synced channelConfigs.meshcore in openclaw.plugin.json");
