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
  buildTraceRequestFrame,
  buildTraceRoute,
  formatTraceReply,
  normalizeTraceRouteResult,
  parseTraceDataPushFrame,
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
      listenerCount: emitter.listenerCount.bind(emitter),
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


// ---------------------------------------------------------------------------
// Trace path (issues #33, #52)
//
// A MeshCore trace is source-routed out AND back: contact out-path hops +
// target hash + hops reversed ([R] direct, [A, R, A] behind one repeater).
// The plugin writes the CMD_SEND_TRACE_PATH frame itself because meshcore.js
// 1.15.0 hardcodes flags=0 (1-byte hashes only) and forwards its argument
// unchanged as the route — the pre-fix code passed the full 32-byte pubkey,
// so the firmware tried 32 one-byte hops and every trace died (issue #52).
// The 0x89 push is parsed here as well: the library reads path_len SNR bytes
// while the firmware sends path_len >> path_sz plus a final SNR byte.
// ---------------------------------------------------------------------------

function contactWithPath(outPathLen: number, outPath?: Uint8Array) {
  return {
    publicKey: REPEATER_PUBKEY,
    outPathLen,
    outPath: outPath ?? new Uint8Array(64),
  };
}

function pathBytes(...bytes: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(bytes);
  return out;
}

describe("trace route building (issue #52)", () => {
  it("direct contact: the route is just the target hash", () => {
    expect(buildTraceRoute(contactWithPath(0))).toEqual({
      ok: true,
      route: hexToBytes("aa"),
      pathSz: 0,
      width: 1,
      direct: true,
      hopCount: 0,
    });
  });

  it("one relay hop: out and back ([A, R, A])", () => {
    expect(buildTraceRoute(contactWithPath(1, pathBytes(0x4f)))).toEqual({
      ok: true,
      route: hexToBytes("4faa4f"),
      pathSz: 0,
      width: 1,
      direct: false,
      hopCount: 1,
    });
  });

  it("two relay hops: the return leg reverses the hops ([A, B, R, B, A])", () => {
    const plan = buildTraceRoute(contactWithPath(2, pathBytes(0x4f, 0x9c)));
    expect(plan.ok && bytesToHex(plan.route)).toBe("4f9caa9c4f");
  });

  it("unknown path (0xFF) refuses — stored signed or unsigned", () => {
    expect(buildTraceRoute(contactWithPath(-1))).toEqual({ ok: false, code: "unknown-path" });
    expect(buildTraceRoute(contactWithPath(255))).toEqual({ ok: false, code: "unknown-path" });
  });

  it("2-byte contact path: hashes stay 2 bytes wide (pathSz 1)", () => {
    // stored byte: ((2 - 1) << 6) | 1 = 0x41
    expect(buildTraceRoute(contactWithPath(0x41, pathBytes(0x4f, 0x11)))).toEqual({
      ok: true,
      route: hexToBytes("4f11" + "aabb" + "4f11"),
      pathSz: 1,
      width: 2,
      direct: false,
      hopCount: 1,
    });
  });

  it("3-byte contact path: every hop truncates to 2 bytes (a shorter prefix still matches)", () => {
    // stored byte: ((3 - 1) << 6) | 1 = 0x81; the book keeps the library's
    // signed int8, so this arrives as -127.
    expect(buildTraceRoute(contactWithPath(-127, pathBytes(0x4f, 0x11, 0x22)))).toEqual({
      ok: true,
      route: hexToBytes("4f11" + "aabb" + "4f11"),
      pathSz: 1,
      width: 2,
      direct: false,
      hopCount: 1,
    });
  });

  it("4-byte contact path: width 4 (pathSz 2), negative stored outPathLen", () => {
    // stored byte: ((4 - 1) << 6) | 0 = 0xC0, signed: -64
    expect(buildTraceRoute(contactWithPath(-64))).toEqual({
      ok: true,
      route: hexToBytes("aabbccdd"),
      pathSz: 2,
      width: 4,
      direct: true,
      hopCount: 0,
    });
  });

  it("refuses when the out-and-back route would exceed 64 elements", () => {
    // width 1, 32 relay hops -> 2*32+1 = 65 elements > firmware MAX_PATH_SIZE
    expect(buildTraceRoute(contactWithPath(32))).toEqual({
      ok: false,
      code: "route-too-long",
      hopCount: 32,
    });
  });

  it("treats a stored path that overclaims the 64-byte buffer as unknown", () => {
    // ((3 - 1) << 6) | 22 = 0x96, signed -106: 22 hops x 3 bytes = 66 > 64,
    // invalid per firmware Packet.isValidPathLen.
    expect(buildTraceRoute(contactWithPath(-106))).toEqual({ ok: false, code: "unknown-path" });
  });
});

