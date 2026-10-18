import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createSetupTranslator,
  createStandardChannelSetupStatus,
  formatDocsLink,
  mergeAllowFromEntries,
  setSetupChannelEnabled,
  splitSetupEntries,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultMeshcoreAccountId, resolveMeshcoreAccount } from "./accounts.js";
import { probeMeshcore } from "./probe.js";
import {
  formatMeshcoreChannelTarget,
  normalizeMeshcoreAllowEntry,
  normalizeMeshcoreMessagingTarget,
} from "./normalize.js";
import { diagnoseMeshcoreProbeFailure, splitHostPort } from "./setup-detect.js";
import { formatMeshcoreEndpoint } from "./transport.js";
import {
  meshcoreSetupAdapter,
  parsePort,
  setMeshcoreGroupAccess,
  updateMeshcoreAccountConfig,
} from "./setup-core.js";
import type { CoreConfig, MeshcoreAccountConfig, MeshcoreProbe } from "./types.js";

const t = createSetupTranslator();
const channel = "meshcore" as const;

function normalizeGroupEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return normalizeMeshcoreMessagingTarget(trimmed) ?? trimmed;
}

function resolveMeshcoreConfigKeys(accountId?: string): { policyKey: string; allowFromKey: string } {
  if (accountId && accountId !== DEFAULT_ACCOUNT_ID) {
    return {
      policyKey: `channels.meshcore.accounts.${accountId}.dmPolicy`,
      allowFromKey: `channels.meshcore.accounts.${accountId}.allowFrom`,
    };
  }
  return {
    policyKey: "channels.meshcore.dmPolicy",
    allowFromKey: "channels.meshcore.allowFrom",
  };
}

function readAccountSection(
  cfg: CoreConfig,
  accountId: string,
): MeshcoreAccountConfig | undefined {
  const section = cfg.channels?.meshcore;
  if (!section) {
    return undefined;
  }
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return section;
  }
  return section.accounts?.[accountId];
}

/** Mesh group entries created during setup default to mention-gated.
 * Existing explicit values are never clobbered. */
function withDefaultRequireMention(cfg: CoreConfig, accountId: string): CoreConfig {
  const section = readAccountSection(cfg, accountId);
  const groups = section?.groups;
  if (!groups || typeof groups !== "object") {
    return cfg;
  }
  let changed = false;
  const nextGroups = Object.fromEntries(
    Object.entries(groups).map(([key, value]) => {
      if (value && typeof value === "object" && value.requireMention === undefined) {
        changed = true;
        return [key, { ...value, requireMention: true }];
      }
      return [key, value];
    }),
  );
  if (!changed) {
    return cfg;
  }
  return updateMeshcoreAccountConfig(cfg, accountId, { groups: nextGroups });
}

export { meshcoreSetupAdapter };

