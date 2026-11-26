#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  access,
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { startCommandUnit, type CommandUnit } from "./command-unit.js";
import { startEgressTunnel } from "./egress-tunnel.js";
import { workspaceModel } from "./opencode-config.js";
import {
  GitHubCredentialHolder,
  type GitHubCredential,
} from "./github-credential.js";
import type { ToolInvocationIdentity } from "../protocol.js";
import { parseToolInvocationIdentity } from "../tool-identity.js";
import {
  codeToolContext,
  loadCodeTools,
  type CodeToolDefinition,
} from "../runtime/code-tools.js";

interface FileSystemMount {
  id: string;
  accessPointId?: string;
  mountTargetIp?: string;
  mountPath?: string;
  /**
   * "mounted" means the infrastructure already mounts the workspace
   * volume at mountPath (the Modal provider attaches a Volume at create
   * time), so the supervisor skips its own s3files mount while keeping
   * the local-disk scratch bind mount for repos.
   */
  backend?: "s3files" | "mounted";
}

function validFileSystemMount(value: unknown): boolean {
  const mount = value as Record<string, unknown>;
  if (typeof mount.id !== "string" || !mount.id) return false;
  if (mount.mountPath !== "/workspace") return false;
  if (mount.backend === "mounted") return true;
  return (
    typeof mount.accessPointId === "string" &&
    typeof mount.mountTargetIp === "string"
  );
}

interface AgentArtifactReference {
  bucket: string;
  key: string;
  digest: string;
}

interface RunConfiguration {
  edge: string;
  projectId: string;
  deploymentId: string;
  agentId: string;
  sessionId: string;
  runtimeToken: string;
  fileSystem?: FileSystemMount;
  agentArtifact?: AgentArtifactReference;
}

interface RunHookRequest {
  microvmId?: string;
  runHookPayload?: string;
}

interface WarmPoolConfiguration {
  warmPool: true;
  claimToken: string;
  agentArtifact: AgentArtifactReference;
}

interface ToolSandboxConfiguration {
  toolSandbox: true;
  sessionId: string;
  generation: number;
  edge: string;
  runtimeToken: string;
  fileSystem: FileSystemMount;
  agentArtifact: AgentArtifactReference;
}

/** The command ceiling the host enforces; the supervisor refuses anything past it. */
const COMMAND_TIMEOUT_MAX_SECONDS = 1_800;

/**
 * The longest a status request may hold waiting for new progress or a
 * terminal status before it answers anyway (the long poll). The host
 * re-issues the hold, so the cap only bounds one request through the
 * MicroVM proxy.
 */
const TOOL_STATUS_WAIT_MAX_MS = 30_000;

interface ToolProgressEntry {
  seq: number;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * One tool operation, keyed by session, generation and tool call id. It is
 * `running` from admission until its unit has settled; `completed` and
 * `failed` are the command's own outcomes (a timeout is `failed` with the
 * captured output kept in `result`); `cancelled` is a stop that terminated
 * the unit, or a cancel that arrived before the operation started (the
 * tombstone keeps a late start from running it).
 */
interface ToolOperation {
  status: "running" | "completed" | "failed" | "cancelled";
  progress: ToolProgressEntry[];
  nextSeq: number;
  result?: Record<string, unknown>;
  error?: string;
  /** The command's process unit, for termination. Absent for code tools. */
  unit?: CommandUnit;
  /** The run promise, so a cancel can wait for the outcome to be recorded. */
  settled?: Promise<void>;
  /** Status requests holding for the next progress entry, woken by appendToolProgress. */
  waiters?: Set<() => void>;
}

interface ToolRunOutcome {
  status: "completed" | "failed" | "cancelled";
  result?: Record<string, unknown>;
  error?: string;
}

interface CodexRelayRequest {
  sessionId: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  body: string;
}

const CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
const CODEX_REQUEST_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "user-agent",
  "x-openai-internal-codex-residency",
]);

const port = Number(process.env.BLUE_SUPERVISOR_PORT ?? "8080");
const blueRoot = process.env.BLUE_ROOT ?? "/opt/blue";
const openCodePort = Number(process.env.BLUE_OPENCODE_PORT ?? "4096");
const openCodeUrl = `http://127.0.0.1:${String(openCodePort)}`;
const openCodePassword = randomUUID();
/**
 * This supervisor process's identity. Tool operations live in its memory,
 * so a reply about an operation is only meaningful from the boot that
 * admitted it; the host compares the two before trusting a "not found".
 */
const supervisorBootId = randomUUID();
const localConnectionToken = randomUUID();
const localConnectionsUrl = `http://127.0.0.1:${String(port)}/connections`;
const localOutboxUrl = `http://127.0.0.1:${String(port)}/outboxes`;
const localApprovalUrl = `http://127.0.0.1:${String(port)}/approvals`;
let runtime: ChildProcess | undefined;
let openCode: ChildProcess | undefined;
let openCodeWorkspace: string | undefined;
let openCodeSessionId: string | undefined;
let openCodeStartup: Promise<void> | undefined;
let configuration: RunConfiguration | undefined;
let poolClaimToken: string | undefined;
let toolSandbox: ToolSandboxConfiguration | undefined;
let toolSandboxInitialization:
  | { key: string; promise: Promise<void> }
  | undefined;
let runtimeWorkspace: string | undefined;
/**
 * The GitHub installation credential this computer holds, refreshed before a
 * command that would outlive it is dispatched. Created when the runtime
 * variables are loaded; absent until then.
 */
let gitHubCredential: GitHubCredentialHolder | undefined;
const toolOperations = new Map<string, ToolOperation>();
let codeToolDefinitions:
  | Promise<{ definitions: Map<string, CodeToolDefinition>; resultTool?: string }>
  | undefined;
let httpConnectionIds = new Set<string>();
let mcpServers = new Map<
  string,
  { id: string; url: string; connection?: string }
>();
let operation = Promise.resolve();

function json(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function relayCodexRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!configuration) {
    json(response, 503, { message: "Session runtime is not configured" });
    return;
  }
  const input = (await readJson(request)) as Partial<CodexRelayRequest>;
  if (
    input.sessionId !== configuration.sessionId ||
    input.upstreamUrl !== CODEX_RESPONSES_URL ||
    !input.headers ||
    typeof input.headers !== "object" ||
    Array.isArray(input.headers) ||
    typeof input.body !== "string" ||
    input.body.length > 16 * 1024 * 1024
  ) {
    json(response, 400, { message: "Invalid Codex relay request" });
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers)) {
    const normalized = name.toLowerCase();
    if (!CODEX_REQUEST_HEADERS.has(normalized) || typeof value !== "string") {
      continue;
    }
    headers.set(normalized, value);
  }
  if (
    !headers.get("authorization")?.startsWith("Bearer ") ||
    !headers.get("chatgpt-account-id") ||
    headers.get("originator") !== "opencode"
  ) {
    json(response, 400, { message: "Incomplete Codex relay headers" });
    return;
  }

  const upstream = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: input.body,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const responseHeaders: Record<string, string> = {};
  for (const name of [
    "cache-control",
    "content-type",
    "openai-processing-ms",
    "request-id",
    "retry-after",
    "x-request-id",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders[name] = value;
  }
  response.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!response.write(Buffer.from(value))) {
      await new Promise<void>((resolvePromise) =>
        response.once("drain", resolvePromise),
      );
    }
  }
  response.end();
}

function parseRunHookPayload(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    throw new Error("Invalid run hook request");
  }
  const request = body as RunHookRequest;
  if (typeof request.runHookPayload !== "string") {
    throw new Error("runHookPayload is required");
  }
  return JSON.parse(request.runHookPayload) as unknown;
}

function parseRunConfiguration(value: unknown): RunConfiguration {
  const parsed = value as Partial<RunConfiguration>;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.edge !== "string" ||
    typeof parsed.projectId !== "string" ||
    typeof parsed.deploymentId !== "string" ||
    typeof parsed.agentId !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.runtimeToken !== "string"
  ) {
    throw new Error("Invalid managed-agent run hook payload");
  }
  if (
    parsed.agentArtifact &&
    (typeof parsed.agentArtifact.bucket !== "string" ||
      typeof parsed.agentArtifact.key !== "string" ||
      typeof parsed.agentArtifact.digest !== "string")
  ) {
    throw new Error("Invalid managed-agent artifact reference");
  }
  return parsed as RunConfiguration;
}