describe("trace request frame bytes (issue #52)", () => {
  it("writes [36][tag u32 LE][auth 0 u32 LE][flags = pathSz][route] exactly", () => {
    const frame = buildTraceRequestFrame(0x12345678, 1, hexToBytes("4f11aabb4f11"));
    expect(bytesToHex(frame)).toBe("24" + "78563412" + "00000000" + "01" + "4f11aabb4f11");
  });
});

describe("trace data push parsing (issue #52)", () => {
  it("KAT: path_sz 0 — one hash byte per hop, negative hop SNR, final SNR", () => {
    // Wire shape: 2 hops 4f -> 9c, hop SNRs 5.5 dB (0x16) and -2.0 dB
    // (0xf8 = -8 quarter-dB), final link 5.0 dB (0x14).
    const frame = hexToBytes("8900020078563412efbeadde4f9c16f814");
    expect(parseTraceDataPushFrame(frame)).toEqual({
      tag: 0x12345678,
      authCode: 0xdeadbeef,
      flags: 0,
      pathSz: 0,
      width: 1,
      hopCount: 2,
      hashes: hexToBytes("4f9c"),
      snrBytes: hexToBytes("16f8"),
      finalSnrByte: 0x14,
    });
  });

  it("KAT: path_sz 1 — two hash bytes per hop (the case the library misparses)", () => {
    const frame = hexToBytes("890004010c000000000000004faabbcc16f814");
    const push = parseTraceDataPushFrame(frame);
    expect(push).toMatchObject({ tag: 12, authCode: 0, flags: 1, pathSz: 1, width: 2, hopCount: 2 });
    expect(bytesToHex(push!.hashes)).toBe("4faabbcc");
    expect(bytesToHex(push!.snrBytes)).toBe("16f8");
    expect(push!.finalSnrByte).toBe(0x14);
  });

  it("rejects frames that are not 0x89, truncated, or length-inconsistent", () => {
    expect(parseTraceDataPushFrame(hexToBytes("06000000000000000000"))).toBeUndefined();
    expect(parseTraceDataPushFrame(hexToBytes("8900"))).toBeUndefined();
    // pathLen 3 with width 2 (flags 1): not a multiple of the hash size
    expect(parseTraceDataPushFrame(hexToBytes("8900030178563412000000004f9caa16f814"))).toBeUndefined();
    // pathLen overclaims the bytes actually present
    expect(parseTraceDataPushFrame(hexToBytes("8900050078563412efbeadde4f9c16f814"))).toBeUndefined();
  });
});

