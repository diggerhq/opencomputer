import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Plugin } from "@opencode-ai/plugin-v2";

import type { MemoryBinding, MemoryProjection } from "../edge/memory-contract.js";
import type { SessionIdentity, ToolInvocationIdentity } from "../protocol.js";
import { hostToolCallId, parseSessionIdentity } from "../tool-identity.js";
import { ASK_TOOL, ASK_TOOL_DESCRIPTION, ASK_TOOL_INPUT_SCHEMA, parseAskInput } from "../ask.js";
import { registerCodeTools, type CodeToolResultOptions } from "./code-tools.js";
import {
  memoryToolNames,
  memoryToolSchemas,
  memoryToolsOf,
  memoryToolSummaries,
  type MemoryToolName,
} from "./memory-tools.js";
import { sessionResultCommitter, type ResultToolManifest } from "./session-result.js";
import { buildSkillTool } from "./skill-tool.js";
import { defineOpenCode2ReactivePlugin } from "./opencode2-reactive-plugin.js";
import type { AgentRenderDebugSnapshot } from "./opencode2-reactive-plugin.js";
import {
  modelRegistry,
  useModel,
  useInput,
  useCurrentInput,
  useConnection,
  useMcpServer,
  useMemory,
  useSessionData,
  useTool,
  type AgentFunction,
  type AgentInput,
  type AgentRenderRecord,
  type RenderedMemory,
  type SessionDataValue,
} from "./reactive-agent.js";

interface CloudSessionBinding {
  projectId: string;
  deploymentId: string;
  agentId: string;
  sessionId: string;
  edge: string;
  runtimeToken: string;
  responseId?: string;
  currentInput?: AgentInput;
  /** The managed turn the harness is executing now; written at each turn start. */
  turnId?: string;
  /** The runtime's attachment epoch, the generation a result commit is fenced by. */
  runtimeEpoch?: number;
  /** The session's host-assigned identity, as the Session object sent it with the turn. */
  identity?: SessionIdentity;
}

interface ReactiveManifest {
  version: 2;
  entry: string;
  tools: string[];
  /** The subset of `tools` whose write waits for a person. */
  gatedTools?: string[];
  toolModules?: string[];
  connections: string[];
  mcpServers: string[];
  models?: Array<string | { provider: string; model: string }>;
  mcpServerDefinitions?: Array<{
    id: string;
    url: string;
    connection?: string;
  }>;
  resultTool?: ResultToolManifest;
  /** Declared memory resources; `description` is the model-facing guidance for the resource's tools. */
  memory?: Array<{ id: string; description: string }>;
}

/**
 * What one model request was given for the session's memory: the grants,
 * the projection of each (its revision is what a save is checked against),
 * the resources the render read (the only targets of this request's memory
 * tools), and the assistant messages already in the transcript at the
 * render (a tool call from one of them is stale). The Workerd runtime keeps
 * the same per request in its storage; here one request at a time per
 * OpenCode session is enough, since a request is rendered before its tools
 * can be called.
 */
interface MemoryRequestSnapshot {
  bindings: MemoryBinding[];
  projections: Record<string, MemoryProjection>;
  selected: Set<string>;
  seenMessages: Set<string>;
}

interface SessionResources {
  data?: Array<{ key: string; value: SessionDataValue; updatedAt: string }>;
}

