import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rememberContact,
  resetContactBookForTests,
  setContactBookPathForTests,
} from "./contact-book.js";
import { bytesToHex, hexToBytes } from "./protocol.js";
import { clearSendRateLimitState } from "./rate-limit.js";
import {
  formatHeardAge,
  formatNeighboursReply,
  queryNodeNeighbours,
  RepeaterOpsTargetError,
  runRepeaterOpsCommand,
  type RepeaterNeighboursResult,
} from "./repeater-ops.js";
import type { MeshcoreDeviceHandle } from "./device-client.js";
import type { ResolvedMeshcoreAccount } from "./accounts.js";

const accountId = "default";

const REPEATER_PUBKEY_HEX =
  "aabbccdd11223344556677889900aabbccddeeff00112233445566778899aabb";
const REPEATER_PUBKEY = hexToBytes(REPEATER_PUBKEY_HEX);

const FIELD_NODE_PUBKEY_HEX = "0011223344556677" + "99".repeat(24);
const FIELD_NODE_PUBKEY = hexToBytes(FIELD_NODE_PUBKEY_HEX);

function createAccount(overrides?: Partial<ResolvedMeshcoreAccount>): ResolvedMeshcoreAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    transport: "tcp",
    host: "192.0.2.10",
    port: 5000,
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "disabled",
      groupAllowFrom: [],
      channels: [0],
    },
    ...overrides,
  } satisfies ResolvedMeshcoreAccount;
}

function createDeviceHandle(connectionOverrides: Record<string, unknown>): MeshcoreDeviceHandle {
  const emitter = new EventEmitter();
  return {
    accountId,
    connection: {
      on: emitter.on.bind(emitter),
      off: emitter.off.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      ...connectionOverrides,
    },
    contacts: [],
    channels: [],
    connected: true,
  } as unknown as MeshcoreDeviceHandle;
}

