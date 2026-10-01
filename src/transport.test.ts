import { describe, expect, it } from "vitest";
import { defaultPortForTransport, formatMeshcoreEndpoint, normalizeMeshcoreTransport } from "./transport.js";

describe("meshcore transport helpers", () => {
  it("normalizes transport names", () => {
    expect(normalizeMeshcoreTransport("TCP")).toBe("tcp");
    expect(normalizeMeshcoreTransport("tcp")).toBe("tcp");
    expect(normalizeMeshcoreTransport(undefined)).toBe("tcp");
    expect(normalizeMeshcoreTransport("ble")).toBe("tcp");
  });

  it("picks default port", () => {
    expect(defaultPortForTransport()).toBe(5000);
  });

  it("formats endpoints for status output", () => {
    expect(
      formatMeshcoreEndpoint({
        host: "127.0.0.1",
        port: 5000,
      }),
    ).toBe("127.0.0.1:5000");
  });
});
