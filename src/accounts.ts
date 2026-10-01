import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { defaultPortForTransport, normalizeMeshcoreTransport, type MeshcoreTransport } from "./transport.js";
import type { CoreConfig, MeshcoreAccountConfig } from "./types.js";

const TRUTHY_ENV = new Set(["true", "1", "yes", "on"]);
const DEFAULT_MESH_CHANNELS = [0];

export type ResolvedMeshcoreAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  transport: MeshcoreTransport;
  host: string;
  port: number;
  config: MeshcoreAccountConfig;
};

function parseTruthy(value?: string): boolean {
  if (!value) {
    return false;
  }
  return TRUTHY_ENV.has(normalizeLowercaseStringOrEmpty(value));
}

function parseIntEnv(value?: string): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

function parseHostEnv(raw?: string): { host: string; port?: number } {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return { host: "" };
  }
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex > 0 && colonIndex < trimmed.length - 1) {
    const hostPart = trimmed.slice(0, colonIndex).trim();
    const portPart = trimmed.slice(colonIndex + 1).trim();
    const port = Number.parseInt(portPart, 10);
    if (hostPart && Number.isFinite(port) && port > 0 && port <= 65535) {
      return { host: hostPart, port };
    }
  }
  return { host: trimmed };
}

const {
  listAccountIds: listMeshcoreAccountIds,
  resolveDefaultAccountId: resolveDefaultMeshcoreAccountId,
} = createAccountListHelpers("meshcore", {
  normalizeAccountId,
  hasImplicitDefaultAccount: (cfg) => {
    const envHost = process.env.MESHCORE_HOST?.trim();
    const configHost = cfg.channels?.meshcore?.host?.trim();
    return Boolean(envHost || configHost);
  },
});
export { listMeshcoreAccountIds, resolveDefaultMeshcoreAccountId };

function mergeMeshcoreAccountConfig(cfg: CoreConfig, accountId: string): MeshcoreAccountConfig {
  return resolveMergedAccountConfig<MeshcoreAccountConfig>({
    channelConfig: cfg.channels?.meshcore as MeshcoreAccountConfig | undefined,
    accounts: cfg.channels?.meshcore?.accounts as
      | Record<string, Partial<MeshcoreAccountConfig>>
      | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
  });
}

export function resolveMeshcoreAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMeshcoreAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.meshcore?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeMeshcoreAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const transport = merged.transport ? normalizeMeshcoreTransport(merged.transport) : "tcp";

    const envHost =
      accountId === DEFAULT_ACCOUNT_ID ? parseHostEnv(process.env.MESHCORE_HOST) : { host: "" };
    const configHost = parseHostEnv(merged.host);
    const host = configHost.host || envHost.host;
    const envPort =
      accountId === DEFAULT_ACCOUNT_ID ? parseIntEnv(process.env.MESHCORE_PORT) : undefined;
    const port = configHost.port ?? envHost.port ?? merged.port ?? envPort ?? defaultPortForTransport();

    const configured = Boolean(host);

    const channels = merged.channels?.length ? merged.channels : DEFAULT_MESH_CHANNELS;

    const config: MeshcoreAccountConfig = {
      ...merged,
      transport,
      host,
      port,
      channels,
    };

    return {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
      configured,
      transport,
      host,
      port,
      config,
    } satisfies ResolvedMeshcoreAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.configured) {
    return primary;
  }

  const fallbackId = resolveDefaultMeshcoreAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}

export function listEnabledMeshcoreAccounts(cfg: CoreConfig): ResolvedMeshcoreAccount[] {
  return listMeshcoreAccountIds(cfg)
    .map((accountId) => resolveMeshcoreAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
