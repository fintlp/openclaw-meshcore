/**
 * MeshCore onboarding helpers: host:port parsing and human-actionable
 * probe failure diagnosis. Pure functions — nothing connects, nothing writes.
 */

export const MESHCORE_DEFAULT_PORT = 5000;

/**
 * Split "host:port" input. Only splits on the LAST colon and only when the
 * suffix is a valid port number — otherwise the whole string is the host.
 */
export function splitHostPort(raw: string): { host: string; port?: number } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { host: "" };
  }
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex > 0 && colonIndex < trimmed.length - 1) {
    const hostPart = trimmed.slice(0, colonIndex).trim();
    const portPart = trimmed.slice(colonIndex + 1).trim();
    const port = Number.parseInt(portPart, 10);
    if (hostPart && /^\d+$/.test(portPart) && Number.isFinite(port) && port >= 1 && port <= 65535) {
      return { host: hostPart, port };
    }
  }
  return { host: trimmed };
}

export type ProbeDiagnosis = {
  /** One-line summary of what is most likely wrong. */
  summary: string;
  /** Concrete things to check or change, most likely first. */
  hints: string[];
};

const ONE_CLIENT_RULE =
  "A MeshCore node serves ONE companion client at a time. If the MeshCore phone app, another gateway, or any other client is connected, this probe fights it for the slot — disconnect the other client first.";

/**
 * Translate a probe failure into operator-actionable guidance. MeshCore's
 * signature trap is the single-companion-slot rule; the rest are the usual
 * network-path suspects.
 */
export function diagnoseMeshcoreProbeFailure(params: {
  host: string;
  port: number;
  error?: string;
}): ProbeDiagnosis {
  const error = params.error ?? "";
  const target = `${params.host}:${params.port}`;

  if (/ECONNREFUSED/i.test(error)) {
    return {
      summary: `Nothing is listening on ${target}.`,
      hints: [
        "Check the node is powered and on the same network (battery-powered nodes die quietly).",
        "The companion TCP server (default port 5000) must be enabled in the node's network settings.",
        "Double-check the IP: DHCP leases change. Consider a reservation for the node.",
      ],
    };
  }

  if (/socket closed before connected/i.test(error)) {
    return {
      summary: `${target} accepted the connection, then dropped it — the classic busy-slot symptom.`,
      hints: [
        ONE_CLIENT_RULE,
        "If this gateway was previously connected, give the node a few seconds to release the stale session, then retry.",
      ],
    };
  }

  if (/SelfInfo/i.test(error)) {
    return {
      summary: `${target} connected but never identified itself.`,
      hints: [
        "This usually means the companion handshake stalled — most often because another client holds the slot.",
        ONE_CLIENT_RULE,
        "Less common: the port serves something that is not a MeshCore companion interface — verify the port.",
      ],
    };
  }

  if (/timed?\s*out|abort/i.test(error)) {
    return {
      summary: `${target} did not answer in time.`,
      hints: [
        "If the node sits on an IoT/guest VLAN, client isolation may be blocking you — test from the same VLAN.",
        "Check firewalls between the gateway and the node.",
        "Confirm the IP is reachable at all (ping it).",
        "A node with a dead battery looks exactly like this while its TCP state lingers — check the device physically.",
      ],
    };
  }

  return {
    summary: `Could not reach the node at ${target}${error ? `: ${error}` : "."}`,
    hints: [
      "Verify the node is reachable from this machine (same network, correct IP/port).",
      `Default port is ${MESHCORE_DEFAULT_PORT} — the companion TCP server must be enabled on the node.`,
      ONE_CLIENT_RULE,
    ],
  };
}
