export type SessionAction =
  | "create"
  | "list"
  | "inspect"
  | "attach"
  | "send"
  | "end";

import type { MemoryBindings } from "./api.js";

export type SessionCommand = {
  action: SessionAction;
  args: string[];
  keep: boolean;
  agent?: string;
  /** `--memory` bindings for `create`, keyed by resource. */
  memory?: MemoryBindings;
  /** `--create-document`: create each bound document that does not exist yet. */
  createDocuments?: boolean;
};

const RESOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * One `--memory` value: `<resource>=<documentId>[:read|read-write]` binds a
 * document (read-write by default), `<resource>` alone binds the collection.
 */
export function parseMemoryBinding(
  value: string,
): { resource: string; binding: MemoryBindings[string] } {
  const usage =
    "--memory takes <resource>=<documentId>[:read|read-write] or <resource> for a collection";
  const equals = value.indexOf("=");
  const resource = equals < 0 ? value : value.slice(0, equals);
  if (!RESOURCE_ID.test(resource) || resource.length > 128) {
    throw new Error(`${usage}; ${JSON.stringify(resource)} is not a resource id`);
  }
  if (equals < 0) return { resource, binding: { scope: "collection" } };
  const target = value.slice(equals + 1);
  const colon = target.lastIndexOf(":");
  const id = colon < 0 ? target : target.slice(0, colon);
  const access = colon < 0 ? "read-write" : target.slice(colon + 1);
  if (!DOCUMENT_ID.test(id)) {
    throw new Error(`${usage}; ${JSON.stringify(id)} is not a document id`);
  }
  if (access !== "read" && access !== "read-write") {
    throw new Error(`${usage}; access must be read or read-write`);
  }
  return { resource, binding: { scope: "document", id, access } };
}

function takeMemoryOptions(args: string[]): MemoryBindings | undefined {
  const bindings: MemoryBindings = {};
  let count = 0;
  for (;;) {
    const equalsIndex = args.findIndex((argument) =>
      argument.startsWith("--memory="),
    );
    const index = equalsIndex >= 0 ? equalsIndex : args.indexOf("--memory");
    if (index < 0) break;
    let value: string;
    if (equalsIndex >= 0) {
      value = args[index]!.slice("--memory=".length);
      args.splice(index, 1);
    } else {
      value = args[index + 1] ?? "";
      if (!value || value.startsWith("--")) {
        throw new Error("--memory requires a value");
      }
      args.splice(index, 2);
    }
    if (!value) throw new Error("--memory requires a value");
    const { resource, binding } = parseMemoryBinding(value);
    if (bindings[resource]) {
      throw new Error(`--memory names resource ${resource} twice`);
    }
    bindings[resource] = binding;
    count += 1;
  }
  return count ? bindings : undefined;
}

export function developmentAgentReference(agentId: string): string {
  return `${agentId}@development`;
}

export function resolveProjectAgent(
  agents: Array<{ id: string; name: string }>,
  selector: string,
): string {
  if (selector.includes("@")) {
    throw new Error(
      "--agent selects a project agent only; session environment aliases are not supported.",
    );
  }
  const exactId = agents.find((agent) => agent.id === selector);
  if (exactId) return exactId.id;
  const named = agents.filter((agent) => agent.name === selector);
  if (named.length === 1) return named[0]!.id;
  const available = agents.map((agent) => agent.id).join(", ") || "none";
  throw new Error(
    `Agent ${selector} is not unique in the current project. Available agents: ${available}.`,
  );
}

const ACTIONS = new Set<SessionAction>([
  "create",
  "list",
  "inspect",
  "attach",
  "send",
  "end",
]);

const DEPRECATED_ROUTING_OPTIONS = [
  "--local",
  "--remote",
  "--alias",
] as const;

function takeAgentOption(args: string[]): string | undefined {
  const equalsIndex = args.findIndex((argument) =>
    argument.startsWith("--agent="),
  );
  if (equalsIndex >= 0) {
    const value = args[equalsIndex]!.slice("--agent=".length);
    if (!value) throw new Error("--agent requires a value");
    args.splice(equalsIndex, 1);
    return value;
  }
  const index = args.indexOf("--agent");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--agent requires a value");
  }
  args.splice(index, 2);
  return value;
}

export function parseSessionCommand(rawArgs: string[]): SessionCommand {
  const deprecated = rawArgs.find((argument) =>
    DEPRECATED_ROUTING_OPTIONS.some(
      (option) => argument === option || argument.startsWith(`${option}=`),
    ),
  );
  if (deprecated) {
    throw new Error(
      `${deprecated.split("=")[0]} is no longer supported; ` +
        "sessions use the project's current deployment.",
    );
  }

  const args = [...rawArgs];
  const agent = takeAgentOption(args);
  const memory = takeMemoryOptions(args);
  const createDocumentsIndex = args.indexOf("--create-document");
  const createDocuments = createDocumentsIndex >= 0;
  if (createDocuments) args.splice(createDocumentsIndex, 1);
  const keepIndex = args.indexOf("--keep");
  const keep = keepIndex >= 0;
  if (keep) args.splice(keepIndex, 1);

  const shorthand = args[0] as SessionAction | undefined;
  const action =
    shorthand && ACTIONS.has(shorthand)
      ? (args.shift()! as SessionAction)
      : "create";
  if (agent && action !== "create") {
    throw new Error("--agent is only supported when creating a session.");
  }
  if (memory && action !== "create") {
    throw new Error("--memory is only supported when creating a session.");
  }
  if (createDocuments && !memory) {
    throw new Error("--create-document needs at least one --memory <resource>=<documentId>.");
  }
  if (
    createDocuments &&
    !Object.values(memory ?? {}).some((binding) => binding.scope === "document")
  ) {
    throw new Error("--create-document applies to document bindings; --memory <resource> binds a collection.");
  }
  return {
    action,
    args,
    keep,
    ...(agent ? { agent } : {}),
    ...(memory ? { memory } : {}),
    ...(createDocuments ? { createDocuments } : {}),
  };
}