function parseWarmPoolConfiguration(
  value: unknown,
): WarmPoolConfiguration | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("warmPool" in value) ||
    value.warmPool !== true ||
    !("claimToken" in value) ||
    typeof value.claimToken !== "string" ||
    !value.claimToken ||
    !("agentArtifact" in value) ||
    typeof value.agentArtifact !== "object" ||
    value.agentArtifact === null ||
    !("bucket" in value.agentArtifact) ||
    typeof value.agentArtifact.bucket !== "string" ||
    !("key" in value.agentArtifact) ||
    typeof value.agentArtifact.key !== "string" ||
    !("digest" in value.agentArtifact) ||
    typeof value.agentArtifact.digest !== "string"
  ) {
    return null;
  }
  return value as WarmPoolConfiguration;
}

function parseToolSandboxConfiguration(
  value: unknown,
): ToolSandboxConfiguration | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("toolSandbox" in value) ||
    value.toolSandbox !== true ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    !("generation" in value) ||
    !Number.isInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !("edge" in value) ||
    typeof value.edge !== "string" ||
    !value.edge ||
    !("runtimeToken" in value) ||
    typeof value.runtimeToken !== "string" ||
    !value.runtimeToken ||
    !("fileSystem" in value) ||
    typeof value.fileSystem !== "object" ||
    value.fileSystem === null ||
    !validFileSystemMount(value.fileSystem) ||
    !("agentArtifact" in value) ||
    typeof value.agentArtifact !== "object" ||
    value.agentArtifact === null ||
    !("bucket" in value.agentArtifact) ||
    typeof value.agentArtifact.bucket !== "string" ||
    !("key" in value.agentArtifact) ||
    typeof value.agentArtifact.key !== "string" ||
    !("digest" in value.agentArtifact) ||
    typeof value.agentArtifact.digest !== "string"
  ) {
    return null;
  }
  return value as ToolSandboxConfiguration;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedOpenCodeDependencies(workspace: string): Promise<void> {
  const source = resolve(blueRoot, "opencode2-deps");
  if (!(await pathExists(source))) return;

  const destination = resolve(workspace, ".opencode");
  await mkdir(destination, { recursive: true });
  for (const filename of ["package.json", "package-lock.json"]) {
    const target = resolve(destination, filename);
    if (!(await pathExists(target))) {
      await copyFile(resolve(source, filename), target);
    }
  }

  const modules = resolve(destination, "node_modules");
  try {
    await lstat(modules);
  } catch {
    await symlink(resolve(source, "node_modules"), modules, "dir");
  }
}

/**
 * Platform AWS credentials sit in process.env only so the supervisor's own
 * S3 work (artifact fetch) reaches the bucket; agent-spawned processes must
 * never inherit them. Region variables are harmless and stay.
 */
function sandboxChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.AWS_ACCESS_KEY_ID;
  delete out.AWS_SECRET_ACCESS_KEY;
  delete out.AWS_SESSION_TOKEN;
  return out;
}

async function runCommand(
  command: string,
  args: string[],
  options: { tolerateFailure?: boolean } = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || options.tolerateFailure) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `${command} exited with ${String(code)}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

interface AgentArtifactBundle {
  version: 1;
  files: Array<{
    path: string;
    content: string;
  }>;
}

function parseAgentArtifact(value: unknown): AgentArtifactBundle {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("files" in value) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("Invalid managed-agent artifact");
  }
  for (const file of value.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      !("path" in file) ||
      typeof file.path !== "string" ||
      !("content" in file) ||
      typeof file.content !== "string"
    ) {
      throw new Error("Invalid managed-agent artifact file");
    }
  }
  return value as AgentArtifactBundle;
}

async function materializeAgentArtifact(
  workspace: string,
  artifact: AgentArtifactReference,
): Promise<void> {
  const startedAt = Date.now();
  // The artifact was uploaded when the deployment registered; an S3 read
  // moments later can still see a transient miss or throttle.
  const result = await withTransientRetries(() =>
    new S3Client({}).send(
      new GetObjectCommand({
        Bucket: artifact.bucket,
        Key: artifact.key,
      }),
    ),
  );
  if (!result.Body) {
    throw new Error("Managed-agent artifact has no body");
  }
  const bytes = Buffer.from(await result.Body.transformToByteArray());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.digest) {
    throw new Error(
      `Managed-agent artifact digest mismatch: expected ${artifact.digest}, got ${digest}`,
    );
  }

  const bundle = parseAgentArtifact(JSON.parse(bytes.toString("utf8")));
  const workspacePrefix = `${resolve(workspace)}/`;
  for (const file of bundle.files) {
    const target = resolve(workspace, file.path);
    if (!target.startsWith(workspacePrefix)) {
      throw new Error(`Agent artifact path escapes workspace: ${file.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.content, "base64"));
  }
  process.stdout.write(
    `managed-agent supervisor: agent artifact ${artifact.digest.slice(0, 12)} ` +
      `ready in ${String(Date.now() - startedAt)}ms\n`,
  );
}

async function initializeToolSandbox(
  toolConfiguration: ToolSandboxConfiguration,
): Promise<void> {
  const hook = `tool-sandbox run hook (session ${toolConfiguration.sessionId}, generation ${String(toolConfiguration.generation)})`;
  toolSandbox = toolConfiguration;
  runtimeWorkspace = await prepareWorkspace(toolConfiguration, true).catch(
    (error) => {
      throw hookStageError(hook, "prepare workspace", error);
    },
  );
  configuration = {
    edge: toolConfiguration.edge,
    projectId: "tool-sandbox",
    deploymentId: toolConfiguration.agentArtifact.digest,
    agentId: "tool-sandbox",
    sessionId: toolConfiguration.sessionId,
    runtimeToken: toolConfiguration.runtimeToken,
    fileSystem: toolConfiguration.fileSystem,
    agentArtifact: toolConfiguration.agentArtifact,
  };
  process.env.BLUE_CONNECTIONS_URL = localConnectionsUrl;
  process.env.BLUE_CONNECTION_TOKEN = localConnectionToken;
  process.env.OPENCOMPUTER_CONNECTIONS_URL = localConnectionsUrl;
  process.env.OPENCOMPUTER_CONNECTION_TOKEN = localConnectionToken;
  process.env.OPENCOMPUTER_OUTBOX_URL = localOutboxUrl;
  process.env.OPENCOMPUTER_OUTBOX_TOKEN = localConnectionToken;
  process.env.OPENCOMPUTER_APPROVAL_URL = localApprovalUrl;
  process.env.OPENCOMPUTER_APPROVAL_TOKEN = localConnectionToken;
  // main made the variables mutable before they reach process.env so git
  // authentication can be woven in; the approval pair is set directly
  // because it comes from the supervisor, not from the deployment.
  const loadedVariables = await loadRuntimeVariables(configuration).catch(
    (error) => {
      throw hookStageError(hook, "load runtime variables", error);
    },
  );
  await configureGitHubGitAuthentication(configuration, loadedVariables).catch(
    (error) => {
      throw hookStageError(hook, "configure GitHub authentication", error);
    },
  );
  Object.assign(process.env, loadedVariables.variables);
  const manifest = JSON.parse(
    await readFile(
      resolve(runtimeWorkspace, ".opencomputer", "reactive.json"),
      "utf8",
    ).catch((error) => {
      throw hookStageError(hook, "read agent manifest", error);
    }),
  ) as { httpConnections?: Array<{ id?: unknown }> };
  httpConnectionIds = new Set(
    (manifest.httpConnections ?? []).flatMap((connection) =>
      typeof connection.id === "string" ? [connection.id] : [],
    ),
  );
}

/**
 * Sessions used to keep the agent's files in a `workspace/` subdirectory of
 * the mount (so the agent worked in /workspace/workspace). The mount root is
 * the workspace now; a volume laid out the old way is moved up on its next
 * boot so the session keeps its files.
 */
