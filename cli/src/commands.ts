import { rm } from "node:fs/promises";

import {
  OpenComputerClient,
  type ManagedAgentEvent,
  type ManagedSessionSnapshot,
} from "./api.js";
import { login, logout, openBrowser } from "./auth.js";
import { resolveConfig } from "./config.js";
import { runCloudDevelopment } from "./dev.js";
import { runLocalAgent } from "./local.js";
import {
  addCalendarTools,
  addGmailTools,
  addSlackChannel,
  assertStarterTarget,
  buildAgentArtifact,
  findAgentRoot,
  initializeAgentProject,
  readManifest,
} from "./project.js";
import {
  captureLocalSlackState,
  clearSlackState,
  readLocalSlackState,
  readRemoteSlackState,
  remoteSlackStatePath,
  requireSlackAgentRoot,
  runSlackCli,
  slackManifest,
  writeRemoteSlackState,
} from "./slack.js";

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

async function requireAgentRoot(): Promise<string> {
  const root = await findAgentRoot();
  if (!root) {
    throw new Error(
      "No OpenComputer agent repository found. Run `opencomputer init <directory>` first.",
    );
  }
  return root;
}

async function connectManagedService(
  client: OpenComputerClient,
  service: "gmail" | "calendar" | "github",
  label = "default",
): Promise<void> {
  const displayName =
    service === "calendar"
      ? "Google Calendar"
      : service === "github"
        ? "GitHub"
        : "Gmail";
  const started = await client.linkManagedConnection(service, label);
  if (started.status === "connected") {
    process.stdout.write(
      `${displayName} connection "${label}" is already connected.\n`,
    );
    return;
  }
  if (!started.authorizationUrl) {
    throw new Error(`${displayName} did not return an authorization link.`);
  }
  process.stdout.write(
    `Authorize ${displayName}:\n${started.authorizationUrl}\n`,
  );
  openBrowser(started.authorizationUrl);
  const deadline = started.expiresAt
    ? Date.parse(started.expiresAt)
    : Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (
      (await client.managedConnection(started.connectionId, service)).status ===
      "connected"
    ) {
      process.stdout.write(`${displayName} connection "${label}" connected.\n`);
      return;
    }
  }
  throw new Error(`${displayName} authorization timed out.`);
}

