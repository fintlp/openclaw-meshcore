import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { ResolvedMeshcoreAccount } from "./accounts.js";
import { createAccountStatusSink } from "./channel-api.js";
import { formatMeshcoreEndpoint } from "./transport.js";
import { monitorMeshcoreProvider } from "./monitor.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { CoreConfig } from "./types.js";

export async function startMeshcoreGatewayAccount(ctx: {
  cfg: CoreConfig;
  accountId: string;
  account: ResolvedMeshcoreAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  setStatus: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
  };
}): Promise<void> {
  const account = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });
  if (!account.configured) {
    throw new Error(
      `MeshCore is not configured for account "${account.accountId}" (need host in channels.meshcore).`,
    );
  }
  ctx.log?.info?.(
    `[${account.accountId}] starting MeshCore provider (tcp) at ${formatMeshcoreEndpoint(account)}`,
  );
  await runStoppablePassiveMonitor({
    abortSignal: ctx.abortSignal,
    start: async () =>
      await monitorMeshcoreProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
      }),
  });
}
