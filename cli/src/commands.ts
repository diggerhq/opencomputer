import {
  OpenComputerClient,
  type ManagedAgentEvent,
  type ManagedAgentLog,
  type ManagedSessionSnapshot,
} from "./api.js";
import { login, logout } from "./auth.js";
import { resolveConfig } from "./config.js";
import { runCloudDevelopment } from "./dev.js";
import {
  ensureProjectBinding,
  findOpenComputerProjectRoot,
} from "./binding.js";
import {
  assertStarterTarget,
  buildAgentArtifact,
  findAgentRoot,
  initializeAgentProject,
} from "./project.js";
import {
  developmentAgentReference,
  parseSessionCommand,
  resolveProjectAgent,
} from "./session-command.js";
import { formatSessionEvent } from "./session-prompt.js";

export interface GlobalOptions {
  apiUrl?: string;
  apiKey?: string;
  json: boolean;
  verbose?: boolean;
}

function printJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  args.splice(index, 2);
  return value;
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = option(args, name);
    if (value === undefined) return values;
    values.push(value);
  }
}

function environmentOption(
  value: string | undefined,
): "development" | "production" {
  if (!value || value === "development") return "development";
  if (value === "production") return "production";
  throw new Error("--environment must be development or production");
}

async function readSecretValue(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (!value) throw new Error("Secret value was empty");
    return value;
  }
  process.stderr.write("Secret value (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else if (!value) reject(new Error("Secret value was empty"));
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("Secret entry cancelled"));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

async function selectedProject(
  client: OpenComputerClient,
  config: Awaited<ReturnType<typeof resolveConfig>>,
  reference?: string,
  interactive = true,
): Promise<{ projectId: string; agentId: string }> {
  if (reference) {
    const project = (await client.projects()).find(
      (candidate) => candidate.id === reference || candidate.slug === reference,
    );
    if (!project) throw new Error(`Project ${reference} was not found.`);
    const agent = project.agents[0];
    if (!agent) throw new Error(`Project ${project.name} has no agents.`);
    return { projectId: project.id, agentId: agent.id };
  }
  const root = await findOpenComputerProjectRoot(process.cwd());
  const binding = await ensureProjectBinding(client, config, root, {
    interactive,
  });
  return { projectId: binding.projectId, agentId: binding.agentId };
}

async function selectedSessionAgent(
  client: OpenComputerClient,
  project: { projectId: string; agentId: string },
  selector?: string,
): Promise<string> {
  if (!selector) return project.agentId;
  const current = (await client.projects()).find(
    (candidate) => candidate.id === project.projectId,
  );
  if (!current) {
    throw new Error("The bound project is no longer available.");
  }
  return resolveProjectAgent(current.agents, selector);
}

function printLog(entry: ManagedAgentLog, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
    return;
  }
  const message =
    typeof entry.data.message === "string"
      ? entry.data.message
      : Object.keys(entry.data).length
        ? JSON.stringify(entry.data)
        : "";
  process.stdout.write(
    `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} ` +
      `${entry.agentId} ${entry.sessionId} ${entry.event}` +
      `${message ? ` ${message}` : ""}\n`,
  );
}

async function requireAgentRoot(): Promise<string> {
  const root = await findAgentRoot();
  if (!root) {
    throw new Error(
      "No OpenComputer agent repository found. Run `opencomputer init <directory>` first.",
    );
  }
  return root;
}

function printSession(session: ManagedSessionSnapshot): void {
  const deployment = session.deploymentId
    ? session.deploymentId.slice(session.deploymentId.lastIndexOf(":") + 1)
    : "—";
  process.stdout.write(
    `${session.id}  ${session.status.padEnd(15)}  ` +
      `${session.agentId ?? "—"}  ${deployment.slice(0, 12)}\n`,
  );
}

