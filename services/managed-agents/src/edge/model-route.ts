import type {
  ModelAccessConnectionKind,
  ModelGatewayProtocol,
  ModelRoute,
} from "../protocol.js";

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface ResolvedModelRoute {
  source: "agent_route" | "project_route" | "use_model" | "platform_default";
  requested?: ModelSelection;
  effective: ModelSelection;
  route?: ModelRoute;
}

/**
 * Resolve the model independently from provider credentials. Routes are
 * already scoped to the session's project and environment by the caller.
 */
export function resolveModelRoute(input: {
  routes: ModelRoute[];
  agentId: string;
  requested?: ModelSelection;
  platformDefault?: ModelSelection;
}): ResolvedModelRoute | null {
  const route =
    input.routes.find((candidate) => candidate.agentId === input.agentId) ??
    input.routes.find((candidate) => !candidate.agentId);
  if (route) {
    return {
      source: route.agentId ? "agent_route" : "project_route",
      ...(input.requested ? { requested: input.requested } : {}),
      effective: { provider: "connection", model: route.model },
      route,
    };
  }
  if (input.requested) {
    return {
      source: "use_model",
      requested: input.requested,
      effective: input.requested,
    };
  }
  if (input.platformDefault) {
    return { source: "platform_default", effective: input.platformDefault };
  }
  return null;
}

/** A route must preserve the wire protocol OpenCode selected for the call. */
export function connectionSupportsProtocol(
  kind: ModelAccessConnectionKind,
  protocol: ModelGatewayProtocol,
): boolean {
  switch (kind) {
    case "codex_subscription":
      return protocol === "responses";
    case "claude_subscription":
      return protocol === "anthropic_messages";
    case "openrouter_api_key":
      return true;
    case "openai_compatible_api":
      return protocol === "chat_completions";
  }
}


/**
 * The OpenRouter model a Managed Responses dispatch requests. A Codex route
 * that fell back at its usage limit keeps its pinned model; otherwise the
 * request's own model is served.
 */
export function managedResponsesModel(
  requested: ModelSelection | undefined,
  pinned?: ModelSelection,
): string | undefined {
  const model = (pinned ?? requested)?.model;
  return model ? `openai/${model}` : undefined;
}
