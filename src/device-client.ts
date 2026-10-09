import { Constants, TCPConnection } from "@liamcottle/meshcore.js";
import {
  rememberContact,
  rememberSelfInfo,
  resolveContactPubkeyByPrefix,
} from "./contact-book.js";
import { updateNodeStatusOps, writeNodeStatusSnapshot } from "./node-status.js";
import type { MeshcoreContact, MeshcoreDeviceInfo, MeshcoreSelfInfo } from "./types.js";
import {
  bytesToHex,
  formatNodeIdFromBytes,
  hexToBytes,
  isValidPubkeyHex,
  normalizePubkeyHex,
} from "./protocol.js";

export type MeshcoreDeviceHandle = {
  accountId: string;
  connection: TCPConnection;
  selfInfo?: MeshcoreSelfInfo;
  deviceInfo?: MeshcoreDeviceInfo;
  batteryMv?: number;
  contacts: MeshcoreContact[];
  channels: Array<{ index: number; name: string; secret: Uint8Array }>;
  connected: boolean;
};

const devices = new Map<string, MeshcoreDeviceHandle>();

export type SendConfirmedPayload = {
  ackCode: number;
  roundTrip: number;
};

type PendingSendConfirmed = {
  expectedAckCode?: number;
  resolve: (value: SendConfirmedPayload | { timeout: true }) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

const pendingSendConfirmedResolvers = new Map<string, PendingSendConfirmed[]>();
const connectionsWithSendConfirmedHandler = new WeakSet<TCPConnection>();

function dispatchSendConfirmed(accountId: string, payload: SendConfirmedPayload): void {
  const queue = pendingSendConfirmedResolvers.get(accountId);
  if (!queue || queue.length === 0) {
    return;
  }

  // Per-frame correlation (must-fix #1): only the waiter whose expected ack tag
  // equals this payload's ackCode is released. A waiter without an expected tag
  // is never satisfied by an arbitrary confirm, and a confirm that matches no
  // pending waiter (e.g. a late push for a frame whose waiter already timed out)
  // is dropped here — it is never buffered or credited to a different frame.
  const matchIndex = queue.findIndex(
    (w) => w.expectedAckCode !== undefined && w.expectedAckCode === payload.ackCode,
  );
  if (matchIndex < 0) {
    return;
  }

  const [matched] = queue.splice(matchIndex, 1);
  if (matched.timer) {
    clearTimeout(matched.timer);
    matched.timer = null;
  }
  matched.resolve(payload);
}

export function attachSendConfirmedHandler(connection: TCPConnection, accountId: string): void {
  if (connectionsWithSendConfirmedHandler.has(connection)) {
    return;
  }
  connectionsWithSendConfirmedHandler.add(connection);
  connection.on(Constants.PushCodes.SendConfirmed, (payload: SendConfirmedPayload) => {
    dispatchSendConfirmed(accountId, payload);
  });
}

/**
 * Wait for the next SendConfirmed (0x82) push for the given account.
 * Only a confirm whose `ackCode` exactly equals `expectedAckCode` releases this
 * waiter; unmatched confirms are ignored (never credited to another frame).
 * Resolves with the payload on confirm, or `{ timeout: true }` if no confirm
 * arrives within `timeoutMs`.
 */
export function waitForSendConfirmed(params: {
  accountId: string;
  expectedAckCode?: number;
  timeoutMs: number;
}): Promise<SendConfirmedPayload | { timeout: true }> {
  const accountId = params.accountId;
  const expectedAckCode = params.expectedAckCode;
  const timeoutMs = params.timeoutMs;

  if (timeoutMs <= 0) {
    return Promise.resolve({ timeout: true });
  }

  return new Promise<SendConfirmedPayload | { timeout: true }>((resolve) => {
    let queue = pendingSendConfirmedResolvers.get(accountId);
    if (!queue) {
      queue = [];
      pendingSendConfirmedResolvers.set(accountId, queue);
    }

    const entry: PendingSendConfirmed = {
      expectedAckCode,
      resolve,
      timer: null,
    };

    // Ensure the connection is wired even if pacing starts after the monitor.
    const handle = devices.get(accountId);
    if (handle) {
      attachSendConfirmedHandler(handle.connection, accountId);
    }

    entry.timer = setTimeout(() => {
      const currentQueue = pendingSendConfirmedResolvers.get(accountId);
      if (currentQueue) {
        const index = currentQueue.indexOf(entry);
        if (index >= 0) {
          currentQueue.splice(index, 1);
        }
      }
      entry.resolve({ timeout: true });
    }, timeoutMs);

    queue.push(entry);
  });
}

/** Clear pending SendConfirmed waiters.  Intended for tests only. */
export function clearSendConfirmedStateForTests(): void {
  for (const queue of pendingSendConfirmedResolvers.values()) {
    for (const entry of queue) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.resolve({ timeout: true });
    }
  }
  pendingSendConfirmedResolvers.clear();
}

