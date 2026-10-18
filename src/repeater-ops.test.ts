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
  formatRemoteStatusReply,
  formatTraceReply,
  normalizeTraceData,
  queryNodeNeighbours,
  queryRemoteNodeStatus,
  RepeaterOpsTargetError,
  runRepeaterOpsCommand,
  tracePathToNode,
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

describe("repeater ops: remote status request (issue #34)", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-repeater-ops-"));
    setContactBookPathForTests(join(dir, "contacts.json"));
    resetContactBookForTests();
    rememberContact({ publicKey: REPEATER_PUBKEY, advName: "HillRepeater" }, accountId);
  });

  afterEach(() => {
    resetContactBookForTests();
    setContactBookPathForTests(undefined);
    clearSendRateLimitState();
  });

  const SAMPLE_STATS = {
    batt_milli_volts: 12_140,
    curr_tx_queue_len: 2,
    noise_floor: -98,
    last_rssi: -45,
    n_packets_recv: 12_345,
    n_packets_sent: 6_789,
    total_air_time_secs: 1_234,
    total_up_time_secs: 190_080,
    n_sent_flood: 100,
    n_sent_direct: 200,
    n_recv_flood: 300,
    n_recv_direct: 400,
    err_events: 3,
    last_snr: 22, // quarter-dB: 5.5 dB
    n_direct_dups: 1,
    n_flood_dups: 2,
  };

  it("normalizes the library repeater stats (snr quarter-dB scaled)", async () => {
    const getStatus = vi.fn(async () => SAMPLE_STATS);
    const handle = createDeviceHandle({ getStatus });

    const { targetLabel, result } = await queryRemoteNodeStatus({
      account: createAccount(),
      targetArg: "aabbccdd1122",
      deviceHandle: handle,
    });

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(bytesToHex(getStatus.mock.calls[0][0] as Uint8Array)).toBe(REPEATER_PUBKEY_HEX);
    expect(targetLabel).toBe("HillRepeater");
    expect(result).toEqual({
      batteryMv: 12_140,
      txQueueLen: 2,
      noiseFloorDbm: -98,
      lastRssiDbm: -45,
      packetsRecv: 12_345,
      packetsSent: 6_789,
      airtimeSecs: 1_234,
      uptimeSecs: 190_080,
      sentFlood: 100,
      sentDirect: 200,
      recvFlood: 300,
      recvDirect: 400,
      errEvents: 3,
      lastSnrDb: 5.5,
      directDups: 1,
      floodDups: 2,
    });
  });

  it("formats the health readout compactly", async () => {
    const getStatus = vi.fn(async () => SAMPLE_STATS);
    const reply = await runRepeaterOpsCommand({
      op: "rstatus",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: createDeviceHandle({ getStatus }),
    });
    expect(reply).toBe(
      "HillRepeater bat:12.14V txq:2 nf:-98 rssi:-45 rx:12345 tx:6789 " +
        "air:20m up:2d err:3 snr:5.5 dup:1/2",
    );
  });

  it("scales a negative snr reading from quarter-dB", () => {
    expect(
      formatRemoteStatusReply("HillRepeater", {
        batteryMv: 3_900,
        txQueueLen: 0,
        noiseFloorDbm: -105,
        lastRssiDbm: -87,
        packetsRecv: 0,
        packetsSent: 0,
        airtimeSecs: 45,
        uptimeSecs: 59,
        sentFlood: 0,
        sentDirect: 0,
        recvFlood: 0,
        recvDirect: 0,
        errEvents: 0,
        lastSnrDb: -9 / 4,
        directDups: 0,
        floodDups: 0,
      }),
    ).toBe(
      "HillRepeater bat:3.90V txq:0 nf:-105 rssi:-87 rx:0 tx:0 air:45s up:59s " +
        "err:0 snr:-2.3 dup:0/0",
    );
  });

  it("maps the library bare-string timeout to the soft no-answer reply", async () => {
    const getStatus = vi.fn(async () => {
      throw "timeout";
    });
    const reply = await runRepeaterOpsCommand({
      op: "rstatus",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: createDeviceHandle({ getStatus }),
    });
    expect(reply).toContain("no answer from aabbccdd1122 (timeout)");
  });

  it("counts against the airtime budget before the request goes on air", async () => {
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
    const getStatus = vi.fn(async () => SAMPLE_STATS);
    const handle = createDeviceHandle({ getStatus });

    const first = await runRepeaterOpsCommand({
      op: "rstatus",
      targetArg: "aabbccdd1122",
      account,
      deviceHandle: handle,
    });
    expect(first).toMatch(/^HillRepeater bat:/);

    const second = await runRepeaterOpsCommand({
      op: "rstatus",
      targetArg: "aabbccdd1122",
      account,
      deviceHandle: handle,
    });
    expect(second).toMatch(/^airtime budget exhausted/);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it("answers with usage text when the node argument is missing", async () => {
    const reply = await runRepeaterOpsCommand({
      op: "rstatus",
      targetArg: "",
      account: createAccount(),
    });
    expect(reply).toMatch(/^usage: !rstatus <node>/);
  });
});


