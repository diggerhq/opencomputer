export type DataValue =
  | null | boolean | number | string
  | readonly DataValue[]
  | { readonly [key: string]: DataValue };

export type InputSource =
  | "user" | "channel" | "schedule" | "webhook" | "subagent" | "system";

export interface AgentInput {
  readonly source: InputSource;
  readonly text?: string;
  readonly payload?: DataValue;
}

export interface ResourceReference {
  readonly id: string;
}

export interface ConnectionReference extends ResourceReference {
  readonly kind: "connection";
}

export interface McpServerDefinition extends ResourceReference {
  readonly kind: "mcp";
  readonly url: string;
  readonly connection?: ConnectionReference;
}

export type ModelSelection =
  | string
  | { readonly provider: string; readonly model: string };

export type ToolInputSchema = Readonly<Record<string, unknown>>;

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly messageId: string;
  readonly agentId: string;
  reportProgress(
    metadata: Readonly<Record<string, DataValue>>,
  ): Promise<void>;
}

export interface ToolResult {
  readonly content: string;
  readonly metadata?: Readonly<Record<string, DataValue>>;
}

export interface ToolDefinition<Input = Record<string, unknown>>
  extends ResourceReference {
  readonly kind: "tool";
  readonly version: 1;
  readonly description: string;
  readonly input: ToolInputSchema;
  execute(
    input: Input,
    context: ToolExecutionContext,
  ): ToolResult | string | Promise<ToolResult | string>;
}

interface AgentHooks {
  useInput(): Readonly<AgentInput>;
  useModel(model: ModelSelection): void;
  useTool(tool: string | ResourceReference): void;
  useSubagent(agent: string | ResourceReference): void;
  useSessionData<T extends DataValue>(key: string): T | undefined;
  useConnection(connection: string | ResourceReference): void;
  useMcpServer(server: string | ResourceReference): void;
}

function hooks(): AgentHooks {
  const value = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("opencomputer.agent-hooks")
  ];
  if (!value) {
    throw new Error(
      "OpenComputer hooks can only run while rendering an agent",
    );
  }
  return value as AgentHooks;
}

function identifier(value: string, kind: string): string {
  const id = value.trim();
  if (!id) throw new Error(`${kind} requires a non-empty id`);
  return id;
}

export function connection(id: string): ConnectionReference {
  return Object.freeze({ kind: "connection", id: identifier(id, "connection") });
}

export function defineMcpServer(input: {
  id: string;
  url: string;
  connection?: ConnectionReference;
}): McpServerDefinition {
  const url = new URL(input.url);
  if (url.protocol !== "https:") {
    throw new Error("Managed MCP server URLs must use HTTPS");
  }
  return Object.freeze({
    kind: "mcp",
    id: identifier(input.id, "defineMcpServer"),
    url: url.toString(),
    ...(input.connection ? { connection: input.connection } : {}),
  });
}

export function tool<Input = Record<string, unknown>>(input: {
  id: string;
  description: string;
  input: ToolInputSchema;
  execute(
    input: Input,
    context: ToolExecutionContext,
  ): ToolResult | string | Promise<ToolResult | string>;
}): ToolDefinition<Input> {
  const id = identifier(input.id, "tool");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      "Tool IDs may contain only letters, numbers, underscores, and hyphens",
    );
  }
  if (!input.description.trim()) {
    throw new Error("tool requires a non-empty description");
  }
  if (!input.input || typeof input.input !== "object") {
    throw new Error("tool requires a JSON Schema input object");
  }
  return Object.freeze({
    kind: "tool" as const,
    version: 1 as const,
    ...input,
    id,
  });
}

export const useInput = (): Readonly<AgentInput> => hooks().useInput();
export const useCurrentInput = useInput;
export const useModel = (model: ModelSelection): void => hooks().useModel(model);
export const useTool = (tool: string | ResourceReference): void => hooks().useTool(tool);
export const useSubagent = (agent: string | ResourceReference): void => hooks().useSubagent(agent);
export const useConnection = (value: string | ResourceReference): void => hooks().useConnection(value);
export const useMcpServer = (server: string | ResourceReference): void => hooks().useMcpServer(server);
export function useSessionData<T extends DataValue>(key: string): T | undefined {
  return hooks().useSessionData<T>(key);
}