async function flattenLegacyWorkspace(workspace: string): Promise<void> {
  const legacy = resolve(workspace, "workspace");
  if (!(await pathExists(legacy))) return;
  const siblings = (await readdir(workspace)).filter((e) => e !== "workspace");
  if (siblings.length > 0) return;
  for (const entry of await readdir(legacy)) {
    await rename(resolve(legacy, entry), resolve(workspace, entry));
  }
  await rm(legacy, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify({ level: "info", event: "workspace.flattened", workspace })}\n`,
  );
}

async function prepareWorkspace(
  config: Pick<RunConfiguration, "sessionId" | "fileSystem" | "agentArtifact">,
  directWorkspace = false,
): Promise<string> {
  const startedAt = Date.now();
  const fallback = resolve("/blue/sessions", config.sessionId);
  const mountPath = config.fileSystem?.mountPath ?? fallback;
  await mkdir(mountPath, { recursive: true });

  let mounted = false;
  let mountMs = 0;
  const infraMounted = config.fileSystem?.backend === "mounted";
  if (config.fileSystem && process.env.BLUE_SKIP_MOUNT !== "1" && !infraMounted) {
    const source = config.fileSystem.id;
    const mountOptions = [
      `accesspoint=${config.fileSystem.accessPointId}`,
      `mounttargetip=${config.fileSystem.mountTargetIp}`,
    ].join(",");
    const mounts = await readFile("/proc/mounts", "utf8");
    if (!mounts.split("\n").some((line) => line.split(" ")[1] === mountPath)) {
      const mountStartedAt = Date.now();
      // The session's access point can still be propagating right after it
      // was created; a refused mount on a fresh install is transient.
      await withTransientRetries(
        () =>
          runCommand("mount", [
            "-t",
            "s3files",
            "-o",
            mountOptions,
            source,
            mountPath,
          ]),
        { delayMs: 500 },
      );
      mountMs = Date.now() - mountStartedAt;
      mounted = true;
    }
  }

  const workspace = mountPath;
  await mkdir(workspace, { recursive: true });
  if (!directWorkspace) await flattenLegacyWorkspace(workspace);
  const entries = await readdir(workspace);
  const reused = entries.length > 0;
  const packagedAgent = resolve(blueRoot, "agent");
  if (entries.length === 0) {
    if (config.agentArtifact) {
      await materializeAgentArtifact(workspace, config.agentArtifact);
    } else if (await pathExists(packagedAgent)) {
      await cp(packagedAgent, workspace, { recursive: true });
    }
  }
  await seedOpenCodeDependencies(workspace);
  // Scratch space on the VM's own disk: on the network filesystem `git
  // clone`, `find`/`grep -r`, and package installs pay per-file latency, so
  // `repos/` under the workspace is a bind mount of a local directory.
  // Hibernation snapshots RAM and disk, so clones survive suspend/resume; a
  // replacement VM starts it empty and the agent clones again — anything
  // that must persist still belongs directly under the workspace.
  let reposMounted = false;
  // The scratch bind mount still applies when the infrastructure mounted
  // the workspace volume: it keeps per-file repo traffic on the VM's own
  // disk either way.
  if (config.fileSystem && process.env.BLUE_SKIP_MOUNT !== "1") {
    const scratchRoot = resolve("/blue/scratch", config.sessionId);
    const reposPath = resolve(workspace, "repos");
    await mkdir(scratchRoot, { recursive: true });
    await mkdir(reposPath, { recursive: true });
    const mounts = await readFile("/proc/mounts", "utf8");
    if (!mounts.split("\n").some((line) => line.split(" ")[1] === reposPath)) {
      await runCommand("mount", ["--bind", scratchRoot, reposPath]);
      reposMounted = true;
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event: "workspace.ready",
      sessionId: config.sessionId,
      storage: config.fileSystem
        ? infraMounted
          ? "infra-mounted"
          : "s3-files"
        : "local",
      mounted,
      mountMs,
      reused,
      reposMounted,
      totalMs: Date.now() - startedAt,
    })}\n`,
  );
  return workspace;
}

/**
 * Runs one command as its own process unit for at most `timeoutSeconds`.
 * The outcome is the command's: `completed` with its exit status, `failed`
 * on timeout (the unit terminated, the captured output kept so the model
 * sees what happened before the cutoff), `cancelled` when a stop terminated
 * it. Writes the command finished before that point stay in the workspace.
 */
async function executeToolCommand(
  operation: ToolOperation,
  unitId: string,
  workspace: string,
  command: string,
  timeoutSeconds: number,
  reportProgress: (data: Record<string, unknown>) => void,
): Promise<ToolRunOutcome> {
  // Refresh-before-dispatch (C3): the token the command receives must
  // outlive the command's allowed duration, for `git` through the credential
  // helper's file and for `gh` through these variables. The duration is the
  // command's own `timeoutSeconds`, so a long command near expiry refreshes
  // and a short one does not.
  const credentialVariables =
    (await gitHubCredential?.environmentForCommand(timeoutSeconds)) ?? {};
  Object.assign(process.env, credentialVariables);
  const unit = startCommandUnit({
    unitId,
    workspace,
    command,
    timeoutMs: timeoutSeconds * 1_000,
    env: sandboxChildEnv({ ...process.env, ...credentialVariables }),
    onOutput: (stream, chunk) =>
      reportProgress({ stream, chunk: chunk.slice(0, 16 * 1024) }),
  });
  operation.unit = unit;
  const result = await unit.done;
  const summary: Record<string, unknown> = {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    terminated: result.terminated,
    truncated: result.truncated,
    durationMs: result.durationMs,
    isolation: result.isolation,
    contained: result.contained,
    orphansTerminated: result.orphansTerminated,
  };
  if (result.timedOut) {
    return {
      status: "failed",
      result: summary,
      error: `timed out after ${String(timeoutSeconds)} seconds; the command's process unit was terminated (${result.isolation})`,
    };
  }
  if (result.terminated) {
    return {
      status: "cancelled",
      result: summary,
      error: `cancelled (${result.terminationReason ?? "stop"}); the command's process unit was terminated (${result.isolation})`,
    };
  }
  return { status: "completed", result: summary };
}

async function loadToolDefinitions(
  workspace: string,
): Promise<{ definitions: Map<string, CodeToolDefinition>; resultTool?: string }> {
  const manifestPath = resolve(workspace, ".opencomputer", "reactive.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    tools?: unknown;
    toolModules?: unknown;
    resultTool?: { id?: unknown };
  };
  if (
    !Array.isArray(manifest.tools) ||
    manifest.tools.some((value) => typeof value !== "string") ||
    !Array.isArray(manifest.toolModules) ||
    manifest.toolModules.some((value) => typeof value !== "string")
  ) {
    throw new Error("The agent artifact has invalid tool declarations");
  }
  const definitions = await loadCodeTools(
    manifestPath,
    manifest.toolModules as string[],
    new Set(manifest.tools as string[]),
  );
  return {
    definitions: new Map(definitions.map((definition) => [definition.id, definition])),
    ...(typeof manifest.resultTool?.id === "string"
      ? { resultTool: manifest.resultTool.id }
      : {}),
  };
}

async function executeCodeTool(
  workspace: string,
  request: {
    toolId: string;
    input: Record<string, unknown>;
    /** The call's host identity, as the Workerd runtime resolved it; the tool's context is built from it, never from `input`. */
    identity: ToolInvocationIdentity;
    /**
     * Present when a human has approved this call. The write then runs from
     * the arguments that were on the card, which are `request.input` — not
     * from anything the model produced since.
     */
    decision?: { id: string; decidedAt: string; decidedBy?: string };
  },
  reportProgress: (data: Record<string, unknown>) => void,
): Promise<ToolRunOutcome> {
  codeToolDefinitions ??= loadToolDefinitions(workspace);
  const loaded = await codeToolDefinitions;
  const definition = loaded.definitions.get(request.toolId);
  if (!definition) {
    throw new Error(`The artifact does not define tool ${JSON.stringify(request.toolId)}`);
  }
  const context = codeToolContext(request.identity, request.input, {
    reportProgress: async (progress: Readonly<Record<string, unknown>>) => {
      reportProgress({ ...progress });
    },
  });
  if (request.decision) {
    if (definition.kind !== "gated-tool" || !definition.apply) {
      throw new Error(
        `Tool ${JSON.stringify(request.toolId)} is not gated and cannot be applied`,
      );
    }
  }
  const result = request.decision
    ? await definition.apply!({ ...context, decision: request.decision })
    : await definition.run(context);
  // The result tool's value is always JSON text: the Workerd host parses
  // it back to validate against the pinned output schema before the
  // commit (C1). Other tools keep returning a string as is.
  const content =
    typeof result === "string" && definition.id !== loaded.resultTool
      ? result
      : JSON.stringify(result ?? null);
  if (Buffer.byteLength(content, "utf8") > 1024 * 1024) {
    throw new Error("Tool result exceeded 1 MiB");
  }
  return { status: "completed", result: { content } };
}

