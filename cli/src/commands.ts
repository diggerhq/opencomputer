import {
  OpenComputerClient,
  type ManagedAgentEvent,
  type ManagedAgentLog,
  type ManagedSessionSnapshot,
  type MemoryBindings,
  type MemoryDocument,
  type MemoryDocumentMeta,
} from "./api.js";
import { login, logout } from "./auth.js";
import { codexLogin } from "./codex-oauth.js";
import { resolveConfig } from "./config.js";
import {
  publishProjectDeployment,
  runCloudDevelopment,
  runDeploymentWatch,
} from "./dev.js";
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
import {
  buildTemplateProject,
  normalizeTemplateRepositoryUrl,
  readTemplateManifest,
  templateDeployUrl,
} from "./template.js";
import {
  defaultTemplateDirectory,
  materializeTemplateCheckout,
} from "./template-local.js";
import { materializeProjectArchive } from "./project-local.js";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { doctorProject, type DoctorResult } from "./doctor.js";
import { CLIError } from "./errors.js";
import {
  createSessionWithMemory,
  ensureMemoryDocuments,
  memoryResources,
  saveMemoryEdit,
  type EnsuredMemoryDocument,
  type MemoryEditDraft,
  type MemoryResourceSummary,
} from "./memory-commands.js";

export interface GlobalOptions {
  apiUrl?: string;
  apiKey?: string;
  json: boolean;
  verbose?: boolean;
  idempotencyKey?: string;
}

export function deploymentAlias(requestedAlias?: string): string {
  return requestedAlias ?? "development";
}

export function shouldBindModelAccessProject(
  projectReference: string | undefined,
  currentAgentRoot: string | null | undefined,
): boolean {
  return Boolean(projectReference || currentAgentRoot);
}

function printJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printJSONLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
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

function consumeModelAccessProvider(args: string[]): "claude" | "codex" {
  if (args[0] === "claude" || args[0] === "codex") {
    return args.shift() as "claude" | "codex";
  }
  return "codex";
}

