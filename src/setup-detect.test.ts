import { describe, expect, it } from "vitest";
import { diagnoseMeshcoreProbeFailure, splitHostPort } from "./setup-detect.js";

describe("splitHostPort", () => {
  it("returns plain hosts untouched", () => {
    expect(splitHostPort("node.local")).toEqual({ host: "node.local" });
    expect(splitHostPort("192.168.1.226")).toEqual({ host: "192.168.1.226" });
  });

  it("splits host:port on the last colon when the suffix is numeric", () => {
    expect(splitHostPort("node.local:5000")).toEqual({ host: "node.local", port: 5000 });
    expect(splitHostPort(" 192.168.1.226:5001 ")).toEqual({ host: "192.168.1.226", port: 5001 });
  });

  it("treats non-numeric or out-of-range suffixes as part of the host", () => {
    expect(splitHostPort("weird:abc")).toEqual({ host: "weird:abc" });
    expect(splitHostPort("node:")).toEqual({ host: "node:" });
    expect(splitHostPort("node:0")).toEqual({ host: "node:0" });
    expect(splitHostPort("node:99999")).toEqual({ host: "node:99999" });
  });

  it("handles empty input", () => {
    expect(splitHostPort("")).toEqual({ host: "" });
    expect(splitHostPort("   ")).toEqual({ host: "" });
  });
});

describe("diagnoseMeshcoreProbeFailure", () => {
  it("maps ECONNREFUSED to nothing-listening with TCP-server hint", () => {
    const diagnosis = diagnoseMeshcoreProbeFailure({
      host: "192.168.1.226",
      port: 5000,
      error: "connect ECONNREFUSED 192.168.1.226:5000",
    });
    expect(diagnosis.summary).toMatch(/Nothing is listening/);
    expect(diagnosis.hints.join(" ")).toMatch(/TCP server/);
  });

  it("maps socket-closed-before-connected to the busy-slot rule", () => {
    const diagnosis = diagnoseMeshcoreProbeFailure({
      host: "node.local",
      port: 5000,
      error: "MeshCore TCP socket closed before connected",
    });
    expect(diagnosis.summary).toMatch(/dropped it/);
    expect(diagnosis.hints.join(" ")).toMatch(/ONE companion client/);
  });

  it("maps SelfInfo timeouts to the stalled-handshake/busy-slot rule", () => {
    const diagnosis = diagnoseMeshcoreProbeFailure({
      host: "node.local",
      port: 5000,
      error: "timeout waiting for SelfInfo (8000ms)",
    });
    expect(diagnosis.summary).toMatch(/never identified itself/);
    expect(diagnosis.hints.join(" ")).toMatch(/companion handshake stalled/);
    expect(diagnosis.hints.join(" ")).toMatch(/ONE companion client/);
  });

  it("maps generic timeouts to network path problems (incl. dead battery)", () => {
    const diagnosis = diagnoseMeshcoreProbeFailure({
      host: "node.local",
      port: 5000,
      error: "MeshCore TCP connect timeout (8000ms)",
    });
    expect(diagnosis.summary).toMatch(/did not answer in time/);
    expect(diagnosis.hints.join(" ")).toMatch(/VLAN|isolation/i);
    expect(diagnosis.hints.join(" ")).toMatch(/dead battery/i);
  });

  it("falls back to generic guidance that still teaches the one-client rule", () => {
    const diagnosis = diagnoseMeshcoreProbeFailure({
      host: "node.local",
      port: 5000,
      error: "something entirely unexpected",
    });
    expect(diagnosis.summary).toMatch(/Could not reach/);
    expect(diagnosis.hints.join(" ")).toMatch(/ONE companion client/);
  });
});
