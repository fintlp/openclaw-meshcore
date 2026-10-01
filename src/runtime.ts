import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const {
  setRuntime: setMeshcoreRuntime,
  clearRuntime: clearStoredMeshcoreRuntime,
  getRuntime: getMeshcoreRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "meshcore",
  errorMessage: "MeshCore runtime not initialized",
});
export { getMeshcoreRuntime, setMeshcoreRuntime };
export function clearMeshcoreRuntime() {
  clearStoredMeshcoreRuntime();
}