const bindingPath = required("OPENCOMPUTER_REACTIVE_SESSION_PATH");
const manifestPath = required("OPENCOMPUTER_REACTIVE_MANIFEST_PATH");
let providerTurn = 0;
let stateVersion = 0;
let previousState = "{}";
let loadedAgent: Promise<AgentFunction> | undefined;
const memorySnapshots = new Map<string, MemoryRequestSnapshot>();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the reactive runtime`);
  return value;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function agent(): Promise<AgentFunction> {
  if (!loadedAgent) {
    loadedAgent = (async () => {
      const manifest = await readJson<ReactiveManifest>(manifestPath);
      const entry = resolve(dirname(manifestPath), manifest.entry);
      const module = (await import(pathToFileURL(entry).href)) as {
        default?: unknown;
      };
      if (typeof module.default !== "function") {
        throw new Error("The reactive agent entry must default-export a function");
      }
      return module.default as AgentFunction;
    })();
  }
  return loadedAgent;
}

async function sessionState(binding: CloudSessionBinding) {
  const response = await fetch(
    `${binding.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(binding.sessionId)}/resources`,
    { headers: { authorization: `Bearer ${binding.runtimeToken}` } },
  );
  if (!response.ok) {
    throw new Error(`Session state returned ${String(response.status)}`);
  }
  const resources = (await response.json()) as SessionResources;
  const state = Object.fromEntries(
    (resources.data ?? []).map((entry) => [entry.key, entry.value]),
  );
  const serialized = JSON.stringify(state);
  if (serialized !== previousState) {
    previousState = serialized;
    stateVersion += 1;
  }
  return state;
}

function edgeUrl(binding: CloudSessionBinding, path: string): string {
  return `${binding.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(binding.sessionId)}${path}`;
}

/** Every grant with its projection, from the edge memory route. */
async function recallMemory(
  binding: CloudSessionBinding,
): Promise<Array<MemoryBinding & { projection: MemoryProjection }>> {
  const response = await fetch(edgeUrl(binding, "/memory"), {
    headers: { authorization: `Bearer ${binding.runtimeToken}` },
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { detail?: unknown };
    throw new Error(
      typeof failure.detail === "string"
        ? `Memory recall failed: ${failure.detail}`
        : `Memory recall returned ${String(response.status)}`,
    );
  }
  const recalled = (await response.json()) as {
    bindings: Array<MemoryBinding & { projection: MemoryProjection }>;
  };
  return recalled.bindings;
}

/**
 * One of the fixed memory tools, run against the edge memory route. Every
 * documented outcome is a result the model reads, never a tool error; only
 * malformed arguments and host failures throw. Mirrors the Workerd runtime's
 * `executeMemoryTool`.
 */
async function executeMemoryTool(
  tool: MemoryToolName,
  rawInput: unknown,
  context: { sessionID: string; messageID: string },
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const reply = (result: unknown, resource?: string) => ({
    content: JSON.stringify(result),
    metadata: { tool, ...(resource ? { memory: resource } : {}), messageID: context.messageID },
  });
  const snapshot = memorySnapshots.get(context.sessionID);
  if (snapshot?.seenMessages.has(context.messageID)) {
    // The call's message was already in the transcript when a later
    // request was rendered: its snapshot is not the latest one.
    return { ...reply({ status: "rejected", reason: "stale" }), metadata: { tool, stale: true } };
  }
  const targets = (snapshot?.bindings ?? []).filter(
    (binding) => snapshot?.selected.has(binding.resource) && memoryToolsOf(binding).includes(tool),
  );
  const target =
    input.memory !== undefined
      ? targets.find((candidate) => candidate.resource === input.memory)
      : targets.length === 1
        ? targets[0]
        : undefined;
  if (!target) {
    return reply({
      status: "rejected",
      reason: "not_bound",
      bound: targets.map((candidate) => candidate.resource),
    });
  }
  const resource = target.resource;
  let body: Record<string, unknown>;
  switch (tool) {
    case "memory_save": {
      if (typeof input.text !== "string") throw new Error("memory_save requires text");
      if (input.summary !== undefined && typeof input.summary !== "string") {
        throw new Error("memory_save summary must be a string");
      }
      const expectedRevision = snapshot?.projections[resource]?.revision;
      if (typeof expectedRevision !== "string") {
        throw new Error(`The request snapshot for ${JSON.stringify(resource)} has no revision`);
      }
      body = {
        resource,
        text: input.text,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        expectedRevision,
      };
      break;
    }
    case "memory_read":
      if (typeof input.id !== "string") throw new Error("memory_read requires id");
      body = { resource, id: input.id };
      break;
    case "memory_list":
      if (input.cursor !== undefined && typeof input.cursor !== "string") {
        throw new Error("memory_list cursor must be a string");
      }
      body = { resource, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) };
      break;
  }
  const binding = await readJson<CloudSessionBinding>(bindingPath);
  const operation = tool.slice("memory_".length);
  const response = await fetch(edgeUrl(binding, `/memory/${operation}`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${binding.runtimeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { detail?: unknown };
    throw new Error(
      typeof failure.detail === "string"
        ? `${tool} failed: ${failure.detail}`
        : `${tool} returned ${String(response.status)}`,
    );
  }
  return reply(await response.json(), resource);
}

/** The fixed memory tools, registered when the manifest declares memory; exposed per render by the plugin. */
function memoryTools(): Array<Record<string, unknown>> {
  return memoryToolNames.map((name) => ({
    name,
    description: memoryToolSummaries[name],
    input: memoryToolSchemas[name],
    options: { codemode: false },
    execute: async (rawInput: unknown, tool: { sessionID: unknown; messageID: unknown }) =>
      executeMemoryTool(name, rawInput, {
        sessionID: String(tool.sessionID),
        messageID: String(tool.messageID),
      }),
  }));
}

/**
 * The `ask` harness tool. It only validates and answers the model: the
 * harness sees the call succeed, stops the loop and sends the question to
 * the session with the turn's completion, which commits it.
 */
function askTool(): Record<string, unknown> {
  return {
    name: ASK_TOOL,
    description: ASK_TOOL_DESCRIPTION,
    input: ASK_TOOL_INPUT_SCHEMA,
    options: { codemode: false },
    execute: async (rawInput: unknown) => {
      const parsed = parseAskInput(rawInput);
      if (!parsed.ok) throw new Error(parsed.message);
      return {
        content:
          "The question is recorded and this turn ends now. Do not call other tools or write more; the answer arrives as the next input.",
      };
    },
  };
}

async function commit(
  binding: CloudSessionBinding,
  record: AgentRenderRecord,
  debug: AgentRenderDebugSnapshot,
): Promise<void> {
  const response = await fetch(
    `${binding.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(binding.sessionId)}/renders`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${binding.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        renderId: record.renderId,
        responseId: record.responseId,
        providerTurn: record.providerTurn,
        stateVersion: record.stateVersion,
        instructionsHash: record.instructionsHash,
        instructions: record.render.instructions,
        enabledTools: record.enabledTools,
        requiredConnections: record.requiredConnections,
        enabledMcpServers: record.enabledMcpServers,
        input: debug.input,
        tools: debug.tools,
        model: debug.model,
        renderedAt: record.renderedAt,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Render commit returned ${String(response.status)}`);
  }
}

