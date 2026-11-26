import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import type { MemorySource } from "../edge/memory-contract.js";

export type SessionDataValue =
  | null
  | boolean
  | number
  | string
  | readonly SessionDataValue[]
  | { readonly [key: string]: SessionDataValue };

export type AgentInputSource =
  | "user"
  | "channel"
  | "schedule"
  | "webhook"
  | "subagent"
  | "system";

export interface AgentInput {
  source: AgentInputSource;
  text?: string;
  payload?: SessionDataValue;
  schedule?: {
    id: string;
    runId: string;
    scheduledAt: string;
    timezone: string;
    attempt: number;
    manual: boolean;
  };
  /** Who sent a channel message, in the provider's own terms. */
  channel?: {
    provider: string;
    connectionId: string;
    workspaceId?: string;
    conversationId?: string;
    userId?: string;
  };
}

/** What a render receives for one bound memory resource; the same shape the Workerd runtime renders with. */
export interface RenderedMemory {
  text: string;
  sources: MemorySource[];
  writable: boolean;
}

export interface AgentRenderInput {
  projectId: string;
  deploymentId: string;
  agentId: string;
  sessionId: string;
  responseId: string;
  providerTurn: number;
  stateVersion: number;
  state: Readonly<Record<string, SessionDataValue>>;
  currentInput: Readonly<AgentInput>;
  /** The session's memory projections by resource; absent when it holds no grants. */
  memory?: Readonly<Record<string, RenderedMemory>>;
}

export interface AgentResourceRegistry {
  tools: ReadonlySet<string>;
  connections?: ReadonlySet<string>;
  mcpServers?: ReadonlySet<string>;
  models?: ReadonlySet<string>;
}

export interface AgentResourceReference {
  id: string;
}

export type AgentResource = string | AgentResourceReference;
export type AgentFunction = () => string;

export interface ResolvedModel {
  provider: string;
  model: string;
}

export type AgentModel = string | ResolvedModel;

export interface AgentRender {
  instructions: string;
  enabledTools: ReadonlySet<string>;
  requiredConnections: ReadonlySet<string>;
  enabledMcpServers: ReadonlySet<string>;
  /** The memory resources the render read with useMemory(); the only targets of this request's memory tools. */
  selectedMemory: ReadonlySet<string>;
  model?: ResolvedModel;
}

export interface AgentRenderRecord {
  renderId: string;
  deploymentId: string;
  agentId: string;
  sessionId: string;
  responseId: string;
  providerTurn: number;
  stateVersion: number;
  renderedAt: string;
  instructionsHash: string;
  enabledTools: readonly string[];
  requiredConnections: readonly string[];
  enabledMcpServers: readonly string[];
  model?: ResolvedModel;
  render: AgentRender;
}

export interface RenderAgentOptions {
  now?: () => Date;
  renderId?: () => string;
  defaultModelProvider?: string;
}

interface RenderScope {
  input: AgentRenderInput;
  registry: AgentResourceRegistry;
  tools: Set<string>;
  connections: Set<string>;
  mcpServers: Set<string>;
  selectedMemory: Set<string>;
  defaultModelProvider: string;
  model?: ResolvedModel;
}

const currentRender = new AsyncLocalStorage<RenderScope>();

export class AgentRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRenderError";
  }
}

export function resolveModel(
  selection: AgentModel,
  defaultProvider = "openrouter",
): ResolvedModel {
  const provider =
    typeof selection === "string" ? defaultProvider : selection.provider;
  const model = typeof selection === "string" ? selection : selection.model;
  if (!provider.trim() || !model.trim()) {
    throw new AgentRenderError(
      `Invalid model selection ${JSON.stringify(selection)}. Use "vendor/model" for the default provider or { provider, model } for an explicit provider.`,
    );
  }
  return { provider, model };
}

export function modelKey(model: ResolvedModel): string {
  return JSON.stringify([model.provider, model.model]);
}

export function modelRegistry(
  models: readonly AgentModel[],
  defaultProvider = "openrouter",
): ReadonlySet<string> {
  return new Set(
    models.map((model) => modelKey(resolveModel(model, defaultProvider))),
  );
}

function scopeFor(hook: string): RenderScope {
  const scope = currentRender.getStore();
  if (!scope) {
    throw new AgentRenderError(
      `${hook}() can only be called while rendering an OpenComputer agent`,
    );
  }
  return scope;
}

function resourceId(resource: AgentResource, hook: string): string {
  const id = typeof resource === "string" ? resource : resource.id;
  if (!id.trim()) {
    throw new AgentRenderError(`${hook}() requires a non-empty resource id`);
  }
  return id;
}

function enableResource(
  hook: string,
  resource: AgentResource,
  registered: ReadonlySet<string>,
  enabled: Set<string>,
): void {
  const id = resourceId(resource, hook);
  if (!registered.has(id)) {
    throw new AgentRenderError(
      `${hook}() referenced ${JSON.stringify(id)}, which is not part of this deployment`,
    );
  }
  enabled.add(id);
}

