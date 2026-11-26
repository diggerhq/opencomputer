import { Plugin } from "@opencode-ai/plugin-v2";
import type { SessionContext } from "@opencode-ai/plugin-v2/promise/session";

import type { MemoryBinding } from "../edge/memory-contract.js";
import {
  memoryToolDescription,
  memoryToolNames,
  memoryToolsOf,
  type MemoryToolName,
} from "./memory-tools.js";
import {
  AgentRenderError,
  modelKey,
  renderAgent,
  type AgentFunction,
  type AgentRenderInput,
  type AgentRenderRecord,
  type AgentResourceRegistry,
  type ResolvedModel,
  type RenderAgentOptions,
  type AgentInput,
} from "./reactive-agent.js";

export const OPENCODE2_REACTIVE_PLUGIN_ID =
  "opencomputer.reactive-runtime";

export interface OpenCode2ProviderTurn {
  openCodeSessionId: string;
  openCodeAgentId: string;
  model: ResolvedModel;
  input: Readonly<AgentInput>;
  /**
   * The assistant messages already in the transcript when this request is
   * rendered. A tool call carrying one of these ids was made by an earlier
   * request, so its memory snapshot is not this one.
   */
  assistantMessageIds: readonly string[];
}

/** The session's memory grants and the declared, model-facing description of each resource. */
export interface OpenCode2MemoryBinding {
  bindings: readonly MemoryBinding[];
  descriptions: Readonly<Record<string, string>>;
}

export interface OpenCode2RenderBinding {
  agent: AgentFunction;
  input: AgentRenderInput;
  registry: AgentResourceRegistry;
  renderOptions?: RenderAgentOptions;
  memory?: OpenCode2MemoryBinding;
}

export interface OpenCode2ToolDefinition {
  description: string;
  input: unknown;
}

export type OpenCode2ToolRecord = Record<string, OpenCode2ToolDefinition>;

export interface AgentRenderDebugSnapshot {
  input: Readonly<AgentInput>;
  tools: Array<{ name: string; description: string }>;
  model: ResolvedModel;
}

export interface OpenCode2ReactivePluginOptions {
  resolve(
    turn: OpenCode2ProviderTurn,
  ): Promise<OpenCode2RenderBinding> | OpenCode2RenderBinding;
  commit(
    record: AgentRenderRecord,
    debug: AgentRenderDebugSnapshot,
    turn: OpenCode2ProviderTurn,
  ): Promise<void> | void;
  validateModel?(
    model: ResolvedModel | undefined,
    turn: OpenCode2ProviderTurn,
  ): Promise<ResolvedModel> | ResolvedModel;
}

function modelId(model: {
  providerID: string;
  id: string;
}): ResolvedModel {
  return { provider: model.providerID, model: model.id };
}

function assistantMessageIds(messages: SessionContext["messages"]): string[] {
  return messages.flatMap((message: { id?: unknown; role?: unknown }) =>
    message.role === "assistant" && typeof message.id === "string" ? [message.id] : [],
  );
}

/**
 * For each fixed memory tool, the resources the render selected that offer
 * it, with their declared descriptions; an empty list means the tool is not
 * exposed for this request. The same rule as the Workerd runtime's.
 */
export function memoryToolExposure(
  selected: ReadonlySet<string>,
  memory: OpenCode2MemoryBinding | undefined,
): Map<MemoryToolName, Array<{ resource: string; description: string }>> {
  const exposure = new Map<MemoryToolName, Array<{ resource: string; description: string }>>();
  for (const tool of memoryToolNames) {
    const targets: Array<{ resource: string; description: string }> = [];
    for (const binding of memory?.bindings ?? []) {
      if (selected.has(binding.resource) && memoryToolsOf(binding).includes(tool)) {
        targets.push({
          resource: binding.resource,
          description: memory?.descriptions[binding.resource] ?? binding.resource,
        });
      }
    }
    exposure.set(tool, targets);
  }
  return exposure;
}

function currentInput(messages: SessionContext["messages"]): AgentInput {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = message.content
      .filter((part: { type: string }) => part.type === "text")
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n");
    return { source: "user", ...(text ? { text } : {}) };
  }
  return { source: "system" };
}

/**
 * Tools the runtime offers every agent, which no agent declares. Kept here
 * because this is the only place that can tell them apart from a tool the
 * agent did not ask for.
 */
const RUNTIME_TOOLS = new Set(["load_agent_skill"]);

/**
 * Agents select a shell as `sandbox_exec` (or its older name `shell`), the
 * tool the workerd runtime provides. In the sandbox runtime the agent already
 * runs on its computer and the shell is OpenCode's own (`shell` in current
 * builds, `bash` in older ones), so either selection enables that.
 */