/**
 * Byte-level replica of meshcore.js onTraceDataPush (Connection class), used
 * to build the push payload from realistic wire bytes so the known-answer
 * tests below pin the FULL path: wire frame -> library parse -> our
 * normalization. Layout: reserved(1) pathLen(1) flags(1) tag(u32le)
 * auth(u32le) pathHashes(pathLen) pathSnrs(pathLen) lastSnr(int8, /4).
 */
function parseTraceDataFrameLikeTheLibrary(frame: Uint8Array): {
  reserved: number;
  pathLen: number;
  flags: number;
  tag: number;
  authCode: number;
  pathHashes: Uint8Array;
  pathSnrs: Uint8Array;
  lastSnr: number;
} {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const reserved = view.getUint8(0);
  const pathLen = view.getUint8(1);
  return {
    reserved,
    pathLen,
    flags: view.getUint8(2),
    tag: view.getUint32(3, true),
    authCode: view.getUint32(7, true),
    pathHashes: frame.slice(11, 11 + pathLen),
    pathSnrs: frame.slice(11 + pathLen, 11 + 2 * pathLen),
    lastSnr: view.getInt8(11 + 2 * pathLen) / 4,
  };
}

describe("repeater ops: trace path (issue #33)", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-repeater-ops-"));
    setContactBookPathForTests(join(dir, "contacts.json"));
    resetContactBookForTests();
    rememberContact({ publicKey: REPEATER_PUBKEY, advName: "HillRepeater" }, accountId);
    // Unique 0x4f-prefix contact: hop hash 4f resolves to this name.
    rememberContact(
      { publicKey: hexToBytes("4f" + "aa".repeat(31)), advName: "RelayA" },
      accountId,
    );
  });

  afterEach(() => {
    resetContactBookForTests();
    setContactBookPathForTests(undefined);
    clearSendRateLimitState();
  });

  it("KAT: parses a realistic 2-hop trace frame (negative SNR byte included)", () => {
    // Wire capture shape: 2 hops 4f -> 9c, hop SNRs 5.5 dB and -2.0 dB
    // (0xf8 = -8 quarter-dB), final link 5.0 dB, flags=1 (response).
    const frame = hexToBytes("00020178563412efbeadde4f9c16f814");
    const push = parseTraceDataFrameLikeTheLibrary(frame);

    const result = normalizeTraceData(push, accountId);

    expect(push.pathLen).toBe(2);
    expect(push.tag).toBe(0x12345678);
    expect(result).toEqual({
      hops: [
        { hashHex: "4f", snrDb: 5.5, name: "RelayA" },
        { hashHex: "9c", snrDb: -2, name: undefined },
      ],
      lastSnrDb: 5,
    });
    expect(formatTraceReply("HillRepeater", result)).toBe(
      "path to HillRepeater: 2 hops 4f(RelayA) 5.5dB > 9c -2.0dB (final-link 5.0dB)",
    );
  });

  it("KAT: parses a direct-path trace frame (zero hops)", () => {
    const frame = hexToBytes("0000010100000000000000" + "18");
    const push = parseTraceDataFrameLikeTheLibrary(frame);

    const result = normalizeTraceData(push, accountId);

    expect(result.hops).toEqual([]);
    expect(result.lastSnrDb).toBe(6);
    expect(formatTraceReply("HillRepeater", result)).toBe(
      "path to HillRepeater: direct (final-link 6.0dB)",
    );
  });

  it("leaves a hop unnamed when its hash byte is ambiguous in the contact book", () => {
    // A second 0x4f-prefix contact makes the 4f byte ambiguous.
    rememberContact(
      { publicKey: hexToBytes("4f" + "bb".repeat(31)), advName: "RelayB" },
      accountId,
    );
    const frame = hexToBytes("00010178563412efbeadde" + "4f" + "16" + "14");
    const push = parseTraceDataFrameLikeTheLibrary(frame);

    const result = normalizeTraceData(push, accountId);

    expect(result.hops).toEqual([{ hashHex: "4f", snrDb: 5.5, name: undefined }]);
  });

  it("never reads past the reported arrays when pathLen overclaims", () => {
    // Corrupt/truncated shape: pathLen says 3 hops but only 1 hash byte and
    // no SNR bytes follow. The min() guard must cap at the available data.
    const push = {
      pathLen: 3,
      pathHashes: new Uint8Array([0x4f]),
      pathSnrs: new Uint8Array(0),
      lastSnr: 1.5,
    };
    const result = normalizeTraceData(push, accountId);
    expect(result.hops).toEqual([{ hashHex: "4f", snrDb: 0, name: "RelayA" }]);
  });

  it("runs the full op against a mocked connection", async () => {
    const frame = hexToBytes("00020178563412efbeadde4f9c16f814");
    const tracePath = vi.fn(async () => parseTraceDataFrameLikeTheLibrary(frame));
    const handle = createDeviceHandle({ tracePath });

    const { targetLabel, result } = await tracePathToNode({
      account: createAccount(),
      targetArg: "aabbccdd1122",
      deviceHandle: handle,
    });

    expect(tracePath).toHaveBeenCalledTimes(1);
    expect(bytesToHex(tracePath.mock.calls[0][0] as Uint8Array)).toBe(REPEATER_PUBKEY_HEX);
    expect(targetLabel).toBe("HillRepeater");
    expect(result.hops).toHaveLength(2);
  });

  it("maps the library bare-string timeout to the soft no-answer reply", async () => {
    const tracePath = vi.fn(async () => {
      throw "timeout";
    });
    const reply = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: createDeviceHandle({ tracePath }),
    });
    expect(reply).toContain("no answer from aabbccdd1122 (timeout)");
  });

  it("counts against the airtime budget before the request goes on air", async () => {
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
    const frame = hexToBytes("0000010100000000000000" + "18");
    const tracePath = vi.fn(async () => parseTraceDataFrameLikeTheLibrary(frame));
    const handle = createDeviceHandle({ tracePath });

    const first = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "aabbccdd1122",
      account,
      deviceHandle: handle,
    });
    expect(first).toMatch(/^path to HillRepeater: direct/);

    const second = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "aabbccdd1122",
      account,
      deviceHandle: handle,
    });
    expect(second).toMatch(/^airtime budget exhausted/);
    expect(tracePath).toHaveBeenCalledTimes(1);
  });

  it("answers with usage text when the node argument is missing", async () => {
    const reply = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "",
      account: createAccount(),
    });
    expect(reply).toMatch(/^usage: !trace <node>/);
  });
});