describe("trace hop normalization (issues #33, #52)", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-repeater-ops-"));
    setContactBookPathForTests(join(dir, "contacts.json"));
    resetContactBookForTests();
    rememberContact({ publicKey: REPEATER_PUBKEY, advName: "HillRepeater" }, accountId);
    rememberContact({ publicKey: hexToBytes("4f" + "aa".repeat(31)), advName: "RelayA" }, accountId);
  });

  afterEach(() => {
    resetContactBookForTests();
    setContactBookPathForTests(undefined);
    clearSendRateLimitState();
  });

  it("maps hashes to SNRs and resolves names only on a unique prefix", () => {
    const raw = parseTraceDataPushFrame(hexToBytes("8900020078563412efbeadde4f9c16f814"))!;
    const result = normalizeTraceRouteResult(raw, { direct: false }, accountId);
    expect(result).toEqual({
      direct: false,
      lastSnrDb: 5,
      hops: [
        { hashHex: "4f", snrDb: 5.5, name: "RelayA" },
        { hashHex: "9c", snrDb: -2, name: undefined },
      ],
    });
    expect(formatTraceReply("HillRepeater", result)).toBe(
      "path to HillRepeater: 2 hops 4f(RelayA) 5.5dB > 9c -2.0dB (final-link 5.0dB)",
    );
  });

  it("resolves names on multi-byte hashes with the same unique-prefix rule", () => {
    rememberContact(
      { publicKey: hexToBytes("4f11" + "cc".repeat(30)), advName: "RelayC" },
      accountId,
    );
    const raw = parseTraceDataPushFrame(hexToBytes("890004010c000000000000004f11bbcc16f814"))!;
    const result = normalizeTraceRouteResult(raw, { direct: false }, accountId);
    expect(result.hops).toEqual([
      { hashHex: "4f11", snrDb: 5.5, name: "RelayC" },
      { hashHex: "bbcc", snrDb: -2, name: undefined },
    ]);
  });

  it("leaves a hop unnamed when its hash is ambiguous in the contact book", () => {
    rememberContact(
      { publicKey: hexToBytes("4f" + "bb".repeat(31)), advName: "RelayB" },
      accountId,
    );
    const raw = parseTraceDataPushFrame(hexToBytes("8900010078563412efbeadde4f1614"))!;
    const result = normalizeTraceRouteResult(raw, { direct: false }, accountId);
    expect(result.hops).toEqual([{ hashHex: "4f", snrDb: 5.5, name: undefined }]);
  });

  it("direct route: the single hop is the target itself", () => {
    const raw = parseTraceDataPushFrame(hexToBytes("8900010078563412efbeaddeaa1618"))!;
    const result = normalizeTraceRouteResult(raw, { direct: true }, accountId);
    expect(result.hops).toEqual([{ hashHex: "aa", snrDb: 5.5, name: "HillRepeater" }]);
    expect(result.lastSnrDb).toBe(6);
    expect(formatTraceReply("HillRepeater", result)).toBe(
      "path to HillRepeater: direct (out 5.5dB, final-link 6.0dB)",
    );
  });
});

