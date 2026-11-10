/**
 * The agent worker this runtime loads at request time.
 *
 * Kept out of `index.ts` so it can be read and tested without pulling in the
 * OpenCode SDK's workerd entry point, which does not resolve outside a workerd
 * build — and this is the file that decides which tools the model is offered.
 */
export function renderWorkerSource(
  toolModules: readonly string[],
  tools: readonly string[],
  gatedTools: readonly string[] = [],
): string {
  const imports = toolModules
    .map((path, index) => `import * as toolModule${String(index)} from ${JSON.stringify(`./${path}`)};`)
    .join("\n");
  const moduleNames = toolModules.map((_, index) => `toolModule${String(index)}`).join(", ");
  return `
import agent from "./agent.js";
${imports}
let scope;
const id = (value) => typeof value === "string" ? value : value?.id;
const registeredTools = new Set(${JSON.stringify(tools)});
const gatedTools = new Set(${JSON.stringify(gatedTools)});
const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const toolDefinitions = () => {
  const definitions = [];
  const seen = new Set();
  for (const module of [${moduleNames}]) {
    for (const value of Object.values(module)) {
      if (!isRecord(value) || (value.kind !== "tool" && value.kind !== "gated-tool") || value.version !== 1 ||
          typeof value.id !== "string" || value.name !== value.id ||
          typeof value.description !== "string" || !value.description ||
          (value.input !== undefined && !isRecord(value.input)) ||
          typeof value.run !== "function") continue;
      if (value.kind === "gated-tool" && typeof value.apply !== "function") continue;
      if (!registeredTools.has(value.id)) throw new Error("Tool module exported an unregistered tool: " + value.id);
      // Declared gated but exported plain would write without ever asking, and
      // the reverse would ask for a write that can never land.
      if (gatedTools.has(value.id) !== (value.kind === "gated-tool")) {
        throw new Error(gatedTools.has(value.id)
          ? "Tool is declared gated but does not wait for approval: " + value.id
          : "Tool waits for approval but is not declared gated: " + value.id);
      }
      if (seen.has(value.id)) throw new Error("Tool is defined more than once: " + value.id);
      seen.add(value.id);
      definitions.push({
        id: value.id,
        description: value.description,
        input: value.input || { type: "object", properties: {}, additionalProperties: false },
      });
    }
  }
  return definitions.sort((left, right) => left.id.localeCompare(right.id));
};
globalThis[Symbol.for("opencomputer.agent-hooks")] = {
  useModel(value) {
    scope.model = typeof value === "string"
      ? { provider: "openrouter", model: value }
      : value;
  },
  useInput() { return scope.input; },
  useCurrentInput() { return scope.input; },
  useSessionData(key) { return scope.state[key]; },
  useTool(value) { scope.tools.add(id(value)); },
  useConnection(value) { scope.connections.add(id(value)); },
  useMcpServer(value) { scope.mcpServers.add(id(value)); },
  useMemory(id) {
    const projection = scope.memory[id];
    if (projection) scope.selectedMemory.add(id);
    return projection;
  },
};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/tools") return Response.json({ tools: toolDefinitions() });
    const input = await request.json();
    scope = {
      input: input.currentInput,
      state: input.state || {},
      tools: new Set(), connections: new Set(),
      mcpServers: new Set(), model: undefined,
      memory: input.memory || {},
      selectedMemory: new Set(),
    };
    try {
      const instructions = agent();
      if (typeof instructions !== "string") throw new Error("Agent must return instructions synchronously");
      return Response.json({
        instructions,
        enabledTools: [...scope.tools].sort(),
        requiredConnections: [...scope.connections].sort(),
        enabledMcpServers: [...scope.mcpServers].sort(),
        selectedMemory: [...scope.selectedMemory].sort(),
        model: scope.model,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally { scope = undefined; }
  },
};
`;
}