function appendToolProgress(
  operation: ToolOperation,
  data: Record<string, unknown>,
): void {
  const encoded = JSON.stringify(data);
  const bounded =
    Buffer.byteLength(encoded, "utf8") <= 16 * 1024
      ? data
      : { message: "Tool progress update exceeded 16 KiB and was omitted" };
  operation.progress.push({
    seq: operation.nextSeq++,
    timestamp: new Date().toISOString(),
    data: bounded,
  });
  if (operation.progress.length > 128) operation.progress.shift();
  // Every operation event — progress, completion, failure, cancellation —
  // arrives through this append, so waking here delivers all of them to a
  // status request holding for news.
  if (operation.waiters) {
    for (const wake of operation.waiters) wake();
    operation.waiters.clear();
  }
}

function toolOperationKey(
  sessionId: string,
  generation: number,
  toolCallId: string,
): string {
  return `${sessionId}:${String(generation)}:${toolCallId}`;
}

function startToolOperation(
  key: string,
  run: (
    operation: ToolOperation,
    reportProgress: (data: Record<string, unknown>) => void,
  ) => Promise<ToolRunOutcome>,
): ToolOperation {
  const operation: ToolOperation = { status: "running", progress: [], nextSeq: 1 };
  toolOperations.set(key, operation);
  appendToolProgress(operation, { stage: "started" });
  operation.settled = run(operation, (data) => appendToolProgress(operation, data)).then(
    (outcome) => {
      if (outcome.result) operation.result = outcome.result;
      if (outcome.error) operation.error = outcome.error.slice(0, 16 * 1024);
      operation.status = outcome.status;
      appendToolProgress(operation, {
        stage: outcome.status,
        ...(outcome.error ? { message: operation.error } : {}),
      });
    },
    (error: unknown) => {
      operation.error = (error instanceof Error ? error.message : String(error)).slice(
        0,
        16 * 1024,
      );
      operation.status = "failed";
      appendToolProgress(operation, { stage: "failed", message: operation.error });
    },
  );
  return operation;
}

/**
 * A cancel that arrives before the operation was admitted: the tombstone is
 * the operation, already cancelled, so a start that lands afterwards finds
 * it and never runs the command.
 */
function tombstoneToolOperation(key: string, reason: string): ToolOperation {
  const operation: ToolOperation = {
    status: "cancelled",
    progress: [],
    nextSeq: 1,
    error: `cancelled before it started (${reason})`,
  };
  toolOperations.set(key, operation);
  appendToolProgress(operation, { stage: "cancelled", message: operation.error });
  return operation;
}

function toolOperationReply(
  toolCallId: string,
  operation: ToolOperation,
  after?: number,
): Record<string, unknown> {
  return {
    operationId: toolCallId,
    status: operation.status,
    bootId: supervisorBootId,
    ...(after === undefined
      ? {}
      : { progress: operation.progress.filter((entry) => entry.seq > after) }),
    ...(operation.result ? { result: operation.result } : {}),
    ...(operation.error ? { error: operation.error } : {}),
  };
}

async function openCodeIsHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${openCodeUrl}/api/health`, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${openCodePassword}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { healthy?: boolean };
    return body.healthy === true;
  } catch {
    return false;
  }
}

async function ensureOpenCodeServer(
  workspace?: string,
  runtimeConfig?: RunConfiguration,
  runtimeVariables: Readonly<Record<string, string>> = {},
): Promise<void> {
  const requestedWorkspace = workspace ? resolve(workspace) : undefined;
  const requestedSessionId = runtimeConfig?.sessionId;
  if (
    openCode?.exitCode === null &&
    openCodeWorkspace === requestedWorkspace &&
    openCodeSessionId === requestedSessionId &&
    (await openCodeIsHealthy())
  ) return;
  if (openCodeStartup) await openCodeStartup;
  if (
    openCode?.exitCode === null &&
    openCodeWorkspace === requestedWorkspace &&
    openCodeSessionId === requestedSessionId &&
    (await openCodeIsHealthy())
  ) return;

  openCodeStartup = (async () => {
    if (openCode?.exitCode === null) {
      openCode.kill("SIGKILL");
      await new Promise<void>((done) => openCode?.once("exit", () => done()));
    }
    const workingDirectory = "/tmp/blue-opencode";
    const dataDirectory = resolve(workingDirectory, "data");
    const configDirectory = resolve(workingDirectory, "config");
    await Promise.all([
      mkdir(dataDirectory, { recursive: true }),
      mkdir(configDirectory, { recursive: true }),
    ]);
    const executable = resolve(blueRoot, "node_modules", ".bin", "opencode2");
    const configuredModel = await workspaceModel(requestedWorkspace);
    const startedAt = Date.now();
    const child = spawn(
      executable,
      [
        "serve",
        "--hostname=127.0.0.1",
        `--port=${String(openCodePort)}`,
        "--log-level=warn",
      ],
      {
        cwd: workspace ?? workingDirectory,
        env: sandboxChildEnv({
          ...process.env,
          ...runtimeVariables,
          BLUE_CONNECTIONS_URL: localConnectionsUrl,
          BLUE_CONNECTION_TOKEN: localConnectionToken,
          OPENCOMPUTER_CONNECTIONS_URL: localConnectionsUrl,
          OPENCOMPUTER_CONNECTION_TOKEN: localConnectionToken,
          OPENCOMPUTER_OUTBOX_URL: localOutboxUrl,
          OPENCOMPUTER_OUTBOX_TOKEN: localConnectionToken,
          OPENCOMPUTER_APPROVAL_URL: localApprovalUrl,
          OPENCOMPUTER_APPROVAL_TOKEN: localConnectionToken,
          OPENCODE_PASSWORD: openCodePassword,
          ...(runtimeConfig
            ? {
                OPENAI_API_KEY: runtimeConfig.runtimeToken,
                OPENROUTER_API_KEY: runtimeConfig.runtimeToken,
                ANTHROPIC_API_KEY: runtimeConfig.runtimeToken,
              }
            : {}),
          XDG_CONFIG_HOME: configDirectory,
          XDG_DATA_HOME: dataDirectory,
          OPENCOMPUTER_REACTIVE_MANIFEST_PATH: workspace
            ? resolve(workspace, ".opencomputer", "reactive.json")
            : "",
          OPENCOMPUTER_REACTIVE_SESSION_PATH: resolve(
            "/tmp/blue-runtime",
            "reactive-session.json",
          ),
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...(requestedWorkspace
              ? {
                  plugins: [
                    resolve(
                      blueRoot,
                      "dist",
                      "runtime",
                      "cloud-reactive-plugin.js",
                    ),
                  ],
                  ...(configuredModel ? { model: configuredModel } : {}),
                  ...(runtimeConfig
                    ? {
                        providers: {
                          openrouter: {
                            settings: {
                              baseURL:
                                `${runtimeConfig.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(runtimeConfig.sessionId)}/model-gateway/api/v1`,
                            },
                          },
                          openai: {
                            settings: {
                              baseURL:
                                `${runtimeConfig.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(runtimeConfig.sessionId)}/model-gateway/api/v1`,
                            },
                          },
                          anthropic: {
                            settings: {
                              baseURL:
                                `${runtimeConfig.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(runtimeConfig.sessionId)}/model-gateway/api/v1`,
                            },
                          },
                        },
                      }
                    : {}),
                }
              : { enabled_providers: ["openrouter"] }),
            ...(requestedWorkspace && mcpServers.size
              ? {
                  mcp: Object.fromEntries(
                    [...mcpServers.values()].map((server) => [
                      server.id,
                      {
                        type: "remote",
                        url: server.connection
                          ? `${localConnectionsUrl.replace(/\/connections$/, "")}/mcp/${encodeURIComponent(server.id)}`
                          : server.url,
                        ...(server.connection
                          ? {
                              headers: {
                                authorization: `Bearer ${localConnectionToken}`,
                              },
                            }
                          : {}),
                        oauth: false,
                      },
                    ]),
                  ),
                }
              : {}),
            // Nobody can answer a permission prompt inside a sandbox session,
            // so anything OpenCode would "ask" about (by default: paths
            // outside the workspace, `.env` reads, repeated identical calls)
            // hangs the turn forever. Allow everything; keep the tools that
            // exist only to wait for a human disabled.
            permission: {
              "*": "allow",
              question: "deny",
              plan_enter: "deny",
              plan_exit: "deny",
            },
            autoupdate: false,
            share: "disabled",
          }),
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    openCode = child;
    openCodeWorkspace = requestedWorkspace;
    openCodeSessionId = requestedSessionId;
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    const deadline = Date.now() + 45_000;
    while (!(await openCodeIsHealthy())) {
      if (child.exitCode !== null) {
        throw new Error(
          `Prestarted OpenCode exited before ready: ${String(child.exitCode)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error("Prestarted OpenCode server was not ready within 45s");
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!(await openCodeIsHealthy())) {
      throw new Error("Prestarted OpenCode failed its health check");
    }
    process.stdout.write(
      `managed-agent supervisor: OpenCode ready in ${String(Date.now() - startedAt)}ms\n`,
    );
  })().catch((error: unknown) => {
    if (openCode?.exitCode === null) {
      openCode.kill("SIGKILL");
    }
    openCode = undefined;
    openCodeWorkspace = undefined;
    throw error;
  }).finally(() => {
    openCodeStartup = undefined;
  });

  return openCodeStartup;
}