describe("trace path op (issues #33, #52)", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "meshcore-repeater-ops-"));
    setContactBookPathForTests(join(dir, "contacts.json"));
    resetContactBookForTests();
    rememberContact({ publicKey: REPEATER_PUBKEY, advName: "HillRepeater" }, accountId);
    rememberContact({ publicKey: hexToBytes("4f" + "aa".repeat(31)), advName: "RelayA" }, accountId);
  });

  afterEach(() => {
    resetContactBookForTests();
    setContactBookPathForTests(undefined);
    clearSendRateLimitState();
  });

  function createTraceHandle(
    onSentFrame?: (frame: Uint8Array, emit: (frame: Uint8Array) => void) => void,
  ) {
    // createDeviceHandle binds on/off to its own internal emitter, so rx
    // frames must enter through handle.connection.emit to reach the plugin.
    const handle = createDeviceHandle({});
    const sendToRadioFrame = vi.fn(async (frame: Uint8Array) => {
      onSentFrame?.(frame, (f) => handle.connection.emit("rx", f));
    });
    (handle.connection as unknown as Record<string, unknown>).sendToRadioFrame = sendToRadioFrame;
    return { handle, sendToRadioFrame };
  }

  function tagOf(frame: Uint8Array): number {
    return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, true);
  }

  function sentFrameFor(tag: number, estTimeoutMs = 500): Uint8Array {
    const f = new Uint8Array(10);
    const view = new DataView(f.buffer);
    f[0] = 6;
    view.setUint32(2, tag, true);
    view.setUint32(6, estTimeoutMs, true);
    return f;
  }

  function traceDataFrame(
    tag: number,
    flags: number,
    hashesHex: string,
    snrsHex: string,
    finalSnrByte: number,
  ): Uint8Array {
    const hashes = hexToBytes(hashesHex);
    const snrs = hexToBytes(snrsHex);
    const f = new Uint8Array(12 + hashes.length + snrs.length + 1);
    const view = new DataView(f.buffer);
    f[0] = 0x89;
    f[2] = hashes.length;
    f[3] = flags;
    view.setUint32(4, tag, true);
    f.set(hashes, 12);
    f.set(snrs, 12 + hashes.length);
    view.setInt8(12 + hashes.length + snrs.length, finalSnrByte);
    return f;
  }

  it("runs the full op: route from the contact book, own request frame, own push parsing", async () => {
    const { handle, sendToRadioFrame } = createTraceHandle((frame, emit) => {
      const tag = tagOf(frame);
      setTimeout(() => {
        emit(sentFrameFor(tag));
        emit(traceDataFrame(tag, 0, "aa", "16", 0x18));
      }, 0);
    });

    const { targetLabel, result } = await tracePathToNode({
      account: createAccount(),
      targetArg: "aabbccdd1122",
      deviceHandle: handle,
    });

    expect(sendToRadioFrame).toHaveBeenCalledTimes(1);
    const sent = sendToRadioFrame.mock.calls[0][0] as Uint8Array;
    expect(sent[0]).toBe(36);
    expect(sent[9]).toBe(0); // flags = pathSz 0
    expect(bytesToHex(sent.slice(10))).toBe("aa"); // route = target hash only
    expect(targetLabel).toBe("HillRepeater");
    expect(result).toEqual({
      direct: true,
      lastSnrDb: 6,
      hops: [{ hashHex: "aa", snrDb: 5.5, name: "HillRepeater" }],
    });
    expect(formatTraceReply(targetLabel, result)).toBe(
      "path to HillRepeater: direct (out 5.5dB, final-link 6.0dB)",
    );
  });

  it("builds the out-and-back route from the contact out-path", async () => {
    rememberContact(
      {
        publicKey: FIELD_NODE_PUBKEY,
        advName: "FieldNode1",
        outPathLen: 1, // 1 hop, width 1
        outPath: pathBytes(0x4f),
      },
      accountId,
    );
    const { handle, sendToRadioFrame } = createTraceHandle((frame, emit) => {
      const tag = tagOf(frame);
      setTimeout(() => {
        emit(sentFrameFor(tag));
        emit(traceDataFrame(tag, 0, "4f004f", "16f81c", 0x14));
      }, 0);
    });

    const { targetLabel, result } = await tracePathToNode({
      account: createAccount(),
      targetArg: "001122334455",
      deviceHandle: handle,
    });

    const sent = sendToRadioFrame.mock.calls[0][0] as Uint8Array;
    expect(bytesToHex(sent.slice(10))).toBe("4f004f"); // [relay, target, relay]
    expect(targetLabel).toBe("FieldNode1");
    expect(result).toEqual({
      direct: false,
      lastSnrDb: 5,
      hops: [
        { hashHex: "4f", snrDb: 5.5, name: "RelayA" },
        { hashHex: "00", snrDb: -2, name: "FieldNode1" },
        { hashHex: "4f", snrDb: 7, name: "RelayA" },
      ],
    });
    expect(formatTraceReply(targetLabel, result)).toBe(
      "path to FieldNode1: 3 hops 4f(RelayA) 5.5dB > 00(FieldNode1) -2.0dB > 4f(RelayA) 7.0dB (final-link 5.0dB)",
    );
  });

  it("ignores trace pushes carrying a different tag", async () => {
    const { handle } = createTraceHandle((frame, emit) => {
      const tag = tagOf(frame);
      setTimeout(() => {
        emit(sentFrameFor(tag));
        // A late push from an earlier trace: same shape, different tag, junk data.
        emit(traceDataFrame(tag ^ 0x80000000, 0, "aa", "f8", 0x10));
        emit(traceDataFrame(tag, 0, "aa", "16", 0x18));
      }, 0);
    });

    const { result } = await tracePathToNode({
      account: createAccount(),
      targetArg: "aabbccdd1122",
      deviceHandle: handle,
    });

    expect(result.lastSnrDb).toBe(6);
    expect(result.hops[0].snrDb).toBe(5.5);
  });

  it("maps a silent node to the soft no-answer reply", async () => {
    const { handle, sendToRadioFrame } = createTraceHandle(() => {});
    const reply = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: handle,
      timeoutMs: 50,
    });
    expect(reply).toContain("no answer from aabbccdd1122 (timeout)");
    expect(sendToRadioFrame).toHaveBeenCalledTimes(1);
  });

  it("removes its rx listener when Sent never arrives (no leak, PR #59 review)", async () => {
    const { handle } = createTraceHandle(() => {});
    const conn = handle.connection as unknown as { listenerCount: (event: string) => number };
    const before = conn.listenerCount("rx");

    const pending = runRepeaterOpsCommand({
      op: "trace",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: handle,
      timeoutMs: 60,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(conn.listenerCount("rx")).toBe(before + 1); // attached while in flight

    const reply = await pending;
    expect(reply).toContain("(timeout)");
    expect(conn.listenerCount("rx")).toBe(before); // torn down after the timeout
  });

  it("removes its rx listener after a successful trace as well", async () => {
    const { handle } = createTraceHandle((frame, emit) => {
      const tag = tagOf(frame);
      setTimeout(() => {
        emit(sentFrameFor(tag));
        emit(traceDataFrame(tag, 0, "aa", "16", 0x18));
      }, 0);
    });
    const conn = handle.connection as unknown as { listenerCount: (event: string) => number };
    const before = conn.listenerCount("rx");

    await tracePathToNode({
      account: createAccount(),
      targetArg: "aabbccdd1122",
      deviceHandle: handle,
    });

    expect(conn.listenerCount("rx")).toBe(before);
  });

  it("stops waiting at est_timeout + margin once the node accepted the request", async () => {
    const { handle } = createTraceHandle((frame, emit) => {
      const tag = tagOf(frame);
      setTimeout(() => emit(sentFrameFor(tag, 20)), 0); // accepted; trace data never arrives
    });
    const started = Date.now();
    const reply = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: handle,
      timeoutMs: 30_000,
      estMarginMs: 30,
    });
    expect(reply).toContain("(timeout)");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("fails soft when the node rejects the request frame", async () => {
    const { handle } = createTraceHandle((_frame, emit) => {
      setTimeout(() => emit(hexToBytes("0106")), 0); // Err, ERR_CODE_ILLEGAL_ARG
    });
    const reply = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "aabbccdd1122",
      account: createAccount(),
      deviceHandle: handle,
    });
    expect(reply).toContain("query failed:");
    expect(reply).toContain("err 6");
  });

  it("refuses a contact whose path is unknown — nothing goes on air, no budget spent", async () => {
    rememberContact(
      { publicKey: hexToBytes("ee".repeat(32)), advName: "Ghost", outPathLen: -1 },
      accountId,
    );
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
    const { handle, sendToRadioFrame } = createTraceHandle();

    const reply = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "eeeeeeeeeeee",
      account,
      deviceHandle: handle,
    });
    expect(reply).toBe("no known route to Ghost yet; wait for an advert or a DM");
    expect(sendToRadioFrame).not.toHaveBeenCalled();

    const again = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "eeeeeeeeeeee",
      account,
      deviceHandle: handle,
    });
    expect(again).toBe("no known route to Ghost yet; wait for an advert or a DM");
  });

  it("refuses a target with no contact-book entry at all", async () => {
    const { handle, sendToRadioFrame } = createTraceHandle();
    const reply = await runRepeaterOpsCommand({
      op: "trace",
      targetArg: "ff".repeat(32),
      account: createAccount(),
      deviceHandle: handle,
    });
    expect(reply).toBe("no known route to !ffffffffffff yet; wait for an advert or a DM");
    expect(sendToRadioFrame).not.toHaveBeenCalled();
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
    const { handle, sendToRadioFrame } = createTraceHandle((frame, emit) => {
      const tag = tagOf(frame);
      setTimeout(() => {
        emit(sentFrameFor(tag));
        emit(traceDataFrame(tag, 0, "aa", "16", 0x18));
      }, 0);
    });

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
    expect(sendToRadioFrame).toHaveBeenCalledTimes(1);
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