describe("repeater ops: neighbours query (issue #35)", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-repeater-ops-"));
    setContactBookPathForTests(join(dir, "contacts.json"));
    resetContactBookForTests();
    rememberContact({ publicKey: REPEATER_PUBKEY, advName: "HillRepeater" }, accountId);
    rememberContact({ publicKey: FIELD_NODE_PUBKEY, advName: "FieldNode1" }, accountId);
  });

  afterEach(() => {
    resetContactBookForTests();
    setContactBookPathForTests(undefined);
    clearSendRateLimitState();
  });

  it("resolves a contact prefix and normalizes neighbours with contact names", async () => {
    const getNeighbours = vi.fn(async () => ({
      totalNeighboursCount: 2,
      neighbours: [
        {
          // Matches the seeded FieldNode1 contact (8-byte prefix).
          publicKeyPrefix: FIELD_NODE_PUBKEY.slice(0, 8),
          heardSecondsAgo: 125,
          snr: 5.5,
        },
        {
          publicKeyPrefix: hexToBytes("ff00ff00ff00ff00"),
          heardSecondsAgo: 9,
          snr: -1.25,
        },
      ],
    }));
    const handle = createDeviceHandle({ getNeighbours });

    const { targetLabel, result } = await queryNodeNeighbours({
      account: createAccount(),
      targetArg: "aabbccdd1122",
      deviceHandle: handle,
    });

    expect(getNeighbours).toHaveBeenCalledTimes(1);
    const [pubkey, count, offset, orderBy, prefixLen] = getNeighbours.mock.calls[0];
    expect(bytesToHex(pubkey as Uint8Array)).toBe(REPEATER_PUBKEY_HEX);
    expect([count, offset, orderBy, prefixLen]).toEqual([8, 0, 0, 8]);

    expect(targetLabel).toBe("HillRepeater");
    expect(result.totalNeighboursCount).toBe(2);
    expect(result.neighbours).toEqual([
      {
        prefixHex: FIELD_NODE_PUBKEY_HEX.slice(0, 16),
        heardSecondsAgo: 125,
        snrDb: 5.5,
        name: "FieldNode1",
      },
      {
        prefixHex: "ff00ff00ff00ff00",
        heardSecondsAgo: 9,
        snrDb: -1.25,
        name: undefined,
      },
    ]);
  });

  it("rejects an unknown node argument before touching the radio", async () => {
    const getNeighbours = vi.fn();
    const handle = createDeviceHandle({ getNeighbours });

    await expect(
      queryNodeNeighbours({
        account: createAccount(),
        targetArg: "not-a-node",
        deviceHandle: handle,
      }),
    ).rejects.toBeInstanceOf(RepeaterOpsTargetError);
    expect(getNeighbours).not.toHaveBeenCalled();
  });

  it("formats the reply with the total, a showing note, ages and SNR", () => {
    const result: RepeaterNeighboursResult = {
      totalNeighboursCount: 11,
      neighbours: [
        {
          prefixHex: "0011223344556677",
          heardSecondsAgo: 125,
          snrDb: 5.5,
          name: "FieldNode1",
        },
        {
          prefixHex: "ff00ff00ff00ff00",
          heardSecondsAgo: 8,
          snrDb: -1.25,
        },
      ],
    };

    expect(formatNeighboursReply("HillRepeater", result)).toBe(
      "HillRepeater hears 11, showing 2: " +
        "001122334455(FieldNode1) 2m 5.5dB; ff00ff00ff00 8s -1.3dB",
    );
  });

  it("formats an empty neighbour set without a list", () => {
    expect(
      formatNeighboursReply("HillRepeater", { totalNeighboursCount: 0, neighbours: [] }),
    ).toBe("HillRepeater reports no neighbours");
  });

  it("formats heard ages compactly", () => {
    expect(formatHeardAge(0)).toBe("0s");
    expect(formatHeardAge(45)).toBe("45s");
    expect(formatHeardAge(125)).toBe("2m");
    expect(formatHeardAge(10_000)).toBe("2h");
    expect(formatHeardAge(200_000)).toBe("2d");
  });

  it("fails soft when the gateway has no connected node", async () => {
    // No deviceHandle override and no registered device: the module-level
    // device map is empty in this test file, so the op reports unavailability
    // instead of grabbing the one-client slot on demand.
    const reply = await runRepeaterOpsCommand({
      op: "neighbours",
      targetArg: "aabbccdd1122",
      account: createAccount(),
    });
    expect(reply).toBe("node not connected (gateway offline?) — try again later");
  });

  it("maps the library bare-string timeout to the soft no-answer reply", async () => {
    // meshcore.js rejects with the bare string "timeout" (not an Error).
    const getNeighbours = vi.fn(async () => {
      throw "timeout";
    });
    const reply = await runRepeaterOpsCommand({
      op: "neighbours",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: createDeviceHandle({ getNeighbours }),
    });
    expect(reply).toBe(
      "no answer from aabbccdd1122 (timeout) — target may not be a " +
        "repeater-class node, or out of range",
    );
  });

  it("maps the outer timeout race to the same soft no-answer reply", async () => {
    const getNeighbours = vi.fn(() => new Promise(() => {})); // never settles
    const reply = await runRepeaterOpsCommand({
      op: "neighbours",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: createDeviceHandle({ getNeighbours }),
      timeoutMs: 20,
    });
    expect(reply).toContain("no answer from aabbccdd1122 (timeout)");
  });

  it("refuses the request when the airtime budget is exhausted, before any frame", async () => {
    const account = createAccount({
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "disabled",
        groupAllowFrom: [],
        channels: [0],
        sendRateLimit: { enabled: true, maxSends: 1, windowMs: 600_000 },
      },
    });
    const getNeighbours = vi.fn(async () => ({ totalNeighboursCount: 0, neighbours: [] }));
    const handle = createDeviceHandle({ getNeighbours });

    const first = await runRepeaterOpsCommand({
      op: "neighbours",
      targetArg: "aabbccdd1122",
      account,
      deviceHandle: handle,
    });
    expect(first).toBe("HillRepeater reports no neighbours");

    const second = await runRepeaterOpsCommand({
      op: "neighbours",
      targetArg: "aabbccdd1122",
      account,
      deviceHandle: handle,
    });
    expect(second).toMatch(/^airtime budget exhausted — retry in ~\d+s \(LoRa airtime rule\)$/);
    // The second invocation never reached the radio.
    expect(getNeighbours).toHaveBeenCalledTimes(1);
  });

  it("answers with usage text when the node argument is missing", async () => {
    const reply = await runRepeaterOpsCommand({
      op: "neighbours",
      targetArg: "",
      account: createAccount(),
    });
    expect(reply).toMatch(/^usage: !neighbours <node>/);
  });

  it("returns a generic soft failure for unexpected library errors", async () => {
    const getNeighbours = vi.fn(async () => {
      throw new Error("socket exploded");
    });
    const reply = await runRepeaterOpsCommand({
      op: "neighbours",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: createDeviceHandle({ getNeighbours }),
    });
    expect(reply).toBe("query failed: socket exploded");
  });
});