interface LoadedRuntimeVariables {
  variables: Record<string, string>;
  /** The GitHub installation token among the variables and when it expires; absent without a GitHub connection. */
  github: GitHubCredential | null;
}

/**
 * Bounded retry for hook steps that touch resources which can lag a fresh
 * deployment: the session's access point, the agent artifact object, the
 * edge's runtime-variables route, a just-attached connection. A step whose
 * failure is not flagged non-retryable gets a few short attempts; one
 * flagged with `retryable: false` (a 4xx, a deterministic validation)
 * throws immediately.
 */
async function withTransientRetries<T>(
  run: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 750;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (
        (error as { retryable?: boolean } | null)?.retryable === false ||
        attempt === attempts
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

/** The lifecycle-hook stage a failure belongs to, kept in the error text the platform reads back. */
function hookStageError(
  hook: string,
  stage: string,
  error: unknown,
): Error {
  return new Error(
    `${hook} failed at ${stage}: ` +
      (error instanceof Error ? error.message : String(error)),
  );
}

async function loadRuntimeVariables(
  config: RunConfiguration,
): Promise<LoadedRuntimeVariables> {
  // Throttled, unavailable or timed-out edge answers get a few attempts —
  // right after a deployment registers this route can still be settling.
  // A 4xx (invalid token, missing scope or connection) is terminal.
  const response = await withTransientRetries(async () => {
    const result = await fetch(
      `${config.edge.replace(/\/$/, "")}/v1/sessions/` +
        `${encodeURIComponent(config.sessionId)}/runtime-variables`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${config.runtimeToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!result.ok) {
      throw Object.assign(
        new Error(
          `Runtime variables request returned ${String(result.status)}`,
        ),
        {
          retryable: result.status === 429 || result.status >= 500,
        },
      );
    }
    return result;
  });
  const body = (await response.json()) as { variables?: unknown; github?: unknown };
  if (!body.variables || typeof body.variables !== "object" || Array.isArray(body.variables)) {
    throw new Error("Runtime variables response was invalid");
  }
  const expiresAt =
    body.github && typeof body.github === "object" && !Array.isArray(body.github)
      ? (body.github as { expiresAt?: unknown }).expiresAt
      : undefined;
  if (expiresAt !== undefined && typeof expiresAt !== "string") {
    throw new Error("Runtime variables response was invalid");
  }
  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(body.variables)) {
    if (
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) ||
      /^(OPENCOMPUTER_|BLUE_|OPENCODE_|AWS_|CLOUDFLARE_|LD_|DYLD_)/.test(name) ||
      ["PATH", "NODE_OPTIONS", "NODE_PATH"].includes(name) ||
      typeof value !== "string"
    ) {
      throw new Error("Runtime variables response contained an invalid entry");
    }
    variables[name] = value;
  }
  if (
    Object.keys(variables).length > 128 ||
    Buffer.byteLength(JSON.stringify(variables), "utf8") > 256 * 1024
  ) {
    throw new Error("Runtime variables response exceeded its limits");
  }
  const token = variables.GITHUB_TOKEN;
  // A token without its expiry comes from an edge older than this image. The
  // holder reads an unreadable expiry as already expired, so such a token is
  // refreshed before every command until the edge reports expiries; that is
  // one mint per command, not a computer that cannot start.
  return {
    variables,
    github: token !== undefined ? { token, expiresAt: expiresAt ?? "" } : null,
  };
}

/**
 * Response headers a proxied call is allowed to see.
 *
 * The managed MCP path forwarded these; the general connection path forwarded
 * only `content-type`, which meant an agent speaking MCP over a declared HTTP
 * connection — rather than through `defineMcpServer` — could never read the
 * `mcp-session-id` it is handed at initialize, and so could never make a second
 * call. Both paths proxy the same kind of reply, so both use this list.
 */
function forwardedResponseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of [
    "content-type",
    "cache-control",
    "mcp-session-id",
    "retry-after",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

/**
 * Places the GitHub credential minted with the runtime variables: the token
 * file the Git credential helper reads, the helper itself, and the variables
 * that point Git at it. Later refreshes go through the holder, which the
 * command dispatch consults before each command.
 */
async function configureGitHubGitAuthentication(
  config: RunConfiguration,
  loaded: LoadedRuntimeVariables,
): Promise<void> {
  const holder = new GitHubCredentialHolder({
    directory: "/tmp/blue-runtime",
    refresh: async () => (await loadRuntimeVariables(config)).github,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  Object.assign(loaded.variables, await holder.install(loaded.github));
  gitHubCredential = holder;
}

async function proxyConnectionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  provider: string,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${localConnectionToken}`) {
    json(response, 401, {
      error: { message: "Invalid local connection token" },
    });
    return;
  }
  if (!configuration) {
    json(response, 503, {
      error: { message: "Session connections are not ready" },
    });
    return;
  }

  const body = await readJson(request);
  // Route on what the request is, not on a set that may not be populated on
  // this path yet. A managed-egress call carries a method and a path; a
  // provider action carries a service. Reading the body cannot be defeated by
  // load order, and picking wrong sends the request to a handler that answers
  // "Invalid API request" without ever contacting anything.
  const shaped = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const looksLikeEgress =
    typeof shaped.method === "string" &&
    typeof shaped.path === "string" &&
    typeof shaped.service !== "string";
  const route =
    httpConnectionIds.has(provider) || looksLikeEgress ? "egress" : "connections";
  const target =
    `${configuration.edge.replace(/\/$/, "")}/v1/sessions/` +
    `${encodeURIComponent(configuration.sessionId)}/${route}/` +
    `${encodeURIComponent(provider)}/fetch`;
  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${configuration.runtimeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!upstream.ok) {
    process.stderr.write(
      `managed-agent supervisor: connection ${provider} via ${route} returned ${String(upstream.status)}\n`,
    );
  }
  response.writeHead(upstream.status, forwardedResponseHeaders(upstream));
  if (upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) {
        await new Promise<void>((resolvePromise) =>
          response.once("drain", resolvePromise),
        );
      }
    }
    response.end();
  } else {
    response.end();
  }
}

/**
 * The agent never holds the edge's runtime token: it posts to loopback with a
 * local one, and this swaps it. Same arrangement as connections and outboxes.
 */
async function proxyApprovalRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${localConnectionToken}`) {
    json(response, 401, { error: { message: "Invalid local approval token" } });
    return;
  }
  if (!configuration) {
    json(response, 503, {
      error: { message: "Session approvals are not ready" },
    });
    return;
  }
  const body = await readJson(request);
  const target =
    `${configuration.edge.replace(/\/$/, "")}/v1/sessions/` +
    `${encodeURIComponent(configuration.sessionId)}/approvals`;
  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${configuration.runtimeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  response.end(await upstream.text());
}

async function proxyOutboxRequest(
  request: IncomingMessage,
  response: ServerResponse,
  outboxId: string,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${localConnectionToken}`) {
    json(response, 401, { error: { message: "Invalid local outbox token" } });
    return;
  }
  if (!configuration) {
    json(response, 503, { error: { message: "Session outboxes are not ready" } });
    return;
  }
  const body = await readJson(request);
  const target =
    `${configuration.edge.replace(/\/$/, "")}/v1/sessions/` +
    `${encodeURIComponent(configuration.sessionId)}/outboxes/` +
    `${encodeURIComponent(outboxId)}/items`;
  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${configuration.runtimeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  response.end(await upstream.text());
}

async function proxyMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  serverId: string,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${localConnectionToken}`) {
    json(response, 401, { error: { message: "Invalid local MCP token" } });
    return;
  }
  const server = mcpServers.get(serverId);
  if (!configuration || !server?.connection) {
    json(response, 503, { error: { message: "Managed MCP is not ready" } });
    return;
  }
  const targetUrl = new URL(server.url);
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      name === "authorization" ||
      value === undefined ||
      Array.isArray(value)
    ) {
      continue;
    }
    headers[name] = value;
  }
  const upstream = await fetch(
    `${configuration.edge.replace(/\/$/, "")}/v1/sessions/` +
      `${encodeURIComponent(configuration.sessionId)}/egress/` +
      `${encodeURIComponent(server.connection)}/fetch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${configuration.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: request.method ?? "POST",
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
        ...(body ? { body } : {}),
      }),
    },
  );
  response.writeHead(upstream.status, forwardedResponseHeaders(upstream));
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!response.write(Buffer.from(value))) {
      await new Promise<void>((resolvePromise) =>
        response.once("drain", resolvePromise),
      );
    }
  }
  response.end();
}

function shipRuntimeLog(
  config: RunConfiguration,
  stream: "stdout" | "stderr",
  chunk: Buffer,
): void {
  const entries = chunk
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 100)
    .map((message) => ({
      timestamp: new Date().toISOString(),
      level: stream === "stderr" ? "error" : "info",
      stream,
      message,
    }));
  if (!entries.length) return;
  void fetch(
    `${config.edge.replace(/\/$/, "")}/v1/sessions/` +
      `${encodeURIComponent(config.sessionId)}/runtime-logs`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.runtimeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ entries }),
    },
  ).catch(() => undefined);
}

async function startRuntime(
  config: RunConfiguration,
  lifecycle: "run" | "resume",
): Promise<void> {
  const startedAt = Date.now();
  if (runtime && runtime.exitCode === null) {
    process.stdout.write(
      `${JSON.stringify({
        level: "info",
        event: "runtime.ready",
        sessionId: config.sessionId,
        lifecycle,
        reused: true,
        totalMs: Date.now() - startedAt,
      })}\n`,
    );
    return;
  }
  process.env.BLUE_CONNECTIONS_URL =
    `${config.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(config.sessionId)}/connections`;
  process.env.BLUE_CONNECTION_TOKEN = config.runtimeToken;
  process.env.OPENCOMPUTER_CONNECTIONS_URL =
    process.env.BLUE_CONNECTIONS_URL;
  process.env.OPENCOMPUTER_CONNECTION_TOKEN =
    process.env.BLUE_CONNECTION_TOKEN;
  process.env.OPENCOMPUTER_OUTBOX_URL =
    `${config.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(config.sessionId)}/outboxes`;
  process.env.OPENCOMPUTER_OUTBOX_TOKEN = config.runtimeToken;
  process.env.OPENCOMPUTER_APPROVAL_URL =
    `${config.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(config.sessionId)}/approvals`;
  process.env.OPENCOMPUTER_APPROVAL_TOKEN = config.runtimeToken;
  const loadedVariables = await loadRuntimeVariables(config);
  const runtimeVariables = loadedVariables.variables;
  const workspace = runtimeWorkspace ?? await prepareWorkspace(config);
  runtimeWorkspace = workspace;
  const configuredModel = await workspaceModel(workspace);
  const runtimeWorkingDirectory = "/tmp/blue-runtime";
  await mkdir(runtimeWorkingDirectory, { recursive: true });
  await configureGitHubGitAuthentication(config, loadedVariables);
  const manifestPath = resolve(workspace, ".opencomputer", "reactive.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error(
      "The agent artifact is missing .opencomputer/reactive.json; rebuild it with the current OpenComputer CLI",
    );
  }
  const reactiveManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    httpConnections?: Array<{ id?: unknown }>;
    mcpServerDefinitions?: Array<{
      id?: unknown;
      url?: unknown;
      connection?: unknown;
    }>;
  };
  httpConnectionIds = new Set(
    (reactiveManifest.httpConnections ?? []).flatMap((connection) =>
      typeof connection.id === "string" ? [connection.id] : [],
    ),
  );
  mcpServers = new Map(
    (reactiveManifest.mcpServerDefinitions ?? []).flatMap((server) =>
      typeof server.id === "string" &&
      typeof server.url === "string" &&
      (server.connection === undefined || typeof server.connection === "string")
        ? [[server.id, server as { id: string; url: string; connection?: string }]]
        : [],
    ),
  );
  await writeFile(
    resolve(runtimeWorkingDirectory, "reactive-session.json"),
    `${JSON.stringify({
      projectId: config.projectId,
      deploymentId: config.deploymentId,
      agentId: config.agentId,
      sessionId: config.sessionId,
      edge: config.edge,
      runtimeToken: config.runtimeToken,
    })}\n`,
    { mode: 0o600 },
  );
  await ensureOpenCodeServer(workspace, config, runtimeVariables);
  const runtimePath = resolve(blueRoot, "dist", "runtime", "local-runtime.js");
  const child = spawn(
    process.execPath,
    [
      runtimePath,
      "--edge",
      config.edge,
      "--session",
      config.sessionId,
      "--token",
      config.runtimeToken,
      "--harness",
      "opencode2-reactive",
      "--directory",
      workspace,
      ...(configuredModel ? ["--model", configuredModel] : []),
    ],
    {
      cwd: runtimeWorkingDirectory,
      env: sandboxChildEnv({
        ...process.env,
        ...runtimeVariables,
        PATH: `${resolve(blueRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
        BLUE_OPENCODE_URL: openCodeUrl,
        BLUE_OPENCODE_PASSWORD: openCodePassword,
        // A gated tool's `apply` runs in this process, not in OpenCode, and it
        // reaches its APIs the same way every other tool does. Inheriting the
        // edge URL from `process.env` instead pointed managed egress at an
        // endpoint that speaks a different shape, so `apply` could not make a
        // single outbound call while `preview` — running in OpenCode — could.
        OPENCOMPUTER_CONNECTIONS_URL: localConnectionsUrl,
        OPENCOMPUTER_CONNECTION_TOKEN: localConnectionToken,
        BLUE_CONNECTIONS_URL: localConnectionsUrl,
        BLUE_CONNECTION_TOKEN: localConnectionToken,
        OPENCOMPUTER_OUTBOX_URL: localOutboxUrl,
        OPENCOMPUTER_OUTBOX_TOKEN: localConnectionToken,
        OPENCOMPUTER_APPROVAL_URL: localApprovalUrl,
        OPENCOMPUTER_APPROVAL_TOKEN: localConnectionToken,
        BLUE_OPENCODE_SESSION_PATH: resolve(
          runtimeWorkingDirectory,
          "opencode-session.json",
        ),
        OPENCOMPUTER_REACTIVE_SESSION_PATH: resolve(
          runtimeWorkingDirectory,
          "reactive-session.json",
        ),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  runtime = child;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (!childStdout || !childStderr) {
    throw new Error("OpenCode runtime pipes were not created");
  }
  childStdout.on("data", (chunk: Buffer) => shipRuntimeLog(config, "stdout", chunk));
  childStderr.on("data", (chunk: Buffer) => shipRuntimeLog(config, "stderr", chunk));
  childStderr.pipe(process.stderr);
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("OpenCode runtime did not become ready within 50s"));
    }, 50_000);
    let output = "";
    const cleanup = (): void => {
      clearTimeout(timeout);
      childStdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      process.stdout.write(text);
      output += text;
      if (output.includes("runtime connected:")) {
        cleanup();
        resolvePromise();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`OpenCode runtime exited before ready: ${String(code)}`));
    };
    childStdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  childStdout.pipe(process.stdout);
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event: "runtime.ready",
      sessionId: config.sessionId,
      lifecycle,
      reused: false,
      totalMs: Date.now() - startedAt,
    })}\n`,
  );
}

async function stopRuntime(): Promise<void> {
  const child = runtime;
  runtime = undefined;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

async function stopOpenCode(): Promise<void> {
  const child = openCode;
  openCode = undefined;
  openCodeWorkspace = undefined;
  openCodeSessionId = undefined;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

async function handleHook(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/codex-relay") {
    if (request.method !== "POST") {
      json(response, 405, { message: "Method not allowed" });
      return;
    }
    await relayCodexRequest(request, response);
    return;
  }
  if (path === "/tool-exec") {
    if (request.method !== "POST") {
      json(response, 405, { message: "Method not allowed" });
      return;
    }
    if (!toolSandbox || !runtimeWorkspace) {
      json(response, 409, { message: "MicroVM is not a tool sandbox" });
      return;
    }
    const workspace = runtimeWorkspace;
    const input = await readJson(request);
    if (
      typeof input !== "object" ||
      input === null ||
      !("sessionId" in input) ||
      input.sessionId !== toolSandbox.sessionId ||
      !("generation" in input) ||
      input.generation !== toolSandbox.generation ||
      !("toolCallId" in input) ||
      typeof input.toolCallId !== "string" ||
      !input.toolCallId ||
      !("capability" in input) ||
      (input.capability !== "exec" &&
        input.capability !== "code-tool" &&
        input.capability !== "apply-gated-tool") ||
      !("request" in input) ||
      typeof input.request !== "object" ||
      input.request === null ||
      Array.isArray(input.request)
    ) {
      json(response, 400, { message: "Invalid tool execution request" });
      return;
    }
    const toolRequest = input.request as Record<string, unknown>;
    // The call's host identity travels with the request from the Workerd
    // runtime, which resolved it from the admitted turn; it has to name this
    // sandbox's session and this call, and nothing in `request.input` can
    // stand in for it.
    const toolIdentity =
      input.capability === "exec"
        ? undefined
        : parseToolInvocationIdentity(toolRequest.identity);
    if (
      (input.capability === "exec" &&
        (typeof toolRequest.command !== "string" ||
          !toolRequest.command ||
          toolRequest.command.length > 64 * 1_024 ||
          !Number.isInteger(toolRequest.timeoutSeconds) ||
          Number(toolRequest.timeoutSeconds) < 1 ||
          Number(toolRequest.timeoutSeconds) > COMMAND_TIMEOUT_MAX_SECONDS)) ||
      ((input.capability === "code-tool" ||
        input.capability === "apply-gated-tool") &&
        (typeof toolRequest.toolId !== "string" ||
          !toolRequest.toolId ||
          typeof toolRequest.input !== "object" ||
          toolRequest.input === null ||
          Array.isArray(toolRequest.input) ||
          !toolIdentity ||
          toolIdentity.sessionId !== toolSandbox.sessionId ||
          toolIdentity.toolCallId !== input.toolCallId)) ||
      (input.capability === "apply-gated-tool" &&
        (typeof toolRequest.decision !== "object" ||
          toolRequest.decision === null ||
          Array.isArray(toolRequest.decision) ||
          typeof (toolRequest.decision as Record<string, unknown>).id !==
            "string" ||
          !(toolRequest.decision as Record<string, unknown>).id ||
          typeof (toolRequest.decision as Record<string, unknown>).decidedAt !==
            "string"))
    ) {
      json(response, 400, { message: "Invalid tool execution request" });
      return;
    }
    const resultKey = toolOperationKey(
      toolSandbox.sessionId,
      toolSandbox.generation,
      input.toolCallId,
    );
    const toolCallId = input.toolCallId;
    let toolOperation = toolOperations.get(resultKey);
    if (!toolOperation) {
      toolOperation = startToolOperation(resultKey, async (operation, reportProgress) => {
        // Fixed IPs (work 073): each tool call leaves from the next exit.
        await egressTunnel?.rotate();
        return input.capability === "exec"
          ? executeToolCommand(
              operation,
              `${String(toolSandbox!.generation)}-${createHash("sha256").update(toolCallId).digest("hex").slice(0, 32)}`,
              workspace,
              toolRequest.command as string,
              Number(toolRequest.timeoutSeconds),
              reportProgress,
            )
          : executeCodeTool(
              workspace,
              {
                toolId: toolRequest.toolId as string,
                input: toolRequest.input as Record<string, unknown>,
                identity: toolIdentity!,
                ...(input.capability === "apply-gated-tool"
                  ? {
                      decision: toolRequest.decision as {
                        id: string;
                        decidedAt: string;
                        decidedBy?: string;
                      },
                    }
                  : {}),
              },
              reportProgress,
            );
      });
    }
    // The start reply carries the operation's entries from seq 0 so the
    // follower's first held request can open beyond what it already has —
    // a status roundtrip saved on every command.
    json(response, 202, toolOperationReply(toolCallId, toolOperation, 0));
    return;
  }
  if (path === "/tool-exec/cancel") {
    // Settlement of one operation: terminate its unit if it is running and
    // answer with the recorded outcome. An unknown operation is
    // tombstoned so it can no longer start; the reply says which boot
    // answered, because a tombstone from a later boot says nothing about a
    // command an earlier boot may have left behind.
    if (request.method !== "POST") {
      json(response, 405, { message: "Method not allowed" });
      return;
    }
    if (!toolSandbox) {
      json(response, 409, { message: "MicroVM is not a tool sandbox" });
      return;
    }
    const input = await readJson(request);
    if (
      typeof input !== "object" ||
      input === null ||
      !("sessionId" in input) ||
      input.sessionId !== toolSandbox.sessionId ||
      !("generation" in input) ||
      input.generation !== toolSandbox.generation ||
      !("toolCallId" in input) ||
      typeof input.toolCallId !== "string" ||
      !input.toolCallId
    ) {
      json(response, 400, { message: "Invalid tool operation cancel request" });
      return;
    }
    const reason =
      "reason" in input && typeof input.reason === "string" && input.reason
        ? input.reason.slice(0, 256)
        : "stop";
    const key = toolOperationKey(
      toolSandbox.sessionId,
      toolSandbox.generation,
      input.toolCallId,
    );
    let toolOperation = toolOperations.get(key);
    let found = true;
    if (!toolOperation) {
      found = false;
      toolOperation = tombstoneToolOperation(key, reason);
    } else if (toolOperation.status === "running" && toolOperation.unit) {
      await toolOperation.unit.terminate(reason);
      await toolOperation.settled;
    }
    json(response, 200, {
      ...toolOperationReply(input.toolCallId, toolOperation),
      found,
      // A running code tool has no unit to terminate; the host decides
      // whether to wait for it or retire the computer.
      cancellable: toolOperation.status !== "running",
      // Settlement is the host's call (C4): a terminated unit counts only
      // with verified containment, which the result carries.
      contained: toolOperation.result?.contained === true,
    });
    return;
  }
  if (path === "/tool-exec/status") {
    if (request.method !== "POST") {
      json(response, 405, { message: "Method not allowed" });
      return;
    }
    if (!toolSandbox) {
      json(response, 409, { message: "MicroVM is not a tool sandbox" });
      return;
    }
    const input = await readJson(request);
    if (
      typeof input !== "object" ||
      input === null ||
      !("sessionId" in input) ||
      input.sessionId !== toolSandbox.sessionId ||
      !("generation" in input) ||
      input.generation !== toolSandbox.generation ||
      !("toolCallId" in input) ||
      typeof input.toolCallId !== "string" ||
      !input.toolCallId ||
      !("after" in input) ||
      !Number.isInteger(input.after) ||
      Number(input.after) < 0 ||
      ("waitMs" in input &&
        (!Number.isInteger(input.waitMs) || Number(input.waitMs) < 0))
    ) {
      json(response, 400, { message: "Invalid tool operation status request" });
      return;
    }
    const toolOperation = toolOperations.get(
      toolOperationKey(
        toolSandbox.sessionId,
        toolSandbox.generation,
        input.toolCallId,
      ),
    );
    if (!toolOperation) {
      json(response, 404, {
        message: "Tool operation was not found",
        bootId: supervisorBootId,
      });
      return;
    }
    const after = Number(input.after);
    const waitMs =
      "waitMs" in input
        ? Math.min(Number(input.waitMs), TOOL_STATUS_WAIT_MAX_MS)
        : 0;
    // The long poll: a request that finds nothing new on a running
    // operation holds until the next progress entry — which every status
    // change also produces — or the wait expires. The host re-issues the
    // hold, so an expired wait answering "running" is ordinary. The check
    // and the waiter registration cannot interleave with
    // appendToolProgress: it is synchronous on this thread.
    if (
      waitMs > 0 &&
      toolOperation.status === "running" &&
      !toolOperation.progress.some((entry) => entry.seq > after)
    ) {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const wake = () => {
          // A progress event answers the request; its deadline must not
          // outlive it or a noisy command would pile up dead timers.
          clearTimeout(timer);
          resolve();
        };
        (toolOperation.waiters ??= new Set()).add(wake);
        timer = setTimeout(() => {
          toolOperation.waiters?.delete(wake);
          resolve();
        }, waitMs);
      });
    }
    json(
      response,
      200,
      toolOperationReply(input.toolCallId, toolOperation, after),
    );
    return;
  }
  const mcpMatch = path.match(/^\/mcp\/([^/]+)$/);
  if (mcpMatch) {
    await proxyMcpRequest(request, response, decodeURIComponent(mcpMatch[1]!));
    return;
  }
  const connectionMatch = path.match(/^\/connections\/([^/]+)\/fetch$/);
  if (connectionMatch) {
    if (request.method !== "POST") {
      json(response, 405, { message: "Method not allowed" });
      return;
    }
    await proxyConnectionRequest(
      request,
      response,
      decodeURIComponent(connectionMatch[1]!),
    );
    return;
  }
  if (path === "/approvals") {
    if (request.method !== "POST") {
      json(response, 405, { message: "Method not allowed" });
      return;
    }
    await proxyApprovalRequest(request, response);
    return;
  }
  const outboxMatch = path.match(/^\/outboxes\/([^/]+)\/items$/);
  if (outboxMatch) {
    if (request.method !== "POST") {
      json(response, 405, { message: "Method not allowed" });
      return;
    }
    await proxyOutboxRequest(
      request,
      response,
      decodeURIComponent(outboxMatch[1]!),
    );
    return;
  }
  if (path === "/claim") {
    if (request.method !== "POST") {
      json(response, 405, { message: "Method not allowed" });
      return;
    }
    if (
      !poolClaimToken ||
      request.headers["x-blue-pool-claim-token"] !== poolClaimToken
    ) {
      json(response, 401, { message: "Invalid pool claim token" });
      return;
    }
    if (configuration || (runtime && runtime.exitCode === null)) {
      json(response, 409, { message: "MicroVM is already claimed" });
      return;
    }
    configuration = parseRunConfiguration(await readJson(request));
    poolClaimToken = undefined;
    await startRuntime(configuration, "run");
    json(response, 200, { ready: true, sessionId: configuration.sessionId });
    return;
  }
  if (
    path === "/aws/lambda-microvms/runtime/v1/ready" ||
    path === "/aws/lambda-microvms/runtime/v1/validate"
  ) {
    await ensureOpenCodeServer(runtimeWorkspace);
    json(response, 200, { ready: true });
    return;
  }
  if (path === "/health") {
    // Also the liveness probe's evidence: a tool sandbox answers with the
    // session and generation it was started for, so a probe can tell a
    // reused address from the computer it expects.
    let running = 0;
    for (const candidate of toolOperations.values()) {
      if (candidate.status === "running") running += 1;
    }
    json(response, 200, {
      status: "ok",
      bootId: supervisorBootId,
      runtime: runtime?.exitCode === null ? "running" : "stopped",
      opencode: openCode?.exitCode === null ? "running" : "stopped",
      sessionId: configuration?.sessionId,
      pool: poolClaimToken ? "available" : undefined,
      toolSandbox: toolSandbox ? "ready" : undefined,
      ...(toolSandbox
        ? { generation: toolSandbox.generation, operations: { running } }
        : {}),
    });
    return;
  }
  if (request.method !== "POST") {
    json(response, 405, { message: "Method not allowed" });
    return;
  }

  if (path.endsWith("/run")) {
    const payload = parseRunHookPayload(await readJson(request));
    const toolConfiguration = parseToolSandboxConfiguration(payload);
    if (toolConfiguration) {
      const key = `${toolConfiguration.sessionId}:${String(toolConfiguration.generation)}`;
      // The shim redelivers the hook when its curl times out or its create
      // request is retried: the same session and generation wait for (or
      // reuse) the first delivery instead of failing as already initialized.
      if (toolSandboxInitialization?.key === key) {
        await toolSandboxInitialization.promise;
      } else {
        if (configuration || poolClaimToken || toolSandbox) {
          throw new Error("MicroVM is already initialized");
        }
        const promise = initializeToolSandbox(toolConfiguration);
        toolSandboxInitialization = { key, promise };
        // A failed setup leaves nothing initialized, so a later delivery
        // can try again rather than be refused forever.
        promise.catch(() => {
          if (toolSandboxInitialization?.promise !== promise) return;
          toolSandboxInitialization = undefined;
          toolSandbox = undefined;
          configuration = undefined;
          runtimeWorkspace = undefined;
          httpConnectionIds = new Set();
        });
        await promise;
      }
      json(response, 200, {
        ready: true,
        toolSandbox: true,
        sessionId: toolConfiguration.sessionId,
        generation: toolConfiguration.generation,
      });
      return;
    }
    const warmPool = parseWarmPoolConfiguration(payload);
    if (warmPool) {
      if (configuration || poolClaimToken || toolSandbox) {
        throw new Error("MicroVM is already initialized");
      }
      poolClaimToken = warmPool.claimToken;
      runtimeWorkspace = await prepareWorkspace({
        sessionId: `pool-${warmPool.agentArtifact.digest}`,
        agentArtifact: warmPool.agentArtifact,
      });
      if (
        !(await pathExists(
          resolve(runtimeWorkspace, ".opencomputer", "reactive.json"),
        ))
      ) {
        throw new Error(
          "The agent artifact is missing .opencomputer/reactive.json; rebuild it with the current OpenComputer CLI",
        );
      }
      json(response, 200, { ready: true, pool: "available" });
      return;
    }
    configuration = parseRunConfiguration(payload);
    await startRuntime(configuration, "run");
    json(response, 200, { ready: true });
    return;
  }
  if (path.endsWith("/resume")) {
    if (!configuration) throw new Error("MicroVM has no run configuration");
    await startRuntime(configuration, "resume");
    json(response, 200, { ready: true });
    return;
  }
  if (path.endsWith("/suspend")) {
    await stopRuntime();
    json(response, 200, { stopped: true });
    return;
  }
  if (path.endsWith("/terminate")) {
    await stopRuntime();
    await stopOpenCode();
    json(response, 200, { stopped: true });
    return;
  }
  json(response, 404, { message: "Hook not found" });
}

function isConcurrentDataPlaneRequest(request: IncomingMessage): boolean {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  return (
    path === "/codex-relay" ||
    path === "/tool-exec" ||
    path === "/tool-exec/status" ||
    path === "/tool-exec/cancel" ||
    path === "/health" ||
    path.startsWith("/mcp/") ||
    path.startsWith("/connections/") ||
    path.startsWith("/outboxes/") ||
    path === "/approvals"
  );
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    await handleHook(request, response);
  } catch (error: unknown) {
    process.stderr.write(
      `managed-agent supervisor: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (!response.headersSent) {
      json(response, 500, { message: "Supervisor request failed" });
    } else {
      response.end();
    }
  }
}