const OPENCODE_SHELL_TOOLS = new Set(["shell", "bash"]);
const SHELL_SELECTIONS = ["sandbox_exec", ...OPENCODE_SHELL_TOOLS];

function selectsShell(enabledTools: ReadonlySet<string>): boolean {
  return SHELL_SELECTIONS.some((name) => enabledTools.has(name));
}

export function defineOpenCode2ReactivePlugin(
  options: OpenCode2ReactivePluginOptions,
): Plugin.Plugin {
  return Plugin.define({
    id: OPENCODE2_REACTIVE_PLUGIN_ID,
    setup: async (context) => {
      await context.session.hook("context", async (event) => {
        const selectedModel = modelId(event.model);
        const turn: OpenCode2ProviderTurn = {
          openCodeSessionId: String(event.sessionID),
          openCodeAgentId: String(event.agent),
          model: selectedModel,
          input: currentInput(event.messages),
          assistantMessageIds: assistantMessageIds(event.messages),
        };
        const binding = await options.resolve(turn);
        const record = await renderAgent(
          binding.agent,
          binding.input,
          binding.registry,
          binding.renderOptions,
        );

        const renderedModel = record.model ?? selectedModel;
        const validatedModel = options.validateModel
          ? await options.validateModel(record.model, turn)
          : renderedModel;
        // A pinned model route (bring your own key) resolves to the
        // connection; the model gateway dispatches every call through it,
        // whatever model OpenCode asks for.
        if (
          validatedModel.provider !== "connection" &&
          modelKey(validatedModel) !== modelKey(renderedModel)
        ) {
          throw new AgentRenderError(
            "The model resolver returned a different model identity",
          );
        }

        if (
          record.model &&
          modelKey(record.model) !== modelKey(selectedModel)
        ) {
          throw new AgentRenderError(
            `The active response uses ${JSON.stringify(selectedModel)}, but the agent rendered ${JSON.stringify(record.model)}. Model changes apply to the next response.`,
          );
        }

        await options.commit(
          record,
          {
            input: turnInput(binding.input.currentInput),
            tools: record.enabledTools.map((name) => ({
              name,
              description: event.tools[name]?.description ?? "",
            })),
            model: selectedModel,
          },
          turn,
        );

        if (record.render.instructions) {
          event.system.push({
            type: "text",
            text: record.render.instructions,
          });
        }

        const registeredMcpServers = binding.registry.mcpServers ?? new Set();
        const allRegisteredMcpServersEnabled =
          record.render.enabledMcpServers.size > 0 &&
          record.render.enabledMcpServers.size ===
            registeredMcpServers.size &&
          [...registeredMcpServers].every((server) =>
            record.render.enabledMcpServers.has(server),
          );
        const memoryTools = memoryToolExposure(record.render.selectedMemory, binding.memory);
        for (const tool of Object.keys(event.tools)) {
          const exposure = memoryTools.get(tool as MemoryToolName);
          if (exposure !== undefined) {
            // A fixed memory tool: offered only for the resources this
            // render read, described with their declarations.
            const definition = event.tools[tool];
            if (exposure.length === 0 || !definition) delete event.tools[tool];
            else definition.description = memoryToolDescription(tool as MemoryToolName, exposure);
            continue;
          }
          const enabledByMcp = [...record.render.enabledMcpServers].some(
            (server) => tool.startsWith(`${server}_`),
          );
          const enabledMcpCatalogBridge =
            allRegisteredMcpServersEnabled &&
            (tool === "search" || tool === "execute");
          // Tools the runtime supplies rather than the agent declaring them.
          // The filter exists so an agent only gets what it asked for, which is
          // what makes the manifest mean something — but it was also deleting
          // the runtime's own tools, so a packaged skill could be registered
          // and then removed from every request before the model ever saw it.
          const suppliedByRuntime = RUNTIME_TOOLS.has(tool);
          const enabledAsShell =
            OPENCODE_SHELL_TOOLS.has(tool) &&
            selectsShell(record.render.enabledTools);
          if (
            !record.render.enabledTools.has(tool) &&
            !enabledByMcp &&
            !enabledMcpCatalogBridge &&
            !suppliedByRuntime &&
            !enabledAsShell
          ) {
            delete event.tools[tool];
          }
        }

      });
    },
  });
}

function turnInput(input: Readonly<AgentInput>): Readonly<AgentInput> {
  return {
    source: input.source,
    ...(typeof input.text === "string" ? { text: input.text } : {}),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    ...("schedule" in input && input.schedule
      ? { schedule: input.schedule }
      : {}),
  };
}