function printToolProgress(event: ManagedAgentEvent): void {
  if (
    event.type !== "tool.started" &&
    event.type !== "tool.completed" &&
    event.type !== "tool.failed"
  ) {
    return;
  }

  const tool = String(event.data.tool ?? "tool");
  if (event.type === "tool.started") {
    const title =
      typeof event.data.title === "string" && event.data.title
        ? ` (${event.data.title})`
        : "";
    process.stderr.write(`tool: ${tool}${title}\n`);
    return;
  }

  process.stderr.write(
    `tool: ${tool} ${event.type === "tool.completed" ? "completed" : "failed"}\n`,
  );
}

function printSessionProgress(
  event: ManagedAgentEvent,
  json: boolean,
  verbose: boolean,
): void {
  if (json) return;
  if (verbose) {
    const formatted = formatSessionEvent(event);
    if (formatted) process.stderr.write(`${formatted}\n`);
    return;
  }
  printToolProgress(event);
}

function printAgentEvent(event: ManagedAgentEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (event.type === "message.delta") {
    process.stdout.write(String(event.data.text ?? ""));
  } else if (
    event.type === "message.completed" &&
    typeof event.data.text === "string"
  ) {
    process.stdout.write(`${event.data.text}\n`);
  } else if (event.type === "turn.failed") {
    process.stderr.write(
      `turn failed: ${String(event.data.message ?? "unknown error")}\n`,
    );
  } else {
    printToolProgress(event);
  }
}

async function sendAgentTurn(
  client: OpenComputerClient,
  sessionId: string,
  prompt: string,
  keep: boolean,
  json: boolean,
): Promise<{ turnId: string; output?: string }> {
  const existing = await client.events(sessionId, 0);
  let cursor = existing.at(-1)?.seq ?? 0;
  const session = await client.session(sessionId);
  if (session.microvmState === "suspended") {
    process.stderr.write(`Resuming ${sessionId}…\n`);
    await client.resumeSession(sessionId);
    const connected = await waitForEvent(
      client,
      sessionId,
      cursor,
      (event) => event.type === "runtime.connected",
      () => undefined,
      90_000,
    );
    cursor = connected.cursor;
  }
  const turn = await client.createTurn(sessionId, prompt);
  let streamedText = "";
  let completedText = "";
  const completed = await waitForEvent(
    client,
    sessionId,
    cursor,
    (event) => event.type === "turn.completed" || event.type === "turn.failed",
    (event) => {
      if (event.type === "message.delta") {
        const text = String(event.data.text ?? "");
        streamedText += text;
        if (!json) process.stdout.write(text);
      } else if (
        event.type === "message.completed" &&
        typeof event.data.text === "string"
      ) {
        completedText = event.data.text;
      } else {
        if (!json) printToolProgress(event);
      }
    },
    180_000,
  );
  if (!json && !streamedText && completedText) {
    process.stdout.write(completedText);
  }
  if (!json && (streamedText || completedText)) process.stdout.write("\n");
  if (completed.event.type === "turn.failed") {
    throw new Error(
      String(completed.event.data.message ?? "Agent turn failed"),
    );
  }
  if (!keep) {
    await client.suspendSession(sessionId).catch(() => undefined);
  }
  return {
    turnId: turn.turnId,
    output: streamedText || completedText || undefined,
  };
}

