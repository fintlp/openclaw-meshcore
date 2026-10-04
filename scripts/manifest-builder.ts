import type { meshcoreChannelConfigUiHints } from "../src/config-ui-hints.js";

export interface PackageJson {
  openclaw?: {
    channel?: {
      label?: string;
      blurb?: string;
    };
  };
}

export function buildChannelConfigSchemaFromCanonical(canonicalSchema: Record<string, unknown>): {
  root: Record<string, unknown>;
  account: Record<string, unknown>;
} {
  const canonicalProperties = canonicalSchema.properties as Record<string, unknown>;
  const account = (canonicalSchema.$defs as Record<string, Record<string, unknown>>).account;

  // Root channel config schema: everything except the internal $defs block.
  const root: Record<string, unknown> = { ...canonicalSchema };
  delete root.$defs;

  // Per-account schema is the canonical account definition. The sync script
  // injects it under channelConfigs.meshcore.schema.properties.accounts.additionalProperties.
  return { root, account };
}

export function buildManifest(
  manifest: Record<string, unknown>,
  packageJson: PackageJson,
  canonicalSchema: Record<string, unknown>,
  uiHints: typeof meshcoreChannelConfigUiHints,
): Record<string, unknown> {
  const channelMeta = packageJson.openclaw?.channel ?? {};
  const { root, account } = buildChannelConfigSchemaFromCanonical(canonicalSchema);

  // Stitch the account schema into the root schema's accounts property.
  const rootProperties = { ...(root.properties as Record<string, unknown>) };
  const accountsProperty = { ...(rootProperties.accounts as Record<string, unknown>) };
  accountsProperty.additionalProperties = account;
  rootProperties.accounts = accountsProperty;
  root.properties = rootProperties;

  return {
    ...manifest,
    channelConfigs: {
      ...(typeof manifest.channelConfigs === "object" && manifest.channelConfigs
        ? manifest.channelConfigs
        : {}),
      meshcore: {
        label: channelMeta.label ?? "MeshCore",
        description:
          channelMeta.blurb ?? "LoRa mesh messaging via MeshCore Companion Protocol over TCP.",
        schema: root,
        uiHints,
      },
    },
  };
}
