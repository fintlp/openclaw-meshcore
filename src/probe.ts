import { resolveMeshcoreAccount } from "./accounts.js";
import { connectMeshcoreDevice, disconnectMeshcoreDevice } from "./device-client.js";
import { bytesToHex } from "./protocol.js";
import { formatMeshcoreEndpoint } from "./transport.js";
import type { CoreConfig, MeshcoreProbe } from "./types.js";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export async function probeMeshcore(
  cfg: CoreConfig,
  opts?: { accountId?: string; timeoutMs?: number },
): Promise<MeshcoreProbe> {
  const account = resolveMeshcoreAccount({ cfg, accountId: opts?.accountId });
  const base: MeshcoreProbe = {
    ok: false,
    transport: "tcp",
    host: account.host,
    port: account.port,
  };

  if (!account.configured) {
    return {
      ...base,
      error: "missing host",
    };
  }

  const started = Date.now();
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const handle = await connectMeshcoreDevice({
      accountId: account.accountId,
      host: account.host,
      port: account.port,
      connectTimeoutMs: timeoutMs,
      handshakeTimeoutMs: timeoutMs,
    });

    const elapsed = Date.now() - started;
    const pubkey = handle.selfInfo?.publicKey;

    await disconnectMeshcoreDevice(account.accountId);

    return {
      ...base,
      ok: true,
      latencyMs: elapsed,
      selfInfo: pubkey
        ? {
            nodeId: `!${bytesToHex(pubkey)}`,
            longName: handle.selfInfo?.name ?? "",
            firmwareVersion: handle.deviceInfo?.firmware_build_date ?? "",
            hardwareModel: handle.deviceInfo?.manufacturerModel ?? "",
            batteryMv: handle.batteryMv,
          }
        : undefined,
    };
  } catch (err) {
    return {
      ...base,
      error: formatError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function describeMeshcoreProbeTarget(account: { host: string; port: number }): string {
  return formatMeshcoreEndpoint(account);
}
