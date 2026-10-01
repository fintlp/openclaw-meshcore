import { describe, expect, it } from "vitest";
import { resolveMeshcoreAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("resolveMeshcoreAccount", () => {
  it("defaults to tcp with port 5000", () => {
    const account = resolveMeshcoreAccount({
      cfg: {
        channels: {
          meshcore: {
            host: "192.168.1.5",
          },
        },
      } as CoreConfig,
    });
    expect(account.transport).toBe("tcp");
    expect(account.port).toBe(5000);
    expect(account.configured).toBe(true);
  });

  it("parses host with port suffix", () => {
    const account = resolveMeshcoreAccount({
      cfg: {
        channels: {
          meshcore: {
            host: "192.168.1.5:6000",
          },
        },
      } as CoreConfig,
    });
    expect(account.host).toBe("192.168.1.5");
    expect(account.port).toBe(6000);
  });

  it("uses explicit port when provided", () => {
    const account = resolveMeshcoreAccount({
      cfg: {
        channels: {
          meshcore: {
            host: "192.168.1.5",
            port: 7000,
          },
        },
      } as CoreConfig,
    });
    expect(account.port).toBe(7000);
  });

  it("defaults channels to [0]", () => {
    const account = resolveMeshcoreAccount({
      cfg: {
        channels: {
          meshcore: {
            host: "192.168.1.5",
          },
        },
      } as CoreConfig,
    });
    expect(account.config.channels).toEqual([0]);
  });

  it("is not configured without host", () => {
    const account = resolveMeshcoreAccount({
      cfg: {
        channels: {
          meshcore: {},
        },
      } as CoreConfig,
    });
    expect(account.configured).toBe(false);
  });
});
