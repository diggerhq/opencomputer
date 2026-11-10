import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { modelRetryDecision } from "./model-retry.js";
import {
  dispatchToolExecution,
  type ToolExecution,
} from "./execution-policy.js";
import {
  durableObjectMemoryClients,
  unboundMemoryClients,
  type MemoryClientFactory,
  type MemoryScope,
} from "./memory-client.js";
import {
  commitResultToolOutput,
  ResultRejectedError,
  sessionResultCommitter,
  type ResultCommitter,
  type ResultToolManifest,
} from "../runtime/session-result.js";

import {
  MEMORY_LIMITS,
  type MemoryBinding,
  type MemoryProjection,
  type MemorySource,
  type SaveResult,
} from "../edge/memory-contract.js";
import {
  memoryToolDescription,
  memoryToolNames,
  memoryToolSchemas,
  memoryToolsOf,
  memoryToolSummaries,
  type MemoryToolName,
} from "../runtime/memory-tools.js";
import {
  COMMAND_TIMEOUT_DEFAULT_SECONDS,
  COMMAND_TIMEOUT_MAX_SECONDS,
} from "../platform/sandbox-adapter.js";
import type {
  AgentDeployment,
  SessionAgentRender,
  SessionIdentity,
  StructuredAgentInput,
  ToolInvocationIdentity,
} from "../protocol.js";
import { hostToolCallId, parseSessionIdentity } from "../tool-identity.js";
import { LOCATION_HINT_HEADER, parseLocationHint } from "../deployment-region.js";
import {
  ASK_TOOL,
  ASK_TOOL_DESCRIPTION,
  ASK_TOOL_INPUT_SCHEMA,
  parseAskInput,
} from "../ask.js";
import {
  CONSULT_TOOL,
  CONSULT_TOOL_DESCRIPTION,
  CONSULT_TOOL_INPUT_SCHEMA,
  parseConsultInput,
} from "../consult.js";
import { renderWorkerSource } from "./render.js";
import { buildArtifactSkillTool } from "./skills.js";
import {
  safeMcpDiagnosticError,
  workerdDatabaseMcpServer,
  workerdMcpServers,
  workerdMcpToolExposure,
  workerdMcpToolIsEnabled,
} from "./mcp.js";
import type { SkillToolDefinition } from "../runtime/skill-tool-core.js";
import { type Latency, latencyTelemetry, requestRegion } from "../edge/latency.js";
import type { Dimensions } from "../computer/telemetry/envelope.js";

interface Env {
  OPENCODE_SESSIONS: DurableObjectNamespace<OpenCodeSessionDurableObject>;
  /** Defaults on; broad unrelated integration suites disable MCP startup. */
  DATABASE_MCP_ENABLED?: string;
  SANDBOX_IDLE_GRACE_MS?: string;
  /**
   * How long past a command's timeout the host waits for the supervisor to
   * report before it treats the outcome as unknown. Tests shorten it.
   */
  SANDBOX_POLL_MARGIN_MS?: string;
  SANDBOX?: Fetcher;
  ARTIFACTS?: Fetcher;
  AGENT_LOADER?: WorkerLoader;
  /** The Memory Durable Object namespace, exported by the edge worker. */
  MEMORY?: DurableObjectNamespace;
  /** Latency spans (work 073); without both nothing is sent. */
  TINYBIRD_API_URL?: string;
  TINYBIRD_APPEND_TOKEN?: string;
  CF_VERSION_METADATA?: { id?: string };
}

/**
 * The managed session's memory grants, sent next to `sandboxContext` on
 * `/session` and `/turn`. Admission chose the object and issued the grants;
 * the host only stores them and presents the session id on every call.
 */
interface MemoryPayload extends MemoryScope {
  bindings: MemoryBinding[];
}

/** A turn's latency spans (work 073), timed from the `/turn` request. */
interface TurnTrace {
  latency: Latency;
  receivedAt: number;
  /** Whether this request constructed OpenCode. */
  booted: boolean;
  /** The managed turn and session the request named. */
  dimensions: Dimensions;
}

interface TurnInput {
  sessionID: string;
  text: string;
  /**
   * The managed turn this execution belongs to. It names the host's turn
   * lease, so a controller that recovers a lost driver learns which turn is
   * still executing here (409 `turn_in_progress`) instead of steering a new
   * prompt into it. Optional for callers without managed turns.
   */
  turnId?: string;
  /**
   * The managed session's typed input for this turn, handed to the agent's
   * `useInput()` as is. Without it the render reconstructs a plain user input
   * from the prompt text.
   */
  agentInput?: StructuredAgentInput;
  sandboxContext?: {
    accountId: string;
    managedSessionId: string;
    edge: string;
    runtimeToken: string;
    /** A session whose workspace the computers mount instead of this session's own — consult inner sessions. */
    sharedWorkspaceSessionId?: string;
  };
  memory?: MemoryPayload;
  /**
   * The session's host-assigned identity, kept with the turn lease so every
   * custom tool call of the turn is stamped from it and the lease's turn,
   * never from what the model passed.
   */
  identity?: SessionIdentity;
}

interface ArtifactBundle {
  version: 1;
  files: Array<{ path: string; content: string }>;
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
  mcpServerDefinitions?: Array<{
    id: string;
    url: string;
    connection?: string;
  }>;
  models?: Array<{ provider: string; model: string }>;
  /** Declared memory resources, sorted by id; `description` is the model-facing guidance for the resource's tools. */
  memory?: MemoryDeclaration[];
  /** The agent's result tool and the output schema its values are validated against before a commit (C1). */
  resultTool?: ResultToolManifest;
}

type MemoryDeclaration = {
  id: string;
  description: string;
  provider:
    | { kind: "document"; maxBytes: number }
    | {
        kind: "http";
        connection: string;
        path: string;
        maxBytes: number;
        tools: Array<{
          name: string;
          description: string;
          access: "read" | "write";
          idempotent: boolean;
          input: Record<string, unknown>;
        }>;
      };
};

interface MemoryBindingRow {
  [key: string]: SqlStorageValue;
  resource: string;
  scope: "document" | "collection";
  document_id: string | null;
  access: "read" | "read-write";
}

interface MemoryContextRow {
  [key: string]: SqlStorageValue;
  object_name: string;
  session_id: string;
}

/**
 * The projection one model request was given for one bound resource. A save
 * from that request is checked against `revision`; tools resolve `memory`
 * against the rows the render `selected`.
 */
interface RequestSnapshotRow {
  [key: string]: SqlStorageValue;
  request_key: string;
  resource: string;
  document_id: string | null;
  revision: string | null;
  projection_json: string;
  cursor: string;
  writable: number;
  selected: number;
}

/** What the render receives for one bound resource; the cursor stays host-private. */
interface RenderedMemory {
  text: string;
  sources: MemorySource[];
  writable: boolean;
}

interface CodeToolMetadata {
  id: string;
  description: string;
  input: Readonly<Record<string, unknown>>;
}

interface ArtifactProjection {
  manifest: ReactiveManifest;
  agent: string;
  api: string;
  modules: Record<string, string>;
  skillTool: SkillToolDefinition | null;
}

interface SandboxToolInput {
  command: string;
  timeoutSeconds?: unknown;
}

/**
 * The computer lease. `starting` while the platform launches generation N;
 * `ready` with a sandbox id and the computer's expiry; `terminating` once
 * termination was requested but the platform has not confirmed it; and
 * `terminated`, confirmed, the tombstone the next generation advances from.
 * A lease in `terminating` is never reused and never advanced: the next
 * acquisition confirms the termination first, so two computers never mount
 * the workspace at once.
 */
interface SandboxLeaseRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  sandbox_id: string | null;
  generation: number;
  state: "starting" | "ready" | "terminating" | "terminated";
  last_used_at: number;
  idle_deadline_at: number | null;
  /** When the platform will end the computer regardless; null when unknown. */
  expires_at: number | null;
  /** 1 when the computer must answer a liveness probe before this turn reuses it. */
  probe_due: number;
  /**
   * Set when the computer must not be reused (C4, rollout compatibility):
   * its supervisor answered in a shape from before the command contract
   * (no boot id, no cancel route) and cannot be verified. The next
   * acquisition retires it with confirmed termination, without a probe.
   */
  retire_reason: string | null;
}

/** The operation ledger's outcomes, as the host learned them. */
type SandboxOperationOutcome =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown"
  | "lost";

/**
 * Time the host keeps free at the end of a computer's life: a command may
 * only be dispatched if it can run to its timeout and still leave this much
 * lifetime for termination and settlement.
 */
const SANDBOX_TERMINATION_RESERVE_MS = 120_000;
/**
 * Retirement reasons whose computer is healthy and only out of time: the
 * platform is asked to preserve its filesystem (a Modal snapshot the next
 * generation starts from). The rest retire a computer in doubt.
 */
const PRESERVED_RETIREMENTS = new Set(["idle", "lifetime"]);
const defaultSandboxPollMarginMs = 60_000;
/**
 * How long one status request may hold inside the computer waiting for
 * progress or a terminal reply (the long poll). A supervisor from before
 * the contract ignores it and answers at once; the follow loop keeps its
 * old cadence for those. Bounded well under the reporting margin.
 */
const SANDBOX_STATUS_WAIT_MS = 15_000;
/** Polling deadline for code tools, which carry no timeout of their own yet. */
const CODE_TOOL_DEADLINE_MS = 10 * 60_000;
const OUTPUT_TAIL_CHARS = 4 * 1024;

interface TurnLeaseRow {
  [key: string]: SqlStorageValue;
  turn_id: string;
  claimed_at: number;
  stop_requested_at: number | null;
  /** The session identity the turn was admitted with; null for a turn admitted without one. */
  identity_json: string | null;
}

interface SandboxContextRow {
  [key: string]: SqlStorageValue;
  account_id: string;
  managed_session_id: string;
  edge: string;
  runtime_token: string;
  shared_workspace_session_id: string;
}

interface ModelGatewayContext {
  baseURL: string;
  token: string;
}

interface RuntimeModelRoute {
  model: string;
  protocol: "anthropic_messages" | "chat_completions" | "responses";
}

function runtimeModelProviderID(modelRoute?: RuntimeModelRoute): string {
  if (!modelRoute) return "custom";
  if (modelRoute.protocol === "responses") return "gateway-responses";
  if (modelRoute.protocol === "anthropic_messages") return "gateway-anthropic";
  return "gateway-chat";
}

interface RuntimeToolDefinition<Input> {
  toolId: string;
  execution?: ToolExecution;
  capability: string;
  sandboxRequest(input: Input): Record<string, unknown>;
  /**
   * The validated command timeout, for tools that run a command. Throws
   * the tool error for an out-of-range value; the call then fails before
   * anything is dispatched.
   */
  commandTimeoutSeconds?(input: Input): number;
  executeEdge?(input: Input): Promise<string> | string;
}

/**
 * What a supervisor's cancel reply settles (C4). `settled` with the
 * operation's outcome; `unverified` when the supervisor answered but the
 * unit's containment was not verified, so retrying the cancel changes
 * nothing and only computer termination resolves it; `pending` when the
 * reply is no evidence at all (still running, or a "not found" that is
 * not from the boot that admitted the operation, or with no boot recorded
 * to compare against).
 */
function settlementOf(
  body: Record<string, unknown>,
  recordedBootId: string | null,
): OperationSettlement {
  const status = body.status;
  const result = isRecord(body.result) ? body.result : undefined;
  if (status !== "completed" && status !== "cancelled" && status !== "failed") {
    return { kind: "pending" };
  }
  // A unit the supervisor killed, on cancellation or at the timeout,
  // whatever status it files that under (the supervisor from before the
  // contract filed a timed-out command as completed): an exited leader
  // says nothing about its descendants, so this settles only with the
  // cgroup's word that the unit is empty. A reply that does not say
  // `contained` is the same as one that says it is not.
  const killed = result?.terminated === true || result?.timedOut === true;
  if (killed && result?.contained !== true) {
    return {
      kind: "unverified",
      reason:
        typeof result?.isolation === "string"
          ? `the unit was terminated under ${result.isolation} isolation without verified containment`
          : "the unit was terminated without verified containment",
    };
  }
  if (status === "completed") return settled("completed", "supervisor");
  if (body.found === false) {
    // A tombstone: the command never started on this boot. That is
    // evidence only from the boot that admitted the operation.
    if (
      recordedBootId === null ||
      typeof body.bootId !== "string" ||
      body.bootId !== recordedBootId
    ) {
      return { kind: "pending" };
    }
    return settled("cancelled", "supervisor");
  }
  if (status === "cancelled") return settled("cancelled", "supervisor");
  return settled(result?.timedOut === true ? "timed_out" : "failed", "supervisor");
}

/**
 * The evidence a settled verdict rests on (C4, one definition of
 * settlement): the supervisor's own reply read by `settlementOf`; a request
 * the host never admitted to the computer; the platform's confirmation
 * that the computer is gone. These three constructors are the only sources
 * of a `settled` verdict, and `recordOperationSettlement` is the only
 * writer of the row's transition, so nothing records an outcome by any
 * other rule.
 */
type SettlementEvidence = "supervisor" | "undispatched" | "computer_terminated";
type OperationSettlement =
  | { kind: "settled"; outcome: SandboxOperationOutcome; evidence: SettlementEvidence }
  | { kind: "unverified"; reason: string }
  | { kind: "pending" };

function settled(outcome: SandboxOperationOutcome, evidence: SettlementEvidence): OperationSettlement {
  return { kind: "settled", outcome, evidence };
}

/** Refused before admission (a 4xx from the computer) or by the stop fence before dispatch: nothing ran. */
function undispatched(outcome: "failed" | "cancelled"): OperationSettlement {
  return settled(outcome, "undispatched");
}

/** The platform confirmed the computer terminated: whatever it still ran is gone with it. */
function lostWithComputer(): OperationSettlement {
  return settled("lost", "computer_terminated");
}

/**
 * A dispatched row from before the ownership columns: no turn, no
 * generation, no supervisor boot. Unverifiable by construction; only the
 * computer's confirmed termination resolves it.
 */
const legacyOperationVerdict: OperationSettlement = {
  kind: "unverified",
  reason:
    "the operation predates the ownership ledger and names no computer or supervisor, so it cannot be verified; only computer termination settles it",
};

/**
 * Following an operation ended without a settlement of the follower's own
 * (C4): the reporting deadline, a status request that failed or answered
 * something unusable, a row another path concluded meanwhile. `reason` is
 * what the cancel that follows is recorded under; `what` is how the model
 * is told, once the verdict is known.
 */
class FollowEnded extends Error {
  constructor(
    readonly reason: string,
    readonly what: string,
  ) {
    super(what);
  }
}

function confirmedOperationEnd(what: string, outcome: SandboxOperationOutcome): string {
  return `${what}; it was ${
    outcome === "completed"
      ? "found completed"
      : outcome === "cancelled"
        ? "cancelled on the computer (confirmed)"
        : `found ${outcome}`
  }. Writes it completed before that remain.`;
}

function unknownOperationEnd(what: string): string {
  return `${what}; its cancellation could not be confirmed, so its outcome is unknown and the computer will not run another command until the operation is confirmed stopped or the computer is replaced. Check the workspace before retrying.`;
}

function unverifiedOperationEnd(what: string, reason: string): string {
  return `${what}; ${reason}, so the operation is not settled and the computer will be terminated and replaced before it runs another command. Writes it completed before that remain. Check the workspace before retrying.`;
}

/** What the model is told when the host stopped following an operation, from the verdict of the cancel that followed. */
function describeOperationEnd(what: string, verdict: OperationSettlement): string {
  if (verdict.kind === "settled") return confirmedOperationEnd(what, verdict.outcome);
  if (verdict.kind === "unverified") return unverifiedOperationEnd(what, verdict.reason);
  return unknownOperationEnd(what);
}

/**
 * A cancel reply as evidence: the supervisor's body under `settlementOf`
 * when it answered; unverified when it has no cancel route at all (a
 * supervisor from before the contract answers 404, and asking again
 * changes nothing); no evidence when it did not answer.
 */
function cancelVerdict(
  reply: { ok: boolean; status: number; body: Record<string, unknown> },
  recordedBootId: string | null,
): OperationSettlement {
  if (reply.ok) return settlementOf(reply.body, recordedBootId);
  if (reply.status === 404) {
    return {
      kind: "unverified",
      reason:
        "the supervisor has no cancel route (an image from before the command contract), so the unit can be neither terminated nor verified through it",
    };
  }
  return { kind: "pending" };
}

function commandTimeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return COMMAND_TIMEOUT_DEFAULT_SECONDS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > COMMAND_TIMEOUT_MAX_SECONDS
  ) {
    throw new Error(
      `timeoutSeconds must be an integer between 1 and ${String(COMMAND_TIMEOUT_MAX_SECONDS)}; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function outputTail(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.length > OUTPUT_TAIL_CHARS
    ? `[${String(value.length - OUTPUT_TAIL_CHARS)} characters omitted]\n${value.slice(-OUTPUT_TAIL_CHARS)}`
    : value;
}

const commandToolSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The shell command to run, as bash -lc would run it, in the session workspace.",
    },
    timeoutSeconds: {
      type: "integer",
      minimum: 1,
      maximum: COMMAND_TIMEOUT_MAX_SECONDS,
      description: `How long the command may run before it is terminated and the call fails. Default ${String(COMMAND_TIMEOUT_DEFAULT_SECONDS)}, at most ${String(COMMAND_TIMEOUT_MAX_SECONDS)}. Set it above the default for installs, builds and test suites.`,
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const defaultSandboxIdleGraceMs = 3 * 60 * 1_000;

const terminalEvents = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/** Spans for a call no request is timing: validated and discarded. */
function untraced(): Latency {
  return latencyTelemetry({}, "workerd", {});
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventSessionID(event: unknown): string | null {
  if (!isRecord(event) || !isRecord(event.data)) return null;
  return typeof event.data.sessionID === "string" ? event.data.sessionID : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** JSON with recursively sorted object keys for a stable request digest. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Text(value: string): Promise<string> {
  return sha256(new TextEncoder().encode(value).buffer as ArrayBuffer);
}

function artifactModulePath(entry: string): string {
  const path = new URL(entry, "https://artifact.invalid/.opencomputer/reactive.json")
    .pathname.slice(1);
  if (!path || path.startsWith(".opencomputer/") || path.split("/").includes("..")) {
    throw new Error(`Invalid artifact module path ${JSON.stringify(entry)}`);
  }
  return path;
}


function isMemoryBinding(value: unknown): value is MemoryBinding {
  if (!isRecord(value) || typeof value.resource !== "string" || !value.resource) {
    return false;
  }
  if (value.scope === "collection") return value.access === "read";
  return (
    value.scope === "document" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.access === "read" || value.access === "read-write")
  );
}

function memoryBindingOf(row: MemoryBindingRow): MemoryBinding {
  return row.scope === "collection"
    ? { resource: row.resource, scope: "collection", access: "read" }
    : {
        resource: row.resource,
        scope: "document",
        id: row.document_id ?? "",
        access: row.access,
      };
}

/** Order-independent identity of a binding set, for the fixed-for-the-session check. */
function memoryBindingsKey(bindings: readonly MemoryBinding[]): string {
  return JSON.stringify(
    bindings
      .map((binding) =>
        binding.scope === "collection"
          ? [binding.resource, "collection", "", "read"]
          : [binding.resource, "document", binding.id, binding.access],
      )
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  );
}

export class OpenCodeSessionDurableObject extends DurableObject<Env> {
  private readonly bootID = crypto.randomUUID();
  private readonly constructedAt = Date.now();
  private activation = 0;
  private openCodeInitMs = 0;
  private readonly initialized: Promise<void>;
  private pendingDeployment?: AgentDeployment;
  private pendingModelGateway?: ModelGatewayContext;
  private pendingModelRoute?: RuntimeModelRoute;
  private pendingSandboxContext?: NonNullable<TurnInput["sandboxContext"]>;
  private opencode?: Promise<OpenCodeWorkerd.Interface>;
  /** Expensive MCP catalog diagnostics run once per Durable Object activation. */
  private mcpExposureLogged = false;
  private projection?: Promise<ArtifactProjection>;
  private codeTools?: Promise<CodeToolMetadata[]>;
  /** The lease decision in flight, whatever it returns; every lease actor waits on it. */
  private sandboxAcquisition?: Promise<unknown>;
  /**
   * The retry the host granted for the model call in flight, by OpenCode
   * session: the attempt number the retry hook turned from OpenCode's
   * decline into a retry (model-retry.ts). One per model call: cleared when
   * a step ends or the execution does, so a continuation of the same call
   * gets no second grant.
   */
  private readonly modelRetryGrants = new Map<string, number>();
  /**
   * The memory client seam. Production binds the `MEMORY` namespace; tests
   * replace this field with a scripted fake, the way they replace
   * `env.SANDBOX`. Resolved per call so a replacement takes effect at once.
   */
  private memory: MemoryClientFactory;
  /**
   * The result commit seam (C1): the committer for the managed session the
   * sandbox context names, over the edge's runtime-authenticated route.
   * Tests replace it with a scripted committer the way they replace
   * `memory`.
   */
  private results: (context: SandboxContextRow) => ResultCommitter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.memory = env.MEMORY
      ? durableObjectMemoryClients(env.MEMORY)
      : unboundMemoryClients();
    this.results = (context) =>
      sessionResultCommitter(
        context.edge,
        context.managed_session_id,
        context.runtime_token,
      );
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      // An object that has hosted a session before carries the platform
      // schema of the code that created it. Bring it up to the current
      // schema before any request runs, so a table added in a later release
      // exists for a session created under an earlier one. A fresh object
      // gets its schema from `/session`, after OpenCode has initialised its
      // own tables. `workerd_deployment` is the marker: it is the first
      // platform table `/session` writes. (OpenCode has no table named
      // `session`; a guard on that name never fired, so restarted objects
      // kept their original schema.)
      if (this.hasPlatformSchema()) this.ensurePlatformSchema();
    });
  }

  private hasPlatformSchema(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workerd_deployment'",
        )
        .toArray().length > 0
    );
  }

  private ensurePlatformSchema(): void {
    this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS workerd_deployment (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          deployment_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_model_route (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          route_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_capability_faults (
          tool_call_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          capability TEXT NOT NULL,
          request_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          requested_at INTEGER,
          resolved_at INTEGER,
          turn_id TEXT,
          generation INTEGER,
          outcome TEXT,
          terminal_result_json TEXT,
          terminal_error TEXT,
          supervisor_boot_id TEXT,
          abandoned_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS workerd_tool_invocations (
          tool_call_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          provider_call_id TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (session_id, turn_id, message_id, provider_call_id)
        );
        CREATE TABLE IF NOT EXISTS workerd_agent_renders (
          render_id TEXT PRIMARY KEY,
          render_json TEXT NOT NULL,
          emitted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS workerd_activation (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          activation INTEGER NOT NULL,
          boot_id TEXT NOT NULL,
          constructed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_turn_state (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          active_turns INTEGER NOT NULL DEFAULT 0,
          alarm_generation INTEGER
        );
        CREATE TABLE IF NOT EXISTS workerd_sandbox_lease (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          session_id TEXT NOT NULL,
          sandbox_id TEXT,
          generation INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('starting', 'ready', 'terminating', 'terminated')),
          last_used_at INTEGER NOT NULL,
          idle_deadline_at INTEGER,
          expires_at INTEGER,
          probe_due INTEGER NOT NULL DEFAULT 0,
          retire_reason TEXT
        );
        CREATE TABLE IF NOT EXISTS workerd_sandbox_context (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          account_id TEXT NOT NULL,
          managed_session_id TEXT NOT NULL,
          edge TEXT NOT NULL DEFAULT '',
          runtime_token TEXT NOT NULL DEFAULT '',
          shared_workspace_session_id TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS workerd_sandbox_deployment (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          deployment_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_memory_context (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          object_name TEXT NOT NULL,
          session_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_memory_bindings (
          resource TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('document', 'collection')),
          document_id TEXT,
          access TEXT NOT NULL CHECK (access IN ('read', 'read-write'))
        );
        CREATE TABLE IF NOT EXISTS workerd_request_snapshot (
          request_key TEXT NOT NULL,
          resource TEXT NOT NULL,
          session_id TEXT NOT NULL,
          document_id TEXT,
          revision TEXT,
          projection_json TEXT NOT NULL,
          cursor TEXT NOT NULL,
          writable INTEGER NOT NULL,
          selected INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (request_key, resource)
        );
        CREATE INDEX IF NOT EXISTS workerd_request_snapshot_session
          ON workerd_request_snapshot (session_id);
        CREATE TABLE IF NOT EXISTS workerd_memory_saved (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          data_json TEXT NOT NULL,
          emitted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS workerd_turn_input (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          input_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workerd_questions (
          call_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          emitted INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, turn_id, call_id)
        );
        CREATE TABLE IF NOT EXISTS workerd_consults (
          call_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          emitted INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, turn_id, call_id)
        );
        CREATE TABLE IF NOT EXISTS workerd_turn_lease (
          opencode_session_id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          claimed_at INTEGER NOT NULL,
          stop_requested_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS workerd_seen_messages (
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          render_id TEXT NOT NULL,
          PRIMARY KEY (session_id, message_id)
        )
    `);
    const sandboxContextColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(workerd_sandbox_context)")
      .toArray();
    if (!sandboxContextColumns.some((column) => column.name === "edge")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE workerd_sandbox_context ADD COLUMN edge TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!sandboxContextColumns.some((column) => column.name === "runtime_token")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE workerd_sandbox_context ADD COLUMN runtime_token TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!sandboxContextColumns.some((column) => column.name === "shared_workspace_session_id")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE workerd_sandbox_context ADD COLUMN shared_workspace_session_id TEXT NOT NULL DEFAULT ''",
      );
    }
    const faultColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(workerd_capability_faults)")
      .toArray();
    for (const [column, definition] of [
      ["turn_id", "TEXT"],
      ["generation", "INTEGER"],
      ["outcome", "TEXT"],
      ["terminal_result_json", "TEXT"],
      ["terminal_error", "TEXT"],
      ["supervisor_boot_id", "TEXT"],
      // Set when the host stopped following the operation without a
      // confirmed settlement (C4, unknown outcomes): the row stays
      // unresolved and fences the computer until a cancel is confirmed or
      // the computer is terminated.
      ["abandoned_at", "INTEGER"],
    ] as const) {
      if (!faultColumns.some((candidate) => candidate.name === column)) {
        this.ctx.storage.sql.exec(
          `ALTER TABLE workerd_capability_faults ADD COLUMN ${column} ${definition}`,
        );
      }
    }
    const turnLeaseColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(workerd_turn_lease)")
      .toArray();
    if (!turnLeaseColumns.some((column) => column.name === "stop_requested_at")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE workerd_turn_lease ADD COLUMN stop_requested_at INTEGER",
      );
    }
    if (!turnLeaseColumns.some((column) => column.name === "identity_json")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE workerd_turn_lease ADD COLUMN identity_json TEXT",
      );
    }
    // The lease table of an older object: `terminated` was not a state and
    // the expiry was not recorded. SQLite cannot widen a CHECK, so the table
    // is rebuilt once, keeping the row. A legacy tombstone (`terminating`
    // with no sandbox id, written when that meant confirmed) becomes
    // `terminated`; a `terminating` row that still names a computer keeps
    // its state so the next acquisition confirms the termination.
    const leaseDefinition = this.ctx.storage.sql
      .exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workerd_sandbox_lease'",
      )
      .toArray()[0]?.sql;
    if (leaseDefinition && !leaseDefinition.includes("'terminated'")) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE workerd_sandbox_lease_next (
          slot INTEGER PRIMARY KEY CHECK (slot = 1),
          session_id TEXT NOT NULL,
          sandbox_id TEXT,
          generation INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('starting', 'ready', 'terminating', 'terminated')),
          last_used_at INTEGER NOT NULL,
          idle_deadline_at INTEGER,
          expires_at INTEGER,
          probe_due INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO workerd_sandbox_lease_next (
          slot, session_id, sandbox_id, generation, state, last_used_at,
          idle_deadline_at, expires_at, probe_due
        )
        SELECT slot, session_id, sandbox_id, generation,
               CASE WHEN state = 'terminating' AND sandbox_id IS NULL
                    THEN 'terminated' ELSE state END,
               last_used_at, idle_deadline_at, NULL, 1
        FROM workerd_sandbox_lease;
        DROP TABLE workerd_sandbox_lease;
        ALTER TABLE workerd_sandbox_lease_next RENAME TO workerd_sandbox_lease;
      `);
    }
    const leaseColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(workerd_sandbox_lease)")
      .toArray();
    if (!leaseColumns.some((column) => column.name === "probe_due")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE workerd_sandbox_lease ADD COLUMN probe_due INTEGER NOT NULL DEFAULT 1",
      );
    }
    if (!leaseColumns.some((column) => column.name === "retire_reason")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE workerd_sandbox_lease ADD COLUMN retire_reason TEXT",
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO workerd_turn_state (
           slot, active_turns, alarm_generation
         ) VALUES (1, 0, NULL)`,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_activation (slot, activation, boot_id, constructed_at)
         VALUES (1, 1, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET
           activation = activation + 1,
           boot_id = excluded.boot_id,
           constructed_at = excluded.constructed_at`,
      this.bootID,
      this.constructedAt,
    );
    this.activation = Number(
      this.ctx.storage.sql
        .exec<{ activation: number }>(
          "SELECT activation FROM workerd_activation WHERE slot = 1",
        )
        .one().activation,
    );
  }

  /** `latency` takes the boot's spans when this call constructs OpenCode. */
  private getOpenCode(latency = untraced()): Promise<OpenCodeWorkerd.Interface> {
    this.opencode ??= (async () => {
      const startedAt = performance.now();
      const projection = await this.artifactProjection(latency);
      const codeTools = await this.codeToolMetadata(latency);
      const deployment = this.deployment();
      const admitted = this.admittedModels(deployment);
      const selected =
        deployment.models?.length === 1
          ? deployment.models[0]!
          : deployment.defaultModel ?? admitted[0]!;
      const modelGateway = this.pendingModelGateway ?? (() => {
        const sandbox = this.requireSandboxContext();
        return {
          baseURL: `${sandbox.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sandbox.managed_session_id)}/model-gateway/api/v1`,
          token: sandbox.runtime_token,
        };
      })();
      const modelRoute = this.runtimeModelRoute();
      const providerID = runtimeModelProviderID(modelRoute);
      const selectedModelID =
        modelRoute?.model ?? this.openRouterModelId(selected);
      const providerPackage = modelRoute
        ? modelRoute.protocol === "responses"
          ? "@opencode-ai/ai/providers/openai/responses"
          : modelRoute.protocol === "anthropic_messages"
            ? "@opencode-ai/ai/providers/anthropic"
            : "@opencode-ai/ai/providers/openai-compatible"
        : "@opencode-ai/ai/providers/openai-compatible";
      const storedSandboxContext = this.hasPlatformSchema()
        ? this.sandboxContext()
        : undefined;
      const managedMcpContext = this.pendingSandboxContext ?? (storedSandboxContext
        ? {
            managedSessionId: storedSandboxContext.managed_session_id,
            edge: storedSandboxContext.edge,
            runtimeToken: storedSandboxContext.runtime_token,
          }
        : undefined);
      const databaseMcpEnabled = this.env.DATABASE_MCP_ENABLED !== "false";
      const mcpServers = managedMcpContext
        ? {
            ...(projection.manifest.mcpServers.length
              ? workerdMcpServers(
                  projection.manifest.mcpServers,
                  projection.manifest.mcpServerDefinitions ?? [],
                  managedMcpContext,
                )
              : {}),
            ...(databaseMcpEnabled
              ? { database: workerdDatabaseMcpServer(managedMcpContext) }
              : {}),
          }
        : {};
      const registeredMcpServers = [
        ...projection.manifest.mcpServers,
        ...(databaseMcpEnabled ? ["database"] : []),
      ];
      const opencode = await latency.time("workerd.opencode_created", () => OpenCodeWorkerd.create({
        storage: this.ctx.storage,
        app: { name: "opencomputer-do-first-spike", version: "dev-19272" },
        models: { fetch: false },
        config: {
          model: `${providerID}/${selectedModelID}`,
          default_agent: "build",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
          agents: {
            build: {
              system: "",
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            },
          },
          providers: {
            [providerID]: {
              package: providerPackage,
              settings: {
                baseURL: modelGateway.baseURL,
                apiKey: modelGateway.token,
                ...(modelRoute?.protocol === "anthropic_messages"
                  ? { authToken: modelGateway.token }
                  : {}),
              },
              models: Object.fromEntries(
                (modelRoute
                  ? [{ provider: "connection", model: modelRoute.model }]
                  : admitted
                ).map((model) => [
                  modelRoute ? model.model : this.openRouterModelId(model),
                  {
                    capabilities: {
                      tools: true,
                      input: ["text"],
                      output: ["text"],
                    },
                  },
                ]),
              ),
            },
          },
          ...(Object.keys(mcpServers).length
            ? { mcp: { servers: mcpServers } }
            : {}),
        },
        plugins: [
          this.runtimePlugin(
            codeTools,
            projection.skillTool,
            registeredMcpServers,
          ),
        ],
      }));
      await latency.time(
        "workerd.opencode_ready",
        async () => {
          await opencode.health.get();
          await this.logMcpStatus(opencode, "startup", Object.keys(mcpServers));
        },
        () => ({ mcp_servers: Object.keys(mcpServers).length }),
      );
      this.openCodeInitMs =
        Math.round((performance.now() - startedAt) * 100) / 100;
      return opencode;
    })();
    return this.opencode;
  }

  private async logMcpStatus(
    opencode: OpenCodeWorkerd.Interface,
    phase: "startup" | "model_context",
    configuredServers: readonly string[],
  ): Promise<void> {
    if (!configuredServers.length) return;
    try {
      const catalog = await opencode.mcp.list();
      console.log(
        JSON.stringify({
          level: "info",
          event: "workerd.mcp_status",
          phase,
          configuredServers: [...configuredServers].sort(),
          servers: catalog.data.map((server) => ({
            name: server.name,
            status: server.status.status,
            ...(server.status.status === "failed"
              ? { error: safeMcpDiagnosticError(server.status.error) }
              : {}),
          })),
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "workerd.mcp_status_failed",
          phase,
          configuredServers: [...configuredServers].sort(),
          error: safeMcpDiagnosticError(message(error)),
        }),
      );
    }
  }

  private deployment(): AgentDeployment {
    if (this.pendingDeployment) return this.pendingDeployment;
    const row = this.ctx.storage.sql
      .exec<{ deployment_json: string }>(
        "SELECT deployment_json FROM workerd_deployment WHERE slot = 1",
      )
      .toArray()[0];
    if (!row) throw new Error("The Workerd session has no pinned deployment");
    return JSON.parse(row.deployment_json) as AgentDeployment;
  }

  /**
   * The account-resolved deployment used only for the lazy computer. Pooled
   * Workerd sessions keep their original deployment immutable because it
   * owns OpenCode's already-admitted model and agent configuration.
   */
  private sandboxDeployment(): AgentDeployment {
    const row = this.ctx.storage.sql
      .exec<{ deployment_json: string }>(
        "SELECT deployment_json FROM workerd_sandbox_deployment WHERE slot = 1",
      )
      .toArray()[0];
    return row
      ? (JSON.parse(row.deployment_json) as AgentDeployment)
      : this.deployment();
  }

  private runtimeModelRoute(): RuntimeModelRoute | undefined {
    if (this.pendingModelRoute) return this.pendingModelRoute;
    if (!this.hasPlatformSchema()) return undefined;
    const row = this.ctx.storage.sql
      .exec<{ route_json: string }>(
        "SELECT route_json FROM workerd_model_route WHERE slot = 1",
      )
      .toArray()[0];
    return row ? (JSON.parse(row.route_json) as RuntimeModelRoute) : undefined;
  }

  private admittedModels(
    deployment = this.deployment(),
  ): Array<{ provider: string; model: string }> {
    const models = [
      ...(deployment.models ?? []),
      ...(deployment.defaultModel ? [deployment.defaultModel] : []),
    ];
    if (!models.length) {
      return [{ provider: "openrouter", model: "anthropic/claude-sonnet-4.6" }];
    }
    return models.filter(
      (model, index) =>
        models.findIndex(
          (candidate) =>
            candidate.provider === model.provider && candidate.model === model.model,
        ) === index,
    );
  }

  private openRouterModelId(model: { provider: string; model: string }): string {
    return model.provider === "openrouter"
      ? model.model
      : `${model.provider}/${model.model}`;
  }

  private async resolveModel(
    model?: { provider: string; model: string },
  ): Promise<{ provider: string; model: string }> {
    const sandbox = this.requireSandboxContext();
    const response = await fetch(
      `${sandbox.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sandbox.managed_session_id)}/models/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandbox.runtime_token}`,
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

  private async initializeManagedSession(
    deployment: AgentDeployment,
    modelGateway: ModelGatewayContext,
    modelRoute?: RuntimeModelRoute,
    sandboxContext?: NonNullable<TurnInput["sandboxContext"]>,
    memory?: unknown,
    latency?: Latency,
  ) {
    this.pendingDeployment = deployment;
    this.pendingModelGateway = modelGateway;
    this.pendingModelRoute = modelRoute;
    this.pendingSandboxContext = sandboxContext;
    const opencode = await this.getOpenCode(latency);
    this.ensurePlatformSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_deployment (slot, deployment_json) VALUES (1, ?)
       ON CONFLICT(slot) DO UPDATE SET deployment_json = excluded.deployment_json`,
      JSON.stringify(deployment),
    );
    if (modelRoute) {
      this.ctx.storage.sql.exec(
        `INSERT INTO workerd_model_route (slot, route_json) VALUES (1, ?)
         ON CONFLICT(slot) DO UPDATE SET route_json = excluded.route_json`,
        JSON.stringify(modelRoute),
      );
    }
    if (sandboxContext) this.pinSandboxContext(sandboxContext);
    this.pendingModelGateway = undefined;
    this.pendingModelRoute = undefined;
    this.pendingSandboxContext = undefined;
    if (memory !== undefined) this.pinMemory(memory);
    const admitted = this.admittedModels(deployment);
    const selected =
      deployment.models?.length === 1
        ? deployment.models[0]!
        : deployment.defaultModel ?? admitted[0]!;
    return opencode.sessions.create({
      agent: "build",
      model: {
        providerID: runtimeModelProviderID(modelRoute),
        id: modelRoute?.model ?? this.openRouterModelId(selected),
      },
      location: { directory: "/workspace" },
    });
  }

  private async artifactFiles(
    deployment: AgentDeployment,
  ): Promise<Map<string, string>> {
    if (!this.env.ARTIFACTS) {
      throw new Error("The private artifact service is not configured");
    }
    const response = await this.env.ARTIFACTS.fetch(
      "https://managed-platform.invalid/v1/artifacts/read",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(deployment.artifact),
      },
    );
    if (!response.ok) {
      throw new Error(`Artifact service returned ${response.status}`);
    }
    if (deployment.artifact.size > 8 * 1024 * 1024) {
      throw new Error("Workerd agent artifacts cannot exceed 8 MiB");
    }
    const bytes = await response.arrayBuffer();
    if (
      bytes.byteLength !== deployment.artifact.size ||
      (await sha256(bytes)) !== deployment.artifact.digest
    ) {
      throw new Error("The Workerd agent artifact failed integrity verification");
    }
    const bundle = JSON.parse(new TextDecoder().decode(bytes)) as ArtifactBundle;
    if (
      bundle.version !== 1 ||
      !Array.isArray(bundle.files) ||
      bundle.files.length > 256
    ) {
      throw new Error("The Workerd agent artifact has an unsupported format");
    }
    const files = new Map<string, string>();
    for (const file of bundle.files) {
      if (
        !file ||
        typeof file.path !== "string" ||
        typeof file.content !== "string" ||
        file.path.startsWith("/") ||
        file.path.split("/").includes("..")
      ) {
        throw new Error("The Workerd agent artifact contains an invalid path");
      }
      files.set(file.path, decodeBase64(file.content));
    }
    return files;
  }

  private artifactProjection(latency = untraced()): Promise<ArtifactProjection> {
    const deployment = this.deployment();
    this.projection ??= (async () => {
      const files = await latency.time(
        "workerd.artifacts_loaded",
        () => this.artifactFiles(deployment),
        (files) => ({ files: files.size, bytes: deployment.artifact.size }),
      );
      const agent = files.get("agent.js");
      const api = files.get("opencomputer-agent.js");
      const manifestSource = files.get(".opencomputer/reactive.json");
      if (!agent || !api || !manifestSource) {
        throw new Error("The deployment is missing its reactive agent files");
      }
      const manifest = JSON.parse(manifestSource) as ReactiveManifest;
      if (manifest.version !== 2 || manifest.entry !== "../agent.js") {
        throw new Error("This Workerd slice requires a version-2 reactive artifact");
      }
      const modules: Record<string, string> = {};
      for (const entry of manifest.toolModules ?? []) {
        const path = artifactModulePath(entry);
        const source = files.get(path);
        if (!source) {
          throw new Error(`The deployment is missing tool module ${JSON.stringify(path)}`);
        }
        modules[path] = source;
      }
      return {
        manifest,
        agent,
        api,
        modules,
        skillTool: buildArtifactSkillTool(files),
      };
    })();
    return this.projection;
  }

  private artifactWorker(projection: ArtifactProjection) {
    if (!this.env.AGENT_LOADER) {
      throw new Error("The Dynamic Worker Loader is not configured");
    }
    const deployment = this.deployment();
    const toolModulePaths = Object.keys(projection.modules).sort();
    return this.env.AGENT_LOADER.get(
      `agent-tools-v2-${deployment.artifact.digest}`,
      async () => ({
        compatibilityDate: "2026-07-24",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "render-worker.js",
        modules: {
          "render-worker.js": {
            js: renderWorkerSource(
              toolModulePaths,
              projection.manifest.tools,
              projection.manifest.gatedTools ?? [],
            ),
          },
          "agent.js": { js: projection.agent },
          "opencomputer-agent.js": { js: projection.api },
          ...Object.fromEntries(
            Object.entries(projection.modules).map(([path, source]) => [
              path,
              { js: source },
            ]),
          ),
        },
        globalOutbound: null,
        limits: { cpuMs: 50, subRequests: 0 },
      }),
    );
  }

  private codeToolMetadata(latency = untraced()): Promise<CodeToolMetadata[]> {
    this.codeTools ??= latency.time("workerd.tools_loaded", async () => {
      const projection = await this.artifactProjection(latency);
      if (Object.keys(projection.modules).length === 0) return [];
      const response = await this.artifactWorker(projection)
        .getEntrypoint()
        .fetch("https://agent.invalid/tools");
      if (!response.ok) {
        throw new Error(`Agent tool metadata returned ${response.status}`);
      }
      const body = (await response.json()) as { tools?: unknown };
      if (!Array.isArray(body.tools)) {
        throw new Error("Agent tool metadata was invalid");
      }
      const tools = body.tools as CodeToolMetadata[];
      if (tools.some((tool) => tool.id === ASK_TOOL)) {
        throw new Error(`The tool id ${JSON.stringify(ASK_TOOL)} is reserved for the platform's ask tool`);
      }
      return tools;
    }, (tools) => ({ tools: tools.length }));
    return this.codeTools;
  }

  /**
   * Recalls every bound resource, renders the agent with the projections in
   * scope, and pins what this model request saw as its request snapshot in
   * the same transaction as the render row. A rejected recall fails the
   * request before inference, whether or not the render would have used it.
   *
   * REQUEST KEY, PENDING S6. The snapshot should be keyed by the assistant
   * messageID so that a retried model request reuses the accepted projection
   * and a tool call finds its snapshot by its own messageID. The pinned
   * OpenCode cohort does not expose messageID in the context hook, so the
   * key is the render id and `currentRequestKey` maps a tool call to the
   * latest render of its session. A retry therefore recalls fresh content;
   * that is the recorded limitation. When SessionContext carries messageID,
   * key the rows by it here and look them up by `context.messageID` in
   * `executeMemoryTool`; nothing else changes.
   *
   * STALE TOOL CALLS, the mitigation until then. Each render records the
   * assistant message ids already present in the context hook's transcript
   * (`transcript.assistantMessageIds`): a message with content before a
   * render was emitted by an earlier request than that render, so a tool
   * call carrying such a `messageID` belongs to an earlier render (after an
   * interrupt and a new turn, for example) and `executeMemoryTool` rejects
   * it as `stale` instead of saving against the latest snapshot. The
   * current request's own assistant message has no content yet and is
   * never in the set; a retried request is only retried before any output
   * started, so it is not in the set either.
   */
  private async renderAgent(
    currentInput: StructuredAgentInput,
    sessionID: string,
    transcript: { assistantMessageIds: readonly string[] } = { assistantMessageIds: [] },
  ): Promise<SessionAgentRender> {
    const projection = await this.artifactProjection();
    const manifest = projection.manifest;
    const worker = this.artifactWorker(projection);
    const bindings = this.memoryBindings();
    const recalled = await this.recallMemory(bindings);
    const memory: Record<string, RenderedMemory> = {};
    for (const [resource, recall] of recalled) {
      memory[resource] = {
        text: recall.text,
        sources: recall.sources,
        writable: recall.writable,
      };
    }
    const response = await worker.getEntrypoint().fetch(
      new Request("https://agent.invalid/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentInput, state: {}, memory }),
      }),
    );
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new Error(
        `Agent render returned ${response.status}` +
          (typeof failure.error === "string" ? `: ${failure.error}` : ""),
      );
    }
    const rendered = (await response.json()) as {
      instructions: string;
      enabledTools: string[];
      enabledSubagents?: string[];
      requiredConnections: string[];
      enabledMcpServers: string[];
      selectedMemory?: string[];
      model?: { provider: string; model: string };
    };
    const selectedMemory = rendered.selectedMemory ?? [];
    const registered = {
      // `ask` and `consult` are harness tools: any agent on this runtime may
      // select them, and no artifact declares them.
      tools: new Set([...manifest.tools, ASK_TOOL, CONSULT_TOOL]),
      connections: new Set(manifest.connections),
      mcpServers: new Set(manifest.mcpServers),
      memory: new Set((manifest.memory ?? []).map((declaration) => declaration.id)),
    };
    if (rendered.enabledSubagents?.length) {
      throw new Error(
        "useSubagent() is removed: agent members of a project are reached with the consult tool",
      );
    }
    for (const [kind, selected] of [
      ["tools", rendered.enabledTools],
      ["connections", rendered.requiredConnections],
      ["mcpServers", rendered.enabledMcpServers],
      ["memory", selectedMemory],
    ] as const) {
      if (selected.some((id) => !registered[kind].has(id))) {
        throw new Error(`Agent selected an unregistered ${kind} resource`);
      }
    }
    const providerTurn =
      Number(
        this.ctx.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM workerd_agent_renders",
          )
          .one().count,
      ) + 1;
    const instructionsBytes = new TextEncoder().encode(rendered.instructions);
    const render: SessionAgentRender = {
      renderId: crypto.randomUUID(),
      responseId: crypto.randomUUID(),
      providerTurn,
      stateVersion: 0,
      instructionsHash: await sha256(instructionsBytes.buffer as ArrayBuffer),
      instructions: rendered.instructions,
      enabledTools: rendered.enabledTools,
      requiredConnections: rendered.requiredConnections,
      enabledMcpServers: rendered.enabledMcpServers,
      input: currentInput,
      tools: [],
      ...(rendered.model ? { model: rendered.model } : {}),
      renderedAt: new Date().toISOString(),
    };
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO workerd_agent_renders (render_id, render_json) VALUES (?, ?)",
        render.renderId,
        JSON.stringify(render),
      );
      for (const messageID of new Set(transcript.assistantMessageIds)) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO workerd_seen_messages (session_id, message_id, render_id)
           VALUES (?, ?, ?)`,
          sessionID,
          messageID,
          render.renderId,
        );
      }
      for (const [resource, recall] of recalled) {
        this.ctx.storage.sql.exec(
          `INSERT INTO workerd_request_snapshot (
             request_key, resource, session_id, document_id, revision,
             projection_json, cursor, writable, selected, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          render.renderId,
          resource,
          sessionID,
          recall.documentId ?? null,
          recall.revision ?? null,
          JSON.stringify(recall),
          recall.cursor,
          recall.writable ? 1 : 0,
          selectedMemory.includes(resource) ? 1 : 0,
          now,
        );
      }
    });
    return render;
  }

  private async recallMemory(
    bindings: readonly MemoryBinding[],
  ): Promise<Map<string, MemoryProjection>> {
    const recalled = new Map<string, MemoryProjection>();
    if (bindings.length === 0) return recalled;
    const client = this.memory(this.requireMemoryScope());
    const outcomes = await Promise.all(
      bindings.map(async (binding) => ({
        binding,
        outcome: await client.recall(binding.resource),
      })),
    );
    for (const { binding, outcome } of outcomes) {
      if (outcome.kind !== "projection") {
        throw new Error(
          `Memory recall for ${JSON.stringify(binding.resource)} was rejected: ${outcome.reason}`,
        );
      }
      recalled.set(binding.resource, outcome.projection);
    }
    return recalled;
  }

  override async fetch(request: Request): Promise<Response> {
    const receivedAt = performance.now();
    // This request's latency spans, sent when it returns or, for a turn, by
    // its stream.
    let traced: Latency | undefined;
    let streaming = false;
    try {
      const url = new URL(request.url);
      await this.initialized;

      if (request.method === "GET" && url.pathname === "/health") {
        const hasDeploymentTable = this.ctx.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workerd_deployment'",
          )
          .toArray().length > 0;
        if (!hasDeploymentTable) {
          return json({ healthy: true, initialized: false });
        }
        const deployment = this.ctx.storage.sql
          .exec("SELECT slot FROM workerd_deployment WHERE slot = 1")
          .toArray()[0];
        if (!deployment) return json({ healthy: true, initialized: false });
        const opencode = await this.getOpenCode();
        return json(await opencode.health.get());
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        const faults = this.ctx.storage.sql
          .exec<{ total: number; requested: number; unresolved: number }>(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN requested_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS requested,
                    COALESCE(SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END), 0) AS unresolved
             FROM workerd_capability_faults`,
          )
          .one();
        const lease = this.sandboxLease();
        const memoryCounts = this.ctx.storage.sql
          .exec<{ bindings: number; snapshots: number; saved: number }>(
            `SELECT (SELECT COUNT(*) FROM workerd_memory_bindings) AS bindings,
                    (SELECT COUNT(*) FROM workerd_request_snapshot) AS snapshots,
                    (SELECT COUNT(*) FROM workerd_memory_saved) AS saved`,
          )
          .one();
        return json({
          capabilityFaults: faults.total,
          runtimeRequests: faults.requested,
          unresolvedFaults: faults.unresolved,
          sandboxLease: lease
            ? {
                state: lease.state,
                generation: lease.generation,
                idleDeadlineAt: lease.idle_deadline_at,
                expiresAt: lease.expires_at,
              }
            : null,
          memory: {
            bindings: memoryCounts.bindings,
            snapshots: memoryCounts.snapshots,
            saved: memoryCounts.saved,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/session") {
        const input = (await request.json()) as {
          deployment?: AgentDeployment;
          sandboxContext?: TurnInput["sandboxContext"];
          modelGateway?: ModelGatewayContext;
          modelRoute?: RuntimeModelRoute;
          memory?: unknown;
        };
        if (!input.deployment) {
          return json({ error: "deployment is required" }, 400);
        }
        const modelGateway = input.modelGateway ?? (input.sandboxContext
          ? {
              baseURL: `${input.sandboxContext.edge.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(input.sandboxContext.managedSessionId)}/model-gateway/api/v1`,
              token: input.sandboxContext.runtimeToken,
            }
          : undefined);
        if (!modelGateway) {
          return json({ error: "modelGateway or sandboxContext is required" }, 400);
        }
        const latency = (traced = this.latency(
          request,
          input.sandboxContext ? { session_key: input.sandboxContext.managedSessionId } : {},
        ));
        const session = await latency.time("workerd.session_created", () =>
          this.initializeManagedSession(
            input.deployment!,
            modelGateway,
            input.modelRoute,
            input.sandboxContext,
            input.memory,
            latency,
          ),
        );
        return Response.json(session, {
          status: 201,
          headers: this.runtimeHeaders(),
        });
      }

      if (request.method === "POST" && url.pathname === "/sandbox-context") {
        const sandboxContext = (await request.json()) as NonNullable<
          TurnInput["sandboxContext"]
        > & { deployment?: AgentDeployment };
        const latency = (traced = this.latency(request, {
          session_key: sandboxContext.managedSessionId,
        }));
        const attached = latency.start("workerd.context_attached");
        const rebooted = this.opencode === undefined;
        if (sandboxContext.deployment) {
          const current = this.deployment();
          const replacement = sandboxContext.deployment;
          if (
            replacement.id !== current.id ||
            replacement.agentId !== current.agentId ||
            replacement.artifact.digest !== current.artifact.digest
          ) {
            return json(
              { error: "sandbox deployment does not match the pooled session" },
              409,
            );
          }
          this.ctx.storage.sql.exec(
            `INSERT INTO workerd_sandbox_deployment (slot, deployment_json)
             VALUES (1, ?)
             ON CONFLICT(slot) DO UPDATE SET deployment_json = excluded.deployment_json`,
            JSON.stringify(replacement),
          );
        }
        this.pinSandboxContext(sandboxContext);
        const opencode = await this.getOpenCode(latency);
        const projection = await this.artifactProjection(latency);
        const context = {
          managedSessionId: sandboxContext.managedSessionId,
          edge: sandboxContext.edge,
          runtimeToken: sandboxContext.runtimeToken,
        };
        const servers = {
          ...(projection.manifest.mcpServers.length
            ? workerdMcpServers(
                projection.manifest.mcpServers,
                projection.manifest.mcpServerDefinitions ?? [],
                context,
              )
            : {}),
          ...(this.env.DATABASE_MCP_ENABLED !== "false"
            ? { database: workerdDatabaseMcpServer(context) }
            : {}),
        };
        const configured = new Set(
          (await opencode.mcp.list()).data.map((server) => server.name),
        );
        for (const [server, config] of Object.entries(servers)) {
          if (!configured.has(server)) {
            await opencode.mcp.add({ server, config });
          }
        }
        await this.logMcpStatus(opencode, "startup", Object.keys(servers));
        attached.end({ data: { rebooted } });
        return json({ configured: true });
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        const body = (await request.json()) as {
          sessionID?: unknown;
          turnId?: unknown;
          reason?: unknown;
        };
        if (typeof body.sessionID !== "string" || !body.sessionID) {
          return json({ error: "sessionID is required" }, 400);
        }
        const outcome = await this.stopTurn(
          body.sessionID,
          typeof body.reason === "string" && body.reason ? body.reason : "stop",
          { turnId: typeof body.turnId === "string" && body.turnId ? body.turnId : null },
        );
        return json(outcome, outcome.settled ? 200 : 409);
      }

      if (request.method === "POST" && url.pathname === "/terminate-computer") {
        const body = (await request.json()) as {
          sessionID?: unknown;
          reason?: unknown;
          turnId?: unknown;
          generation?: unknown;
        };
        if (typeof body.sessionID !== "string" || !body.sessionID) {
          return json({ error: "sessionID is required" }, 400);
        }
        return json(
          await this.terminateComputer(
            typeof body.reason === "string" && body.reason ? body.reason : "stop_unconfirmed",
            {
              sessionID: body.sessionID,
              turnId: typeof body.turnId === "string" && body.turnId ? body.turnId : null,
              generation:
                typeof body.generation === "number" && Number.isInteger(body.generation)
                  ? body.generation
                  : null,
            },
          ),
        );
      }

      if (request.method === "POST" && url.pathname === "/turn") {
        const latency = (traced = this.latency(request, this.latencyDimensions()));
        const booted = this.opencode === undefined;
        const opencode = await this.getOpenCode(latency);
        const body = (await request.json()) as Partial<TurnInput>;
        if (!body.sessionID || !body.text) {
          return json({ error: "sessionID and text are required" }, 400);
        }
        // The execution fence: one live turn per OpenCode session. A lease
        // nobody released (its stream was cancelled with the loop still
        // running, or the object was evicted mid-turn and the loop replays
        // at boot) or a loop OpenCode reports running refuses the prompt
        // before it could be steered into the old execution; the caller
        // interrupts first and retries. Checked after boot so a replayed
        // orphan is visible.
        const live = this.turnLease(body.sessionID);
        if (live) {
          return json({ error: "turn_in_progress", turnId: live.turn_id }, 409);
        }
        if (await this.sessionIsActive(opencode, body.sessionID)) {
          return json({ error: "turn_in_progress", turnId: null }, 409);
        }
        if (body.sandboxContext) {
          this.pinSandboxContext(body.sandboxContext);
        }
        if (body.memory !== undefined) this.pinMemory(body.memory);
        this.pinTurnInput(body.agentInput);
        const turnId =
          typeof body.turnId === "string" && body.turnId ? body.turnId : crypto.randomUUID();
        this.claimTurnLease(body.sessionID, turnId, parseSessionIdentity(body.identity));
        await this.beginTurn();
        streaming = true;
        return this.streamTurn(
          opencode,
          { sessionID: body.sessionID, text: body.text, turnId },
          {
            latency,
            receivedAt,
            booted,
            dimensions: {
              ...(typeof body.turnId === "string" && body.turnId ? { turn_id: body.turnId } : {}),
              ...(body.sandboxContext ? { session_key: body.sandboxContext.managedSessionId } : {}),
            },
          },
        );
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      const errorMessage = message(error);
      console.error(
        JSON.stringify({
          level: "error",
          event: "workerd.request_failed",
          method: request.method,
          path: new URL(request.url).pathname,
          message: errorMessage,
        }),
      );
      return json({ error: errorMessage }, 500);
    } finally {
      if (!streaming) traced?.send(this.ctx);
    }
  }

  /** A latency emitter (work 073) for one request or model call. */
  private latency(request?: Request, base: Dimensions = {}): Latency {
    return latencyTelemetry(this.env, "workerd", base, request && requestRegion(request));
  }

  /**
   * The managed session this object serves, once its context is pinned, and
   * the managed turn `sessionID` is executing, as span dimensions.
   */
  private latencyDimensions(sessionID?: string): Dimensions {
    try {
      if (!this.hasPlatformSchema()) return {};
      const sessionKey = this.sandboxContext()?.managed_session_id;
      const turnId = sessionID === undefined ? undefined : this.turnLease(sessionID)?.turn_id;
      return {
        ...(sessionKey ? { session_key: sessionKey } : {}),
        ...(turnId ? { turn_id: turnId } : {}),
      };
    } catch {
      return {};
    }
  }

  /**
   * Stop one OpenCode session's execution and settle what it dispatched.
   * In order: the fence (`stop_requested_at` on the turn lease, persisted
   * first, so no new computer operation is admitted for the execution),
   * OpenCode's own interrupt of the model loop, then every operation the
   * execution has in flight on the current computer is cancelled through
   * the supervisor and its outcome recorded. `settled` is the acknowledgement
   * the controller waits for: the loop is not running and no operation is
   * left pending. Anything else (a loop still reported running, an operation
   * the supervisor did not confirm, a supervisor that did not answer) is
   * `settled: false` with the pending operation ids, and the controller
   * retries or retires the computer.
   *
   * The stop is for one execution (C4): the turn the caller named, or the
   * live one when it named none. That identity is fixed at entry and
   * conditions everything after every await: the fence is written on that
   * turn's lease only, the sweep covers that turn's operations only, and
   * the release deletes that turn's lease only. A handler that finishes
   * late, after its turn settled and a newer turn took the lease, finds
   * nothing of its own left and touches nothing of the newer turn's; it
   * answers `staleTurn: true`, settled.
   *
   * With a lease still held, OpenCode is booted if it is not running,
   * because its boot-time sweep replays an orphaned turn and that replay
   * must be stopped, not raced. An activation without a lease and without
   * OpenCode has no loop to stop and is not booted just to say so; its
   * operations are still swept.
   */
  private async stopTurn(
    sessionID: string,
    reason: string,
    identity: { turnId: string | null },
  ): Promise<{
    interrupted: boolean;
    active: boolean;
    turnId: string | null;
    staleTurn: boolean;
    generation: number | null;
    operations: { total: number; settled: number; pending: string[]; unverified: string[] };
    settled: boolean;
  }> {
    const entryLease = this.turnLease(sessionID);
    // The execution this stop is for. Immutable from here on.
    const turnId = identity.turnId ?? entryLease?.turn_id ?? null;
    const owns = (lease: { turn_id: string } | undefined): boolean =>
      lease !== undefined && (turnId === null || lease.turn_id === turnId);
    const staleTurn = entryLease !== undefined && !owns(entryLease);
    if (entryLease && owns(entryLease) && !entryLease.stop_requested_at) {
      this.ctx.storage.sql.exec(
        "UPDATE workerd_turn_lease SET stop_requested_at = ? WHERE opencode_session_id = ? AND turn_id = ?",
        Date.now(),
        sessionID,
        entryLease.turn_id,
      );
    }
    const fenced = this.turnLease(sessionID);
    const fenceAt = (owns(fenced) ? fenced?.stop_requested_at : null) ?? Date.now();
    let interrupted = false;
    let active = false;
    let opencode: OpenCodeWorkerd.Interface | undefined;
    if (!staleTurn && (this.opencode || entryLease)) {
      // The loop is this turn's (or nobody's): interrupt it. A newer
      // turn's loop is never interrupted by an older turn's stop.
      opencode = await this.getOpenCode();
      const result = await opencode.sessions.interrupt({ sessionID });
      interrupted = result.interrupted;
      active = await this.sessionIsActive(opencode, sessionID);
    }
    const operations = await this.settleOperations(sessionID, reason, fenceAt, turnId, {
      // Rows from before the ownership ledger belong to no turn; a live
      // turn's stop takes them on, a stale stop leaves them to the turn
      // that holds the computer now.
      legacy: staleTurn ? "excluded" : "included",
    });
    if (active && opencode) {
      // The loop winds down once its cancelled tool call has returned;
      // give it a moment before reporting it still running. If meanwhile
      // the lease passed to another turn, the loop reported is that
      // turn's, not the one being stopped.
      const deadline = Date.now() + 3_000;
      while (active && Date.now() < deadline && owns(this.turnLease(sessionID))) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        active = await this.sessionIsActive(opencode, sessionID);
      }
      if (!owns(this.turnLease(sessionID))) active = false;
    }
    const settled = !active && operations.pending.length === 0;
    if (settled && turnId !== null) this.releaseTurnLease(sessionID, turnId);
    const generation = this.sandboxLease()?.generation ?? null;
    console.log(
      JSON.stringify({
        level: "info",
        event: "workerd.turn_stopped",
        sessionID,
        turnId,
        staleTurn,
        reason,
        interrupted,
        active,
        generation,
        operations,
        settled,
      }),
    );
    return { interrupted, active, turnId, staleTurn, generation, operations, settled };
  }

  /**
   * Cancels every operation of the OpenCode session still in flight and
   * records what the supervisor said. An operation on a generation that is
   * no longer the current computer is lost with that computer. What
   * settles an operation (C4): a completion; a failure or cancellation of a
   * unit whose containment the supervisor verified (the cgroup confirmed
   * empty); a "not found" from the very supervisor boot that admitted the
   * operation, meaning the command never started (the tombstone keeps it
   * that way). A terminated unit without verified containment (a process
   * group only, or a cgroup wait that expired) is not settled: it is
   * reported pending and `unverified`, and only computer termination
   * resolves it. A "not found" with no recorded boot, or from another
   * boot, is not evidence of anything. A reply that did not come is not a
   * settlement.
   *
   * The count is the operations in flight when the stop was requested
   * (`fenceAt`), so a retried stop reports the same total and what is
   * still pending, not zero because an earlier attempt already settled them.
   *
   * A dispatched row with no generation predates the ownership columns
   * (C4, rollout compatibility): it names no turn, no computer and no
   * supervisor boot, so nothing can be asked about it and nothing is
   * guessed. When in scope it is reported unverified, which escalates the
   * stop to computer termination; the confirmed termination resolves it.
   */
  private async settleOperations(
    sessionID: string,
    reason: string,
    fenceAt: number,
    /** The turn whose operations are swept; null sweeps every operation of the session. */
    turnId: string | null,
    options: { legacy: "included" | "excluded" },
  ): Promise<{ total: number; settled: number; pending: string[]; unverified: string[] }> {
    const scope =
      turnId === null
        ? ""
        : options.legacy === "included"
          ? " AND (turn_id = ? OR generation IS NULL)"
          : " AND turn_id = ?";
    const scopeArgs = turnId === null ? [] : [turnId];
    const inFlightAtFence = this.ctx.storage.sql
      .exec<{ tool_call_id: string }>(
        `SELECT tool_call_id
         FROM workerd_capability_faults
         WHERE session_id = ? AND requested_at IS NOT NULL
           AND (resolved_at IS NULL OR resolved_at >= ?)${scope}
         ORDER BY created_at`,
        sessionID,
        fenceAt,
        ...scopeArgs,
      )
      .toArray().length;
    const inFlight = this.ctx.storage.sql
      .exec<{ tool_call_id: string; generation: number | null; supervisor_boot_id: string | null }>(
        `SELECT tool_call_id, generation, supervisor_boot_id
         FROM workerd_capability_faults
         WHERE session_id = ? AND requested_at IS NOT NULL AND resolved_at IS NULL${scope}
         ORDER BY created_at`,
        sessionID,
        ...scopeArgs,
      )
      .toArray();
    const lease = this.sandboxLease();
    const managedSessionId = this.sandboxContext()?.managed_session_id;
    const outcomes = await Promise.all(
      inFlight.map(async (operation): Promise<"settled" | "pending" | "unverified"> => {
        if (operation.generation === null) {
          this.recordOperationSettlement(operation.tool_call_id, legacyOperationVerdict, {
            generation: null,
            reason,
            following: "stopped",
          });
          return "unverified";
        }
        if (
          !lease ||
          lease.state !== "ready" ||
          operation.generation !== lease.generation ||
          managedSessionId === undefined
        ) {
          // Not on the current computer: the computer that ran it is gone
          // or being confirmed gone, and its processes with it.
          if (lease?.state === "terminating" && operation.generation === lease.generation) {
            return "pending";
          }
          this.recordOperationSettlement(operation.tool_call_id, lostWithComputer(), {
            generation: operation.generation,
            reason,
            following: "continues",
          });
          return "settled";
        }
        const reply = await this.cancelSandboxOperation(
          managedSessionId,
          lease,
          operation.tool_call_id,
          reason,
        );
        const verdict = cancelVerdict(reply, operation.supervisor_boot_id);
        // The follower of this operation, if one is polling, sees the
        // row's transition and stops; a pending verdict leaves it following.
        this.recordOperationSettlement(operation.tool_call_id, verdict, {
          generation: lease.generation,
          reason,
          following: "continues",
        });
        return verdict.kind;
      }),
    );
    const pending = inFlight
      .filter((_operation, index) => outcomes[index] !== "settled")
      .map((operation) => operation.tool_call_id);
    const unverified = inFlight
      .filter((_operation, index) => outcomes[index] === "unverified")
      .map((operation) => operation.tool_call_id);
    const total = Math.max(inFlightAtFence, inFlight.length);
    return { total, settled: total - pending.length, pending, unverified };
  }

  /**
   * The fallback when settlement cannot be confirmed: the current computer
   * is terminated through the platform and the termination confirmed, which
   * is what lets another computer mount the workspace. Every operation the
   * generation still had in flight is recorded lost. Idempotent: a lease
   * already terminated answers as such.
   *
   * Conditioned on the stop's identity (C4): a termination asked for a
   * computer generation that is no longer current concerns a computer
   * already confirmed gone (generations advance only after confirmed
   * termination) and answers `alreadyTerminated` without touching the
   * current one; one asked for a turn while a newer turn holds the lease
   * is refused, because the computer is that turn's now.
   */
  private terminateComputer(
    reason: string,
    identity: { sessionID: string; turnId: string | null; generation: number | null },
  ): Promise<{
    terminated: boolean;
    generation: number | null;
    sandboxId: string | null;
    alreadyTerminated: boolean;
  }> {
    return this.acquire("", async () => {
      const lease = this.sandboxLease();
      if (!lease || lease.state === "terminated") {
        return {
          terminated: true,
          generation: lease?.generation ?? null,
          sandboxId: null,
          alreadyTerminated: true,
        };
      }
      if (identity.generation !== null && lease.generation !== identity.generation) {
        return {
          terminated: true,
          generation: identity.generation,
          sandboxId: null,
          alreadyTerminated: true,
        };
      }
      const live = this.turnLease(identity.sessionID);
      if (identity.turnId !== null && live && live.turn_id !== identity.turnId) {
        throw new Error(
          `The computer is serving turn ${live.turn_id}; a termination for the stop of turn ${identity.turnId} is refused`,
        );
      }
      if (lease.state === "starting") {
        throw new Error("The computer is still being acquired; retry the termination");
      }
      const sandboxId = lease.sandbox_id;
      await this.retireLease(lease, reason);
      return { terminated: true, generation: lease.generation, sandboxId, alreadyTerminated: false };
    });
  }
  /** Whether OpenCode reports the session's loop as running right now. */
  private async sessionIsActive(
    opencode: OpenCodeWorkerd.Interface,
    sessionID: string,
  ): Promise<boolean> {
    const active = await opencode.sessions.active();
    return Object.prototype.hasOwnProperty.call(active, sessionID);
  }

  /**
   * The host's turn lease: one live execution per OpenCode session, claimed
   * before the prompt is admitted and released only by the loop's own
   * terminal event for that session or by `/stop`. A cancelled stream
   * does not release it; the loop it observed may still be running.
   * `stop_requested_at` is the fence: once set, no new computer operation
   * is admitted for the execution, whatever the loop still asks for.
   */
  private turnLease(sessionID: string): TurnLeaseRow | undefined {
    return this.ctx.storage.sql
      .exec<TurnLeaseRow>(
        "SELECT turn_id, claimed_at, stop_requested_at, identity_json FROM workerd_turn_lease WHERE opencode_session_id = ?",
        sessionID,
      )
      .toArray()[0];
  }

  private claimTurnLease(
    sessionID: string,
    turnId: string,
    identity: SessionIdentity | undefined,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_turn_lease (opencode_session_id, turn_id, claimed_at, identity_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(opencode_session_id) DO UPDATE SET
         turn_id = excluded.turn_id, claimed_at = excluded.claimed_at,
         identity_json = excluded.identity_json`,
      sessionID,
      turnId,
      Date.now(),
      identity ? JSON.stringify(identity) : null,
    );
  }

  /**
   * The host identity of a custom tool call: the session part the turn was
   * admitted with, the lease's turn, the assistant message OpenCode reports
   * for the call and the call's id. Refused rather than guessed when the
   * turn carries no identity, so a call is never attributed to a session
   * the host did not name.
   */
  private async toolInvocationIdentity(
    sessionID: string,
    providerCallID: string,
    messageId: string,
    logicalRequest: unknown,
  ): Promise<ToolInvocationIdentity> {
    const lease = this.turnLease(sessionID);
    if (!lease) {
      throw new Error(
        "The tool call was refused: no managed turn was running when this call was dispatched",
      );
    }
    const session = lease.identity_json
      ? parseSessionIdentity(JSON.parse(lease.identity_json))
      : undefined;
    if (!session) {
      throw new Error(
        "The tool call was refused: the running turn was admitted without a host identity",
      );
    }
    const inputDigest = await sha256Text(canonicalJson(logicalRequest));
    const toolCallId = hostToolCallId({
      sessionId: session.sessionId,
      turnId: lease.turn_id,
      messageId,
      providerCallId: providerCallID,
    });
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO workerd_tool_invocations (
         tool_call_id, session_id, turn_id, message_id, provider_call_id, input_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      toolCallId,
      session.sessionId,
      lease.turn_id,
      messageId,
      providerCallID,
      inputDigest,
      Date.now(),
    );
    const invocation = this.ctx.storage.sql
      .exec<{ tool_call_id: string; input_digest: string }>(
        `SELECT tool_call_id, input_digest FROM workerd_tool_invocations
         WHERE session_id = ? AND turn_id = ? AND message_id = ? AND provider_call_id = ?`,
        session.sessionId,
        lease.turn_id,
        messageId,
        providerCallID,
      )
      .one();
    if (invocation.input_digest !== inputDigest) {
      throw new Error(
        `Tool call ${JSON.stringify(providerCallID)} conflicts with an earlier call under the same turn and message because its input changed`,
      );
    }
    return {
      ...session,
      turnId: lease.turn_id,
      messageId,
      toolCallId: invocation.tool_call_id,
      providerCallId: providerCallID,
    };
  }

  private releaseTurnLease(sessionID: string, turnId?: string): void {
    if (turnId === undefined) {
      this.ctx.storage.sql.exec(
        "DELETE FROM workerd_turn_lease WHERE opencode_session_id = ?",
        sessionID,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM workerd_turn_lease WHERE opencode_session_id = ? AND turn_id = ?",
      sessionID,
      turnId,
    );
  }

  private streamTurn(
    opencode: OpenCodeWorkerd.Interface,
    input: TurnInput,
    trace?: TurnTrace,
  ): Response {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    const events = opencode.events.subscribe({ signal: abort.signal })[
      Symbol.asyncIterator
    ]();
    const host = this;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (value: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        };
        const sendHostEvents = () => host.drainHostEvents(send);
        const sinceReceived = () => (trace ? performance.now() - trace.receivedAt : 0);
        let awaitingDelta = trace !== undefined;

        try {
          let next = events.next();
          let admitted;
          try {
            admitted = await opencode.sessions.prompt({
              sessionID: input.sessionID,
              text: input.text,
            });
          } catch (error) {
            // Nothing started: the lease claimed for this prompt is free.
            if (input.turnId) host.releaseTurnLease(input.sessionID, input.turnId);
            trace?.latency.emit("workerd.turn_started", {
              ...trace.dimensions,
              duration_ms: sinceReceived(),
              outcome: "failed",
              data: { booted: trace.booted },
            });
            throw error;
          }
          trace?.latency.emit("workerd.turn_started", {
            ...trace.dimensions,
            duration_ms: sinceReceived(),
            data: { booted: trace.booted },
          });
          send({ type: "turn.admitted", data: admitted });

          while (true) {
            const item = await next;
            if (item.done) break;
            next = events.next();
            if (eventSessionID(item.value) !== input.sessionID) continue;
            if (trace && awaitingDelta && item.value.type === "session.text.delta") {
              awaitingDelta = false;
              trace.latency.emit("workerd.first_delta", {
                ...trace.dimensions,
                duration_ms: sinceReceived(),
              });
              trace.latency.send(host.ctx);
            }
            sendHostEvents();
            send(host.forwardedEvent(input.sessionID, item.value));
            await host.interruptAfterAsk(opencode, input, item.value);
            await host.interruptAfterConsult(opencode, input, item.value);
            if (terminalEvents.has(item.value.type)) {
              // The loop's own word that this execution is over.
              if (input.turnId) host.releaseTurnLease(input.sessionID, input.turnId);
              break;
            }
          }
        } catch (error) {
          send({ type: "stream.error", data: { message: message(error) } });
        } finally {
          abort.abort();
          trace?.latency.send(host.ctx);
          await host.finishTurn();
          controller.close();
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        ...this.runtimeHeaders(),
      },
    });
  }

  /**
   * An OpenCode event as the session sees it. A retry the host granted
   * (model-retry.ts) is marked on its `session.retry.scheduled` frame, so
   * the session can say whether a retry was OpenCode's own or the host's;
   * the grant is spent when the step ends or the execution does.
   */
  private forwardedEvent(sessionID: string, event: { type: string; data?: unknown }): unknown {
    if (event.type === "session.step.ended" || terminalEvents.has(event.type)) {
      this.modelRetryGrants.delete(sessionID);
      return event;
    }
    if (event.type !== "session.retry.scheduled") return event;
    const data = event.data;
    const granted = this.modelRetryGrants.get(sessionID);
    if (
      granted === undefined ||
      typeof data !== "object" ||
      data === null ||
      (data as { attempt?: unknown }).attempt !== granted
    ) {
      return event;
    }
    return { ...event, data: { ...(data as Record<string, unknown>), hostGranted: true } };
  }

  /**
   * Host events ride the turn stream between OpenCode's own events. Each is
   * persisted before it is emitted and marked emitted once sent, so a host
   * that dies mid-turn re-sends what it had not yet marked. That is the
   * whole guarantee: C7's saved event is best-effort (observed success, no
   * delivery guarantee), and a consumer may still see an event twice or
   * not at all when the stream itself is lost.
   */
  private drainHostEvents(send: (value: unknown) => void): void {
    const renders = this.ctx.storage.sql
      .exec<{ render_id: string; render_json: string }>(
        "SELECT render_id, render_json FROM workerd_agent_renders WHERE emitted = 0 ORDER BY rowid",
      )
      .toArray();
    for (const render of renders) {
      send({
        type: "opencomputer.agent.rendered",
        data: JSON.parse(render.render_json),
      });
      this.ctx.storage.sql.exec(
        "UPDATE workerd_agent_renders SET emitted = 1 WHERE render_id = ?",
        render.render_id,
      );
    }
    const saved = this.ctx.storage.sql
      .exec<{ seq: number; data_json: string }>(
        "SELECT seq, data_json FROM workerd_memory_saved WHERE emitted = 0 ORDER BY seq",
      )
      .toArray();
    for (const row of saved) {
      send({
        type: "opencomputer.memory.saved",
        data: JSON.parse(row.data_json),
      });
      this.ctx.storage.sql.exec(
        "UPDATE workerd_memory_saved SET emitted = 1 WHERE seq = ?",
        row.seq,
      );
    }
    // `ask` calls (design 018): the question rides ahead of the call's own
    // completion, so the session holds it when the loop ends.
    const questions = this.ctx.storage.sql
      .exec<{ session_id: string; turn_id: string; call_id: string; data_json: string }>(
        `SELECT session_id, turn_id, call_id, data_json FROM workerd_questions
         WHERE emitted = 0 ORDER BY created_at, rowid`,
      )
      .toArray();
    for (const row of questions) {
      send({
        type: "opencomputer.question.asked",
        data: { ...(JSON.parse(row.data_json) as Record<string, unknown>), callId: row.call_id },
      });
      this.ctx.storage.sql.exec(
        `UPDATE workerd_questions SET emitted = 1
         WHERE session_id = ? AND turn_id = ? AND call_id = ?`,
        row.session_id,
        row.turn_id,
        row.call_id,
      );
    }
    // `consult` calls (project sessions): like `ask`, the consultation rides
    // ahead of the call's own completion, so the session holds it when the
    // loop ends.
    const consults = this.ctx.storage.sql
      .exec<{ session_id: string; turn_id: string; call_id: string; data_json: string }>(
        `SELECT session_id, turn_id, call_id, data_json FROM workerd_consults
         WHERE emitted = 0 ORDER BY created_at, rowid`,
      )
      .toArray();
    for (const row of consults) {
      send({
        type: "opencomputer.agent.consulted",
        data: { ...(JSON.parse(row.data_json) as Record<string, unknown>), callId: row.call_id },
      });
      this.ctx.storage.sql.exec(
        `UPDATE workerd_consults SET emitted = 1
         WHERE session_id = ? AND turn_id = ? AND call_id = ?`,
        row.session_id,
        row.turn_id,
        row.call_id,
      );
    }
  }

  /**
   * Records an `ask` call for the running turn and answers the model at
   * once. The call never ends the turn itself: the stream sees the call's
   * completion and interrupts the loop (`interruptAfterAsk`), and the
   * session settles the turn as completed with outcome `question`.
   */
  private executeAskTool(
    rawInput: unknown,
    context: { sessionID: string; messageID: string; id: string },
  ): { content: string; metadata: Record<string, unknown> } {
    const parsed = parseAskInput(rawInput);
    if (!parsed.ok) throw new Error(parsed.message);
    const lease = this.turnLease(context.sessionID);
    if (!lease) {
      throw new Error("ask was refused: no managed turn was running when it was called");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_questions (call_id, session_id, turn_id, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_id, call_id) DO NOTHING`,
      context.id,
      context.sessionID,
      lease.turn_id,
      JSON.stringify(parsed.input),
      Date.now(),
    );
    return {
      content:
        "The question is recorded and this turn ends now. Do not call other tools or write more; the answer arrives as the next input.",
      metadata: { tool: ASK_TOOL, messageID: context.messageID, options: parsed.input.options.length },
    };
  }

  /**
   * After a frame was forwarded: when it is the completion of this turn's
   * `ask` call, ends the loop the way `stopTurn` does (the computer fence,
   * then OpenCode's interrupt). Never from inside the tool's own execute.
   * The loop then reports `session.execution.interrupted`, which the
   * session reads as the end of a turn that asked.
   */
  private async interruptAfterAsk(
    opencode: OpenCodeWorkerd.Interface,
    input: TurnInput,
    event: { type: string; data?: unknown },
  ): Promise<void> {
    if (event.type !== "session.tool.success" || !input.turnId) return;
    const callId = isRecord(event.data) && typeof event.data.id === "string" ? event.data.id : undefined;
    if (!callId) return;
    const asked = this.ctx.storage.sql
      .exec<{ call_id: string }>(
        `SELECT call_id FROM workerd_questions
         WHERE session_id = ? AND turn_id = ? AND call_id = ?`,
        input.sessionID,
        input.turnId,
        callId,
      )
      .toArray()[0];
    if (!asked) return;
    const lease = this.turnLease(input.sessionID);
    if (lease?.turn_id === input.turnId && !lease.stop_requested_at) {
      this.ctx.storage.sql.exec(
        "UPDATE workerd_turn_lease SET stop_requested_at = ? WHERE opencode_session_id = ? AND turn_id = ?",
        Date.now(),
        input.sessionID,
        input.turnId,
      );
    }
    try {
      await opencode.sessions.interrupt({ sessionID: input.sessionID });
    } catch (error) {
      // The turn still ends with its question: the session settles it as
      // asked on whichever terminal event the loop reports.
      console.error(
        JSON.stringify({
          level: "error",
          event: "workerd.ask_interrupt_failed",
          sessionID: input.sessionID,
          turnId: input.turnId,
          message: message(error),
        }),
      );
    }
    console.log(
      JSON.stringify({
        level: "info",
        event: "workerd.ask_interrupted",
        sessionID: input.sessionID,
        turnId: input.turnId,
        callId,
      }),
    );
  }

  /**
   * Records a `consult` call for the running turn and answers the model at
   * once, exactly as `ask` does: the stream sees the call's completion and
   * interrupts the loop (`interruptAfterConsult`), and the session settles
   * the turn as completed with outcome `question` while it dispatches the
   * consultation to the member agent's own session.
   */
  private executeConsultTool(
    rawInput: unknown,
    context: { sessionID: string; messageID: string; id: string },
  ): { content: string; metadata: Record<string, unknown> } {
    const parsed = parseConsultInput(rawInput);
    if (!parsed.ok) throw new Error(parsed.message);
    const lease = this.turnLease(context.sessionID);
    if (!lease) {
      throw new Error("consult was refused: no managed turn was running when it was called");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_consults (call_id, session_id, turn_id, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_id, call_id) DO NOTHING`,
      context.id,
      context.sessionID,
      lease.turn_id,
      JSON.stringify(parsed.input),
      Date.now(),
    );
    return {
      content:
        "The consultation is recorded and this turn ends now. Do not call other tools or write more; the agent's answer arrives as the next input.",
      metadata: { tool: CONSULT_TOOL, messageID: context.messageID, agent: parsed.input.agent },
    };
  }

  /**
   * After a frame was forwarded: when it is the completion of this turn's
   * `consult` call, ends the loop the way `interruptAfterAsk` does. The
   * session reads the report as the end of a turn that consulted.
   */
  private async interruptAfterConsult(
    opencode: OpenCodeWorkerd.Interface,
    input: TurnInput,
    event: { type: string; data?: unknown },
  ): Promise<void> {
    if (event.type !== "session.tool.success" || !input.turnId) return;
    const callId = isRecord(event.data) && typeof event.data.id === "string" ? event.data.id : undefined;
    if (!callId) return;
    const consulted = this.ctx.storage.sql
      .exec<{ call_id: string }>(
        `SELECT call_id FROM workerd_consults
         WHERE session_id = ? AND turn_id = ? AND call_id = ?`,
        input.sessionID,
        input.turnId,
        callId,
      )
      .toArray()[0];
    if (!consulted) return;
    const lease = this.turnLease(input.sessionID);
    if (lease?.turn_id === input.turnId && !lease.stop_requested_at) {
      this.ctx.storage.sql.exec(
        "UPDATE workerd_turn_lease SET stop_requested_at = ? WHERE opencode_session_id = ? AND turn_id = ?",
        Date.now(),
        input.sessionID,
        input.turnId,
      );
    }
    try {
      await opencode.sessions.interrupt({ sessionID: input.sessionID });
    } catch (error) {
      // The turn still ends with its consultation: the session settles it as
      // asked on whichever terminal event the loop reports.
      console.error(
        JSON.stringify({
          level: "error",
          event: "workerd.consult_interrupt_failed",
          sessionID: input.sessionID,
          turnId: input.turnId,
          message: message(error),
        }),
      );
    }
    console.log(
      JSON.stringify({
        level: "info",
        event: "workerd.consult_interrupted",
        sessionID: input.sessionID,
        turnId: input.turnId,
        callId,
      }),
    );
  }

  private runtimeHeaders(): Record<string, string> {
    return {
      "x-opencomputer-runtime-activation": String(this.activation),
      "x-opencomputer-runtime-boot": this.bootID,
      "x-opencomputer-runtime-init-ms": String(this.openCodeInitMs),
      "x-opencomputer-runtime-age-ms": String(Date.now() - this.constructedAt),
    };
  }

  private sandboxLease(): SandboxLeaseRow | undefined {
    return this.ctx.storage.sql
      .exec<SandboxLeaseRow>(
        `SELECT session_id, sandbox_id, generation, state, last_used_at,
                idle_deadline_at, expires_at, probe_due, retire_reason
         FROM workerd_sandbox_lease WHERE slot = 1`,
      )
      .toArray()[0];
  }

  private sandboxPollMarginMs(): number {
    const configured = Number(this.env.SANDBOX_POLL_MARGIN_MS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : defaultSandboxPollMarginMs;
  }

  /** How long the computer of a ready lease can still host a command, after the termination reserve. */
  private leaseHeadroomMs(lease: SandboxLeaseRow, nowMs: number): number {
    if (lease.expires_at === null) return 0;
    return Number(lease.expires_at) - nowMs - SANDBOX_TERMINATION_RESERVE_MS;
  }

  private pinSandboxContext(context: {
    accountId: string;
    managedSessionId: string;
    edge: string;
    runtimeToken: string;
    sharedWorkspaceSessionId?: string;
  }): void {
    let edge: URL;
    try {
      edge = new URL(context.edge);
    } catch {
      throw new Error("Sandbox context requires a valid edge URL");
    }
    if (
      !context.accountId.trim() ||
      !context.managedSessionId.trim() ||
      edge.protocol !== "https:" ||
      !context.runtimeToken.trim()
    ) {
      throw new Error("Sandbox context requires accountId and managedSessionId");
    }
    const existing = this.sandboxContext();
    if (
      existing &&
      (existing.account_id !== context.accountId ||
        existing.managed_session_id !== context.managedSessionId)
    ) {
      throw new Error("The Workerd session is already pinned to another sandbox context");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_sandbox_context (
         slot, account_id, managed_session_id, edge, runtime_token, shared_workspace_session_id
       ) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         edge = excluded.edge,
         runtime_token = excluded.runtime_token,
         shared_workspace_session_id = COALESCE(NULLIF(excluded.shared_workspace_session_id, ''), shared_workspace_session_id)`,
      context.accountId,
      context.managedSessionId,
      edge.origin,
      context.runtimeToken,
      context.sharedWorkspaceSessionId ?? "",
    );
  }

  /**
   * One turn runs at a time, so the current turn's typed input lives in a
   * single slot. It is stored rather than kept in memory because the render
   * may run in a later activation, when OpenCode resumes a turn on its own.
   */
  private pinTurnInput(input: StructuredAgentInput | undefined): void {
    if (!input || !isRecord(input) || typeof input.source !== "string") {
      this.ctx.storage.sql.exec("DELETE FROM workerd_turn_input WHERE slot = 1");
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_turn_input (slot, input_json) VALUES (1, ?)
       ON CONFLICT(slot) DO UPDATE SET input_json = excluded.input_json`,
      JSON.stringify(input),
    );
  }

  private turnInput(): StructuredAgentInput | undefined {
    const row = this.ctx.storage.sql
      .exec<{ input_json: string }>(
        "SELECT input_json FROM workerd_turn_input WHERE slot = 1",
      )
      .toArray()[0];
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(row.input_json);
      return isRecord(parsed) && typeof parsed.source === "string"
        ? (parsed as unknown as StructuredAgentInput)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private sandboxContext(): SandboxContextRow | undefined {
    return this.ctx.storage.sql
      .exec<SandboxContextRow>(
        `SELECT account_id, managed_session_id, edge, runtime_token, shared_workspace_session_id
         FROM workerd_sandbox_context WHERE slot = 1`,
      )
      .toArray()[0];
  }

  /**
   * Pins the session's memory grants. Bindings are fixed for the life of a
   * managed session, so a repeat with the same set is a no-op and a different
   * set is an error, never a widening.
   */
  private pinMemory(value: unknown): void {
    if (
      !isRecord(value) ||
      typeof value.objectName !== "string" ||
      !value.objectName.trim() ||
      typeof value.sessionId !== "string" ||
      !value.sessionId.trim() ||
      !Array.isArray(value.bindings)
    ) {
      throw new Error("Memory requires objectName, sessionId and bindings");
    }
    if (value.bindings.length > MEMORY_LIMITS.bindingsPerSession) {
      throw new Error(
        `A session binds at most ${String(MEMORY_LIMITS.bindingsPerSession)} memory resources`,
      );
    }
    const bindings: MemoryBinding[] = [];
    const resources = new Set<string>();
    for (const binding of value.bindings as unknown[]) {
      if (!isMemoryBinding(binding)) {
        throw new Error("Memory bindings must name a resource with a document or collection scope");
      }
      if (resources.has(binding.resource)) {
        throw new Error(`Memory resource ${JSON.stringify(binding.resource)} is bound twice`);
      }
      resources.add(binding.resource);
      bindings.push(binding);
    }
    const payload: MemoryPayload = {
      objectName: value.objectName,
      sessionId: value.sessionId,
      bindings,
    };
    const sandbox = this.sandboxContext();
    if (sandbox && sandbox.managed_session_id !== payload.sessionId) {
      throw new Error("Memory bindings belong to a different managed session");
    }
    const existing = this.memoryScope();
    if (existing) {
      const same =
        existing.objectName === payload.objectName &&
        existing.sessionId === payload.sessionId &&
        memoryBindingsKey(this.memoryBindings()) === memoryBindingsKey(bindings);
      if (!same) {
        throw new Error("The Workerd session is already pinned to different memory bindings");
      }
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO workerd_memory_context (slot, object_name, session_id)
         VALUES (1, ?, ?)`,
        payload.objectName,
        payload.sessionId,
      );
      for (const binding of bindings) {
        this.ctx.storage.sql.exec(
          `INSERT INTO workerd_memory_bindings (resource, scope, document_id, access)
           VALUES (?, ?, ?, ?)`,
          binding.resource,
          binding.scope,
          binding.scope === "document" ? binding.id : null,
          binding.access,
        );
      }
    });
  }

  private memoryScope(): MemoryScope | undefined {
    const row = this.ctx.storage.sql
      .exec<MemoryContextRow>(
        "SELECT object_name, session_id FROM workerd_memory_context WHERE slot = 1",
      )
      .toArray()[0];
    return row ? { objectName: row.object_name, sessionId: row.session_id } : undefined;
  }

  private requireMemoryScope(): MemoryScope {
    const scope = this.memoryScope();
    if (!scope) throw new Error("The managed session has not supplied memory bindings");
    return scope;
  }

  private memoryBindings(): MemoryBinding[] {
    return this.ctx.storage.sql
      .exec<MemoryBindingRow>(
        "SELECT resource, scope, document_id, access FROM workerd_memory_bindings ORDER BY resource",
      )
      .toArray()
      .map(memoryBindingOf);
  }

  /**
   * The request key of the model request a tool call belongs to. Until S6
   * exposes the assistant messageID in the context hook, this is the latest
   * render of the session: the runner prepares one request at a time per
   * session and runs its tool calls before preparing the next, and the rows
   * are durable before the model request leaves.
   */
  private currentRequestKey(sessionID: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ request_key: string }>(
        `SELECT request_key FROM workerd_request_snapshot
         WHERE session_id = ? ORDER BY rowid DESC LIMIT 1`,
        sessionID,
      )
      .toArray()[0]?.request_key;
  }

  /** The resources one request selected that offer `tool`; the only valid `memory` targets for that request. */
  private memoryToolTargets(
    requestKey: string,
    tool: MemoryToolName,
  ): Array<{ binding: MemoryBinding; snapshot: RequestSnapshotRow }> {
    const bindings = new Map(
      this.memoryBindings().map((binding) => [binding.resource, binding]),
    );
    const rows = this.ctx.storage.sql
      .exec<RequestSnapshotRow>(
        `SELECT request_key, resource, document_id, revision, projection_json,
                cursor, writable, selected
         FROM workerd_request_snapshot
         WHERE request_key = ? AND selected = 1 ORDER BY resource`,
        requestKey,
      )
      .toArray();
    const targets: Array<{ binding: MemoryBinding; snapshot: RequestSnapshotRow }> = [];
    for (const snapshot of rows) {
      const binding = bindings.get(snapshot.resource);
      if (binding && memoryToolsOf(binding).includes(tool)) {
        targets.push({ binding, snapshot });
      }
    }
    return targets;
  }

  /**
   * For each fixed tool, the resources one request selected that offer it,
   * with the model-facing description from the deployment manifest. An empty
   * list means the tool is not exposed for that request.
   */
  private async memoryToolExposure(
    requestKey: string,
  ): Promise<Map<MemoryToolName, Array<{ resource: string; description: string }>>> {
    const exposure = new Map<MemoryToolName, Array<{ resource: string; description: string }>>();
    const declared = new Map<string, string>();
    if (this.memoryBindings().length > 0) {
      const { manifest } = await this.artifactProjection();
      for (const declaration of manifest.memory ?? []) {
        if (
          isRecord(declaration) &&
          typeof declaration.id === "string" &&
          typeof declaration.description === "string" &&
          declaration.description
        ) {
          declared.set(declaration.id, declaration.description);
        }
      }
    }
    for (const tool of memoryToolNames) {
      exposure.set(
        tool,
        this.memoryToolTargets(requestKey, tool).map(({ binding }) => ({
          resource: binding.resource,
          description: declared.get(binding.resource) ?? binding.resource,
        })),
      );
    }
    return exposure;
  }

  /**
   * Executes one of the fixed memory tools. Every documented outcome is a
   * result the model reads, never a tool error; only malformed arguments and
   * host failures throw.
   */
  private async executeMemoryTool(
    tool: MemoryToolName,
    rawInput: unknown,
    context: { sessionID: string; messageID: string; id: string },
  ): Promise<{ content: string; metadata: Record<string, unknown> }> {
    const input = isRecord(rawInput) ? rawInput : {};
    const staleSince = this.ctx.storage.sql
      .exec<{ render_id: string }>(
        "SELECT render_id FROM workerd_seen_messages WHERE session_id = ? AND message_id = ?",
        context.sessionID,
        context.messageID,
      )
      .toArray()[0];
    if (staleSince) {
      // The call's message was already in the transcript when a later
      // request was rendered: it belongs to an earlier render, and its
      // snapshot is not the latest one. Never saved, never read.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "workerd.memory_tool_stale",
          tool,
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.id,
          renderID: staleSince.render_id,
        }),
      );
      return {
        content: JSON.stringify({ status: "rejected", reason: "stale" }),
        metadata: { tool, messageID: context.messageID, stale: true },
      };
    }
    const requestKey = this.currentRequestKey(context.sessionID);
    const targets = requestKey ? this.memoryToolTargets(requestKey, tool) : [];
    const bound = targets.map((target) => target.binding.resource);
    const target =
      input.memory !== undefined
        ? targets.find((candidate) => candidate.binding.resource === input.memory)
        : targets.length === 1
          ? targets[0]
          : undefined;
    const reply = (result: unknown, resource?: string) => ({
      content: JSON.stringify(result),
      metadata: {
        tool,
        ...(resource ? { memory: resource } : {}),
        ...(requestKey ? { requestKey } : {}),
        messageID: context.messageID,
      },
    });
    if (!target) {
      return reply({ status: "rejected", reason: "not_bound", bound });
    }
    const resource = target.binding.resource;
    const client = this.memory(this.requireMemoryScope());
    switch (tool) {
      case "memory_save": {
        if (typeof input.text !== "string") {
          throw new Error("memory_save requires text");
        }
        if (input.summary !== undefined && typeof input.summary !== "string") {
          throw new Error("memory_save summary must be a string");
        }
        const expectedRevision = target.snapshot.revision;
        if (expectedRevision === null) {
          throw new Error(`The request snapshot for ${JSON.stringify(resource)} has no revision`);
        }
        const result: SaveResult = await client.save(
          resource,
          {
            text: input.text,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
          },
          expectedRevision,
        );
        if (result.status === "saved") {
          this.ctx.storage.sql.exec(
            "INSERT INTO workerd_memory_saved (data_json) VALUES (?)",
            JSON.stringify({
              resource,
              documentId: target.snapshot.document_id,
              revision: result.revision,
              bytes: result.bytes,
            }),
          );
        }
        return reply(result, resource);
      }
      case "memory_read": {
        if (typeof input.id !== "string") throw new Error("memory_read requires id");
        const outcome = await client.readDocument(resource, input.id);
        if (outcome.kind === "document") {
          const { id, title, text, summary, revision, updatedAt } = outcome.document;
          return reply({ id, title, text, summary, revision, updatedAt }, resource);
        }
        return reply(
          {
            status: "rejected",
            reason: outcome.kind === "rejected" ? outcome.reason : "not_found",
          },
          resource,
        );
      }
      case "memory_list": {
        if (input.cursor !== undefined && typeof input.cursor !== "string") {
          throw new Error("memory_list cursor must be a string");
        }
        const outcome = await client.listCollection(resource, input.cursor);
        if ("kind" in outcome) {
          return reply({ status: "rejected", reason: outcome.reason }, resource);
        }
        return reply(
          {
            documents: outcome.documents.map(({ id, title, summary, revision, updatedAt }) => ({
              id,
              title,
              summary,
              revision,
              updatedAt,
            })),
            nextCursor: outcome.nextCursor,
          },
          resource,
        );
      }
    }
  }

  private async beginTurn(): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE workerd_turn_state
       SET active_turns = active_turns + 1, alarm_generation = NULL
       WHERE slot = 1`,
    );
    // A computer kept from an earlier turn answers a liveness probe before
    // this turn's first command reuses it.
    this.ctx.storage.sql.exec(
      "UPDATE workerd_sandbox_lease SET idle_deadline_at = NULL, probe_due = 1 WHERE slot = 1",
    );
    await this.ctx.storage.deleteAlarm();
  }

  private async finishTurn(): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE workerd_turn_state
       SET active_turns = MAX(active_turns - 1, 0)
       WHERE slot = 1`,
    );
    const activeTurns = Number(
      this.ctx.storage.sql
        .exec<{ active_turns: number }>(
          "SELECT active_turns FROM workerd_turn_state WHERE slot = 1",
        )
        .one().active_turns,
    );
    const lease = this.sandboxLease();
    if (activeTurns !== 0 || !lease || lease.state === "terminating") return;

    const configuredGrace = Number(this.env.SANDBOX_IDLE_GRACE_MS);
    const idleGraceMs =
      Number.isFinite(configuredGrace) && configuredGrace > 0
        ? configuredGrace
        : defaultSandboxIdleGraceMs;
    const deadline = Date.now() + idleGraceMs;
    this.ctx.storage.sql.exec(
      `UPDATE workerd_sandbox_lease SET idle_deadline_at = ?
       WHERE slot = 1 AND generation = ?`,
      deadline,
      lease.generation,
    );
    this.ctx.storage.sql.exec(
      `UPDATE workerd_turn_state SET alarm_generation = ? WHERE slot = 1`,
      lease.generation,
    );
    await this.ctx.storage.setAlarm(deadline);
  }

  /**
   * The computer for a command. A ready lease is reused when the computer
   * can host the command for its whole timeout and still leave the
   * termination reserve; otherwise that computer is retired (terminated and
   * confirmed) and a fresh generation is acquired.
   *
   * Probe, reuse, retirement and acquisition are one serialized decision
   * under the acquisition slot (C4): a caller that finds a decision in
   * flight waits for it and then decides again over the lease it left,
   * so two concurrent failed probes of one generation produce one
   * replacement and one termination, never two live computers on the
   * workspace. Every generation transition inside checks that it wrote
   * the row it meant to; one that updates nothing stops.
   */
  private async ensureSandbox(
    sessionID: string,
    requirement: { hostForMs?: number } = {},
  ): Promise<SandboxLeaseRow> {
    while (this.sandboxAcquisition) {
      await this.sandboxAcquisition.catch(() => undefined);
    }
    return this.acquire(sessionID, () => this.decideSandbox(sessionID, requirement));
  }

  /** The decision itself; runs only under the acquisition slot. */
  private async decideSandbox(
    sessionID: string,
    requirement: { hostForMs?: number },
  ): Promise<SandboxLeaseRow> {
    const lease = this.sandboxLease();
    if (lease?.state === "ready") {
      if (lease.session_id !== sessionID) {
        throw new Error("The sandbox lease belongs to a different session");
      }
      const nowMs = Date.now();
      if (this.leaseHeadroomMs(lease, nowMs) >= (requirement.hostForMs ?? 0)) {
        if (lease.retire_reason !== null) {
          // A supervisor that answered in a shape from before the contract
          // cannot be verified by any probe: retired, confirmed, replaced.
          await this.retireLease(lease, lease.retire_reason);
          return this.acquireSandbox(sessionID, this.sandboxLease());
        }
        if (Number(lease.probe_due) === 1) {
          // Liveness before reuse. A failed probe is uncertainty, not proof
          // of death: the generation is terminated and confirmed through
          // the platform before another computer mounts the workspace.
          const alive = await this.probeSandbox(lease);
          if (!alive) {
            await this.retireLease(lease, "probe_failed");
            return this.acquireSandbox(sessionID, this.sandboxLease());
          }
          this.ctx.storage.sql.exec(
            "UPDATE workerd_sandbox_lease SET probe_due = 0 WHERE slot = 1 AND generation = ?",
            lease.generation,
          );
        }
        // A dispatched, unresolved operation from before the ownership
        // ledger (C4, rollout compatibility) names no computer and no
        // supervisor: nothing can confirm it, so the computer is retired
        // and its confirmed termination resolves the row.
        if (this.legacyOperationsUnresolved() > 0) {
          await this.retireLease(lease, "legacy_operation");
          return this.acquireSandbox(sessionID, this.sandboxLease());
        }
        // An operation this host abandoned without a confirmed settlement
        // fences the computer (C4): it is reused only once every such
        // operation is confirmed settled, else it is terminated, confirmed,
        // and replaced.
        if (!(await this.settleAbandonedOperations(sessionID, lease))) {
          await this.retireLease(lease, "unsettled_operation");
          return this.acquireSandbox(sessionID, this.sandboxLease());
        }
        this.ctx.storage.sql.exec(
          "UPDATE workerd_sandbox_lease SET last_used_at = ? WHERE slot = 1 AND generation = ?",
          nowMs,
          lease.generation,
        );
        return { ...lease, last_used_at: nowMs, probe_due: 0 };
      }
      console.log(
        JSON.stringify({
          level: "info",
          event: "workerd.sandbox_replaced",
          reason: "lifetime",
          generation: lease.generation,
          headroomMs: this.leaseHeadroomMs(lease, nowMs),
          requiredMs: requirement.hostForMs ?? 0,
        }),
      );
      await this.retireLease(lease, "lifetime");
      return this.acquireSandbox(sessionID, this.sandboxLease());
    }
    return this.acquireSandbox(sessionID, lease);
  }

  /**
   * Records that this generation's supervisor cannot be verified (a reply
   * in the shape from before the command contract: no boot id, no cancel
   * route). The computer serves the operation it is running, and no
   * other: the next acquisition retires it without a probe.
   */
  private markSupervisorUnverifiable(lease: SandboxLeaseRow, evidence: string): void {
    const written = this.ctx.storage.sql.exec(
      `UPDATE workerd_sandbox_lease SET retire_reason = 'supervisor_unverifiable'
       WHERE slot = 1 AND generation = ? AND retire_reason IS NULL`,
      lease.generation,
    ).rowsWritten;
    if (written === 0) return;
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "workerd.sandbox_supervisor_unverifiable",
        sessionID: lease.session_id,
        generation: lease.generation,
        sandboxId: lease.sandbox_id,
        evidence,
      }),
    );
  }

  /** Dispatched rows written before the ownership columns and never resolved. */
  private legacyOperationsUnresolved(): number {
    return Number(
      this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM workerd_capability_faults
           WHERE requested_at IS NOT NULL AND resolved_at IS NULL AND generation IS NULL`,
        )
        .one().count,
    );
  }

  /**
   * Every operation of this generation the host abandoned without a
   * confirmed settlement is asked to cancel once more. True when each is
   * now settled (the supervisor confirmed it, or it never started on the
   * boot that admitted it); false when any is still unknown, in which
   * case the computer is not reused.
   */
  private async settleAbandonedOperations(
    managedSessionId: string,
    lease: SandboxLeaseRow,
  ): Promise<boolean> {
    const abandoned = this.ctx.storage.sql
      .exec<{ tool_call_id: string; supervisor_boot_id: string | null }>(
        `SELECT tool_call_id, supervisor_boot_id
         FROM workerd_capability_faults
         WHERE generation = ? AND requested_at IS NOT NULL
           AND abandoned_at IS NOT NULL AND resolved_at IS NULL
         ORDER BY created_at`,
        lease.generation,
      )
      .toArray();
    let allSettled = true;
    for (const operation of abandoned) {
      const reply = await this.cancelSandboxOperation(
        managedSessionId,
        lease,
        operation.tool_call_id,
        "unsettled_before_reuse",
      );
      const verdict = cancelVerdict(reply, operation.supervisor_boot_id);
      this.recordOperationSettlement(operation.tool_call_id, verdict, {
        generation: lease.generation,
        reason: "unsettled_before_reuse",
        following: "stopped",
      });
      if (verdict.kind === "settled") continue;
      allSettled = false;
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "workerd.sandbox_operation_still_unsettled",
          toolCallID: operation.tool_call_id,
          generation: lease.generation,
          verdict: verdict.kind,
        }),
      );
    }
    return allSettled;
  }

  /**
   * Whether the computer of a ready lease is alive and is the one the lease
   * names: the platform checks the MicroVM is running and the supervisor
   * answers for this session and generation. Any failure to establish that
   * is `false`.
   */
  private async probeSandbox(lease: SandboxLeaseRow): Promise<boolean> {
    if (!this.env.SANDBOX || lease.sandbox_id === null) return false;
    let alive = false;
    let reason = "unreachable";
    try {
      const response = await this.env.SANDBOX.fetch(
        "https://sandbox.invalid/v1/sandboxes/probe",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: lease.session_id,
            sandboxId: lease.sandbox_id,
            generation: lease.generation,
          }),
        },
      );
      const text = await response.text();
      const body = response.ok && text.length <= 16 * 1024 ? (JSON.parse(text) as unknown) : {};
      if (isRecord(body)) {
        alive = body.alive === true;
        if (typeof body.reason === "string") reason = body.reason;
      }
      if (!response.ok) reason = `platform returned ${String(response.status)}`;
    } catch (error) {
      reason = message(error);
    }
    console.log(
      JSON.stringify({
        level: alive ? "info" : "warn",
        event: alive ? "workerd.sandbox_probe" : "workerd.sandbox_probe_failed",
        sessionID: lease.session_id,
        generation: lease.generation,
        sandboxId: lease.sandbox_id,
        alive,
        ...(alive ? {} : { reason }),
      }),
    );
    return alive;
  }

  /**
   * The acquisition slot: one lease decision at a time for this object.
   * Commands, the idle alarm and computer termination all take it, so no
   * two of them act on the lease at once.
   */
  private async acquire<T>(_sessionID: string, run: () => Promise<T>): Promise<T> {
    while (this.sandboxAcquisition) {
      await this.sandboxAcquisition.catch(() => undefined);
    }
    const acquisition = run();
    this.sandboxAcquisition = acquisition as Promise<unknown>;
    try {
      return await acquisition;
    } finally {
      if (this.sandboxAcquisition === (acquisition as Promise<unknown>)) {
        this.sandboxAcquisition = undefined;
      }
    }
  }

  /**
   * Retires a ready computer: termination requested, then confirmed through
   * the platform. Between the two the lease is `terminating`, which no
   * command reuses and no acquisition advances past; a failed confirmation
   * leaves it there for the next acquisition or alarm to retry. A
   * transition that finds the lease no longer at this generation and state
   * stops: the decision that saw it was stale.
   */
  private async retireLease(lease: SandboxLeaseRow, reason: string): Promise<void> {
    if (!this.env.SANDBOX) {
      throw new Error("Cannot terminate the sandbox without its adapter binding");
    }
    const written = this.ctx.storage.sql.exec(
      `UPDATE workerd_sandbox_lease
       SET state = 'terminating', idle_deadline_at = NULL
       WHERE slot = 1 AND generation = ? AND state IN ('ready', 'terminating')`,
      lease.generation,
    ).rowsWritten;
    if (written === 0) {
      throw new Error(
        `The computer lease is no longer generation ${String(lease.generation)} in a retirable state; nothing was retired`,
      );
    }
    await this.confirmTermination({ ...lease, state: "terminating" }, reason);
  }

  /**
   * The platform's word that the computer is gone. Only then does the lease
   * become `terminated`, every operation the generation still had in flight
   * is recorded as lost, and the workspace is free for the next computer.
   * Rows from before the ownership ledger name no generation; the session
   * has one computer, and its confirmed termination is what resolves them.
   */
  private async confirmTermination(lease: SandboxLeaseRow, reason: string): Promise<void> {
    if (!this.env.SANDBOX) {
      throw new Error("Cannot terminate the sandbox without its adapter binding");
    }
    const response = await this.env.SANDBOX.fetch(
      "https://sandbox.invalid/v1/sandboxes/terminate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: lease.session_id,
          sandboxId: lease.sandbox_id,
          generation: lease.generation,
          // A healthy computer retired for time (idle, or too little lifetime
          // left) keeps its filesystem for the next generation where the
          // provider can snapshot it. A computer retired for doubt (failed
          // probe, unsettled operation, a stop) is not preserved.
          preserve: PRESERVED_RETIREMENTS.has(reason),
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `The computer (generation ${String(lease.generation)}) could not be confirmed terminated: the platform returned ${String(response.status)}; the confirmation is retried before another computer mounts the workspace`,
      );
    }
    const nowMs = Date.now();
    const lost = this.ctx.storage.transactionSync(() => {
      const terminated = this.ctx.storage.sql.exec(
        `UPDATE workerd_sandbox_lease
         SET state = 'terminated', sandbox_id = NULL, idle_deadline_at = NULL,
             expires_at = NULL, last_used_at = ?
         WHERE slot = 1 AND generation = ? AND state = 'terminating'`,
        nowMs,
        lease.generation,
      ).rowsWritten;
      if (terminated === 0) {
        // The lease is not this generation in `terminating` any more:
        // whoever moved it owns what follows. Nothing else is recorded.
        throw new Error(
          `The computer lease moved past generation ${String(lease.generation)} while its termination was being confirmed`,
        );
      }
      const lostRows = this.ctx.storage.sql
        .exec<{ tool_call_id: string }>(
          `SELECT tool_call_id FROM workerd_capability_faults
           WHERE (generation = ? OR (generation IS NULL AND requested_at IS NOT NULL))
             AND resolved_at IS NULL`,
          lease.generation,
        )
        .toArray();
      for (const row of lostRows) {
        this.recordOperationSettlement(row.tool_call_id, lostWithComputer(), {
          generation: lease.generation,
          reason,
          following: "stopped",
        });
      }
      this.ctx.storage.sql.exec(
        `UPDATE workerd_turn_state SET alarm_generation = NULL
         WHERE slot = 1 AND alarm_generation = ?`,
        lease.generation,
      );
      return lostRows.length;
    });
    console.log(
      JSON.stringify({
        level: "info",
        event: "workerd.sandbox_terminated",
        sessionID: lease.session_id,
        generation: lease.generation,
        sandboxId: lease.sandbox_id,
        reason,
        operationsLost: lost,
      }),
    );
  }

  private async acquireSandbox(
    sessionID: string,
    previous: SandboxLeaseRow | undefined,
  ): Promise<SandboxLeaseRow> {
    if (!this.env.SANDBOX) {
      throw new Error("The sandbox adapter is not configured");
    }
    if (previous && previous.session_id !== sessionID) {
      throw new Error("The sandbox lease belongs to a different session");
    }
    if (previous?.state === "terminating") {
      // A termination nobody confirmed. The old generation must be known
      // gone before a new computer mounts the same workspace.
      await this.confirmTermination(previous, "unconfirmed");
      previous = this.sandboxLease();
    }
    if (previous?.state === "ready") {
      // A decision that reached here saw a lease that has since become
      // ready under another decision; it does not advance past it.
      throw new Error(
        `A computer (generation ${String(previous.generation)}) is already ready; the acquisition stops`,
      );
    }

    const generation =
      previous?.state === "starting"
        ? previous.generation
        : (previous?.generation ?? 0) + 1;
    const startedAt = Date.now();
    // A fresh generation is not probed on the turn that launched it.
    this.ctx.storage.sql.exec(
      `INSERT INTO workerd_sandbox_lease (
         slot, session_id, sandbox_id, generation, state, last_used_at,
         idle_deadline_at, expires_at, probe_due, retire_reason
       ) VALUES (1, ?, NULL, ?, 'starting', ?, NULL, NULL, 0, NULL)
       ON CONFLICT(slot) DO UPDATE SET
         session_id = excluded.session_id,
         sandbox_id = NULL,
         generation = excluded.generation,
         state = 'starting',
         last_used_at = excluded.last_used_at,
         idle_deadline_at = NULL,
         expires_at = NULL,
         probe_due = 0,
         retire_reason = NULL`,
      sessionID,
      generation,
      startedAt,
    );

    const sandboxContext = this.requireSandboxContext();
    // Ensure is retried on transport-level failures (the call itself, a 5xx
    // from the platform, an unparsable reply): provisioning a computer is
    // transient-heavy right after a deployment registers, and a failed
    // attempt must not leave the session poisoned. A 4xx is an input error
    // and fails at once. The platform dedupes retried requests on the
    // generation-scoped client token, so retries cannot race two computers
    // for one generation.
    let result: { sandboxId?: unknown; expiresAtMs?: unknown } | undefined;
    const ensureAttempts = 3;
    for (let attempt = 1; attempt <= ensureAttempts; attempt += 1) {
      let refused = false;
      try {
        const response = await this.env.SANDBOX.fetch(
          "https://sandbox.invalid/v1/sandboxes/ensure",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              accountId: sandboxContext.account_id,
              sessionID: sandboxContext.managed_session_id,
              edge: sandboxContext.edge,
              runtimeToken: sandboxContext.runtime_token,
              generation,
              workspace: {
                // A consult's inner session works in the consulting session's
                // files: the platform mounts that session's workspace volume.
                // The computer itself stays this session's — its id, lease and
                // lifecycle do not move to the shared workspace.
                id: sandboxContext.shared_workspace_session_id || sandboxContext.managed_session_id,
                mountPath: "/workspace",
              },
              deployment: this.sandboxDeployment(),
            }),
          },
        );
        const responseText = await response.text();
        if (!response.ok) {
          refused = response.status < 500;
          throw new Error(`Sandbox acquisition returned ${response.status}: ${responseText}`);
        }
        if (responseText.length > 16 * 1024) {
          throw new Error("Sandbox acquisition returned an oversized response");
        }
        const parsed = JSON.parse(responseText) as {
          sandboxId?: unknown;
          expiresAtMs?: unknown;
        };
        if (typeof parsed.sandboxId !== "string" || !parsed.sandboxId) {
          throw new Error("Sandbox acquisition did not return a sandboxId");
        }
        result = parsed;
        break;
      } catch (error) {
        if (refused || attempt === ensureAttempts) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 400 * attempt + Math.floor(Math.random() * 200)),
        );
      }
    }
    if (!result) {
      throw new Error("Sandbox acquisition did not return a sandboxId");
    }

    const readyAt = Date.now();
    const readied = this.ctx.storage.sql.exec(
      `UPDATE workerd_sandbox_lease
       SET sandbox_id = ?, state = 'ready', last_used_at = ?, expires_at = ?, probe_due = 0
       WHERE slot = 1 AND generation = ? AND state = 'starting'`,
      result.sandboxId,
      readyAt,
      typeof result.expiresAtMs === "number" && Number.isFinite(result.expiresAtMs)
        ? result.expiresAtMs
        : null,
      generation,
    ).rowsWritten;
    const ready = this.sandboxLease();
    if (readied === 0 || !ready || ready.generation !== generation || ready.state !== "ready") {
      throw new Error("The sandbox lease changed while acquisition was in flight");
    }
    return ready;
  }

  /**
   * One computer operation, from the tool call to its recorded outcome.
   * The command's timeout is validated before anything is dispatched; the
   * computer is one that can host the whole timeout; the supervisor runs
   * the command as its own process unit and enforces the cutoff; the host
   * polls until the supervisor reports, with a deadline derived from the
   * timeout. A timeout, a cancellation and a supervisor that never reports
   * all fail the call to the model with a message that names the command
   * and what happened; the turn goes on. Writes the command finished stay.
   *
   * After dispatch there is one exit (C4, one definition of settlement).
   * Following the operation (`followOperation`) either records a
   * settlement from the supervisor's own terminal reply, or stops without
   * one: the reporting deadline, a status request that failed or answered
   * something unusable, a body that did not parse, a progress report that
   * threw, any exception at all. Whatever ended it, the row decides what
   * happens next: a row still open is abandoned here, with one
   * settlement-aware cancel, and the model is told exactly what was
   * confirmed; a row another path already settled or abandoned (the stop
   * sweep, a terminal reply) is left as it is. Nothing after dispatch can
   * leave the row open, so uncertainty of any origin fences the computer.
   */
  private async executeSandboxTool<Input>(
    definition: RuntimeToolDefinition<Input>,
    input: Input,
    sessionID: string,
    providerCallID: string,
    context: { messageId: string },
    reportProgress?: (metadata: Record<string, unknown>) => Promise<void>,
  ): Promise<{ content: string; metadata: Record<string, unknown> }> {
    const timeoutSeconds = definition.commandTimeoutSeconds?.(input);
    const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000;
    // The host identity is resolved before anything is dispatched and
    // written after the tool's own request, so no field of the model's
    // input can stand in for it. `messageId` and `agentId` next to it are
    // what a supervisor from before `identity` reads.
    const identity = await this.toolInvocationIdentity(
      sessionID,
      providerCallID,
      context.messageId,
      { toolId: definition.toolId, capability: definition.capability, input },
    );
    const toolCallID = identity.toolCallId;
    const request: Record<string, unknown> = {
      ...definition.sandboxRequest(input),
      identity,
      messageId: identity.messageId,
      agentId: identity.agentId,
    };
    const command = typeof request.command === "string" ? request.command : undefined;
    const turnId = this.turnLease(sessionID)?.turn_id ?? null;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO workerd_capability_faults (
         tool_call_id, session_id, capability, request_json, created_at, turn_id
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      toolCallID,
      sessionID,
      definition.capability,
      JSON.stringify(input),
      Date.now(),
      turnId,
    );
    const replay = this.operationRow(toolCallID);
    if (
      replay &&
      replay.resolved_at !== null &&
      replay.outcome === "completed" &&
      replay.terminal_result_json !== null
    ) {
      const terminalResult = JSON.parse(replay.terminal_result_json) as unknown;
      if (!isRecord(terminalResult)) {
        throw new Error(`The completed operation ${toolCallID} has an invalid durable result`);
      }
      return this.completeSandboxTool(
        definition,
        terminalResult,
        sessionID,
        providerCallID,
        turnId,
        identity,
      );
    }
    if (replay && replay.resolved_at !== null && replay.terminal_error !== null) {
      throw new Error(replay.terminal_error);
    }
    if (!this.env.SANDBOX) {
      return {
        content:
          `The ${definition.capability} capability fault was persisted, ` +
          "but no sandbox adapter is bound in this environment.",
        metadata: { escalated: false, capability: definition.capability },
      };
    }

    const operationName =
      command !== undefined ? `Command ${JSON.stringify(command)}` : `The ${definition.toolId} operation`;
    // The stop fence, checked before the computer is touched and again
    // right before dispatch (acquisition may have taken a while): a stopped
    // execution admits no new operation.
    const refuseIfStopping = (): void => {
      if (this.turnLease(sessionID)?.stop_requested_at) {
        this.recordOperationSettlement(toolCallID, undispatched("cancelled"), {
          generation: null,
          reason: "stop_fence",
          following: "stopped",
        });
        throw new Error(
          "The turn is being stopped; no new commands are admitted. Writes completed so far remain.",
        );
      }
    };
    refuseIfStopping();
    const sandboxContext = this.requireSandboxContext();
    const managedSessionId = sandboxContext.managed_session_id;
    const lease = await this.ensureSandbox(managedSessionId, {
      ...(timeoutMs === undefined ? {} : { hostForMs: timeoutMs }),
    });
    refuseIfStopping();
    this.ctx.storage.sql.exec(
      `UPDATE workerd_capability_faults SET requested_at = ?, generation = ?
       WHERE tool_call_id = ?`,
      Date.now(),
      lease.generation,
      toolCallID,
    );

    // Dispatched. From here on, one exit.
    let followed: { ok: true; result: Record<string, unknown> } | { ok: false; error: unknown };
    try {
      followed = {
        ok: true,
        result: await this.followOperation({
          definition,
          request,
          command,
          timeoutSeconds,
          timeoutMs,
          sessionID,
          managedSessionId,
          lease,
          toolCallID,
          operationName,
          reportProgress,
        }),
      };
    } catch (error) {
      followed = { ok: false, error };
    }
    const row = this.operationRow(toolCallID);
    if (!row) {
      throw new Error(`The operation ledger lost ${toolCallID} while it was being followed`);
    }
    if (row.resolved_at === null && row.abandoned_at === null) {
      // Following ended without a settlement, whatever ended it. One
      // cancel, settlement-aware; the row is abandoned unless the
      // supervisor's reply settles it, and the model learns only what
      // was confirmed.
      const ended = followed.ok ? undefined : followed.error;
      const [reason, what] =
        ended instanceof FollowEnded
          ? [ended.reason, ended.what]
          : ended === undefined
            ? ["follow_failed", `${operationName} returned without a recorded settlement`]
            : ["follow_failed", `${operationName} could not be followed: ${message(ended)}`];
      const verdict = await this.abandonOperation(managedSessionId, lease, toolCallID, reason);
      throw new Error(describeOperationEnd(what, verdict));
    }
    if (!followed.ok) {
      if (followed.error instanceof FollowEnded) {
        if (
          row.outcome === "completed" &&
          row.terminal_result_json !== null
        ) {
          const terminalResult = JSON.parse(row.terminal_result_json) as unknown;
          if (isRecord(terminalResult)) {
            return this.completeSandboxTool(
              definition,
              terminalResult,
              sessionID,
              providerCallID,
              turnId,
              identity,
            );
          }
        }
        // The row was settled or abandoned by another path while this one
        // was following (the stop sweep's word): report that, never a
        // guess of this path's own.
        const terminalError =
          row.resolved_at !== null && row.outcome !== null
            ? confirmedOperationEnd(followed.error.what, row.outcome)
            : unknownOperationEnd(followed.error.what);
        if (row.resolved_at !== null) this.recordOperationError(toolCallID, terminalError);
        throw new Error(terminalError);
      }
      if (row.resolved_at !== null) this.recordOperationError(toolCallID, message(followed.error));
      throw followed.error;
    }
    if (row.resolved_at === null) {
      throw new Error(unknownOperationEnd(`${operationName} returned without a recorded settlement`));
    }

    return this.completeSandboxTool(
      definition,
      followed.result,
      sessionID,
      providerCallID,
      turnId,
      identity,
    );
  }

  /** Formats and, for a result tool, commits one completed durable result. */
  private async completeSandboxTool<Input>(
    definition: RuntimeToolDefinition<Input>,
    terminalResult: Record<string, unknown>,
    sessionID: string,
    providerCallID: string,
    turnId: string | null,
    identity: ToolInvocationIdentity,
  ): Promise<{ content: string; metadata: Record<string, unknown> }> {
    let content = JSON.stringify(terminalResult);
    if (definition.capability === "code-tool") {
      if (typeof terminalResult.content !== "string") {
        throw new Error("Sandbox code tool returned an invalid result");
      }
      content = terminalResult.content;
    }
    this.ctx.storage.sql.exec(
      "UPDATE workerd_sandbox_lease SET last_used_at = ? WHERE slot = 1",
      Date.now(),
    );
    if (definition.capability === "code-tool") {
      const resultTool = (await this.artifactProjection()).manifest.resultTool;
      if (resultTool && resultTool.id === definition.toolId) {
        content = await this.commitResultToolOutput(
          resultTool,
          content,
          sessionID,
          providerCallID,
          turnId,
          identity.messageId,
        );
      }
    }
    return {
      content,
      metadata: { escalated: true, capability: definition.capability },
    };
  }

  /**
   * Dispatches one operation to the supervisor and follows it to a
   * terminal reply. Returns the supervisor's result for a completed
   * operation. Throws a plain error, with the row already resolved, for a
   * terminal reply that is a failure, a timeout or a cancellation, and for
   * a request the supervisor refused before admission (a 4xx: nothing runs
   * on the computer). Throws `FollowEnded` whenever it stops following
   * without a settlement of its own: the reporting deadline, a status
   * request that failed or answered something unusable, a row that
   * another path settled or abandoned meanwhile. Anything else that throws
   * (a body that does not parse, a progress report) is the same thing to
   * the caller: following ended, the row is still open, and the caller's
   * one exit decides.
   */
  private async followOperation<Input>(operation: {
    definition: RuntimeToolDefinition<Input>;
    request: Record<string, unknown>;
    command: string | undefined;
    timeoutSeconds: number | undefined;
    timeoutMs: number | undefined;
    sessionID: string;
    managedSessionId: string;
    lease: SandboxLeaseRow;
    toolCallID: string;
    operationName: string;
    reportProgress?: ((metadata: Record<string, unknown>) => Promise<void>) | undefined;
  }): Promise<Record<string, unknown>> {
    if (!this.env.SANDBOX) throw new Error("The sandbox adapter is not configured");
    const {
      definition,
      request,
      command,
      timeoutSeconds,
      timeoutMs,
      sessionID,
      managedSessionId,
      lease,
      toolCallID,
      operationName,
      reportProgress,
    } = operation;
    const response = await this.env.SANDBOX.fetch(
      "https://sandbox.invalid/v1/sandboxes/execute",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionID: managedSessionId,
          sandboxId: lease.sandbox_id,
          generation: lease.generation,
          toolCallID,
          capability: definition.capability,
          request,
        }),
      },
    );
    const output = await response.text();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        // Refused before admission: nothing runs on the computer.
        this.recordOperationSettlement(toolCallID, undispatched("failed"), {
          generation: lease.generation,
          reason: "refused",
          following: "stopped",
        });
        throw new Error(`Sandbox returned ${response.status}: ${output}`);
      }
      // A 5xx after the request left: the supervisor may have admitted it.
      throw new FollowEnded(
        "start_unconfirmed",
        `The computer answered ${String(response.status)} to the command's start`,
      );
    }
    if (output.length > 16 * 1024) {
      throw new FollowEnded(
        "start_unconfirmed",
        "The computer answered the command's start with an oversized response",
      );
    }
    const started = JSON.parse(output) as {
      operationId?: unknown;
      status?: unknown;
      progress?: unknown;
      bootId?: unknown;
    };
    if (started.operationId !== toolCallID || typeof started.status !== "string") {
      throw new FollowEnded(
        "start_unconfirmed",
        "The computer answered the command's start with an invalid response",
      );
    }
    const recordedBoot = typeof started.bootId === "string" ? started.bootId : null;
    if (recordedBoot !== null) {
      this.ctx.storage.sql.exec(
        "UPDATE workerd_capability_faults SET supervisor_boot_id = ? WHERE tool_call_id = ?",
        recordedBoot,
        toolCallID,
      );
    } else {
      // A start reply with no boot id is the supervisor from before the
      // contract. This command is followed; the computer is not reused.
      this.markSupervisorUnverifiable(lease, "the start reply carries no boot id");
    }

    // The polling deadline follows the command: its timeout, plus the
    // margin the supervisor gets to terminate the unit and report.
    const deadline =
      Date.now() + (timeoutMs ?? CODE_TOOL_DEADLINE_MS) + this.sandboxPollMarginMs();
    let after = 0;
    const consumeProgress = async (entries: unknown[]): Promise<void> => {
      for (const entry of entries) {
        if (!isRecord(entry) || !Number.isInteger(entry.seq) || !isRecord(entry.data)) {
          throw new FollowEnded(
            "status_invalid",
            `${operationName} could not be followed: the computer returned invalid progress`,
          );
        }
        after = Math.max(after, Number(entry.seq));
        await reportProgress?.({
          tool: definition.toolId,
          ...entry.data,
          sandboxOperation: {
            id: toolCallID,
            generation: lease.generation,
            seq: entry.seq,
            timestamp: entry.timestamp,
          },
        });
      }
    };
    // A supervisor that answers the start with the operation's entries
    // saves the follow an instant status roundtrip; one that does not is
    // fetched from zero as before.
    if (Array.isArray(started.progress)) await consumeProgress(started.progress);
    for (;;) {
      if (Date.now() >= deadline) {
        throw new FollowEnded(
          "report_deadline",
          command !== undefined
            ? `${operationName} did not report an outcome within ${String(timeoutSeconds)} seconds plus the reporting margin`
            : `${operationName} did not report an outcome in time`,
        );
      }
      const row = this.operationRow(toolCallID);
      if (!row || row.resolved_at !== null || row.abandoned_at !== null) {
        // Another path concluded (the stop sweep settled or abandoned the
        // row): this one stops following and reports that conclusion.
        throw new FollowEnded("settled_elsewhere", `${operationName} was stopped`);
      }
      const statusRequestedAt = Date.now();
      const statusResponse = await this.env.SANDBOX.fetch(
        "https://sandbox.invalid/v1/sandboxes/execute/status",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: managedSessionId,
            sandboxId: lease.sandbox_id,
            generation: lease.generation,
            toolCallID,
            after,
            // The long poll: the supervisor holds the request until the
            // operation reports something new, bounded so the hold ends
            // before the follow's own deadline.
            waitMs: Math.min(
              SANDBOX_STATUS_WAIT_MS,
              Math.max(0, deadline - statusRequestedAt - 1_000),
            ),
          }),
        },
      );
      const statusText = await statusResponse.text();
      if (!statusResponse.ok) {
        throw new FollowEnded(
          "status_failed",
          `${operationName} could not be followed: the computer answered ${String(statusResponse.status)} to a status request`,
        );
      }
      if (statusText.length > 2 * 1024 * 1024) {
        throw new FollowEnded(
          "status_invalid",
          `${operationName} could not be followed: the status reply was oversized`,
        );
      }
      const status = JSON.parse(statusText) as {
        operationId?: unknown;
        status?: unknown;
        progress?: unknown;
        result?: unknown;
        error?: unknown;
        bootId?: unknown;
      };
      if (status.operationId !== toolCallID || !Array.isArray(status.progress)) {
        throw new FollowEnded(
          "status_invalid",
          `${operationName} could not be followed: the status reply was invalid`,
        );
      }
      if (typeof status.bootId !== "string") {
        this.markSupervisorUnverifiable(lease, "a status reply carries no boot id");
      }
      await consumeProgress(status.progress);
      if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
        // A terminal reply is evidence under the same rule as a cancel
        // reply: verified containment settles a terminated unit; a
        // completion settles; anything else is not a settlement.
        const verdict = settlementOf(status as Record<string, unknown>, recordedBoot);
        const result = isRecord(status.result) ? status.result : undefined;
        this.recordOperationSettlement(toolCallID, verdict, {
          generation: lease.generation,
          reason: "reported",
          following: "stopped",
          ...(status.status === "completed" && result ? { terminalResult: result } : {}),
        });
        if (status.status === "completed" && verdict.kind === "unverified") {
          // Filed as completed, but the unit was killed: the supervisor
          // from before the contract reported its cutoff this way.
          throw new Error(
            unverifiedOperationEnd(
              `${operationName} was terminated by the computer` +
                (result?.timedOut === true ? " at its cutoff" : ""),
              verdict.reason,
            ),
          );
        }
        if (status.status === "completed") {
          if (verdict.kind !== "settled") {
            throw new FollowEnded("status_invalid", `${operationName} reported completion without usable evidence`);
          }
          if (!result) {
            // The supervisor's word is that it finished: settled, with the
            // result unusable.
            throw new Error("Sandbox operation completed without a valid result");
          }
          return result;
        }
        const timedOut = result?.timedOut === true && command !== undefined;
        const tails =
          (outputTail(result?.stdout) ? `\n\nstdout (tail):\n${outputTail(result?.stdout)}` : "") +
          (outputTail(result?.stderr) ? `\n\nstderr (tail):\n${outputTail(result?.stderr)}` : "");
        const what = timedOut
          ? `${operationName} timed out after ${String(timeoutSeconds)} seconds and was terminated` +
            (typeof result?.isolation === "string" ? ` (process unit: ${result.isolation})` : "")
          : status.status === "cancelled"
            ? `${operationName} was cancelled` + (typeof status.error === "string" ? `: ${status.error}` : "")
            : typeof status.error === "string"
              ? status.error
              : "Sandbox operation failed";
        if (verdict.kind === "unverified") {
          throw new Error(unverifiedOperationEnd(what, verdict.reason) + tails);
        }
        if (verdict.kind === "pending") {
          throw new FollowEnded("status_invalid", `${operationName} reported ${status.status} without usable evidence`);
        }
        if (timedOut) {
          this.ctx.storage.sql.exec(
            "UPDATE workerd_sandbox_lease SET last_used_at = ? WHERE slot = 1",
            Date.now(),
          );
          throw new Error(
            `${what}. Writes it completed before that remain; nothing was rolled back. Retry with a larger timeoutSeconds (at most ${String(COMMAND_TIMEOUT_MAX_SECONDS)}) if it needs longer.${tails}`,
          );
        }
        throw new Error(
          status.status === "cancelled" ? `${what}. Writes it completed before that remain.` : what,
        );
      }
      if (status.status !== "running") {
        throw new FollowEnded(
          "status_invalid",
          `${operationName} could not be followed: the computer reported an unknown status`,
        );
      }
      // The long poll already waited inside the computer, so a reply that
      // held is followed at once. A fast reply is a supervisor from before
      // the wait (an older image, or the deadline-capped zero wait): keep
      // the former cadence — a prompt one under a stop, so a pending
      // cancellation fails the call without delay — rather than spin.
      const elapsed = Date.now() - statusRequestedAt;
      const cadence = this.turnLease(sessionID)?.stop_requested_at ? 100 : 1_000;
      if (elapsed < cadence) {
        await new Promise((resolve) => setTimeout(resolve, cadence - elapsed));
      }
    }
  }

  /**
   * The host stops following a dispatched operation without a settlement
   * (C4, unknown outcomes): one cancel is asked of the supervisor, and only
   * a confirmed settlement resolves the row. Otherwise the row stays
   * unresolved and marked abandoned, which fences the computer until a
   * later cancel is confirmed or the computer is terminated. Returns the
   * verdict so the caller can tell the model what was confirmed, never
   * that cancellation succeeded when it did not.
   */
  private async abandonOperation(
    managedSessionId: string,
    lease: SandboxLeaseRow,
    toolCallID: string,
    reason: string,
  ): Promise<OperationSettlement> {
    const recordedBoot = this.operationRow(toolCallID)?.supervisor_boot_id ?? null;
    const reply = await this.cancelSandboxOperation(managedSessionId, lease, toolCallID, reason);
    const verdict = cancelVerdict(reply, recordedBoot);
    this.recordOperationSettlement(toolCallID, verdict, {
      generation: lease.generation,
      reason,
      following: "stopped",
    });
    if (verdict.kind === "settled") return verdict;
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "workerd.sandbox_operation_abandoned",
        toolCallID,
        generation: lease.generation,
        reason,
        verdict: verdict.kind,
      }),
    );
    return verdict;
  }

  /**
   * The one writer of an operation's durable transition (C4, one
   * definition of settlement). A row is resolved by a `settled` verdict and
   * by nothing else, and a settled verdict comes only from `settlementOf`
   * over the supervisor's reply, `undispatched` for a request that never
   * ran, or `lostWithComputer` after confirmed termination. An `unverified`
   * verdict marks the row abandoned: nobody can verify it by asking again,
   * so it fences the computer until termination is confirmed. A `pending`
   * verdict marks the row abandoned only when the caller stops following
   * it; the stop sweep leaves a followed row to its follower. Polling,
   * cancellation, the abandon exit, the sweep, reuse and termination all
   * pass through here.
   */
  private recordOperationSettlement(
    toolCallID: string,
    verdict: OperationSettlement,
    context: {
      generation: number | null;
      reason: string;
      following: "stopped" | "continues";
      terminalResult?: Record<string, unknown>;
    },
  ): void {
    if (verdict.kind === "settled") {
      this.ctx.storage.sql.exec(
        `UPDATE workerd_capability_faults
         SET resolved_at = ?, outcome = ?, terminal_result_json = COALESCE(?, terminal_result_json)
         WHERE tool_call_id = ? AND resolved_at IS NULL`,
        Date.now(),
        verdict.outcome,
        context.terminalResult ? JSON.stringify(context.terminalResult) : null,
        toolCallID,
      );
      return;
    }
    if (verdict.kind === "pending" && context.following === "continues") return;
    this.ctx.storage.sql.exec(
      `UPDATE workerd_capability_faults SET abandoned_at = ?
       WHERE tool_call_id = ? AND resolved_at IS NULL AND abandoned_at IS NULL`,
      Date.now(),
      toolCallID,
    );
    if (verdict.kind === "unverified") {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "workerd.sandbox_operation_unverified",
          toolCallID,
          generation: context.generation,
          reason: context.reason,
          evidence: verdict.reason,
        }),
      );
    }
  }

  /** Persist the stable model-facing failure of a settled logical call for exact replay. */
  private recordOperationError(toolCallID: string, error: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE workerd_capability_faults SET terminal_error = COALESCE(terminal_error, ?)
       WHERE tool_call_id = ? AND resolved_at IS NOT NULL`,
      error,
      toolCallID,
    );
  }

  /** The operation ledger's row for one tool call. */
  private operationRow(toolCallID: string):
    | {
        resolved_at: number | null;
        abandoned_at: number | null;
        outcome: SandboxOperationOutcome | null;
        terminal_result_json: string | null;
        terminal_error: string | null;
        supervisor_boot_id: string | null;
        generation: number | null;
        turn_id: string | null;
      }
    | undefined {
    return this.ctx.storage.sql
      .exec<{
        resolved_at: number | null;
        abandoned_at: number | null;
        outcome: SandboxOperationOutcome | null;
        terminal_result_json: string | null;
        terminal_error: string | null;
        supervisor_boot_id: string | null;
        generation: number | null;
        turn_id: string | null;
      }>(
        `SELECT resolved_at, abandoned_at, outcome, terminal_result_json, terminal_error,
                supervisor_boot_id, generation, turn_id
         FROM workerd_capability_faults WHERE tool_call_id = ?`,
        toolCallID,
      )
      .toArray()[0];
  }
  /**
   * C1: the result tool's output becomes the session's result only through
   * an acknowledged commit, and the model is told success only after it.
   * The turn is the one this host's lease named when the call was
   * dispatched (`dispatchedTurnId`, read before the computer was touched),
   * never whatever lease is current once the tool has run: a call that
   * outlived its turn is refused here as stale, and cannot be attributed to
   * the turn that replaced it. The generation is this activation, which
   * the managed session recorded when the turn started, so a loop replayed
   * by a later activation cannot commit. A rejection or an unconfirmed
   * commit throws, which OpenCode reports to the model as a failed call,
   * and the previous result stands.
   */
  private async commitResultToolOutput(
    tool: ResultToolManifest,
    content: string,
    sessionID: string,
    toolCallID: string,
    dispatchedTurnId: string | null,
    messageId: string | undefined,
  ): Promise<string> {
    if (dispatchedTurnId === null) {
      throw new ResultRejectedError(
        "stale_turn",
        "Result rejected: no managed turn was running when this call was dispatched",
      );
    }
    // The same identity, validated at commit: the lease must still be the
    // one the call was dispatched under. Read to compare, not to attribute.
    const current = this.turnLease(sessionID);
    if (!current || current.turn_id !== dispatchedTurnId) {
      throw new ResultRejectedError(
        "stale_turn",
        "Result rejected: the turn that dispatched this call is no longer running",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new ResultRejectedError(
        "invalid_output",
        `Result rejected: ${tool.id} returned a value that is not JSON`,
      );
    }
    const context = this.requireSandboxContext();
    const committed = await commitResultToolOutput({
      tool,
      value,
      turnId: dispatchedTurnId,
      callId: toolCallID,
      ...(messageId ? { messageId } : {}),
      runtime: { kind: "workerd", bootId: this.bootID, activation: this.activation },
      commit: this.results(context),
    });
    console.log(
      JSON.stringify({
        level: "info",
        event: "workerd.result_committed",
        sessionID,
        turnId: dispatchedTurnId,
        callID: toolCallID,
        replayed: committed.replayed,
      }),
    );
    return committed.content;
  }

  /**
   * Asks the supervisor to terminate one operation's unit. Best effort here:
   * the reply is logged, and whether it counts as settlement is the
   * caller's decision.
   */
  private async cancelSandboxOperation(
    managedSessionId: string,
    lease: SandboxLeaseRow,
    toolCallID: string,
    reason: string,
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    if (!this.env.SANDBOX || lease.sandbox_id === null) {
      return { ok: false, status: 0, body: {} };
    }
    try {
      const response = await this.env.SANDBOX.fetch(
        "https://sandbox.invalid/v1/sandboxes/execute/cancel",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: managedSessionId,
            sandboxId: lease.sandbox_id,
            generation: lease.generation,
            toolCallID,
            reason,
          }),
        },
      );
      const text = await response.text();
      const body = text.length <= 64 * 1024 ? (JSON.parse(text) as unknown) : {};
      console.log(
        JSON.stringify({
          level: "info",
          event: "workerd.sandbox_operation_cancel",
          toolCallID,
          generation: lease.generation,
          reason,
          status: response.status,
        }),
      );
      if (response.status === 404) {
        // No cancel route: the supervisor from before the contract. It
        // cannot terminate or verify anything; the computer is retired.
        this.markSupervisorUnverifiable(lease, "the cancel request answered 404 (no cancel route)");
      }
      return { ok: response.ok, status: response.status, body: isRecord(body) ? body : {} };
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "workerd.sandbox_operation_cancel_failed",
          toolCallID,
          generation: lease.generation,
          reason,
          message: message(error),
        }),
      );
      return { ok: false, status: 0, body: {} };
    }
  }

  override async alarm(): Promise<void> {
    // The alarm's lease work takes the acquisition slot like a command
    // does, so idle disposal never races a decision that just reused or
    // replaced the computer.
    await this.acquire("", async () => {
      const turnState = this.ctx.storage.sql
        .exec<{ active_turns: number; alarm_generation: number | null }>(
          `SELECT active_turns, alarm_generation
           FROM workerd_turn_state WHERE slot = 1`,
        )
        .one();
      const lease = this.sandboxLease();
      if (!lease) return;
      if (lease.state === "terminating") {
        // A termination whose confirmation was lost: confirmed here, or the
        // alarm's own retry brings it back.
        await this.confirmTermination(lease, "unconfirmed");
        return;
      }
      if (
        Number(turnState.active_turns) !== 0 ||
        turnState.alarm_generation === null ||
        lease.generation !== Number(turnState.alarm_generation) ||
        lease.state !== "ready"
      ) {
        return;
      }
      if (lease.idle_deadline_at && lease.idle_deadline_at > Date.now()) {
        await this.ctx.storage.setAlarm(lease.idle_deadline_at);
        return;
      }
      // Idle disposal: the generation is retired and confirmed; the row stays
      // as the tombstone the next acquisition advances from, because AWS
      // RunMicrovm client tokens are generation-scoped and a deleted row
      // would resolve generation 1 to the terminated MicroVM again.
      await this.retireLease(lease, "idle");
    });
  }

  private requireSandboxContext(): SandboxContextRow {
    const context = this.sandboxContext();
    if (!context) {
      throw new Error("The managed session has not supplied sandbox context");
    }
    return context;
  }

  private runtimePlugin(
    codeTools: readonly CodeToolMetadata[],
    skillTool: SkillToolDefinition | null,
    registeredMcpServers: readonly string[],
  ): NonNullable<
    OpenCodeWorkerd.CreateOptions["plugins"]
  >[number] {
    return {
      id: "opencomputer-sandbox-escalation",
      setup: async (plugin) => {
        // OpenCode decides whether a failed model call is retried; the host
        // adds one retry where OpenCode declines a transport failure or a
        // broken response stream (model-retry.ts). Every decision is logged
        // so an operator can see why a turn waited, or did not.
        await plugin.session.hook("retry", async (event) => {
          const sessionID = String(event.sessionID);
          const verdict = modelRetryDecision({
            error: event.error,
            decision: event.decision,
            hostRetried: this.modelRetryGrants.has(sessionID),
          });
          if (verdict.overridden) this.modelRetryGrants.set(sessionID, event.attempt);
          console.log(
            JSON.stringify({
              level: "info",
              event: "workerd.model_retry",
              sessionID,
              attempt: event.attempt,
              errorType: event.error.type,
              ...(event.error.status === undefined ? {} : { status: event.error.status }),
              proposed: event.decision.retry,
              retry: verdict.decision.retry,
              hostGranted: verdict.overridden,
              ...(verdict.decision.retry ? { delayMs: verdict.decision.delay } : {}),
            }),
          );
          event.decision = verdict.decision;
        });
        // COMPACTION, PENDING S6. The pinned cohort runs this hook for the
        // compaction request too, under the original agent id, and sends the
        // system content to the summarizer. There is no structural signal to
        // tell the two apart here (`model.request` sees agent "compaction"
        // one hook later), so the render and its memory recall run during
        // compaction as well. Once SessionContext carries `purpose`, return
        // early for compaction and let OpenCode keep its own prompt. Do not
        // guess from prompt text.
        await plugin.session.hook("context", async (event) => {
          const userMessage = [...event.messages]
            .reverse()
            .find((candidate) => candidate.role === "user");
          const text = userMessage?.content
            .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
            .join("\n");
          const assistantMessageIds = event.messages.flatMap((candidate) =>
            candidate.role === "assistant" && typeof candidate.id === "string" && candidate.id
              ? [candidate.id]
              : [],
          );
          const latency = this.latency(undefined, this.latencyDimensions(String(event.sessionID)));
          const render = await latency
            .time(
              "workerd.agent_rendered",
              () =>
                this.renderAgent(
                  this.turnInput() ?? {
                    source: "user",
                    ...(text ? { text } : {}),
                  },
                  String(event.sessionID),
                  { assistantMessageIds },
                ),
              () => ({ memory: this.memoryBindings().length > 0 }),
            )
            .finally(() => latency.send(this.ctx));
          const enabledMcpServers = [
            ...render.enabledMcpServers,
            "database",
          ];
          const deployment = this.deployment();
          const resolved = deployment.models
            ? await this.resolveModel(render.model)
            : render.model ?? deployment.defaultModel;
          const resolvedModelID = this.runtimeModelRoute()?.model ??
            (resolved ? this.openRouterModelId(resolved) : undefined);
          if (resolvedModelID && resolvedModelID !== event.model.id) {
            throw new Error(
              `The active response uses ${event.model.id}, but the agent rendered ${resolvedModelID}. Model changes require a new response boundary.`,
            );
          }
          if (render.instructions) {
            event.system.push({ type: "text", text: render.instructions });
          }
          if (registeredMcpServers.length && !this.mcpExposureLogged) {
            this.mcpExposureLogged = true;
            const opencode = await this.opencode;
            if (opencode) {
              await this.logMcpStatus(
                opencode,
                "model_context",
                registeredMcpServers,
              );
            }
            console.log(
              JSON.stringify({
                level: "info",
                event: "workerd.mcp_tool_exposure",
                registeredServers: [...registeredMcpServers].sort(),
                enabledServers: [...enabledMcpServers].sort(),
                ...workerdMcpToolExposure(
                  Object.keys(event.tools),
                  enabledMcpServers,
                  registeredMcpServers,
                ),
              }),
            );
          }
          const memoryTools = await this.memoryToolExposure(render.renderId);
          for (const tool of Object.keys(event.tools)) {
            if (tool === ASK_TOOL || tool === CONSULT_TOOL) {
              // Offered only on a step whose render selected it.
              if (!render.enabledTools.includes(tool)) delete event.tools[tool];
              continue;
            }
            const exposure = memoryTools.get(tool as MemoryToolName);
            if (exposure !== undefined) {
              const definition = event.tools[tool];
              if (exposure.length === 0 || !definition) {
                delete event.tools[tool];
              } else {
                definition.description = memoryToolDescription(
                  tool as MemoryToolName,
                  exposure,
                );
              }
              continue;
            }
            if (
              !render.enabledTools.includes(tool) &&
              !workerdMcpToolIsEnabled(
                tool,
                enabledMcpServers,
                registeredMcpServers,
              ) &&
              tool !== skillTool?.name
            ) {
              delete event.tools[tool];
            }
          }
        });
        await plugin.tool.transform((tools) => {
          if (skillTool) tools.add(skillTool);
          tools.add({
            name: ASK_TOOL,
            description: ASK_TOOL_DESCRIPTION,
            input: ASK_TOOL_INPUT_SCHEMA,
            options: { codemode: false },
            execute: async (rawInput, tool) =>
              this.executeAskTool(rawInput, {
                sessionID: String(tool.sessionID),
                messageID: String(tool.messageID),
                id: String(tool.id),
              }),
          });
          tools.add({
            name: CONSULT_TOOL,
            description: CONSULT_TOOL_DESCRIPTION,
            input: CONSULT_TOOL_INPUT_SCHEMA,
            options: { codemode: false },
            execute: async (rawInput, tool) =>
              this.executeConsultTool(rawInput, {
                sessionID: String(tool.sessionID),
                messageID: String(tool.messageID),
                id: String(tool.id),
              }),
          });
          for (const name of memoryToolNames) {
            tools.add({
              name,
              description: memoryToolSummaries[name],
              input: memoryToolSchemas[name],
              options: { codemode: false },
              execute: async (rawInput, tool) =>
                this.executeMemoryTool(name, rawInput, {
                  sessionID: String(tool.sessionID),
                  messageID: String(tool.messageID),
                  id: String(tool.id),
                }),
            });
          }
          // The two command tools share one path to the computer. `shell`
          // replaces OpenCode's built-in shell, which runs on the host's own
          // filesystem and has no computer there (work 027: the path
          // error); on this runtime a shell command is a computer command.
          const commandTool = (toolId: string): RuntimeToolDefinition<SandboxToolInput> => ({
            toolId,
            capability: "exec",
            sandboxRequest: (input) => ({
              command: input.command,
              timeoutSeconds: commandTimeoutSeconds(input.timeoutSeconds),
            }),
            commandTimeoutSeconds: (input) => commandTimeoutSeconds(input.timeoutSeconds),
          });
          const registerCommandTool = (
            definition: RuntimeToolDefinition<SandboxToolInput>,
            description: string,
          ) => {
            tools.remove(definition.toolId);
            tools.add({
              name: definition.toolId,
              description,
              input: commandToolSchema,
              options: { codemode: false },
              execute: async (rawInput, tool) => {
                const input = rawInput as SandboxToolInput;
                return dispatchToolExecution(definition.execution, {
                  edge: async () => {
                    if (!definition.executeEdge) {
                      throw new Error("The tool has no edge implementation");
                    }
                    return {
                      content: await definition.executeEdge(input),
                      metadata: { escalated: false, capability: "exec" },
                    };
                  },
                  sandbox: () =>
                    this.executeSandboxTool(
                      definition,
                      input,
                      String(tool.sessionID),
                      String(tool.id),
                      { messageId: String(tool.messageID) },
                      (metadata) => tool.progress(metadata),
                    ),
                });
              },
            });
          };
          registerCommandTool(
            commandTool("shell"),
            `Run a shell command on the session's computer, in the workspace. The command is terminated and the call fails when timeoutSeconds (default ${String(COMMAND_TIMEOUT_DEFAULT_SECONDS)}, at most ${String(COMMAND_TIMEOUT_MAX_SECONDS)}) elapses; writes it completed by then remain. The first command starts the computer.`,
          );
          registerCommandTool(
            commandTool("sandbox_exec"),
            `Execute a shell command on the session's computer, in the workspace. The command is terminated and the call fails when timeoutSeconds (default ${String(COMMAND_TIMEOUT_DEFAULT_SECONDS)}, at most ${String(COMMAND_TIMEOUT_MAX_SECONDS)}) elapses; writes it completed by then remain. The first command starts the computer.`,
          );
          for (const definition of codeTools) {
            const codeTool: RuntimeToolDefinition<Record<string, unknown>> = {
              toolId: definition.id,
              capability: "code-tool",
              sandboxRequest: (input) => ({
                toolId: definition.id,
                input,
              }),
            };
            tools.add({
              name: definition.id,
              description: definition.description,
              input: definition.input,
              options: { codemode: false },
              execute: async (rawInput, tool) =>
                this.executeSandboxTool(
                  codeTool,
                  isRecord(rawInput) ? rawInput : {},
                  String(tool.sessionID),
                  String(tool.id),
                  { messageId: String(tool.messageID) },
                  (metadata) => tool.progress(metadata),
                ),
            });
          }
        });
      },
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "POST" && url.pathname === "/sessions") {
      const id = crypto.randomUUID();
      // A regional deployment's session object starts in its region (work 057).
      const locationHint = parseLocationHint(
        request.headers.get(LOCATION_HINT_HEADER),
      );
      const stub = env.OPENCODE_SESSIONS.get(
        env.OPENCODE_SESSIONS.idFromName(id),
        locationHint ? { locationHint } : undefined,
      );
      const response = await stub.fetch(
        new Request("https://session.invalid/session", request),
      );
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: {
          "content-type": "application/json",
          "x-opencomputer-session": id,
          "x-opencomputer-runtime-activation":
            response.headers.get("x-opencomputer-runtime-activation") ?? "",
          "x-opencomputer-runtime-boot":
            response.headers.get("x-opencomputer-runtime-boot") ?? "",
          "x-opencomputer-runtime-init-ms":
            response.headers.get("x-opencomputer-runtime-init-ms") ?? "",
          "x-opencomputer-runtime-age-ms":
            response.headers.get("x-opencomputer-runtime-age-ms") ?? "",
        },
      });
    }

    if (parts[0] === "sessions" && parts[1] && parts[2]) {
      const stub = env.OPENCODE_SESSIONS.get(
        env.OPENCODE_SESSIONS.idFromName(parts[1]),
      );
      const target =
        parts[2] === "turn"
          ? "/turn"
          : parts[2] === "stop"
            ? "/stop"
            : parts[2] === "terminate-computer"
              ? "/terminate-computer"
            : parts[2] === "metrics"
              ? "/metrics"
              : parts[2] === "sandbox-context"
                ? "/sandbox-context"
                : null;
      if (!target) return json({ error: "not_found" }, 404);
      return stub.fetch(new Request(`https://session.invalid${target}`, request));
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const stub = env.OPENCODE_SESSIONS.get(
        env.OPENCODE_SESSIONS.idFromName("health"),
      );
      return stub.fetch("https://session.invalid/health");
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