/**
 * Remove the pending waiter for a specific expected ack tag without resolving
 * it. The timer is cleared and the entry is removed from the queue so a late
 * confirm is not credited anywhere. Intended for internal abort paths (e.g.
 * connection lost mid-send).
 */
export function removeSendConfirmedWait(accountId: string, expectedAckCode: number): void {
  const queue = pendingSendConfirmedResolvers.get(accountId);
  if (!queue) {
    return;
  }
  const matchIndex = queue.findIndex(
    (w) => w.expectedAckCode !== undefined && w.expectedAckCode === expectedAckCode,
  );
  if (matchIndex < 0) {
    return;
  }
  const [matched] = queue.splice(matchIndex, 1);
  if (matched.timer) {
    clearTimeout(matched.timer);
    matched.timer = null;
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export function buildMeshcoreEndpoint(host: string, port: number): string {
  return `${host}:${port}`;
}

function waitForEvent<T>(
  emitter: TCPConnection,
  event: string | number,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${event} (${timeoutMs}ms)`));
    }, timeoutMs);
    const handler = (value: T) => {
      clearTimeout(timer);
      cleanup();
      resolve(value);
    };
    const cleanup = () => {
      emitter.off(event, handler as () => void);
    };
    emitter.on(event, handler as () => void);
  });
}

/**
 * Create a SelfInfo fetcher that first captures any firmware push emitted
 * synchronously during connect, then falls back to an explicit request.
 *
 * Covers both observed behaviours:
 * - RACE: firmware pushes SelfInfo before the connect promise resolves and
 *   before a post-connect listener could attach.
 * - NO PUSH: firmware (e.g. MeshOS 1.3.6 companion over TCP) only answers
 *   an explicit AppStart/SelfInfo request.
 */
function createSelfInfoFetcher(connection: TCPConnection, timeoutMs: number): {
  fetch: () => Promise<Record<string, unknown>>;
} {
  let captured: Record<string, unknown> | undefined;
  let settled = false;

  const earlyHandler = (value: Record<string, unknown>) => {
    captured = value;
  };

  connection.on(Constants.ResponseCodes.SelfInfo, earlyHandler);

  const cleanup = () => {
    if (!settled) {
      settled = true;
      connection.off(Constants.ResponseCodes.SelfInfo, earlyHandler);
    }
  };

  return {
    fetch: () => {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        if (captured) {
          cleanup();
          resolve(captured);
          return;
        }

        let timer: ReturnType<typeof setTimeout> | null = null;

        const handler = (value: Record<string, unknown>) => {
          cleanup();
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          connection.off(Constants.ResponseCodes.SelfInfo, handler);
          resolve(value);
        };

        timer = setTimeout(() => {
          cleanup();
          connection.off(Constants.ResponseCodes.SelfInfo, handler);
          reject(new Error(`timeout waiting for SelfInfo (${timeoutMs}ms)`));
        }, timeoutMs);

        connection.on(Constants.ResponseCodes.SelfInfo, handler);
        connection.sendCommandAppStart().catch((error: unknown) => {
          cleanup();
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          connection.off(Constants.ResponseCodes.SelfInfo, handler);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },
  };
}

function convertToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return new Uint8Array(value);
  }
  if (value && typeof value === "object" && "buffer" in value) {
    return new Uint8Array((value as ArrayBufferView).buffer);
  }
  return new Uint8Array(0);
}

function normalizeSelfInfo(raw: Record<string, unknown>): MeshcoreSelfInfo {
  return {
    type: Number(raw.type ?? 0),
    txPower: Number(raw.txPower ?? 0),
    maxTxPower: Number(raw.maxTxPower ?? 0),
    publicKey: convertToUint8Array(raw.publicKey),
    advLat: Number(raw.advLat ?? 0),
    advLon: Number(raw.advLon ?? 0),
    reserved: convertToUint8Array(raw.reserved),
    manualAddContacts: Number(raw.manualAddContacts ?? 0),
    radioFreq: Number(raw.radioFreq ?? 0),
    radioBw: Number(raw.radioBw ?? 0),
    radioSf: Number(raw.radioSf ?? 0),
    radioCr: Number(raw.radioCr ?? 0),
    name: String(raw.name ?? ""),
  };
}

const ADVERT_POSITION_EPSILON = 1e-5;

type AdvertPositionCorrectionParams = {
  connection: TCPConnection;
  selfInfo: MeshcoreSelfInfo;
  advertLat?: number;
  advertLon?: number;
  ops: {
    connectionState: "connected" | "disconnected";
    since: number;
    reconnectCount: number;
    lastRestartReason?: string;
    lastRestartAt?: number;
  };
  accountId?: string;
};

/**
 * Apply config-driven advertised position correction. Only runs when both
 * advertLat and advertLon are set and the current advertised position differs
 * by more than 1e-5 degrees. Uses console.* because plugin logger.info does not
 * reach gateway.log (issue #14).
 */
async function maybeApplyAdvertPositionCorrection(params: AdvertPositionCorrectionParams): Promise<void> {
  const { advertLat, advertLon, selfInfo, connection, ops } = params;
  if (advertLat === undefined || advertLon === undefined) {
    return;
  }
  const currentLat = selfInfo.advLat / 1e6;
  const currentLon = selfInfo.advLon / 1e6;
  const latDiff = Math.abs(currentLat - advertLat);
  const lonDiff = Math.abs(currentLon - advertLon);
  if (latDiff <= ADVERT_POSITION_EPSILON && lonDiff <= ADVERT_POSITION_EPSILON) {
    return;
  }
  try {
    // The wire format expects int32 degrees * 1e6 (Companion Protocol), while
    // config and logs use decimal degrees. Scale before calling the library.
    const targetLatFixed = Math.round(advertLat * 1e6);
    const targetLonFixed = Math.round(advertLon * 1e6);
    await Promise.race([
      connection.setAdvertLatLong(targetLatFixed, targetLonFixed),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("setAdvertLatLong timeout (5000ms)")),
          5_000,
        ),
      ),
    ]);
    console.log(
      `[meshcore] corrected advertised position from ${currentLat.toFixed(6)},${currentLon.toFixed(6)} to ${advertLat.toFixed(6)},${advertLon.toFixed(6)}`,
    );
    // Refresh the snapshot with the target coordinates; the node reports the
    // same value back, so this avoids an extra getSelfInfo round-trip.
    writeNodeStatusSnapshot(
      {
        ...selfInfo,
        advLat: targetLatFixed,
        advLon: targetLonFixed,
      },
      ops,
      params.accountId,
    );
  } catch (error) {
    console.error(
      `[meshcore] failed to apply advertised position correction: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeDeviceInfo(raw: Record<string, unknown>): MeshcoreDeviceInfo {
  return {
    firmwareVer: Number(raw.firmwareVer ?? 0),
    reserved: convertToUint8Array(raw.reserved),
    firmware_build_date: String(raw.firmware_build_date ?? ""),
    manufacturerModel: String(raw.manufacturerModel ?? ""),
  };
}

function normalizeContact(raw: Record<string, unknown>): MeshcoreContact {
  return {
    publicKey: convertToUint8Array(raw.publicKey),
    type: Number(raw.type ?? 0),
    flags: Number(raw.flags ?? 0),
    outPathLen: Number(raw.outPathLen ?? 0),
    outPath: convertToUint8Array(raw.outPath),
    advName: String(raw.advName ?? ""),
    lastAdvert: Number(raw.lastAdvert ?? 0),
    advLat: Number(raw.advLat ?? 0),
    advLon: Number(raw.advLon ?? 0),
    lastMod: Number(raw.lastMod ?? 0),
  };
}

// meshcore.js emits ChannelInfo by numeric code (Constants.ResponseCodes.ChannelInfo = 18).
const EVENT_CHANNEL_INFO = 18;

async function queryAllChannels(connection: TCPConnection): Promise<
  Array<{ index: number; name: string; secret: Uint8Array }>
> {
  const channels: Array<{ index: number; name: string; secret: Uint8Array }> = [];
  for (let i = 0; i < 8; i++) {
    try {
      const info = (await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`timeout getting channel ${i}`));
        }, 3_000);
        const handler = (value: Record<string, unknown>) => {
          if (Number(value.channelIdx) !== i) {
            return;
          }
          clearTimeout(timeout);
          cleanup();
          resolve(value);
        };
        const cleanup = () => {
          connection.off(EVENT_CHANNEL_INFO, handler);
        };
        connection.on(EVENT_CHANNEL_INFO, handler);
        void connection.sendCommandGetChannel(i);
      })) as { channelIdx?: number; name?: string; secret?: Uint8Array | number[] };
      const secret = info.secret ? convertToUint8Array(info.secret) : new Uint8Array(16);
      channels.push({
        index: i,
        name: String(info.name ?? ""),
        secret,
      });
    } catch {
      // Ignore missing channel slots and continue.
    }
  }
  return channels;
}

