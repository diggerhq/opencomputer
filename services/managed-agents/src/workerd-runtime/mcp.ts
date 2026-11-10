export interface ManifestMcpServerDefinition {
  id: string;
  url: string;
  connection?: string;
}

export interface ManagedMcpContext {
  edge: string;
  managedSessionId: string;
  runtimeToken: string;
}

export interface OpenCodeMcpServerConfiguration {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  oauth: false;
}

export function workerdDatabaseMcpServer(
  context: ManagedMcpContext,
): OpenCodeMcpServerConfiguration {
  return {
    type: "remote",
    url:
      `${context.edge.replace(/\/$/, "")}/v1/sessions/` +
      `${encodeURIComponent(context.managedSessionId)}/database/mcp`,
    headers: { authorization: `Bearer ${context.runtimeToken}` },
    oauth: false,
  };
}

/**
 * OpenCode runs inside the trusted Workerd host, but managed credentials stay
 * at the edge. A connected MCP server therefore points at a raw Streamable
 * HTTP bridge authenticated with the session's runtime token; an unconnected
 * public server can be contacted directly.
 */
export function workerdMcpServers(
  registered: readonly string[],
  definitions: readonly ManifestMcpServerDefinition[],
  context: ManagedMcpContext,
): Record<string, OpenCodeMcpServerConfiguration> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  return Object.fromEntries(
    registered.map((id) => {
      const definition = byId.get(id);
      if (!definition) {
        throw new Error(`MCP server ${JSON.stringify(id)} has no definition in the artifact`);
      }
      if (!URL.canParse(definition.url)) {
        throw new Error(`MCP server ${JSON.stringify(id)} has an invalid URL`);
      }
      if (!definition.connection) {
        return [
          id,
          { type: "remote", url: definition.url, oauth: false },
        ];
      }
      const upstream = new URL(definition.url);
      const proxy = new URL(
        `${context.edge.replace(/\/$/, "")}/v1/sessions/` +
          `${encodeURIComponent(context.managedSessionId)}/mcp/` +
          encodeURIComponent(definition.connection),
      );
      proxy.searchParams.set("path", `${upstream.pathname}${upstream.search}`);
      return [
        id,
        {
          type: "remote",
          url: proxy.toString(),
          headers: { authorization: `Bearer ${context.runtimeToken}` },
          oauth: false,
        },
      ];
    }),
  );
}

export function workerdMcpToolIsEnabled(
  tool: string,
  enabled: readonly string[],
  registered: readonly string[],
): boolean {
  if (enabled.some((server) => tool.startsWith(`${server}_`))) return true;
  const allRegisteredEnabled =
    enabled.length > 0 &&
    enabled.length === registered.length &&
    registered.every((server) => enabled.includes(server));
  return allRegisteredEnabled && (tool === "search" || tool === "execute");
}

export interface WorkerdMcpToolExposure {
  availableToolCount: number;
  codeMode: {
    searchAvailable: boolean;
    executeAvailable: boolean;
    searchRetained: boolean;
    executeRetained: boolean;
  };
  registeredToolCounts: Record<string, number>;
}

/**
 * A bounded, schema-free view of the tool catalog OpenCode gave the request.
 * It is safe to log: it records counts and Code Mode availability, not tool
 * inputs, outputs, server URLs, or credential-bearing configuration.
 */
export function workerdMcpToolExposure(
  tools: readonly string[],
  enabled: readonly string[],
  registered: readonly string[],
): WorkerdMcpToolExposure {
  const available = new Set(tools);
  return {
    availableToolCount: available.size,
    codeMode: {
      searchAvailable: available.has("search"),
      executeAvailable: available.has("execute"),
      searchRetained:
        available.has("search") &&
        workerdMcpToolIsEnabled("search", enabled, registered),
      executeRetained:
        available.has("execute") &&
        workerdMcpToolIsEnabled("execute", enabled, registered),
    },
    registeredToolCounts: Object.fromEntries(
      registered.map((server) => [
        server,
        tools.filter((tool) => tool.startsWith(`${server}_`)).length,
      ]),
    ),
  };
}

/** Keep useful MCP failure detail while preventing accidental bearer leakage. */
export function safeMcpDiagnosticError(error: string): string {
  return error
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .slice(0, 2_000);
}
