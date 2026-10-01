import type { MeshcoreContact, MeshcoreDeviceInfo, MeshcoreSelfInfo } from "./types.js";

export const MESHCORE_PUBKEY_LENGTH = 32;
export const MESHCORE_PUBKEY_PREFIX_LENGTH = 6;

export function bytesToHex(bytes: Uint8Array | number[] | Buffer): string {
  const view = new Uint8Array(bytes);
  return Array.from(view)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/gu, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(clean)) {
    throw new Error(`invalid hex string: ${hex}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function isValidPubkeyHex(hex: string): boolean {
  return /^[0-9a-f]{64}$/iu.test(hex.replace(/\s/gu, ""));
}

export function normalizePubkeyHex(hex: string): string {
  return hex.replace(/\s/gu, "").toLowerCase();
}

export function formatNodeIdFromBytes(pubkey: Uint8Array): string {
  return `!${bytesToHex(pubkey)}`;
}

export function formatNodeIdPrefixFromBytes(pubkey: Uint8Array): string {
  return `!${bytesToHex(pubkey.slice(0, MESHCORE_PUBKEY_PREFIX_LENGTH))}`;
}

export function messageIdFromTimestamp(timestamp: number, suffix?: string): string {
  const base = `mc-${Math.floor(timestamp).toString(36)}`;
  return suffix ? `${base}-${suffix}` : base;
}

export function toLibSelfInfo(raw: Record<string, unknown>): MeshcoreSelfInfo {
  return {
    type: Number(raw.type ?? 0),
    txPower: Number(raw.txPower ?? 0),
    maxTxPower: Number(raw.maxTxPower ?? 0),
    publicKey: new Uint8Array((raw.publicKey as ArrayBufferView)?.byteLength ?? 0),
    advLat: Number(raw.advLat ?? 0),
    advLon: Number(raw.advLon ?? 0),
    reserved: new Uint8Array((raw.reserved as ArrayBufferView)?.byteLength ?? 0),
    manualAddContacts: Number(raw.manualAddContacts ?? 0),
    radioFreq: Number(raw.radioFreq ?? 0),
    radioBw: Number(raw.radioBw ?? 0),
    radioSf: Number(raw.radioSf ?? 0),
    radioCr: Number(raw.radioCr ?? 0),
    name: String(raw.name ?? ""),
  };
}

export function toLibDeviceInfo(raw: Record<string, unknown>): MeshcoreDeviceInfo {
  return {
    firmwareVer: Number(raw.firmwareVer ?? 0),
    reserved: new Uint8Array((raw.reserved as ArrayBufferView)?.byteLength ?? 0),
    firmware_build_date: String(raw.firmware_build_date ?? ""),
    manufacturerModel: String(raw.manufacturerModel ?? ""),
  };
}

export function toLibContact(raw: Record<string, unknown>): MeshcoreContact {
  return {
    publicKey: new Uint8Array((raw.publicKey as ArrayBufferView)?.byteLength ?? 0),
    type: Number(raw.type ?? 0),
    flags: Number(raw.flags ?? 0),
    outPathLen: Number(raw.outPathLen ?? 0),
    outPath: new Uint8Array((raw.outPath as ArrayBufferView)?.byteLength ?? 0),
    advName: String(raw.advName ?? ""),
    lastAdvert: Number(raw.lastAdvert ?? 0),
    advLat: Number(raw.advLat ?? 0),
    advLon: Number(raw.advLon ?? 0),
    lastMod: Number(raw.lastMod ?? 0),
  };
}