export type MeshcoreConnectOptions = {
  accountId: string;
  host: string;
  port: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  reconnectCount?: number;
  lastRestartReason?: string;
  lastRestartAt?: number;
  advertLat?: number;
  advertLon?: number;
  contactBookMaxEntries?: number;
};

export async function connectMeshcoreDevice(params: MeshcoreConnectOptions): Promise<MeshcoreDeviceHandle> {
  const existing = devices.get(params.accountId);
  if (existing) {
    await disconnectMeshcoreDevice(params.accountId);
  }

  const connection = new TCPConnection(params.host, params.port);
  const handle: MeshcoreDeviceHandle = {
    accountId: params.accountId,
    connection,
    contacts: [],
    channels: [],
    connected: false,
  };
  devices.set(params.accountId, handle);

  const connectTimeoutMs = params.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const handshakeTimeoutMs = params.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  // Attach the SelfInfo listener before the TCP handshake so any synchronous
  // firmware push is captured (race hypothesis #1).
  const selfInfoFetcher = createSelfInfoFetcher(connection, handshakeTimeoutMs);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MeshCore TCP connect timeout (${connectTimeoutMs}ms)`));
    }, connectTimeoutMs);
    const onConnected = () => {
      clearTimeout(timer);
      cleanup();
      handle.connected = true;
      // Fan-out SendConfirmed pushes to any pacing gate waiting on this account
      // without interfering with other listeners (advert/DM handlers, etc.).
      attachSendConfirmedHandler(connection, params.accountId);
      resolve();
    };
    const onError = (error: unknown) => {
      clearTimeout(timer);
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("MeshCore TCP socket closed before connected"));
    };
    const cleanup = () => {
      connection.off("connected", onConnected);
      connection.off("error", onError);
      connection.off("disconnected", onClose);
    };
    connection.on("connected", onConnected);
    connection.on("error", onError);
    connection.on("disconnected", onClose);
    void connection.connect();
  });

  // Each connect-time fetch has its own fault-isolated try/catch + timeout so a
  // lost response never forfeits a sibling fetch (issue #20). All failures are
  // best-effort: the TCP connection stays up and the handle is returned.

  // SelfInfo: capture any synchronous push, otherwise request explicitly.
  const connectNow = Date.now();
  try {
    const selfInfoRaw = await selfInfoFetcher.fetch();
    handle.selfInfo = normalizeSelfInfo(selfInfoRaw);
    rememberSelfInfo(handle.selfInfo, handle.accountId, params.contactBookMaxEntries);
    writeNodeStatusSnapshot(
      handle.selfInfo,
      {
        connectionState: "connected",
        since: connectNow,
        reconnectCount: params.reconnectCount ?? 0,
        lastRestartReason: params.lastRestartReason,
        lastRestartAt: params.lastRestartAt,
      },
      handle.accountId,
    );
    await maybeApplyAdvertPositionCorrection({
      connection,
      selfInfo: handle.selfInfo,
      advertLat: params.advertLat,
      advertLon: params.advertLon,
      ops: {
        connectionState: "connected",
        since: connectNow,
        reconnectCount: params.reconnectCount ?? 0,
        lastRestartReason: params.lastRestartReason,
        lastRestartAt: params.lastRestartAt,
      },
      accountId: params.accountId,
    });
  } catch {
    // SelfInfo is optional for messaging; keep the connection. Still update
    // live ops so a reconnect without SelfInfo doesn't leave stale state.
    updateNodeStatusOps(
      {
        connectionState: "connected",
        since: new Date(connectNow).toISOString(),
        reconnectCount: params.reconnectCount ?? 0,
        lastRestartReason: params.lastRestartReason,
        lastRestartAt:
          params.lastRestartAt !== undefined
            ? new Date(params.lastRestartAt).toISOString()
            : undefined,
      },
      params.accountId,
    );
  }

  // DeviceInfo must be explicitly requested.
  try {
    await connection.sendCommandDeviceQuery(1);
    const deviceInfoRaw = await waitForEvent<Record<string, unknown>>(
      connection,
      Constants.ResponseCodes.DeviceInfo,
      handshakeTimeoutMs,
    );
    handle.deviceInfo = normalizeDeviceInfo(deviceInfoRaw);
  } catch {
    // DeviceInfo is optional for messaging; keep the connection.
  }

  // Sync contacts.
  try {
    const contactsRaw = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const contacts: Array<Record<string, unknown>> = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("timeout syncing contacts"));
      }, 10_000);
      const onContact = (contact: Record<string, unknown>) => {
        contacts.push(contact);
      };
      const onEnd = () => {
        clearTimeout(timeout);
        cleanup();
        resolve(contacts);
      };
      const cleanup = () => {
        connection.off(Constants.ResponseCodes.Contact, onContact);
        connection.off(Constants.ResponseCodes.EndOfContacts, onEnd);
      };
      connection.on(Constants.ResponseCodes.Contact, onContact);
      connection.on(Constants.ResponseCodes.EndOfContacts, onEnd);
      void connection.sendCommandGetContacts();
    });
    handle.contacts = contactsRaw.map(normalizeContact);
  } catch {
    // Contacts sync is best-effort.
  }

  // Sync channels.
  try {
    handle.channels = await queryAllChannels(connection);
  } catch {
    // Channel sync is best-effort.
  }

  // Query battery once at startup.
  try {
    const batteryRaw = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("timeout getting battery"));
      }, 3_000);
      const handler = (value: Record<string, unknown>) => {
        clearTimeout(timeout);
        cleanup();
        resolve(value);
      };
      const cleanup = () => {
        connection.off(Constants.ResponseCodes.BatteryVoltage, handler);
      };
      connection.on(Constants.ResponseCodes.BatteryVoltage, handler);
      void connection.sendCommandGetBatteryVoltage();
    });
    handle.batteryMv = Number(batteryRaw.batteryMilliVolts ?? 0);
    updateNodeStatusOps({ batteryMv: handle.batteryMv }, params.accountId);
  } catch {
    // Battery is optional.
  }

  return handle;
}

const DISCONNECT_TIMEOUT_MS = 3_000;

export async function disconnectMeshcoreDevice(accountId: string): Promise<void> {
  const handle = devices.get(accountId);
  if (!handle) {
    return;
  }
  devices.delete(accountId);
  handle.connected = false;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        handle.connection.close();
        resolve();
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`disconnect timeout (${DISCONNECT_TIMEOUT_MS}ms)`)),
          DISCONNECT_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch {
    // Swallow — socket is already dead at this point.
  }
}

export function getMeshcoreDevice(accountId: string): MeshcoreDeviceHandle | undefined {
  return devices.get(accountId);
}

export function resolveSenderNodeId(params: {
  pubkeyPrefix: Uint8Array;
  contacts: MeshcoreContact[];
}): { nodeId: string; name?: string } {
  const prefixHex = bytesToHex(params.pubkeyPrefix).toLowerCase();
  for (const contact of params.contacts) {
    const contactHex = bytesToHex(contact.publicKey).toLowerCase();
    if (contactHex === prefixHex || contactHex.startsWith(prefixHex)) {
      return {
        nodeId: formatNodeIdFromBytes(contact.publicKey),
        name: contact.advName || undefined,
      };
    }
  }
  return { nodeId: `!${prefixHex}` };
}

export function resolveContactByNodeId(
  contacts: MeshcoreContact[],
  nodeId: string,
): MeshcoreContact | undefined {
  const hex = normalizePubkeyHex(nodeId.replace(/^!/u, ""));
  if (!hex) {
    return undefined;
  }
  return contacts.find((contact) => {
    const contactHex = bytesToHex(contact.publicKey).toLowerCase();
    return contactHex === hex || contactHex.startsWith(hex);
  });
}

/**
 * Legacy advert-cache helper kept for backward compatibility.
 * New code should prefer {@link rememberContact} with the full advert payload.
 */
export function rememberAdvertContact(
  publicKey: Uint8Array,
  name: string | undefined,
  accountId: string,
): void {
  rememberContact({ publicKey, advName: name }, accountId);
}

export { resolveContactPubkeyByPrefix as resolveAdvertPubkeyByPrefix };

export function nodeIdToPubkey(
  nodeId: string,
  accountId: string | undefined = undefined,
): Uint8Array {
  const hex = normalizePubkeyHex(nodeId.replace(/^!/u, ""));
  if (!isValidPubkeyHex(hex)) {
    if (hex && accountId) {
      const resolved = resolveContactPubkeyByPrefix(hex, accountId);
      if (resolved) {
        return resolved;
      }
    }
    throw new Error(`invalid MeshCore node id: ${nodeId}`);
  }
  return hexToBytes(hex);
}
