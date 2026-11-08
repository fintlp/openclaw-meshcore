import { describe, expect, it } from "vitest";
import { sendMessageMeshcore } from "./send.js";

// Replaces the deprecated SDK helper requireRuntimeConfig
// (openclaw/plugin-sdk/plugin-config-runtime). A send without a resolved
// config must still fail fast, before any device access.
describe("sendMessageMeshcore config guard", () => {
  it("rejects when no resolved runtime config is passed", async () => {
    await expect(
      sendMessageMeshcore("!00000001", "hi", { cfg: undefined } as unknown as Parameters<typeof sendMessageMeshcore>[2]),
    ).rejects.toThrow("MeshCore send requires a resolved runtime config");
  });
});
