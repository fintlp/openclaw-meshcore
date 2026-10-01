import { TCPConnection } from "@liamcottle/meshcore.js";
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

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export function buildMeshcoreEndpoint(host: string, port: number): string {
  return `${host}:${port}`;
}

function waitForEvent<T>(
  emitter: TCPConnection,
  event: string,
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
          connection.off("ChannelInfo", handler);
        };
        connection.on("ChannelInfo", handler);
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

export async function connectMeshcoreDevice(params: {
  accountId: string;
  host: string;
  port: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}): Promise<MeshcoreDeviceHandle> {
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

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MeshCore TCP connect timeout (${connectTimeoutMs}ms)`));
    }, connectTimeoutMs);
    const onConnected = () => {
      clearTimeout(timer);
      cleanup();
      handle.connected = true;
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

  // Device query handshake (firmware v1+ sends DeviceInfo on connect; explicitly request SelfInfo).
  try {
    const selfInfoRaw = (await waitForEvent<Record<string, unknown>>(
      connection,
      "SelfInfo",
      handshakeTimeoutMs,
    )) as Record<string, unknown>;
    handle.selfInfo = normalizeSelfInfo(selfInfoRaw);
    await connection.sendCommandDeviceQuery(1);
    const deviceInfoRaw = await waitForEvent<Record<string, unknown>>(
      connection,
      "DeviceInfo",
      handshakeTimeoutMs,
    );
    handle.deviceInfo = normalizeDeviceInfo(deviceInfoRaw);
  } catch (error) {
    // SelfInfo/DeviceInfo are best-effort for the handshake; keep the connection.
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
        connection.off("Contact", onContact);
        connection.off("EndOfContacts", onEnd);
      };
      connection.on("Contact", onContact);
      connection.on("EndOfContacts", onEnd);
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
        connection.off("BatteryVoltage", handler);
      };
      connection.on("BatteryVoltage", handler);
      void connection.sendCommandGetBatteryVoltage();
    });
    handle.batteryMv = Number(batteryRaw.batteryMilliVolts ?? 0);
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

export function nodeIdToPubkey(nodeId: string): Uint8Array {
  const hex = normalizePubkeyHex(nodeId.replace(/^!/u, ""));
  if (!isValidPubkeyHex(hex)) {
    throw new Error(`invalid MeshCore node id: ${nodeId}`);
  }
  return hexToBytes(hex);
}