async function inferAgentReference(alias: string): Promise<string | undefined> {
  const root = await findAgentRoot();
  if (!root) return undefined;
  const manifest = await readManifest(root);
  return `${manifest.id}@${alias}`;
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
): Promise<unknown> {
  const created = await client.createSession(agent);
  process.stderr.write(`Starting ${agent}…\n`);
  const connected = await waitForEvent(
    client,
    created.session.id,
    0,
    (event) => event.type === "runtime.connected",
    () => undefined,
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
        if (!json) printToolProgress(event);
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
    const directory = args.shift();
    if (!directory) {
      throw new Error("Usage: opencomputer init <directory|.>");
    }
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    await assertStarterTarget(directory);
    const initialized = await initializeAgentProject(directory);
    if (globals.json) printJSON(initialized);
    else {
      const enterDirectory = directory === "." ? "" : `  cd ${directory}\n`;
      process.stdout.write(
        `Created the ${initialized.manifest.name} OpenComputer app\n` +
          `Directory: ${initialized.root}\n` +
          `Project:   choose or create one on the first npm run dev\n` +
          `Agents:    opencomputer/\n` +
          `React:     src/\n\n` +
          `Next:\n` +
          enterDirectory +
          `  npm install\n` +
          `  npm run dev       # terminal 1: cloud agent sync\n` +
          `  npm run dev:web   # terminal 2: React app\n`,
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
    const result = await runAgent(client, agent, prompt, keep, globals.json);
    if (globals.json) printJSON(result);
    return;
  }

  if (command === "dev") {
    const project = option(args, "--project");
    const createProjectName = option(args, "--create-project");
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    await runCloudDevelopment(client, config, await requireAgentRoot(), {
      project,
      createProjectName,
      interactive: !globals.json,
    });
    return;
  }

  if (command === "session") {
    const local = flag(args, "--local");
    const remote = flag(args, "--remote");
    const keep = flag(args, "--keep");
    const agentOption = option(args, "--agent");
    const alias = option(args, "--alias") ?? "production";
    if (local && (remote || agentOption)) {
      throw new Error("--local cannot be combined with --remote or --agent.");
    }
    const knownActions = new Set([
      "create",
      "list",
      "inspect",
      "attach",
      "send",
      "end",
    ]);
    const shorthand = args[0];
    const action =
      shorthand && knownActions.has(shorthand) ? args.shift()! : "create";
    const useRemote = remote || Boolean(agentOption) || action !== "create";
    if (!useRemote) {
      const prompt = args.join(" ").trim();
      await runLocalAgent(prompt ? ["run", prompt] : ["shell"], config, {
        verbose: globals.verbose,
      });
      return;
    }
    if (action === "list") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const sessions = await client.sessions();
      if (globals.json) printJSON(sessions);
      else if (!sessions.length) process.stdout.write("No sessions.\n");
      else sessions.forEach(printSession);
      return;
    }
    if (action === "create") {
      const prompt = args.join(" ").trim();
      const agent = agentOption ?? (await inferAgentReference(alias));
      if (!agent) {
        throw new Error(
          "No agent repository found. Pass --agent <agent>@<alias>.",
        );
      }
      if (prompt) {
        const result = await runAgent(
          client,
          agent,
          prompt,
          keep,
          globals.json,
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
      if (!keep) {
        await client.suspendSession(created.session.id).catch(() => undefined);
      }
      const result = {
        sessionId: created.session.id,
        agentId: created.deployment?.agentId ?? agent,
        deploymentId: created.deployment?.id,
        status: keep ? "running" : "suspended",
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
    const sessionId = args.shift();
    if (!sessionId) throw new Error("A session ID is required.");
    if (action === "inspect") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      printJSON(await client.session(sessionId));
      return;
    }
    if (action === "attach") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      await attachSession(client, sessionId, globals.json);
      return;
    }
    if (action === "send") {
      const prompt = args.join(" ").trim();
      if (!prompt) throw new Error("A prompt is required.");
      const result = await sendAgentTurn(
        client,
        sessionId,
        prompt,
        keep,
        globals.json,
      );
      if (globals.json) {
        printJSON({ sessionId, ...result, status: "completed" });
      }
      return;
    }
    if (action === "end") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      await client.terminateSession(sessionId).catch(() => undefined);
      const ended = await client.endSession(sessionId);
      if (globals.json) printJSON(ended);
      else process.stdout.write(`Session ${sessionId} ended.\n`);
      return;
    }
    return;
  }

  if (command === "tools") {
    const action = args.shift();
    const toolName = args.shift();
    if (
      action !== "add" ||
      (toolName !== "gmail" && toolName !== "calendar") ||
      args.length
    ) {
      throw new Error("Usage: opencomputer tools add <gmail|calendar>");
    }
    const root = await requireAgentRoot();
    const files =
      toolName === "calendar"
        ? await addCalendarTools(root)
        : await addGmailTools(root);
    process.stdout.write(
      `${files.map((file) => `Created ${file}`).join("\n")}\n`,
    );
    return;
  }

  if (command === "connect") {
    const provider = args.shift();
    if ((provider !== "google" && provider !== "gmail") || args.length) {
      throw new Error("Usage: opencomputer connect google");
    }
    await connectManagedService(client, "gmail", "default");
    return;
  }

  if (command === "connection" || command === "connections") {
    const action = args.shift();
    if (action === "add" || action === "connect") {
      const provider = args.shift();
      const alias = option(args, "--alias") ?? "default";
      const service = provider === "google" ? "gmail" : provider;
      if (
        (service !== "gmail" &&
          service !== "calendar" &&
          service !== "github") ||
        args.length
      ) {
        throw new Error(
          "Usage: opencomputer connection add <gmail|calendar|github> [--alias <name>]",
        );
      }
      await connectManagedService(client, service, alias);
      return;
    }
    if (action === "remove" || action === "disconnect") {
      const connectionReference = args.shift();
      if (!connectionReference || args.length) {
        throw new Error(
          "Usage: opencomputer connection remove <alias|connection-id>",
        );
      }
      const connections = await client.connections();
      const matches = connections.filter(
        (connection) =>
          connection.id === connectionReference ||
          connection.label === connectionReference,
      );
      if (!matches.length) {
        throw new Error(`Connection "${connectionReference}" was not found.`);
      }
      if (matches.length > 1) {
        throw new Error(
          `More than one connection is named "${connectionReference}". Remove it by connection ID.`,
        );
      }
      const connection = matches[0]!;
      const googleService = connection.scopes?.some((scope) =>
        scope.includes("/auth/calendar"),
      )
        ? "calendar"
        : "gmail";
      const managedService =
        connection.provider === "github" ? "github" : googleService;
      const disconnected =
        connection.provider === "google" || connection.provider === "github"
          ? await client.disconnectManagedConnection(
              connection.id,
              managedService,
            )
          : await client.disconnectConnection(connection.id);
      if (globals.json) printJSON(disconnected);
      else process.stdout.write(`Removed connection "${connection.label}".\n`);
      return;
    }
    if (action !== "list" || args.length) {
      throw new Error(
        "Use `opencomputer connection add`, `list`, or `remove`.",
      );
    }
    const connections = await client.connections();
    if (globals.json) printJSON(connections);
    else if (!connections.length) process.stdout.write("No connections.\n");
    else {
      for (const connection of connections) {
        process.stdout.write(
          `${connection.id}  ${connection.provider.padEnd(10)} ` +
            `${connection.status.padEnd(11)} ` +
            `${connection.label.padEnd(16)} ` +
            `${connection.displayName ?? ""}\n`,
        );
      }
    }
    return;
  }

  if (command === "channels") {
    const action = args.shift();
    if (action === "add" || action === "connect") {
      throw new Error(
        "Connect Slack from the deployed agent's Channels tab in the OpenComputer dashboard.",
      );
    }
    if (action === "list") {
      const localOnly = flag(args, "--local");
      const remoteOnly = flag(args, "--remote");
      if (localOnly && remoteOnly) {
        throw new Error("Choose either --local or --remote.");
      }
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const root = await findAgentRoot();
      const localState =
        !remoteOnly && root ? await readLocalSlackState(root) : undefined;
      const remoteConnections = localOnly
        ? []
        : await client.channelConnections();
      if (globals.json) {
        printJSON({
          local: localState,
          remote: remoteConnections,
        });
      } else if (!localState && !remoteConnections.length) {
        process.stdout.write("No channel connections.\n");
      } else {
        if (localState) {
          process.stdout.write(
            `local  slack  connected  ${localState.teamName ?? localState.teamId}\n`,
          );
        }
        for (const connection of remoteConnections) {
          process.stdout.write(
            `${connection.id}  slack  ${connection.status.padEnd(12)} ` +
              `${connection.agentId}@${connection.alias}  ` +
              `${connection.teamName ?? connection.teamId ?? "pending"}\n`,
          );
        }
      }
      return;
    }
    const channel = args.shift();
    if (channel !== "slack") {
      throw new Error(
        "Use `opencomputer channels add|connect|list|disconnect slack`.",
      );
    }
    if (action === "add") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const root = await requireAgentRoot();
      const files = await addSlackChannel(root);
      await import("./slack.js").then(({ ensureSlackHooks }) =>
        ensureSlackHooks(root),
      );
      process.stdout.write(
        `${files.map((file) => `Created ${file}`).join("\n")}\n`,
      );
      return;
    }
    if (action === "connect") {
      const local = flag(args, "--local");
      const remote = flag(args, "--remote");
      const agentOption = option(args, "--agent");
      const alias = option(args, "--alias") ?? "production";
      if (local === remote) {
        throw new Error("Choose exactly one of --local or --remote for Slack.");
      }
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const root = await requireSlackAgentRoot();
      if (local) {
        await runSlackCli(
          root,
          ["app", "install", "--environment", "local"],
          "local",
        );
        const state = await captureLocalSlackState(root);
        process.stdout.write(
          `Connected local Slack app ${state.appId} to ` +
            `${state.teamName ?? state.teamId}.\n`,
        );
        return;
      }
      const agent = agentOption ?? (await inferAgentReference(alias));
      if (!agent) {
        throw new Error(
          "No agent repository found. Pass --agent <agent>@<alias>.",
        );
      }
      const previous = await readRemoteSlackState(root);
      const started = await client.createSlackConnection(agent);
      await writeRemoteSlackState(root, {
        version: 1,
        connectionId: started.connection.id,
        agentId: `${started.connection.agentId}@${started.connection.alias}`,
        webhookUrl: started.webhookUrl,
        apiUrl: config.apiUrl,
      });
      try {
        await runSlackCli(root, ["deploy", "--app", "deployed"], "remote");
        const connected = (await client.channelConnections()).find(
          (connection) => connection.id === started.connection.id,
        );
        if (!connected || connected.status !== "connected") {
          throw new Error(
            "Slack CLI finished without completing the connection.",
          );
        }
        if (previous && previous.connectionId !== connected.id) {
          await client
            .disconnectSlack(previous.connectionId)
            .catch(() => undefined);
        }
        if (globals.json) printJSON(connected);
        else {
          process.stdout.write(
            `Connected ${connected.agentId}@${connected.alias} to ` +
              `${connected.teamName ?? connected.teamId ?? "Slack"}.\n`,
          );
        }
      } catch (error) {
        await client
          .disconnectSlack(started.connection.id)
          .catch(() => undefined);
        if (previous) await writeRemoteSlackState(root, previous);
        else await rm(remoteSlackStatePath(root), { force: true });
        throw error;
      }
      return;
    }
    if (action === "disconnect") {
      const local = flag(args, "--local");
      const remote = flag(args, "--remote");
      const connectionId = args.shift();
      if (local && remote) {
        throw new Error("Choose either --local or --remote.");
      }
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const root = await requireSlackAgentRoot();
      if (local) {
        await runSlackCli(
          root,
          ["app", "uninstall", "--app", "local"],
          "local",
        );
        await clearSlackState(root, "local");
        process.stdout.write("Disconnected the local Slack app.\n");
        return;
      }
      const stored = await readRemoteSlackState(root);
      const id = connectionId ?? stored?.connectionId;
      if (!id) {
        throw new Error(
          "Pass a connection ID or connect Slack from this agent first.",
        );
      }
      const disconnected = await client.disconnectSlack(id);
      if (stored?.connectionId === id) {
        await clearSlackState(root, "remote");
      }
      if (globals.json) printJSON(disconnected);
      else process.stdout.write(`Disconnected Slack connection ${id}.\n`);
      return;
    }
    throw new Error(
      "Use `opencomputer channels add|connect|list|disconnect slack`.",
    );
  }

  if (command === "slack-hook") {
    const action = args.shift();
    // Slack CLI app hooks append metadata such as --source=<directory>.
    // The hook already resolves its repository from the working directory,
    // so these Slack-owned arguments are intentionally ignored.
    const root = await requireSlackAgentRoot();
    const mode =
      process.env.OPENCOMPUTER_SLACK_MODE === "remote" ? "remote" : "local";
    if (action === "manifest") {
      printJSON(await slackManifest(root, mode));
      return;
    }
    if (action === "deploy") {
      const state = await readRemoteSlackState(root);
      if (!state) {
        throw new Error(
          "Run `opencomputer channels connect slack --remote` first.",
        );
      }
      const botToken =
        process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_CLI_XOXB;
      if (!botToken) {
        throw new Error("Slack CLI did not provide SLACK_BOT_TOKEN.");
      }
      const hookConfig = await resolveConfig({
        ...globals,
        apiUrl: state.apiUrl,
      });
      const connection = await new OpenComputerClient(
        hookConfig,
      ).completeSlackConnection(state.connectionId, botToken);
      process.stdout.write(
        `OpenComputer connected ${connection.agentId}@${connection.alias} ` +
          `to ${connection.teamName ?? connection.teamId ?? "Slack"}.\n`,
      );
      return;
    }
    if (action === "start") {
      await runLocalAgent(["dev"], config);
      return;
    }
    throw new Error("Unsupported Slack CLI hook.");
  }

  throw new Error(`Unknown command: ${command}`);
}