async function readTemplateSecretValue(): Promise<string> {
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

async function readStdinValue(enabled: boolean): Promise<string> {
  if (!enabled) {
    throw new CLIError(
      "value_stdin_required",
      "A value must be supplied through standard input.",
      "Pipe the value into this command and add `--value-stdin`.",
    );
  }
  if (process.stdin.isTTY) {
    throw new CLIError(
      "value_stdin_required",
      "--value-stdin requires piped standard input.",
      "Use `printf %s \"$VALUE\" | opencomputer ... --value-stdin`.",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!value) throw new Error("Standard-input value was empty");
  return value;
}

function printDoctor(result: DoctorResult, json: boolean): void {
  if (json) return printJSON(result);
  for (const item of result.diagnostics) {
    process.stdout.write(
      `${item.severity.toUpperCase()} ${item.code} ${item.file}${item.line ? `:${item.line}` : ""}\n` +
        `  ${item.message}\n  fix: ${item.hint}\n`,
    );
  }
  process.stdout.write(
    `${result.ok ? "Doctor passed" : "Doctor failed"}: ${result.summary.errors} errors, ` +
      `${result.summary.warnings} warnings in ${result.durationMs}ms.\n`,
  );
}

async function selectedProject(
  client: OpenComputerClient,
  config: Awaited<ReturnType<typeof resolveConfig>>,
  reference?: string,
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
  const binding = await ensureProjectBinding(client, config, root);
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

// Project memory (docs/agents/document-memory.mdx, "Owner access").

const MEMORY_USAGE =
  "Use `opencomputer memory list [<resource>]|show|create|edit|freeze|unfreeze|export|remove`.";

function memoryWriterLabel(document: MemoryDocumentMeta): string {
  return document.writer.kind === "agent"
    ? `agent ${document.writer.sessionId}`
    : "owner";
}

function memorySizeLabel(document: MemoryDocumentMeta): string {
  return (
    `${document.bytes}/${document.maxBytes} bytes` +
    (document.bytes > document.maxBytes ? " (over limit)" : "")
  );
}

function printMemoryDocument(document: MemoryDocument): void {
  process.stdout.write(
    `${document.id}  ${document.title}\n` +
      `summary:      ${document.summary || "—"}\n` +
      `agent writes: ${document.agentWrites}\n` +
      `size:         ${memorySizeLabel(document)}\n` +
      `updated:      ${document.updatedAt} by ${memoryWriterLabel(document)}\n` +
      `revision:     ${document.revision}\n\n` +
      `${document.text}${document.text.endsWith("\n") || !document.text ? "" : "\n"}`,
  );
}

async function readMemoryText(args: string[]): Promise<string | undefined> {
  const textFile = option(args, "--text-file");
  const textStdin = flag(args, "--text-stdin");
  if (textFile && textStdin) {
    throw new Error("Choose either --text-file or --text-stdin.");
  }
  if (textFile) return readFile(resolvePath(textFile), "utf8");
  if (!textStdin) return undefined;
  if (process.stdin.isTTY) {
    throw new CLIError(
      "value_stdin_required",
      "--text-stdin requires piped standard input.",
      "Use `cat notes.md | opencomputer memory ... --text-stdin`.",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printMemoryResources(
  resources: MemoryResourceSummary[],
  environment: string,
): void {
  if (!resources.length) {
    process.stdout.write(`No ${environment} memory resources.\n`);
    return;
  }
  for (const resource of resources) {
    process.stdout.write(
      `${resource.id.padEnd(24)} ${(resource.provider.kind ?? "document").padEnd(10)} ` +
        `${(resource.provider.maxBytes !== undefined ? `${resource.provider.maxBytes} bytes` : "").padEnd(12)} ` +
        `${(resource.declared ? "declared" : "not declared").padEnd(13)} ` +
        `${resource.documents === undefined ? "" : `${resource.documents} document${resource.documents === 1 ? "" : "s"}`}\n`,
    );
  }
}

// Opens the current text in $VISUAL/$EDITOR and returns what the user saved.
// The file stays in place on a failed save so the edit is not lost.
async function editMemoryTextInEditor(
  resource: string,
  id: string,
  text: string,
): Promise<MemoryEditDraft & { text: string }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CLIError(
      "editor_required",
      "memory edit opens an editor and needs an interactive terminal.",
      "Pass --text-file <path> or pipe the new text with --text-stdin.",
    );
  }
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const directory = await mkdtemp(join(tmpdir(), "opencomputer-memory-"));
  const path = join(directory, `${resource}--${id}.md`);
  await writeFile(path, text, "utf8");
  const result = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "sh", path], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`Editor exited with status ${result.status ?? "unknown"}.`);
  }
  return {
    text: await readFile(path, "utf8"),
    path,
    discard: () => rm(directory, { recursive: true, force: true }),
  };
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
  idempotencyKey?: string,
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
  const turn = await client.createTurn(sessionId, prompt, idempotencyKey);
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

async function tailSession(
  client: OpenComputerClient,
  sessionId: string,
  after: number,
  follow: boolean,
  json: boolean,
): Promise<void> {
  let cursor = after;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  try {
    do {
      const events = await client.events(sessionId, cursor);
      for (const event of events) {
        cursor = Math.max(cursor, event.seq);
        if (json) printJSONLine({ sessionId, cursor: event.seq, ...event });
        else {
          process.stdout.write(
            `${event.seq} ${event.type} ${JSON.stringify(event.data)}\n`,
          );
        }
      }
      if (follow && !stopped) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } while (follow && !stopped);
  } finally {
    process.off("SIGINT", stop);
  }
}

export function nextAgentEventDeadline(
  deadline: number,
  timeoutMs: number,
  receivedEvents: number,
  now = Date.now(),
): number {
  return receivedEvents > 0 ? now + timeoutMs : deadline;
}

async function waitForEvent(
  client: OpenComputerClient,
  sessionId: string,
  after: number,
  terminal: (event: ManagedAgentEvent) => boolean,
  onEvent: (event: ManagedAgentEvent) => void,
  timeoutMs: number,
): Promise<{ event: ManagedAgentEvent; cursor: number }> {
  let deadline = Date.now() + timeoutMs;
  let cursor = after;
  while (Date.now() < deadline) {
    const events = await client.events(sessionId, cursor);
    for (const event of events) {
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
    // Long-running agent turns may exceed one fixed timeout window while
    // continuing to emit useful progress. Timeout only after a full quiet
    // window with no new durable session events.
    deadline = nextAgentEventDeadline(deadline, timeoutMs, events.length);
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
  idempotencyKey?: string,
  memory?: MemoryBindings,
): Promise<unknown> {
  const created = await createSessionWithMemory(client, agent, memory);
  process.stderr.write(`Starting ${agent}…\n`);
  const connected = await waitForEvent(
    client,
    created.session.id,
    0,
    (event) => event.type === "runtime.connected",
    (event) => printSessionProgress(event, json, verbose),
    90_000,
  );
  const turn = await client.createTurn(created.session.id, prompt, idempotencyKey);
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
    ...(memory ? { memory } : {}),
    status: "completed",
    output: streamedText || completedText || undefined,
  };
}

function printMemoryBindings(
  memory: MemoryBindings | undefined,
  documents: EnsuredMemoryDocument[],
): string {
  if (!memory) return "";
  return Object.entries(memory)
    .map(([resource, binding]) => {
      if (binding.scope === "collection") {
        return `Memory:     ${resource} (collection, read)\n`;
      }
      const ensured = documents.find(
        (document) => document.resource === resource && document.id === binding.id,
      );
      const state = ensured ? (ensured.created ? ", created" : ", existing") : "";
      return `Memory:     ${resource}/${binding.id} (${binding.access ?? "read-write"}${state})\n`;
    })
    .join("");
}

export async function runCommand(
  command: string,
  rawArgs: string[],
  globals: GlobalOptions,
): Promise<void> {
  const args = [...rawArgs];

  if (command === "template" && args[0] === "validate") {
    args.shift();
    const repositoryUrl = option(args, "--repository-url");
    const appUrl = option(args, "--app-url");
    const directory = args.shift() ?? process.cwd();
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const manifest = await readTemplateManifest(directory);
    const deployUrl = repositoryUrl
      ? templateDeployUrl(repositoryUrl, appUrl)
      : undefined;
    if (globals.json) {
      printJSON({ file: "oc-template.toml", manifest, deployUrl });
    } else {
      process.stdout.write(
        `Valid template: ${manifest.template.name}\n` +
          (deployUrl ? `Deploy URL: ${deployUrl}\n` : ""),
      );
    }
    return;
  }

  if (command === "template" && args[0] === "build") {
    args.shift();
    const output = option(args, "--output");
    const directory = args.shift() ?? process.cwd();
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const bundle = await buildTemplateProject(directory);
    const serialized = `${JSON.stringify(bundle)}\n`;
    if (output) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, serialized, { mode: 0o600 });
      if (!globals.json)
        process.stdout.write(`Built template bundle: ${output}\n`);
    } else {
      process.stdout.write(serialized);
    }
    return;
  }

  const config = await resolveConfig(globals);
  const client = new OpenComputerClient(config, globals.idempotencyKey);

  if (command === "project" && args[0] === "clone") {
    args.shift();
    const directory = option(args, "--directory");
    const projectId = args.shift();
    if (!projectId || args.length) {
      throw new Error(
        "Usage: opencomputer project clone <project-id> [--directory <path>]",
      );
    }
    const project = (await client.projects()).find(
      (candidate) => candidate.id === projectId,
    );
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const checkout = await materializeProjectArchive({
      response: await client.projectSourceArchive(project.id),
      directory: directory ?? project.slug,
    });
    const binding = await ensureProjectBinding(client, config, checkout.directory, {
      project: project.id,
    });
    if (globals.json) printJSON({ checkout, binding });
    else {
      process.stdout.write(
        `Cloned ${binding.projectName} (${binding.projectId}).\n\n` +
          `Next:\n  cd ${checkout.directory}\n  npm install\n` +
          `  npm run deploy -- --watch --api-url ${config.apiUrl}\n`,
      );
    }
    return;
  }

  if (command === "template") {
    const action = args.shift();
    if (action === "clone") {
      const commitSha = option(args, "--commit");
      const project = option(args, "--project");
      const directory = option(args, "--directory");
      const repositoryUrl = args.shift();
      if (!repositoryUrl || !commitSha || !project || args.length) {
        throw new Error(
          "Usage: opencomputer template clone <repository-url> --commit <sha> --project <id> [--directory <path>]",
        );
      }
      const normalized = normalizeTemplateRepositoryUrl(repositoryUrl);
      const checkout = await materializeTemplateCheckout(
        normalized,
        commitSha,
        directory,
      );
      const binding = await ensureProjectBinding(
        client,
        config,
        checkout.directory,
        { project },
      );
      if (globals.json) printJSON({ checkout, binding });
      else {
        process.stdout.write(
          `Cloned ${normalized}@${commitSha.slice(0, 12)}\n` +
            `Linked to ${binding.projectName} (${binding.projectId}).\n\n` +
            `Next:\n  cd ${checkout.directory}\n  npm install\n  npm run deploy -- --watch\n`,
        );
      }
      return;
    }
    if (action !== "deploy") {
      throw new Error(
        "Usage: opencomputer template <deploy|clone> ...",
      );
    }
    const projectNameOption = option(args, "--project-name");
    const directoryOption = option(args, "--directory");
    const confirmed = flag(args, "--yes");
    const repositoryUrl = args.shift();
    if (!repositoryUrl) {
      throw new Error("A GitHub repository URL is required");
    }
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const inspection = await client.inspectTemplate(
      normalizeTemplateRepositoryUrl(repositoryUrl),
    );
    if (!globals.json) {
      process.stdout.write(
        `\n${inspection.template.name}\n${inspection.template.description}\n` +
          `Source: ${inspection.repository.fullName}@${inspection.repository.commitSha.slice(0, 12)}\n` +
          `Agents: ${inspection.agents.map((agent) => agent.name).join(", ")}\n` +
          `Target: Development\n\n`,
      );
    }
    if (inspection.requirements.connections.length) {
      throw new Error(
        "This template needs an interactive provider connection. Open its deploy URL in the dashboard to continue.",
      );
    }
    const requiredSecrets = inspection.requirements.secrets.filter(
      (requirement) => requirement.required !== false,
    );
    if (!process.stdin.isTTY && requiredSecrets.length) {
      throw new Error(
        `Secret ${requiredSecrets[0]!.name} requires an interactive terminal; secret values are never accepted as command-line arguments`,
      );
    }
    if ((!process.stdin.isTTY || !process.stdout.isTTY) && !projectNameOption) {
      throw new Error("--project-name is required in non-interactive mode");
    }
    const terminal =
      process.stdin.isTTY && process.stdout.isTTY
        ? createInterface({ input: process.stdin, output: process.stdout })
        : undefined;
    let projectName =
      projectNameOption ??
      inspection.template.defaultProjectName ??
      inspection.template.name;
    if (terminal && !projectNameOption) {
      projectName =
        (await terminal.question(`Project name [${projectName}]: `)).trim() ||
        projectName;
    }
    if (terminal && !confirmed) {
      const answer = (
        await terminal.question("Create this Development project? [y/N] ")
      )
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        terminal.close();
        throw new Error("Template deployment cancelled");
      }
    }
    const checkout = await materializeTemplateCheckout(
      inspection.repository.url,
      inspection.repository.commitSha,
      directoryOption ?? defaultTemplateDirectory(inspection.repository.url),
    );
    const runtimeValues = new Map<string, string>();
    for (const requirement of inspection.requirements.runtimeVariables) {
      if (!terminal) {
        if (requirement.required) {
          throw new Error(
            `Runtime variable ${requirement.name} requires an interactive terminal`,
          );
        }
        continue;
      }
      const hint = requirement.example ? ` [${requirement.example}]` : "";
      const value =
        (await terminal.question(`${requirement.name}${hint}: `)).trim() ||
        requirement.example ||
        "";
      if (requirement.required && !value) {
        terminal.close();
        throw new Error(`${requirement.name} is required`);
      }
      if (value) runtimeValues.set(requirement.name, value);
    }
    terminal?.close();
    const installation = await client.createTemplateInstallation({
      inspectionId: inspection.id,
      projectName,
      idempotencyKey: crypto.randomUUID(),
    });
    const installationAgentId = (localAgentId?: string) =>
      !localAgentId || localAgentId === inspection.agents[0]?.id
        ? installation.projectAgentId
        : `${installation.projectAgentId}--${localAgentId}`;
    for (const requirement of requiredSecrets) {
      process.stderr.write(`${requirement.name}\n`);
      const value = await readTemplateSecretValue();
      await client.putSecret({
        projectId: installation.projectId,
        name: requirement.name,
        value,
        environment: "development",
        agentId: installationAgentId(requirement.agentId),
        allowedOrigins: requirement.allowedOrigins,
      });
    }
    for (const requirement of inspection.requirements.runtimeVariables) {
      const value = runtimeValues.get(requirement.name);
      if (!value) continue;
      await client.putRuntimeVariable({
        projectId: installation.projectId,
        name: requirement.name,
        value,
        environment: "development",
        agentId: installationAgentId(requirement.agentId),
      });
    }
    let current = await client.finalizeTemplateInstallation(installation.id);
    const deadline = Date.now() + 10 * 60_000;
    while (
      !["ready", "failed"].includes(current.state) &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      current = await client.templateInstallation(current.id);
      if (!globals.json)
        process.stderr.write(`Template installation: ${current.state}\r`);
    }
    if (current.state === "failed") {
      throw new Error(current.error?.message ?? "Template installation failed");
    }
    if (current.state !== "ready") {
      throw new Error(
        `Template installation is still ${current.state}; ${current.projectUrl}`,
      );
    }
    const binding = await ensureProjectBinding(client, config, checkout.directory, {
      project: current.projectId,
    });
    if (globals.json) printJSON({ installation: current, checkout, binding });
    else {
      process.stdout.write(
        `\nReady: ${current.projectUrl}\n` +
          `Local: ${checkout.directory}\n\n` +
          `Next:\n  cd ${checkout.directory}\n  npm install\n  npm run deploy -- --watch\n`,
      );
    }
    return;
  }

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
      spa,
    });
    if (globals.json) printJSON(initialized);
    else {
      const enterDirectory = directory === "." ? "" : `  cd ${directory}\n`;
      process.stdout.write(
        `Created the ${initialized.manifest.name} OpenComputer app\n` +
          `Directory: ${initialized.root}\n` +
          `Project:   link explicitly with --project or --create-project\n` +
          `Agents:    opencomputer/\n` +
          (spa
            ? `Web app:   src/ (separate lifecycle)\n\n`
            : `App:       agent only\n\n`) +
          `Next:\n` +
          enterDirectory +
          `  npm install\n` +
          `  npm run deploy -- --watch  # deploy changes to Development\n` +
          (spa
            ? `  npm run dev:web             # optional local web app\n`
            : ""),
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

  if (command === "doctor") {
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const root = await findOpenComputerProjectRoot(process.cwd());
    const result = await doctorProject(root);
    if (!result.ok) {
      if (!globals.json) printDoctor(result, false);
      throw new CLIError(
        "doctor_failed",
        "Local project diagnostics failed.",
        "Fix the reported errors and rerun `opencomputer doctor --json`.",
        result,
      );
    }
    printDoctor(result, globals.json);
    return;
  }

  if (command === "link") {
    const project = option(args, "--project");
    const createProjectName = option(args, "--create-project");
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const root = await findOpenComputerProjectRoot(process.cwd());
    const binding = await ensureProjectBinding(client, config, root, {
      project,
      createProjectName,
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
    const watch = flag(args, "--watch");
    const requestedAlias = option(args, "--alias");
    const project = option(args, "--project");
    const createProjectName = option(args, "--create-project");
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const root = await findOpenComputerProjectRoot(process.cwd());
    if (!root) {
      throw new Error(
        "No OpenComputer project found. Run `opencomputer init <directory>` first.",
      );
    }
    const diagnosis = await doctorProject(root);
    if (!diagnosis.ok) {
      throw new CLIError(
        "doctor_failed",
        "Deploy stopped because local project diagnostics failed.",
        "Run `opencomputer doctor --json`, fix the errors, and deploy again.",
        diagnosis,
      );
    }
    if (watch) {
      if (requestedAlias && requestedAlias !== "development") {
        throw new Error(
          "--watch deploys only to development; omit --alias or use --alias development",
        );
      }
      await runDeploymentWatch(client, config, root, {
        project,
        createProjectName,
      });
      return;
    }
    if (project || createProjectName) {
      throw new Error("--project and --create-project require --watch");
    }
    const alias = deploymentAlias(requestedAlias);
    const binding = await ensureProjectBinding(client, config, root);
    const results = await publishProjectDeployment(
      client,
      root,
      binding,
      alias,
    );
    for (const { built } of results) {
      process.stderr.write(
        `Built ${built.agentId} in ${String(built.elapsedMs)}ms\n`,
      );
    }
    if (globals.json) printJSON(results.map(({ deployment }) => deployment));
    else {
      for (const { deployment } of results) {
        process.stdout.write(
          `Deployed ${deployment.agentId}@${deployment.alias}\n` +
            `Deployment: ${deployment.id}\n` +
            `Source ID:  opencomputer.toml\n`,
        );
      }
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
      globals.idempotencyKey,
    );
    if (globals.json) printJSON(result);
    return;
  }

  if (command === "dev") {
    const project = option(args, "--project");
    const createProjectName = option(args, "--create-project");
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    process.stderr.write(
      "`opencomputer dev` is deprecated. Use `opencomputer deploy --watch`; start any web app separately.\n",
    );
    const root = await findOpenComputerProjectRoot(process.cwd());
    const diagnosis = await doctorProject(root);
    if (!diagnosis.ok) {
      throw new CLIError(
        "doctor_failed",
        "Deploy stopped because local project diagnostics failed.",
        "Run `opencomputer doctor --json`, fix the errors, and deploy again.",
        diagnosis,
      );
    }
    await runCloudDevelopment(
      client,
      config,
      root,
      {
        project,
        createProjectName,
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
      throw new Error("Use `opencomputer secrets set|list|remove <name>`.");
    }
    if (action === "set") {
      const explicitOrigins = options(args, "--allow-origin");
      const valueStdin = flag(args, "--value-stdin");
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
        value: await readStdinValue(valueStdin),
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

  if (command === "model-access") {
    const action = args.shift();
    if (action === "connect") {
      // Local Codex-account OAuth: open a localhost callback
      // server, complete the flow in the user's browser, then relay the
      // credential to OpenComputer as a connected account. Nothing secret
      // is echoed or persisted locally.
      const provider = consumeModelAccessProvider(args);
      if (provider !== "codex") {
        throw new Error(
          "Claude account BYOK is not supported. Connect a Codex account instead.",
        );
      }
      const projectReference = option(args, "--project");
      const legacyEnvironment = option(args, "--environment");
      if (legacyEnvironment && !projectReference)
        throw new Error("--environment requires --project <id|slug>");
      if (
        legacyEnvironment &&
        !["development", "production", "both"].includes(legacyEnvironment)
      )
        throw new Error(
          "--environment must be development, production, or both",
        );
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const currentAgentRoot = projectReference ? null : await findAgentRoot();
      const project =
        shouldBindModelAccessProject(projectReference, currentAgentRoot)
          ? await selectedProject(client, config, projectReference)
          : undefined;
      const environments = project
        ? (["development", "production"] as const)
        : [];
      const receipt = await client.connectModelAccess({ provider: "openai" });
      process.stdout.write(
        "Opening a local callback and your browser to authorize your Codex account…\n",
      );
      const { credential, accountHint } = await codexLogin();
      const connection = await client.relayModelAccess(receipt.connection.id, {
        access_token: credential.access_token,
        refresh_token: credential.refresh_token,
        token_type: credential.token_type,
        expires_at: credential.expires_at,
      });
      const bindings = project
        ? await Promise.all(
            environments.map((environment) =>
              client.putModelAccessBinding({
                projectId: project.projectId,
                provider: "openai",
                environment,
                enabled: true,
              }),
            ),
          )
        : [];
      if (globals.json)
        printJSON({
          ...connection,
          external_account_hint: accountHint,
          bindings,
        });
      else {
        process.stdout.write(
          `Connected Codex account as ${connection.label}; status ${connection.status}.\n`,
        );
        if (project) {
          process.stdout.write(
            `Enabled Codex for ${project.projectId} (development and production).\n`,
          );
        }
      }
      return;
    }
    if (action === "list" || action === "ls" || action === undefined) {
      const connections = await client.modelAccessConnections();
      if (globals.json) printJSON(connections);
      else if (!connections.length)
        process.stdout.write("No model access connections.\n");
      else {
        for (const connection of connections) {
          process.stdout.write(
            `${connection.provider.padEnd(10)} ${connection.status.padEnd(18)} ` +
              `${connection.label}${connection.externalAccountHint ? ` (${connection.externalAccountHint})` : ""}\n`,
          );
        }
      }
      return;
    }
    if (action === "disconnect") {
      const provider = consumeModelAccessProvider(args);
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const connections = await client.modelAccessConnections();
      const apiProvider = provider === "claude" ? "anthropic" : "openai";
      const connection = connections.find((c) => c.provider === apiProvider);
      if (!connection) throw new Error(`No ${provider} connection found.`);
      const updated = await client.disconnectModelAccess(connection.id);
      if (globals.json) printJSON(updated);
      else process.stdout.write(`Disconnected ${connection.label}.\n`);
      return;
    }
    throw new Error("Use `opencomputer model-access connect|list|disconnect`.");
  }

  if (command === "env") {
    const action = args.shift();
    const projectReference = option(args, "--project");
    const agentOption = option(args, "--agent");
    const environment = environmentOption(option(args, "--environment"));
    const project = await selectedProject(
      client,
      config,
      projectReference,
    );
    const agentId = agentOption
      ? agentOption === "current"
        ? project.agentId
        : agentOption
      : undefined;
    if (action === "list") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const variables = await client.runtimeVariables({
        projectId: project.projectId,
        environment,
        ...(agentId ? { agentId } : {}),
      });
      if (globals.json) printJSON(variables);
      else if (!variables.length)
        process.stdout.write("No runtime variables.\n");
      else {
        for (const variable of variables) {
          process.stdout.write(
            `${variable.name.padEnd(28)} ${variable.environment.padEnd(12)} ` +
              `${variable.agentId ?? "project"}\n`,
          );
        }
      }
      return;
    }
    const name = args.shift()?.trim().toUpperCase();
    if (!name) {
      throw new Error("Use `opencomputer env set|list|remove <name>`.");
    }
    if (action === "set") {
      const valueStdin = flag(args, "--value-stdin");
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const variable = await client.putRuntimeVariable({
        projectId: project.projectId,
        name,
        value: await readStdinValue(valueStdin),
        environment,
        ...(agentId ? { agentId } : {}),
      });
      if (globals.json) printJSON(variable);
      else {
        process.stdout.write(
          `Set ${variable.name} for ${variable.agentId ?? "project"} ` +
            `(${variable.environment}). Restart the agent runtime to apply it.\n`,
        );
      }
      return;
    }
    if (action === "remove" || action === "delete") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      await client.deleteRuntimeVariable({
        projectId: project.projectId,
        name,
        environment,
        ...(agentId ? { agentId } : {}),
      });
      if (globals.json)
        printJSON({ removed: true, name, environment, agentId });
      else process.stdout.write(`Removed runtime variable ${name}.\n`);
      return;
    }
    throw new Error("Use `opencomputer env set|list|remove <name>`.");
  }

  if (command === "webhooks") {
    const action = args.shift();
    const projectReference = option(args, "--project");
    const agentOption = option(args, "--agent");
    const environment = environmentOption(option(args, "--environment"));
    const project = await selectedProject(
      client,
      config,
      projectReference,
    );
    const agentId = await selectedSessionAgent(
      client,
      project,
      !agentOption || agentOption === "current" ? undefined : agentOption,
    );
    if (action === "list") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const webhooks = await client.webhooks({
        projectId: project.projectId,
        environment,
        agentId,
      });
      if (globals.json) printJSON(webhooks);
      else if (!webhooks.length) process.stdout.write("No webhooks.\n");
      else {
        for (const webhook of webhooks) {
          process.stdout.write(
            `${webhook.id}  ${webhook.enabled ? "enabled " : "disabled"}  ` +
              `${webhook.name}  ${webhook.invocationUrl}` +
              (webhook.identity ? `  identity=${webhook.identity}` : "") +
              "\n",
          );
        }
      }
      return;
    }
    if (action === "create") {
      const name = args.shift()?.trim();
      const identity = option(args, "--identity");
      if (!name || args.length) {
        throw new Error("Use `opencomputer webhooks create <name> [--identity header:<name>|body:<json-pointer>]`.");
      }
      const existing = (await client.webhooks({
        projectId: project.projectId,
        environment,
        agentId,
      })).find((candidate) => candidate.name === name);
      const webhook =
        existing ??
        (await client.createWebhook({
          projectId: project.projectId,
          name,
          environment,
          agentId,
          ...(identity ? { identity } : {}),
        }));
      if (globals.json) printJSON({ ...webhook, reused: Boolean(existing) });
      else {
        process.stdout.write(
          `${existing ? "Reused" : "Created"} ${webhook.name} (${webhook.id}) for ${agentId}@${environment}.\n` +
            `URL: ${webhook.invocationUrl}\n` +
            (webhook.identity ? `Identity: ${webhook.identity}\n` : "") +
            (existing
              ? "The existing token remains unchanged; this URL omits it.\n"
              : `Token: ${webhook.token ?? "unavailable"}\n` +
                "Save this URL now. It carries the token and will not be shown again.\n"),
        );
      }
      return;
    }
    const webhookId = args.shift();
    const identityOption = action === "update" ? option(args, "--identity") : undefined;
    if (!webhookId || args.length) {
      throw new Error(
        "Use `opencomputer webhooks list|create|update|enable|disable|rotate-token|remove`.",
      );
    }
    if (action === "update") {
      if (identityOption === undefined) {
        throw new Error("Use `opencomputer webhooks update <id> --identity header:<name>|body:<json-pointer>|none`.");
      }
      const webhook = await client.updateWebhook({
        projectId: project.projectId,
        webhookId,
        identity: identityOption === "none" ? null : identityOption,
      });
      if (globals.json) printJSON(webhook);
      else
        process.stdout.write(
          webhook.identity
            ? `${webhook.name} now takes its delivery identity from ${webhook.identity}.\n`
            : `${webhook.name} now treats every delivery without an Idempotency-Key as new.\n`,
        );
      return;
    }
    if (action === "enable" || action === "disable") {
      const webhook = await client.updateWebhook({
        projectId: project.projectId,
        webhookId,
        enabled: action === "enable",
      });
      if (globals.json) printJSON(webhook);
      else
        process.stdout.write(
          `${action === "enable" ? "Enabled" : "Disabled"} ${webhook.name}.\n`,
        );
      return;
    }
    if (action === "rotate-token") {
      const webhook = await client.rotateWebhookToken({
        projectId: project.projectId,
        webhookId,
      });
      if (globals.json) printJSON(webhook);
      else {
        process.stdout.write(
          `Rotated the token for ${webhook.name}.\n` +
            `URL: ${webhook.invocationUrl}\n` +
            `Token: ${webhook.token ?? "unavailable"}\n` +
            "Save this URL now. The previous token and URL no longer work.\n",
        );
      }
      return;
    }
    if (action === "remove" || action === "delete") {
      await client.deleteWebhook({ projectId: project.projectId, webhookId });
      if (globals.json) printJSON({ deleted: true, webhookId });
      else process.stdout.write(`Removed webhook ${webhookId}.\n`);
      return;
    }
    throw new Error(
      "Use `opencomputer webhooks list|create|update|enable|disable|rotate-token|remove`.",
    );
  }

  if (command === "memory") {
    const action = args.shift();
    const projectReference = option(args, "--project");
    const environment = environmentOption(option(args, "--environment"));
    if (!action) throw new Error(MEMORY_USAGE);
    const project = await selectedProject(client, config, projectReference);
    const projectId = project.projectId;

    if (action === "export") {
      const out = option(args, "--out");
      const explicitResources = options(args, "--resource");
      if (!out || args.length) {
        throw new Error(
          "Use `opencomputer memory export --out <dir> [--resource <id>] [--environment development|production]`.",
        );
      }
      const listing = explicitResources.length
        ? undefined
        : await memoryResources(client, projectId, environment);
      const resources = listing
        ? listing.resources.map((resource) => resource.id)
        : [...new Set(explicitResources)];
      if (!resources.length) {
        throw new CLIError(
          "memory_resources_unknown",
          `No ${environment} memory resources exist for this project.`,
          "Pass --resource <id> for each resource to export, or deploy an agent that declares memory.",
        );
      }
      const exported: Array<{ resource: string; id: string; path: string }> = [];
      for (const resource of resources) {
        const directory = resolvePath(out, resource);
        await mkdir(directory, { recursive: true });
        let cursor: string | undefined;
        do {
          const page = await client.memoryDocuments({
            projectId,
            resource,
            environment,
            ...(cursor ? { cursor } : {}),
          });
          for (const meta of page.documents) {
            const { document } = await client.memoryDocument({
              projectId,
              resource,
              id: meta.id,
              environment,
            });
            const path = join(directory, `${document.id}.json`);
            await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
            exported.push({ resource, id: document.id, path });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
      const undeclared =
        listing?.resources
          .filter((resource) => !resource.declared)
          .map((resource) => resource.id) ?? [];
      if (globals.json) {
        printJSON({
          environment,
          exported,
          ...(listing ? { resources: listing.resources } : {}),
        });
      } else {
        for (const entry of exported) process.stdout.write(`${entry.path}\n`);
        process.stdout.write(
          `Exported ${exported.length} document${exported.length === 1 ? "" : "s"} ` +
            `from ${resources.length} resource${resources.length === 1 ? "" : "s"} (${environment}).\n` +
            (undeclared.length
              ? `Not declared by any active deployment: ${undeclared.join(", ")}.\n`
              : ""),
        );
      }
      return;
    }

    const resource = args.shift();
    if (action === "list" && !resource) {
      const listing = await memoryResources(client, projectId, environment);
      if (globals.json) printJSON(listing);
      else {
        printMemoryResources(listing.resources, environment);
        if (listing.source === "declarations") {
          process.stdout.write(
            "Listed from active deployments' declarations; this backend has no resource inventory, so undeclared resources and document counts are not shown.\n",
          );
        }
      }
      return;
    }
    if (!resource) throw new Error(MEMORY_USAGE);
    if (action === "list") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const documents: MemoryDocumentMeta[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.memoryDocuments({
          projectId,
          resource,
          environment,
          ...(cursor ? { cursor } : {}),
        });
        documents.push(...page.documents);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (globals.json) printJSON({ documents });
      else if (!documents.length) {
        process.stdout.write(`No ${environment} documents in ${resource}.\n`);
      } else {
        for (const document of documents) {
          process.stdout.write(
            `${document.id.padEnd(24)} ${document.title.padEnd(32)} ` +
              `${memorySizeLabel(document).padEnd(24)} ` +
              `${document.agentWrites.padEnd(9)} ${document.updatedAt} ` +
              `${memoryWriterLabel(document)}\n`,
          );
        }
      }
      return;
    }

    const id = args.shift();
    if (!id) throw new Error(MEMORY_USAGE);
    const target = { projectId, resource, id, environment };

    if (action === "show") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const { document } = await client.memoryDocument(target);
      if (globals.json) printJSON(document);
      else printMemoryDocument(document);
      return;
    }
    if (action === "create") {
      const title = option(args, "--title");
      const summary = option(args, "--summary");
      const frozen = flag(args, "--frozen");
      const text = await readMemoryText(args);
      if (!title || args.length) {
        throw new Error(
          "Use `opencomputer memory create <resource> <id> --title <title> [--summary <text>] [--text-file <path>|--text-stdin] [--frozen]`.",
        );
      }
      const { document } = await client.createMemoryDocument({
        ...target,
        title,
        text: text ?? "",
        ...(summary !== undefined ? { summary } : {}),
        ...(frozen ? { agentWrites: "disabled" as const } : {}),
      });
      if (globals.json) printJSON(document);
      else {
        process.stdout.write(
          `Created ${resource}/${document.id} (${memorySizeLabel(document)}, ${environment}).\n`,
        );
      }
      return;
    }
    if (action === "edit") {
      const summary = option(args, "--summary");
      const supplied = await readMemoryText(args);
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const current = await client.memoryDocument(target);
      let edited: Awaited<ReturnType<typeof editMemoryTextInEditor>> | undefined;
      const text =
        supplied ??
        (edited = await editMemoryTextInEditor(
          resource,
          id,
          current.document.text,
        )).text;
      if (text === current.document.text && summary === undefined) {
        await edited?.discard();
        if (globals.json) printJSON(current.document);
        else process.stdout.write(`No changes to ${resource}/${id}.\n`);
        return;
      }
      const document = await saveMemoryEdit(client, {
        ...target,
        etag: current.etag,
        text,
        ...(summary !== undefined ? { summary } : {}),
        ...(edited ? { draft: { path: edited.path, discard: edited.discard } } : {}),
      });
      if (globals.json) printJSON(document);
      else {
        process.stdout.write(
          `Saved ${resource}/${document.id} (${memorySizeLabel(document)}, revision ${document.revision}).\n`,
        );
      }
      return;
    }
    if (action === "freeze" || action === "unfreeze") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const current = await client.memoryDocument(target);
      const agentWrites = action === "freeze" ? "disabled" : "enabled";
      const { document } =
        current.document.agentWrites === agentWrites
          ? current
          : await client.patchMemoryDocument({
              ...target,
              etag: current.etag,
              agentWrites,
            });
      if (globals.json) printJSON(document);
      else {
        process.stdout.write(
          `Agent writes ${document.agentWrites} for ${resource}/${document.id} (${environment}).\n`,
        );
      }
      return;
    }
    if (action === "remove" || action === "delete") {
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const current = await client.memoryDocument(target);
      await client.deleteMemoryDocument({ ...target, etag: current.etag });
      if (globals.json) printJSON({ deleted: true, resource, id, environment });
      else process.stdout.write(`Removed ${resource}/${id} (${environment}).\n`);
      return;
    }
    throw new Error(MEMORY_USAGE);
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
          await selectedProject(client, config)
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

  if (command === "channels") {
    const action = args.shift();
    if (action !== "status") {
      throw new Error("Use `opencomputer channels status`.");
    }
    const projectReference = option(args, "--project");
    const agentOption = option(args, "--agent");
    const environment = environmentOption(option(args, "--environment"));
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const project = await selectedProject(
      client,
      config,
      projectReference,
    );
    const agentId = await selectedSessionAgent(
      client,
      project,
      !agentOption || agentOption === "current" ? undefined : agentOption,
    );
    const channels = (await client.channels()).filter(
      (channel) => channel.agentId === agentId && channel.alias === environment,
    );
    if (globals.json) printJSON({ projectId: project.projectId, environment, channels });
    else if (!channels.length) process.stdout.write("No matching channels.\n");
    else {
      for (const channel of channels) {
        process.stdout.write(
          `${channel.id} ${channel.status} ${channel.channel} ${channel.agentId}@${channel.alias}\n` +
            `  last event: ${channel.lastEventAt ?? "—"}\n` +
            `  last delivery: ${channel.lastDelivery ? `${channel.lastDelivery.status} at ${channel.lastDelivery.at}` : "—"}\n` +
            `  last error: ${channel.lastError ? `${channel.lastError.category} at ${channel.lastError.at}` : "—"}\n`,
        );
      }
    }
    return;
  }

  if (command === "session" || command === "sessions") {
    if (args[0] === "tail") {
      args.shift();
      const sessionId = args.shift();
      const afterValue = option(args, "--after");
      const follow = !flag(args, "--no-follow");
      if (!sessionId) throw new Error("A session ID is required.");
      if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
      const after = afterValue ? Number.parseInt(afterValue, 10) : 0;
      if (!Number.isFinite(after) || after < 0) {
        throw new Error("--after must be a non-negative event cursor");
      }
      await tailSession(client, sessionId, after, follow, globals.json);
      return;
    }
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
      );
      const agentId = await selectedSessionAgent(
        client,
        project,
        session.agent,
      );
      const agent = developmentAgentReference(agentId);
      // Sessions from the CLI run on Development, so its memory is bound.
      const documents = session.createDocuments && session.memory
        ? await ensureMemoryDocuments(client, {
            projectId: project.projectId,
            environment: "development",
            bindings: session.memory,
          })
        : [];
      if (prompt) {
        const result = await runAgent(
          client,
          agent,
          prompt,
          session.keep,
          globals.json,
          globals.verbose === true,
          globals.idempotencyKey,
          session.memory,
        );
        if (globals.json) {
          printJSON(
            documents.length
              ? { ...(result as Record<string, unknown>), documents }
              : result,
          );
        }
        return;
      }
      const created = await createSessionWithMemory(
        client,
        agent,
        session.memory,
      );
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
        created: created.created,
        agentId: created.deployment?.agentId ?? agent,
        deploymentId: created.deployment?.id,
        ...(session.memory ? { memory: session.memory } : {}),
        ...(documents.length ? { documents } : {}),
        status: session.keep ? "running" : "suspended",
        cursor: connected.cursor,
      };
      if (globals.json) printJSON(result);
      else {
        process.stdout.write(
          `Session:    ${result.sessionId}${created.created ? "" : " (existing)"}\n` +
            `Agent:      ${result.agentId}\n` +
            `Deployment: ${result.deploymentId ?? "—"}\n` +
            printMemoryBindings(session.memory, documents) +
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
        globals.idempotencyKey,
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