async function validateModel(
  binding: CloudSessionBinding,
  model?: { provider: string; model: string },
): Promise<{ provider: string; model: string }> {
  const response = await fetch(
    `${binding.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(binding.sessionId)}/models/resolve`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${binding.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(model ? { model } : {}),
    },
  );
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as {
      detail?: unknown;
    };
    throw new Error(
      typeof failure.detail === "string"
        ? failure.detail
        : `Model validation returned ${response.status}`,
    );
  }
  return ((await response.json()) as {
    model: { provider: string; model: string };
  }).model;
}

Object.assign(globalThis, {
  [Symbol.for("opencomputer.agent-hooks")]: {
    useModel,
    useInput,
    useCurrentInput,
    useConnection,
    useMcpServer,
    useMemory,
    useSessionData,
    useTool,
  },
});

const reactive = defineOpenCode2ReactivePlugin({
  resolve: async (turn) => {
    const [binding, manifest, renderedAgent] = await Promise.all([
      readJson<CloudSessionBinding>(bindingPath),
      readJson<ReactiveManifest>(manifestPath),
      agent(),
    ]);
    const state = await sessionState(binding);
    // A session holds memory grants only when its agent declares memory; the
    // recall is the request snapshot its tools run against.
    let memory: Record<string, RenderedMemory> | undefined;
    let memoryGrants: { bindings: MemoryBinding[]; descriptions: Record<string, string> } | undefined;
    if (manifest.memory?.length) {
      const recalled = await recallMemory(binding);
      const snapshot: MemoryRequestSnapshot = {
        bindings: [],
        projections: {},
        selected: new Set(),
        seenMessages: new Set(turn.assistantMessageIds),
      };
      memory = {};
      for (const { projection, ...grant } of recalled) {
        snapshot.bindings.push(grant);
        snapshot.projections[grant.resource] = projection;
        memory[grant.resource] = {
          text: projection.text,
          sources: projection.sources,
          writable: projection.writable,
        };
      }
      memorySnapshots.set(turn.openCodeSessionId, snapshot);
      memoryGrants = {
        bindings: snapshot.bindings,
        descriptions: Object.fromEntries(
          manifest.memory.map((declaration) => [declaration.id, declaration.description]),
        ),
      };
    }
    providerTurn += 1;
    return {
      agent: renderedAgent,
      input: {
        projectId: binding.projectId,
        deploymentId: binding.deploymentId,
        agentId: binding.agentId,
        sessionId: binding.sessionId,
        responseId: binding.responseId ?? randomUUID(),
        providerTurn,
        stateVersion,
        state,
        currentInput: binding.currentInput ?? turn.input,
        ...(memory ? { memory } : {}),
      },
      ...(memoryGrants ? { memory: memoryGrants } : {}),
      registry: {
        // `ask` is the runtime's own tool, never declared by the agent.
        tools: new Set([...manifest.tools, ASK_TOOL]),
        connections: new Set(manifest.connections),
        mcpServers: new Set(manifest.mcpServers),
        models: modelRegistry(
          manifest.models?.length ? manifest.models : [turn.model],
        ),
      },
    };
  },
  validateModel: async (model) =>
    validateModel(await readJson<CloudSessionBinding>(bindingPath), model),
  commit: async (record, debug, turn) => {
    await commit(await readJson<CloudSessionBinding>(bindingPath), record, debug);
    const snapshot = memorySnapshots.get(turn.openCodeSessionId);
    if (snapshot) snapshot.selected = new Set(record.render.selectedMemory);
  },
});

