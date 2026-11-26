import {
  modelRegistry,
  useModel,
  useSessionData,
  useTool,
  type AgentResourceRegistry,
} from "../../src/runtime/reactive-agent.js";

export const supportAgentRegistry: AgentResourceRegistry = {
  tools: new Set(["search-docs", "update-subscription"]),
  connections: new Set(["github"]),
  mcpServers: new Set(["github"]),
  models: modelRegistry(["anthropic/claude-sonnet-4.6"]),
};

export function SupportAgent(): string {
  const authenticated = useSessionData<boolean>("authenticated") ?? false;
  useModel("anthropic/claude-sonnet-4.6");
  useTool("search-docs");
  if (authenticated) {
    useTool({ id: "update-subscription" });
  }
  return authenticated
    ? "Help the authenticated customer with their account."
    : "Help generally without exposing private account information.";
}
