export const MESHCORE_TRANSPORTS = ["tcp"] as const;

export type MeshcoreTransport = (typeof MESHCORE_TRANSPORTS)[number];

export const DEFAULT_TCP_PORT = 5000;

export function normalizeMeshcoreTransport(raw?: string): MeshcoreTransport {
  const value = raw?.trim().toLowerCase();
  if (value === "tcp") {
    return "tcp";
  }
  return "tcp";
}

export function defaultPortForTransport(): number {
  return DEFAULT_TCP_PORT;
}

export function formatMeshcoreEndpoint(params: { host: string; port: number }): string {
  return `${params.host}:${params.port}`;
}
