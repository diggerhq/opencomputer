export type SessionAction =
  | "create"
  | "list"
  | "inspect"
  | "attach"
  | "send"
  | "end";

export type SessionCommand = {
  action: SessionAction;
  args: string[];
  keep: boolean;
  agent?: string;
};

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
        "sessions use the current project's Development deployment.",
    );
  }

  const args = [...rawArgs];
  const agent = takeAgentOption(args);
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
  return { action, args, keep, ...(agent ? { agent } : {}) };
}