/**
 * Requests that arrive through a public tunnel (e.g. a Modal sandbox's
 * encrypted port) carry this bearer; requests from inside the sandbox are
 * loopback and never need it. Only enforced when the platform set the
 * variable — providers without a public listener leave it unset and the
 * check is skipped entirely.
 */
const SUPERVISOR_SANDBOX_TOKEN = process.env.BLUE_SANDBOX_TOKEN ?? "";

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

const server = createServer((request, response) => {
  if (
    SUPERVISOR_SANDBOX_TOKEN &&
    !isLoopback(request) &&
    request.headers["x-sandbox-token"] !== SUPERVISOR_SANDBOX_TOKEN
  ) {
    json(response, 401, { message: "Invalid sandbox token" });
    return;
  }
  if (isConcurrentDataPlaneRequest(request)) {
    void serveRequest(request, response);
    return;
  }
  operation = operation.then(() => serveRequest(request, response));
});

// Fixed IPs (work 073): the tunnel is up before the supervisor reports
// ready, or the supervisor exits; the sandbox reaches nothing else.
const egressTunnel = await startEgressTunnel(process.env).catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "error", event: "supervisor.egress_tunnel_failed", message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(
    `managed-agent supervisor listening on ${String(port)}\n`,
  );
});

async function shutdown(): Promise<void> {
  server.close();
  egressTunnel?.stop();
  await stopRuntime();
  await stopOpenCode();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
