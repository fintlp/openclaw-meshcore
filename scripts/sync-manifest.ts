import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MeshcoreChannelConfigSchema } from "../src/config-schema.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "openclaw.plugin.json");
const packageJsonPath = path.join(repoRoot, "package.json");

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
manifest.channelConfigs = {
  ...(typeof manifest.channelConfigs === "object" && manifest.channelConfigs
    ? manifest.channelConfigs
    : {}),
  meshcore: {
    label: channelMeta.label ?? "MeshCore",
    description:
      channelMeta.blurb ?? "LoRa mesh messaging via MeshCore Companion Protocol over TCP.",
    schema: MeshcoreChannelConfigSchema.schema,
    uiHints: MeshcoreChannelConfigSchema.uiHints,
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("synced channelConfigs.meshcore in openclaw.plugin.json");
