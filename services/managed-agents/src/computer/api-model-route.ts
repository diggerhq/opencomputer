// Session API writes resolve the owner's model seat before a runner starts,
// just as Slack deliveries do. The model frame precedes the API frame so the
// host never falls back to the organization's Claude route for a Codex model.

import { harnessOnProfile } from "./harnesses.js";
import type { ModelAccess } from "./model-access.js";
import { webOwner } from "./model-access.js";
import type { CalvinApiError, CalvinGatewayToHost, CalvinSessionSpec, ModelProfile } from "./protocol.js";
import { workOsUserOf } from "./session-ids.js";

export type RoutedApiSession = { session: CalvinSessionSpec; error?: CalvinApiError };

/** The subscription identity shared by a dashboard member and their Slack login. */
export function apiSubscriptionOwner(access: ModelAccess, member: string | undefined): string | undefined {
  const user = member && workOsUserOf(member);
  return user ? access.agents.view(user).linkedSlackUser?.id ?? webOwner(user) : undefined;
}

export async function routeApiSession(
  deps: {
    access: ModelAccess;
    profiles: () => ModelProfile[] | undefined;
    send: (frame: CalvinGatewayToHost) => boolean;
  },
  session: CalvinSessionSpec,
  member?: string,
): Promise<RoutedApiSession> {
  const ownerOf = (id: string | undefined) => apiSubscriptionOwner(deps.access, id);
  const owner = session.owner.slackUserId || ownerOf(session.owner.userId);
  let wanted = deps.access.models.harness(session.key);
  if (session.kind === "api") {
    if (session.model?.startsWith("gpt-")) wanted = "codex";
    else if (session.model?.startsWith("claude-")) wanted = "claude";
  }
  // A non-WorkOS API identity has no personal subscription to resolve.
  if (!owner) return wanted === "codex"
    ? { session, error: { code: "model_unavailable", status: 403, message: "This model requires a linked Codex connection." } }
    : { session };
  deps.access.models.setHarness(session.key, wanted);
  const poster = !member || member === session.owner.userId ? owner : ownerOf(member) ?? webOwner(member);
  const { route } = await deps.access.models.forDelivery({ key: session.key, ownerId: owner }, poster);
  if (route.mode === "refuse") return { session, error: { code: "model_unavailable", status: 403, message: route.reason } };
  const harness = route.mode === "subscription"
    ? route.provider === "chatgpt" ? "codex" : "claude"
    : route.mode === "profile" ? harnessOnProfile(deps.profiles(), route.profile, wanted) : "claude";
  if (wanted === "codex" && harness !== "codex") {
    return { session, error: { code: "model_unavailable", status: 403, message: "This model requires an available Codex connection. Connect ChatGPT or select a Claude model." } };
  }
  // The public build has no subscription router. Its managed credentials are
  // already in welcome; no per-session override is needed for that route.
  if (route.mode === "managed") return { session: { ...session, harness } };
  if (!deps.send({ t: "model", sessionKey: session.key, model: route })) {
    return { session, error: { code: "computer_unavailable", status: 503, message: "The computer disconnected. Retry the request.", retryable: true } };
  }
  deps.access.models.noteSent(session.key, route);
  return { session: { ...session, harness } };
}
