import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "meshcore",
  name: "MeshCore",
  description: "MeshCore mesh channel plugin via TCP transport",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "meshcorePlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMeshcoreRuntime",
  },
});