export const meshcoreSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "MeshCore",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: "Needs connection",
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: "Set channels.meshcore.host for the MeshCore device.",
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).configured,
    resolveExtraStatusLines: ({ cfg, accountId }) => {
      const account = resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId });
      if (!account.configured) {
        return [];
      }
      return [`tcp: ${formatMeshcoreEndpoint(account)}`];
    },
  }),
  introNote: {
    title: "MeshCore setup",
    lines: [
      "Connect via Companion TCP protocol (default port 5000).",
      "The wizard probes the node before anything is written, so typos cost seconds, not evenings.",
      "Heads-up: a MeshCore node serves ONE companion client at a time — disconnect the phone app first.",
      `Docs: ${formatDocsLink("/channels/meshcore", "channels/meshcore")}`,
    ],
  },
  credentials: [],
  finalize: async ({ cfg, prompter, accountId }) => {
    const resolvedAccountId = accountId ?? resolveDefaultMeshcoreAccountId(cfg as CoreConfig);
    let workingCfg = cfg as CoreConfig;
    const account = resolveMeshcoreAccount({
      cfg: workingCfg,
      accountId: resolvedAccountId,
    });

    let endpoint = {
      host: account.host,
      port: account.port || 5000,
    };
    let probeOk = false;
    let probeResult: MeshcoreProbe | null = null;

    // ── Endpoint → probe (with diagnosis), retry loop ───────────────────
    for (;;) {
      const hostRaw = await prompter.text({
        message: "MeshCore node host or IP",
        placeholder: "192.168.1.20 or meshcore.local (host:port also works)",
        initialValue: endpoint.host || process.env.MESHCORE_HOST || "",
        validate: (value: string) => (normalizeOptionalString(value) ? undefined : "Required"),
      });
      const split = splitHostPort(hostRaw);
      endpoint.host = split.host;
      endpoint.port = parsePort(
        await prompter.text({
          message: "TCP port",
          initialValue: String(split.port ?? endpoint.port ?? 5000),
        }),
        split.port ?? 5000,
      );

      const candidateCfg = updateMeshcoreAccountConfig(workingCfg, resolvedAccountId, {
        host: endpoint.host,
        port: endpoint.port,
      });
      const target = formatMeshcoreEndpoint(endpoint);
      const progress = prompter.progress(`Probing ${target}…`);
      const probe = await probeMeshcore(candidateCfg, {
        accountId: resolvedAccountId,
        timeoutMs: 8000,
      });
      if (probe.ok) {
        progress.stop(`Node answers at ${target} — ${probe.latencyMs}ms`);
        probeOk = true;
        probeResult = probe;
        workingCfg = candidateCfg;
        break;
      }

      progress.stop(`No answer from ${target}`);
      const diagnosis = diagnoseMeshcoreProbeFailure({
        host: endpoint.host,
        port: endpoint.port,
        error: probe.error,
      });
      await prompter.note(
        [diagnosis.summary, "", ...diagnosis.hints.map((hint) => `• ${hint}`)].join("\n"),
        "Connection diagnosis",
      );
      const retry = await prompter.confirm({
        message: "Re-enter connection details? (No = save anyway and troubleshoot later)",
        initialValue: true,
      });
      if (!retry) {
        workingCfg = candidateCfg;
        break;
      }
    }

    // ── Node identity (returned by a successful probe) ──────────────────
    const selfInfo = probeOk ? probeResult?.selfInfo : undefined;
    if (selfInfo) {
      const lines: string[] = [];
      if (selfInfo.longName) {
        lines.push(`Name: ${selfInfo.longName}`);
      }
      if (selfInfo.hardwareModel) {
        lines.push(`Hardware: ${selfInfo.hardwareModel}`);
      }
      if (selfInfo.firmwareVersion) {
        lines.push(`Firmware: ${selfInfo.firmwareVersion}`);
      }
      if (typeof selfInfo.batteryMv === "number" && selfInfo.batteryMv > 0) {
        lines.push(`Battery: ${(selfInfo.batteryMv / 1000).toFixed(2)} V`);
      }
      if (lines.length > 0) {
        await prompter.note(lines.join("\n"), `Node ${selfInfo.nodeId}`);
      }
    }

    // ── Mesh channels to listen ─────────────────────────────────────────
    const channelsRaw = await prompter.text({
      message: "Mesh channel indices to listen on (comma-separated, 0-7)",
      initialValue: (account.config.channels ?? [0]).join(","),
    });
    const channels = channelsRaw
      .split(/[,;\s]+/)
      .map((entry: string) => Number.parseInt(entry.trim(), 10))
      .filter((value: number) => Number.isFinite(value) && value >= 0 && value <= 7);

    // ── The airtime rule (MeshCore groups are receive-only by design) ────
    await prompter.note(
      [
        "LoRa airtime is a shared commons: every node in range hears every channel message, and there is no delete button on the airwaves.",
        "",
        "This plugin keeps MeshCore groups RECEIVE-ONLY: the agent can listen and answer DMs, but it will never transmit on a channel. That is a code-level decision, not a config toggle.",
      ].join("\n"),
      "The airtime rule",
    );

    // ── Write, default mention-gating, summary ──────────────────────────
    let next = updateMeshcoreAccountConfig(workingCfg, resolvedAccountId, {
      host: endpoint.host,
      port: endpoint.port,
      channels: channels.length ? channels : [0],
    });
    next = withDefaultRequireMention(next, resolvedAccountId);
    next = setSetupChannelEnabled(next, channel, true) as CoreConfig;

    const finalAccount = resolveMeshcoreAccount({ cfg: next, accountId: resolvedAccountId });
    await prompter.note(
      [
        `Endpoint: ${formatMeshcoreEndpoint(endpoint)}${probeOk ? " (probe passed)" : " (not verified — saved anyway)"}`,
        selfInfo
          ? `Node: ${selfInfo.nodeId}${selfInfo.longName ? ` "${selfInfo.longName}"` : ""}`
          : "",
        `DM policy: ${finalAccount.config.dmPolicy ?? "pairing"} — groups: receive-only (code-level)`,
        "",
        `Self-test: send a DM to ${selfInfo?.nodeId ?? "your node"} from a MeshCore companion app — expect a reply within about a minute (LoRa is slow).`,
      ]
        .filter(Boolean)
        .join("\n"),
      "MeshCore configured",
    );

    return { cfg: next };
  },
  dmPolicy: {
    label: "MeshCore",
    channel,
    policyKey: "channels.meshcore.dmPolicy",
    allowFromKey: "channels.meshcore.allowFrom",
    resolveConfigKeys: (_cfg, accountId) => resolveMeshcoreConfigKeys(accountId),
    getCurrent: (cfg, accountId) =>
      resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).config.dmPolicy ?? "pairing",
    setPolicy: (cfg, policy, accountId) =>
      updateMeshcoreAccountConfig(
        cfg as CoreConfig,
        accountId ?? resolveDefaultMeshcoreAccountId(cfg as CoreConfig),
        { dmPolicy: policy },
      ),
    promptAllowFrom: createPromptParsedAllowFromForAccount({
      defaultAccountId: resolveDefaultMeshcoreAccountId,
      message: "Allowed MeshCore node ids",
      placeholder: "!aabbccdd1122..., advert-name, *",
      parseEntries: (raw: string) => ({
        entries: mergeAllowFromEntries(undefined, splitSetupEntries(raw)),
      }),
      getExistingAllowFrom: ({ cfg, accountId }) =>
        resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? [],
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        updateMeshcoreAccountConfig(cfg as CoreConfig, accountId, { allowFrom }),
    }),
  },
  allowFrom: createAllowFromSection({
    message: "Allowed MeshCore node ids",
    placeholder: "!aabbccdd1122..., advert-name, *",
    invalidWithoutCredentialNote:
      "Entries that are not valid MeshCore node ids or names will be ignored.",
    parseId: normalizeMeshcoreAllowEntry,
    apply: ({ cfg, accountId, allowFrom }) =>
      updateMeshcoreAccountConfig(cfg as CoreConfig, accountId, { allowFrom }),
  }),
  groupAccess: {
    label: "MeshCore broadcast channels",
    placeholder: formatMeshcoreChannelTarget(0),
    currentPolicy: ({ cfg, accountId }) =>
      resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).config.groupPolicy ??
      "disabled",
    currentEntries: ({ cfg, accountId }) =>
      Object.keys(resolveMeshcoreAccount({ cfg: cfg as CoreConfig, accountId }).config.groups ?? {}),
    updatePrompt: () => true,
    setPolicy: ({ cfg, accountId, policy }) =>
      setMeshcoreGroupAccess(cfg as CoreConfig, accountId, policy, [], normalizeGroupEntry),
    resolveAllowlist: async ({ entries }) => entries,
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setMeshcoreGroupAccess(
        cfg as CoreConfig,
        accountId,
        "allowlist",
        Array.isArray(resolved) ? resolved.filter((entry): entry is string => typeof entry === "string") : [],
        normalizeGroupEntry,
      ),
  },
};
