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
};

export function developmentAgentReference(agentId: string): string {
  return `${agentId}@development`;
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
  "--agent",
  "--alias",
] as const;

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
  const keepIndex = args.indexOf("--keep");
  const keep = keepIndex >= 0;
  if (keep) args.splice(keepIndex, 1);

  const shorthand = args[0] as SessionAction | undefined;
  const action =
    shorthand && ACTIONS.has(shorthand)
      ? (args.shift()! as SessionAction)
      : "create";
  return { action, args, keep };
}
