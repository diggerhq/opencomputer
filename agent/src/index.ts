export type DataValue =
  | null
  | boolean
  | number
  | string
  | readonly DataValue[]
  | { readonly [key: string]: DataValue };

export type InputSource =
  | "user"
  | "channel"
  | "schedule"
  | "webhook"
  | "subagent"
  | "system";

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

export interface SecretReference extends ResourceReference {
  readonly kind: "secret";
}

export interface SecretHeaderReference {
  readonly kind: "secret-header";
  readonly secret: SecretReference;
  readonly prefix?: string;
  readonly suffix?: string;
}

export interface HttpConnectionDefinition extends ConnectionReference {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string | SecretHeaderReference>>;
  readonly methods?: readonly string[];
  readonly pathPrefix?: string;
  readonly redirectOrigins?: readonly HttpConnectionRedirectOrigin[];
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface HttpConnectionRedirectOrigin {
  readonly origin: string;
  readonly pathPrefix?: string;
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
  readonly input: Record<string, unknown>;
  readonly sessionId: string;
  readonly messageId: string;
  readonly agentId: string;
  readonly signal?: AbortSignal;
  reportProgress(metadata: Readonly<Record<string, DataValue>>): Promise<void>;
}

export interface ToolDefinition<
  Output extends DataValue = DataValue,
> extends ResourceReference {
  readonly kind: "tool";
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly input?: ToolInputSchema;
  readonly output?: ToolInputSchema;
  run(context: ToolExecutionContext): Output | Promise<Output>;
}

interface AgentHooks {
  useInput(): Readonly<AgentInput>;
  useModel(model: ModelSelection): void;
  useTool(tool: string | ResourceReference): void;
  useSubagent(agent: string | ResourceReference): void;
  useSessionData<T extends DataValue>(key: string): T | undefined;
  useMcpServer(server: string | ResourceReference): void;
}

function hooks(): AgentHooks {
  const value = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("opencomputer.agent-hooks")
  ];
  if (!value) {
    throw new Error("OpenComputer hooks can only run while rendering an agent");
  }
  return value as AgentHooks;
}

function identifier(value: string, kind: string): string {
  const id = value.trim();
  if (!id) throw new Error(`${kind} requires a non-empty id`);
  return id;
}

export function useSecret(name: string): SecretReference {
  const id = identifier(name, "useSecret");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(id)) {
    throw new Error(
      "Secret names must use uppercase letters, numbers, and underscores",
    );
  }
  return Object.freeze({ kind: "secret", id });
}

export function secretHeader(
  secret: SecretReference,
  options: { prefix?: string; suffix?: string } = {},
): SecretHeaderReference {
  return Object.freeze({ kind: "secret-header", secret, ...options });
}

export function bearer(secret: SecretReference): SecretHeaderReference {
  return secretHeader(secret, { prefix: "Bearer " });
}

export function defineConnection(input: {
  id: string;
  origin: string;
  headers?: Readonly<Record<string, string | SecretHeaderReference>>;
  methods?: readonly string[];
  pathPrefix?: string;
  redirectOrigins?: readonly HttpConnectionRedirectOrigin[];
}): HttpConnectionDefinition {
  const id = identifier(input.id, "defineConnection");
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new Error("Connection origins must be HTTPS origins without a path");
  }
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (
      [
        "api-key",
        "authorization",
        "cookie",
        "proxy-authorization",
        "x-api-key",
      ].includes(name.toLowerCase()) &&
      typeof value === "string"
    ) {
      throw new Error(`${name} must use useSecret()`);
    }
  }
  if ((input.redirectOrigins?.length ?? 0) > 16) {
    throw new Error("Connections may declare at most 16 redirect origins");
  }
  const redirectOrigins = input.redirectOrigins?.map((input) => {
    const redirectOrigin = new URL(input.origin);
    if (redirectOrigin.protocol !== "https:" || redirectOrigin.pathname !== "/") {
      throw new Error(
        "Connection redirect origins must be HTTPS origins without a path",
      );
    }
    if (input.pathPrefix !== undefined && !input.pathPrefix.startsWith("/")) {
      throw new Error("Connection redirect path prefixes must start with /");
    }
    return Object.freeze({
      origin: redirectOrigin.origin,
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
    });
  });
  if (
    redirectOrigins &&
    new Set(
      redirectOrigins.map(
        ({ origin, pathPrefix }) => `${origin}\n${pathPrefix ?? ""}`,
      ),
    ).size !== redirectOrigins.length
  ) {
    throw new Error("Connection redirect origin policies must be unique");
  }
  const definition = {
    kind: "connection" as const,
    id,
    origin: origin.origin,
    headers: Object.freeze({ ...(input.headers ?? {}) }),
    ...(input.methods
      ? {
          methods: Object.freeze(
            input.methods.map((method) => method.toUpperCase()),
          ),
        }
      : {}),
    ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
    ...(redirectOrigins
      ? { redirectOrigins: Object.freeze(redirectOrigins) }
      : {}),
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const runtime = globalThis as typeof globalThis & {
        process?: { env?: Record<string, string | undefined> };
      };
      const base = runtime.process?.env?.OPENCOMPUTER_CONNECTIONS_URL;
      const token = runtime.process?.env?.OPENCOMPUTER_CONNECTION_TOKEN;
      if (!base || !token) {
        throw new Error("OpenComputer managed egress is unavailable");
      }
      if (!path.startsWith("/")) {
        throw new Error("Connection requests require an absolute path");
      }
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body =
        init.body === undefined || init.body === null
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : (() => {
                throw new Error(
                  "Managed connection request bodies must currently be strings",
                );
              })();
      if (body !== undefined && body.length > 5 * 1024 * 1024) {
        throw new Error(
          "Managed connection request bodies cannot exceed 5 MiB",
        );
      }
      return fetch(
        `${base.replace(/\/$/, "")}/${encodeURIComponent(id)}/fetch`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            method: (init.method ?? "GET").toUpperCase(),
            path,
            headers,
            ...(body === undefined ? {} : { body }),
          }),
          signal: init.signal,
        },
      );
    },
  };
  return Object.freeze(definition);
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

export function defineTool<Output extends DataValue = DataValue>(input: {
  name: string;
  description: string;
  input?: ToolInputSchema;
  output?: ToolInputSchema;
  run(context: ToolExecutionContext): Output | Promise<Output>;
}): ToolDefinition<Output> {
  const id = identifier(input.name, "defineTool");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(
      "Tool IDs may contain only letters, numbers, underscores, and hyphens",
    );
  }
  if (!input.description.trim()) {
    throw new Error("defineTool requires a non-empty description");
  }
  if (input.input && typeof input.input !== "object") {
    throw new Error("defineTool input must be a JSON Schema object");
  }
  if (input.output && typeof input.output !== "object") {
    throw new Error("defineTool output must be a JSON Schema object");
  }
  return Object.freeze({
    kind: "tool" as const,
    version: 1 as const,
    ...input,
    id,
    name: id,
  });
}

export const useInput = (): Readonly<AgentInput> => hooks().useInput();
export const useCurrentInput = useInput;
export const useModel = (model: ModelSelection): void =>
  hooks().useModel(model);
export const useTool = (tool: string | ResourceReference): void =>
  hooks().useTool(tool);
export const useSubagent = (agent: string | ResourceReference): void =>
  hooks().useSubagent(agent);
export const useMcpServer = (server: string | ResourceReference): void =>
  hooks().useMcpServer(server);
export function useSessionData<T extends DataValue>(
  key: string,
): T | undefined {
  return hooks().useSessionData<T>(key);
}