/**
 * Skills the agent shipped with.
 *
 * The CLI packages `skills/` into `.opencode/skills` and the docs promise the
 * agent "can load a matching skill during the session" — but nothing ever
 * registered the directory, so every skill rode along in the artifact and no
 * agent could reach one. Registering the source is what makes the packaging
 * mean something.
 */
async function registerPackagedSkills(
  context: Plugin.Context,
): Promise<void> {
  const directory = resolve(dirname(manifestPath), "..", ".opencode", "skills");
  if (!existsSync(directory)) return;
  const skill = (context as { skill?: { transform?: unknown } }).skill;
  if (!skill || typeof skill !== "object" || !("transform" in skill)) return;
  await (
    skill as {
      transform: (
        apply: (draft: { source(value: unknown): void }) => void,
      ) => Promise<unknown>;
    }
  ).transform((draft) => {
    draft.source({ type: "directory", path: directory });
  });
}

/**
 * The result tool's commit path (C1) in this runtime: the turn and epoch
 * come from what the harness wrote to the binding file when the turn
 * started, and the commit goes to the edge's runtime-authenticated route.
 * A call before any turn was recorded is refused rather than attributed.
 */
function resultOptions(tool: ResultToolManifest): CodeToolResultOptions {
  return {
    tool,
    turn: async () => {
      const binding = await readJson<CloudSessionBinding>(bindingPath);
      if (
        typeof binding.turnId !== "string" ||
        !binding.turnId ||
        typeof binding.runtimeEpoch !== "number"
      ) {
        throw new Error(
          "Result rejected: the runtime has not recorded the turn this call belongs to",
        );
      }
      return {
        turnId: binding.turnId,
        runtime: { kind: "microvm", epoch: binding.runtimeEpoch },
      };
    },
    commit: async (input) => {
      const binding = await readJson<CloudSessionBinding>(bindingPath);
      return sessionResultCommitter(
        binding.edge,
        binding.sessionId,
        binding.runtimeToken,
      )(input);
    },
  };
}

/**
 * A custom tool call's host identity in this runtime: the session identity
 * and turn the harness recorded when the turn started, completed with the
 * message and call OpenCode reports. Read at dispatch, before `run`, and
 * refused when no turn with an identity is recorded, so a call is never
 * attributed by guesswork or from the model's arguments.
 */
async function toolInvocationIdentity(call: {
  messageId: string;
  toolCallId: string;
}): Promise<ToolInvocationIdentity> {
  const binding = await readJson<CloudSessionBinding>(bindingPath);
  const session = parseSessionIdentity(binding.identity);
  if (!session || typeof binding.turnId !== "string" || !binding.turnId) {
    throw new Error(
      "The tool call was refused: the runtime has not recorded the turn this call belongs to",
    );
  }
  return {
    ...session,
    turnId: binding.turnId,
    messageId: call.messageId,
    providerCallId: call.toolCallId,
    toolCallId: hostToolCallId({
      sessionId: session.sessionId,
      turnId: binding.turnId,
      messageId: call.messageId,
      providerCallId: call.toolCallId,
    }),
  };
}

export default Plugin.define({
  id: "opencomputer.cloud-reactive-runtime",
  setup: async (context) => {
    const manifest = await readJson<ReactiveManifest>(manifestPath);
    const skillsDirectory = resolve(
      dirname(manifestPath),
      "..",
      ".opencode",
      "skills",
    );
    // Discovery tells the model a skill exists; the tool is what lets it read
    // one. Both are registered in the same transform as the code tools.
    const skillTool = await buildSkillTool(skillsDirectory);
    // Say what was looked for and what was found. Four rounds went on guessing
    // where the skills were; the answer is cheaper to print than to infer.
    process.stderr.write(
      `${JSON.stringify({
        level: "info",
        event: "reactive.skills",
        manifestPath,
        skillsDirectory,
        directoryExists: existsSync(skillsDirectory),
        skillToolRegistered: Boolean(skillTool),
      })}\n`,
    );
    await registerCodeTools(
      context,
      manifestPath,
      manifest.toolModules ?? [],
      new Set(manifest.tools),
      {
        gated: new Set(manifest.gatedTools ?? []),
        extra: [
          ...(skillTool ? [skillTool as unknown as Record<string, unknown>] : []),
          ...(manifest.memory?.length ? memoryTools() : []),
          askTool(),
        ],
        identity: toolInvocationIdentity,
        ...(manifest.resultTool
          ? { result: resultOptions(manifest.resultTool) }
          : {}),
      },
    );
    await registerPackagedSkills(context);
    return reactive.setup(context);
  },
});
