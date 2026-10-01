import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { isMeshcoreGroupTarget, normalizeMeshcoreMessagingTarget } from "./normalize.js";

export function resolveMeshcoreOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const target = stripChannelTargetPrefix(params.target, "meshcore");
  const normalized = normalizeMeshcoreMessagingTarget(target);
  if (!normalized) {
    return null;
  }
  const isGroup = isMeshcoreGroupTarget(normalized);
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "meshcore",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: normalized,
    },
    chatType: isGroup ? "group" : "direct",
    from: `meshcore:${normalized}`,
    to: `meshcore:${normalized}`,
  });
}