function readonlySet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

function instructionsHash(instructions: string): string {
  return createHash("sha256").update(instructions).digest("hex");
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function cloneState(
  state: Readonly<Record<string, SessionDataValue>>,
): Readonly<Record<string, SessionDataValue>> {
  return deepFreeze(structuredClone(state));
}

export function useModel(model: AgentModel): void {
  const scope = scopeFor("useModel");
  const resolved = resolveModel(model, scope.defaultModelProvider);
  const key = modelKey(resolved);
  if (scope.registry.models && !scope.registry.models.has(key)) {
    throw new AgentRenderError(
      `useModel() referenced ${JSON.stringify(model)}, which is not part of this deployment`,
    );
  }
  if (scope.model && modelKey(scope.model) !== key) {
    throw new AgentRenderError(
      `useModel() selected both ${JSON.stringify(scope.model)} and ${JSON.stringify(model)} in one render`,
    );
  }
  scope.model = resolved;
}

export function useTool(tool: AgentResource): void {
  const scope = scopeFor("useTool");
  enableResource("useTool", tool, scope.registry.tools, scope.tools);
}

export function useConnection(connection: AgentResource): void {
  const scope = scopeFor("useConnection");
  enableResource(
    "useConnection",
    connection,
    scope.registry.connections ?? new Set(),
    scope.connections,
  );
}

export function useMcpServer(server: AgentResource): void {
  const scope = scopeFor("useMcpServer");
  enableResource(
    "useMcpServer",
    server,
    scope.registry.mcpServers ?? new Set(),
    scope.mcpServers,
  );
}

export function useInput(): Readonly<AgentInput> {
  return scopeFor("useInput").input.currentInput;
}

export const useCurrentInput = useInput;

/**
 * The projection of one bound memory resource, or undefined when the
 * session holds no grant for it. Reading it selects the resource: the
 * fixed memory tools of this request target what the render read.
 */
export function useMemory(resource: AgentResource): RenderedMemory | undefined {
  const scope = scopeFor("useMemory");
  const id = resourceId(resource, "useMemory");
  const projection = scope.input.memory?.[id];
  if (projection) scope.selectedMemory.add(id);
  return projection;
}

export function useSessionData<T extends SessionDataValue = SessionDataValue>(
  key: string,
): T | undefined {
  const scope = scopeFor("useSessionData");
  if (!key.trim()) {
    throw new AgentRenderError("useSessionData() requires a non-empty key");
  }
  return scope.input.state[key] as T | undefined;
}

export async function renderAgent(
  agent: AgentFunction,
  input: AgentRenderInput,
  registry: AgentResourceRegistry,
  options: RenderAgentOptions = {},
): Promise<AgentRenderRecord> {
  if (currentRender.getStore()) {
    throw new AgentRenderError("An agent cannot start a nested render");
  }
  if (!Number.isSafeInteger(input.providerTurn) || input.providerTurn < 1) {
    throw new AgentRenderError("providerTurn must be a positive integer");
  }
  if (!Number.isSafeInteger(input.stateVersion) || input.stateVersion < 0) {
    throw new AgentRenderError("stateVersion must be a non-negative integer");
  }

  const scope: RenderScope = {
    input: {
      ...input,
      state: cloneState(input.state),
      currentInput: deepFreeze(structuredClone(input.currentInput)),
    },
    registry,
    tools: new Set(),
    connections: new Set(),
    mcpServers: new Set(),
    selectedMemory: new Set(),
    defaultModelProvider: options.defaultModelProvider ?? "openrouter",
  };
  const instructions = currentRender.run(scope, agent);
  if (typeof instructions !== "string") {
    throw new AgentRenderError("An agent must synchronously return instructions");
  }

  const enabledTools = [...scope.tools].sort();
  const requiredConnections = [...scope.connections].sort();
  const enabledMcpServers = [...scope.mcpServers].sort();
  const renderedAt = (options.now?.() ?? new Date()).toISOString();
  const render: AgentRender = {
    instructions,
    enabledTools: readonlySet(enabledTools),
    requiredConnections: readonlySet(requiredConnections),
    enabledMcpServers: readonlySet(enabledMcpServers),
    selectedMemory: readonlySet([...scope.selectedMemory].sort()),
    model: scope.model,
  };

  return {
    renderId: options.renderId?.() ?? randomUUID(),
    deploymentId: input.deploymentId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    responseId: input.responseId,
    providerTurn: input.providerTurn,
    stateVersion: input.stateVersion,
    renderedAt,
    instructionsHash: instructionsHash(instructions),
    enabledTools,
    requiredConnections,
    enabledMcpServers,
    model: scope.model,
    render,
  };
}