async function attachSession(
  client: OpenComputerClient,
  sessionId: string,
  json: boolean,
): Promise<void> {
  let cursor = 0;
  for (const event of await client.events(sessionId, cursor)) {
    cursor = Math.max(cursor, event.seq);
    printAgentEvent(event, json);
  }
  process.stderr.write("Attached; press Ctrl-C to detach.\n");
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  try {
    while (!stopped) {
      for (const event of await client.events(sessionId, cursor)) {
        cursor = Math.max(cursor, event.seq);
        printAgentEvent(event, json);
        if (event.type === "session.ended") stopped = true;
      }
      if (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } finally {
    process.off("SIGINT", stop);
  }
}

async function waitForEvent(
  client: OpenComputerClient,
  sessionId: string,
  after: number,
  terminal: (event: ManagedAgentEvent) => boolean,
  onEvent: (event: ManagedAgentEvent) => void,
  timeoutMs: number,
): Promise<{ event: ManagedAgentEvent; cursor: number }> {
  const deadline = Date.now() + timeoutMs;
  let cursor = after;
  while (Date.now() < deadline) {
    for (const event of await client.events(sessionId, cursor)) {
      cursor = Math.max(cursor, event.seq);
      onEvent(event);
      if (event.type === "runtime.disconnected") {
        throw new Error(
          typeof event.data.reason === "string"
            ? event.data.reason
            : "The agent runtime disconnected.",
        );
      }
      if (terminal(event)) return { event, cursor };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the agent.");
}

async function runAgent(
  client: OpenComputerClient,
  agent: string,
  prompt: string,
  keep: boolean,
  json: boolean,
  verbose: boolean,
): Promise<unknown> {
  const created = await client.createSession(agent);
  process.stderr.write(`Starting ${agent}…\n`);
  const connected = await waitForEvent(
    client,
    created.session.id,
    0,
    (event) => event.type === "runtime.connected",
    (event) => printSessionProgress(event, json, verbose),
    90_000,
  );
  const turn = await client.createTurn(created.session.id, prompt);
  let streamed = false;
  let streamedText = "";
  let completedText = "";
  const completed = await waitForEvent(
    client,
    created.session.id,
    connected.cursor,
    (event) => event.type === "turn.completed" || event.type === "turn.failed",
    (event) => {
      if (event.type === "message.delta") {
        streamed = true;
        const text = String(event.data.text ?? "");
        streamedText += text;
        if (!json) process.stdout.write(text);
      } else if (
        event.type === "message.completed" &&
        typeof event.data.text === "string"
      ) {
        completedText = event.data.text;
      } else {
        printSessionProgress(event, json, verbose);
      }
    },
    180_000,
  );
  if (!json && !streamed && completedText) process.stdout.write(completedText);
  if (!json && (!process.stdout.isTTY || streamed || completedText)) {
    process.stdout.write("\n");
  }
  if (completed.event.type === "turn.failed") {
    throw new Error(
      String(completed.event.data.message ?? "Agent turn failed"),
    );
  }
  if (!keep) {
    await client.suspendSession(created.session.id).catch(() => undefined);
  }
  return {
    sessionId: created.session.id,
    turnId: turn.turnId,
    agentId: created.deployment?.agentId ?? agent,
    deploymentId: created.deployment?.id,
    status: "completed",
    output: streamedText || completedText || undefined,
  };
}

export async function runCommand(
  command: string,
  rawArgs: string[],
  globals: GlobalOptions,
): Promise<void> {
  const args = [...rawArgs];
  const config = await resolveConfig(globals);
  const client = new OpenComputerClient(config);

  if (command === "login") {
    const identity = await login(config, {
      noBrowser: flag(args, "--no-browser"),
      force: flag(args, "--force"),
    });
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    if (globals.json) printJSON(identity);
    else {
      process.stdout.write(
        `Logged in as ${identity.email ?? identity.user_id ?? "user"}\n` +
          `Organization: ${identity.org_name ?? identity.org_id}\n`,
      );
    }
    return;
  }

  if (command === "logout") {
    const localOnly = flag(args, "--local");
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    await logout(config, localOnly);
    if (globals.json) printJSON({ status: "logged_out", localOnly });
    else
      process.stdout.write(
        localOnly ? "Local login cleared.\n" : "Logged out.\n",
      );
    return;
  }

  if (command === "whoami") {
    const identity = await client.whoami();
    if (globals.json) printJSON(identity);
    else {
      process.stdout.write(
        `User          ${identity.email ?? identity.user_id ?? "—"}\n` +
          `Organization  ${identity.org_name ?? "—"}\n` +
          `Org ID        ${identity.org_id}\n` +
          `API           ${config.apiUrl}\n`,
      );
    }
    return;
  }

  if (command === "init") {
    const spa = flag(args, "--spa");
    const agentOnly = flag(args, "--agent-only");
    if (spa && agentOnly) {
      throw new Error("Choose either --spa or --agent-only");
    }
    const directory = args.shift();
    if (!directory) {
      throw new Error("Usage: opencomputer init <directory|.>");
    }
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    await assertStarterTarget(directory);
    const initialized = await initializeAgentProject(directory, undefined, {
      spa: !agentOnly,
    });
    if (globals.json) printJSON(initialized);
    else {
      const enterDirectory = directory === "." ? "" : `  cd ${directory}\n`;
      process.stdout.write(
        `Created the ${initialized.manifest.name} OpenComputer app\n` +
          `Directory: ${initialized.root}\n` +
          `Project:   choose or create one on the first npm run dev\n` +
          `Agents:    opencomputer/\n` +
          (agentOnly ? `App:       agent only\n\n` : `React:     src/\n\n`) +
          `Next:\n` +
          enterDirectory +
          `  npm install\n` +
          `  npm run dev       # cloud sync${agentOnly ? "" : " + React app"}\n`,
      );
    }
    return;
  }

  if (command === "agents") {
    const agents = await client.agents();
    if (globals.json) printJSON(agents);
    else if (!agents.length) {
      process.stdout.write(
        "No agents deployed. Run `opencomputer init <directory>` to get started.\n",
      );
    } else {
      for (const agent of agents) {
        const name = agent.name?.trim() || agent.id;
        const alias = agent.activeAlias?.trim() || "—";
        const deploymentCount = agent.deploymentCount ?? 0;
        process.stdout.write(
          `${name.padEnd(24)} ${alias.padEnd(12)} ${deploymentCount} deployment${deploymentCount === 1 ? "" : "s"}\n` +
            `${"".padEnd(25)}${agent.id}\n`,
        );
      }
    }
    return;
  }

  if (command === "link") {
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const root = await findOpenComputerProjectRoot(process.cwd());
    const binding = await ensureProjectBinding(client, config, root, {
      interactive: !globals.json,
      select: true,
    });
    if (globals.json) printJSON(binding);
    else {
      process.stdout.write(
        `Linked this app to ${binding.projectName} (${binding.projectId}).\n`,
      );
    }
    return;
  }

  if (command === "deploy") {
    const alias = option(args, "--alias") ?? "production";
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const built = await buildAgentArtifact(await requireAgentRoot());
    process.stderr.write(
      `Built ${built.agentId} in ${String(built.elapsedMs)}ms\n`,
    );
    const deployment = await client.registerDeployment({
      agentId: built.agentId,
      name: built.name,
      alias,
      channels: built.channels,
      connections: built.connections,
      httpConnections: built.httpConnections,
      source: {
        digest: built.digest,
        size: built.body.byteLength,
        contentType: "application/vnd.opencomputer.agent+json",
        body: built.body.toString("utf8"),
      },
    });
    if (globals.json) printJSON(deployment);
    else {
      process.stdout.write(
        `Deployed ${deployment.agentId}@${deployment.alias}\n` +
          `Deployment: ${deployment.id}\n` +
          `Source ID:  opencomputer.toml\n`,
      );
    }
    return;
  }

  if (command === "run") {
    const keep = flag(args, "--keep");
    const agent = args.shift();
    const prompt = args.join(" ").trim();
    if (!agent || !prompt) {
      throw new Error("Usage: opencomputer run <agent> <prompt>");
    }
    const result = await runAgent(
      client,
      agent,
      prompt,
      keep,
      globals.json,
      globals.verbose === true,
    );
    if (globals.json) printJSON(result);
    return;
  }

  if (command === "dev") {
    const project = option(args, "--project");
    const createProjectName = option(args, "--create-project");
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    await runCloudDevelopment(
      client,
      config,
      await findOpenComputerProjectRoot(process.cwd()),
      {
        project,
        createProjectName,
        interactive: !globals.json,
      },
    );
    return;
  }

  if (command === "secrets" || command === "secret") {
    const action = args.shift();
    const projectReference = option(args, "--project");
    const agentOption = option(args, "--agent");
    const environment = environmentOption(option(args, "--environment"));
    const project = await selectedProject(
      client,
      config,
      projectReference,
      !globals.json,
    );
    const agentId = agentOption
      ? agentOption === "current"
        ? project.agentId
        : agentOption
      : undefined;
    if (action === "list") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const secrets = await client.secrets({
        projectId: project.projectId,
        environment,
        ...(agentId ? { agentId } : {}),
      });
      if (globals.json) printJSON(secrets);
      else if (!secrets.length) process.stdout.write("No secrets.\n");
      else {
        for (const secret of secrets) {
          process.stdout.write(
            `${secret.name.padEnd(28)} ${secret.environment.padEnd(12)} ` +
              `${(secret.agentId ?? "project").padEnd(24)} ` +
              `${secret.allowedOrigins.join(", ")}\n`,
          );
        }
      }
      return;
    }
    const name = args.shift();
    if (!name) {
      throw new Error(
        "Use `opencomputer secrets set|list|remove <name>`.",
      );
    }
    if (action === "set") {
      const explicitOrigins = options(args, "--allow-origin");
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      let allowedOrigins = explicitOrigins;
      if (!allowedOrigins.length) {
        const built = await buildAgentArtifact(await requireAgentRoot());
        allowedOrigins = built.httpConnections
          .filter((connection) =>
            Object.values(connection.headers).some(
              (value) => typeof value !== "string" && value.name === name,
            ),
          )
          .flatMap((connection) => [
            connection.origin,
            ...(connection.redirectOrigins ?? []).map(
              (redirect) => redirect.origin,
            ),
          ]);
      }
      allowedOrigins = [...new Set(allowedOrigins)];
      if (!allowedOrigins.length) {
        throw new Error(
          `No connection uses ${name}. Pass --allow-origin https://api.example.com.`,
        );
      }
      const secret = await client.putSecret({
        projectId: project.projectId,
        name,
        value: await readSecretValue(),
        environment,
        ...(agentId ? { agentId } : {}),
        allowedOrigins,
      });
      if (globals.json) printJSON(secret);
      else {
        process.stdout.write(
          `Set ${secret.name} for ${secret.agentId ?? "project"} ` +
            `(${secret.environment}); allowed for ${secret.allowedOrigins.join(", ")}.\n`,
        );
      }
      return;
    }
    if (action === "remove" || action === "delete") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      await client.deleteSecret({
        projectId: project.projectId,
        name,
        environment,
        ...(agentId ? { agentId } : {}),
      });
      if (globals.json) printJSON({ deleted: true, name });
      else process.stdout.write(`Removed ${name}.\n`);
      return;
    }
    throw new Error("Use `opencomputer secrets set`, `list`, or `remove`.");
  }

  if (command === "logs") {
    const follow = flag(args, "--follow");
    let agentId = option(args, "--agent");
    const sessionId = option(args, "--session");
    const environmentValue = option(args, "--environment");
    const environment = environmentValue
      ? environmentOption(environmentValue)
      : undefined;
    const limitValue = option(args, "--limit");
    const limit = limitValue ? Number.parseInt(limitValue, 10) : 200;
    if (!Number.isFinite(limit) || limit < 1 || limit > 1_000) {
      throw new Error("--limit must be between 1 and 1000");
    }
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    if (!agentId && !sessionId) {
      let insideProject = true;
      try {
        await findOpenComputerProjectRoot(process.cwd());
      } catch {
        insideProject = false;
      }
      if (insideProject) {
        agentId = (
          await selectedProject(client, config, undefined, !globals.json)
        ).agentId;
      }
    }
    let cursor = "";
    let stopped = false;
    const stop = (): void => {
      stopped = true;
    };
    process.once("SIGINT", stop);
    try {
      do {
        const result = await client.logs({
          ...(agentId ? { agentId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(environment ? { environment } : {}),
          ...(cursor ? { after: cursor } : {}),
          limit,
        });
        result.logs.forEach((entry) => printLog(entry, globals.json));
        cursor = result.cursor || cursor;
        if (follow && !stopped) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      } while (follow && !stopped);
    } finally {
      process.off("SIGINT", stop);
    }
    return;
  }

  if (command === "session") {
    const session = parseSessionCommand(args);
    const sessionArgs = session.args;
    if (session.action === "list") {
      if (sessionArgs.length)
        throw new Error(`Unexpected argument: ${sessionArgs[0]}`);
      const sessions = await client.sessions();
      if (globals.json) printJSON(sessions);
      else if (!sessions.length) process.stdout.write("No sessions.\n");
      else sessions.forEach(printSession);
      return;
    }
    if (session.action === "create") {
      const prompt = sessionArgs.join(" ").trim();
      const project = await selectedProject(
        client,
        config,
        undefined,
        !globals.json,
      );
      const agentId = await selectedSessionAgent(
        client,
        project,
        session.agent,
      );
      const agent = developmentAgentReference(agentId);
      if (prompt) {
        const result = await runAgent(
          client,
          agent,
          prompt,
          session.keep,
          globals.json,
          globals.verbose === true,
        );
        if (globals.json) printJSON(result);
        return;
      }
      const created = await client.createSession(agent);
      const connected = await waitForEvent(
        client,
        created.session.id,
        0,
        (event) => event.type === "runtime.connected",
        () => undefined,
        90_000,
      );
      if (!session.keep) {
        await client.suspendSession(created.session.id).catch(() => undefined);
      }
      const result = {
        sessionId: created.session.id,
        agentId: created.deployment?.agentId ?? agent,
        deploymentId: created.deployment?.id,
        status: session.keep ? "running" : "suspended",
        cursor: connected.cursor,
      };
      if (globals.json) printJSON(result);
      else {
        process.stdout.write(
          `Session:    ${result.sessionId}\n` +
            `Agent:      ${result.agentId}\n` +
            `Deployment: ${result.deploymentId ?? "—"}\n` +
            `Runtime:    ${result.status}\n`,
        );
      }
      return;
    }
    const sessionId = sessionArgs.shift();
    if (!sessionId) throw new Error("A session ID is required.");
    if (session.action === "inspect") {
      if (sessionArgs.length)
        throw new Error(`Unexpected argument: ${sessionArgs[0]}`);
      printJSON(await client.session(sessionId));
      return;
    }
    if (session.action === "attach") {
      if (sessionArgs.length)
        throw new Error(`Unexpected argument: ${sessionArgs[0]}`);
      await attachSession(client, sessionId, globals.json);
      return;
    }
    if (session.action === "send") {
      const prompt = sessionArgs.join(" ").trim();
      if (!prompt) throw new Error("A prompt is required.");
      const result = await sendAgentTurn(
        client,
        sessionId,
        prompt,
        session.keep,
        globals.json,
      );
      if (globals.json) {
        printJSON({ sessionId, ...result, status: "completed" });
      }
      return;
    }
    if (session.action === "end") {
      if (sessionArgs.length)
        throw new Error(`Unexpected argument: ${sessionArgs[0]}`);
      await client.terminateSession(sessionId).catch(() => undefined);
      const ended = await client.endSession(sessionId);
      if (globals.json) printJSON(ended);
      else process.stdout.write(`Session ${sessionId} ended.\n`);
      return;
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
