import type { AgentDeployment, ToolInvocationIdentity } from "../protocol.js";
import { parseToolInvocationIdentity } from "../tool-identity.js";

export interface SandboxEnsureInput {
  accountId: string;
  sessionID: string;
  edge: string;
  runtimeToken: string;
  generation: number;
  workspace: { id: string; mountPath: "/workspace" };
  deployment: AgentDeployment;
}

/**
 * The command ceiling: no command runs on a computer for longer than this,
 * whatever the caller asks. The host also caps a command by the computer's
 * remaining lifetime, and the supervisor refuses anything past the ceiling.
 */
export const COMMAND_TIMEOUT_MAX_SECONDS = 1_800;
export const COMMAND_TIMEOUT_DEFAULT_SECONDS = 120;

/** How long a launched computer lives at most. */
export const SANDBOX_MAXIMUM_DURATION_SECONDS = 3_600;

/**
 * How long a session runtime sandbox lives at most: a session spans turns
 * and may be held between them, so the ceiling is the provider's own (Modal
 * allows 24 h). Idle time is governed by suspend, not by this.
 */
export const SESSION_RUNTIME_MAXIMUM_DURATION_SECONDS = 86_400;

/** Whether the edge resolved an operator runtime profile (a custom image) for this deployment. */
export function hasManagedRuntimeProfile(deployment: AgentDeployment): boolean {
  const managedRuntimeProfileId = (
    deployment as AgentDeployment & { managedRuntimeProfileId?: unknown }
  ).managedRuntimeProfileId;
  return (
    typeof managedRuntimeProfileId === "string" &&
    managedRuntimeProfileId.length > 0
  );
}

/**
 * The Modal image and supervisor port the edge resolved for an operator
 * runtime profile, or null when the deployment has none (the standard
 * image) or its profile has no Modal image (it has nowhere to run).
 */
export function managedRuntimeModalImage(
  deployment: AgentDeployment,
): { image: string; supervisorPort: number } | null {
  const fields = deployment as AgentDeployment & {
    managedRuntimeModalImage?: unknown;
    managedRuntimeSupervisorPort?: unknown;
  };
  if (
    !hasManagedRuntimeProfile(deployment) ||
    typeof fields.managedRuntimeModalImage !== "string" ||
    fields.managedRuntimeModalImage.length === 0
  ) {
    return null;
  }
  const port = fields.managedRuntimeSupervisorPort;
  return {
    image: fields.managedRuntimeModalImage,
    supervisorPort:
      typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536
        ? port
        : 8080,
  };
}

export interface SandboxExecuteInput {
  sessionID: string;
  sandboxId: string;
  generation: number;
  toolCallID: string;
  capability: "exec" | "code-tool";
  request:
    | { command: string; timeoutSeconds: number }
    | {
        toolId: string;
        input: Record<string, unknown>;
        messageId: string;
        agentId: string;
        /** The call's host identity, as the Workerd runtime resolved it from the admitted turn. */
        identity: ToolInvocationIdentity;
      };
}

export interface SandboxTerminateInput {
  sessionID: string;
  sandboxId?: string | null;
  generation: number;
  /**
   * The computer is healthy and retired only for time: keep its filesystem
   * for the next generation where the provider can (Modal snapshots it).
   * Termination is still the contract; preservation is best effort.
   */
  preserve: boolean;
}

export interface SandboxExecuteStatusInput {
  sessionID: string;
  sandboxId: string;
  generation: number;
  toolCallID: string;
  after: number;
  /** How long the supervisor may hold the request waiting for news (the long poll). */
  waitMs?: number;
}

/** The longest status hold the adapter passes through; the supervisor applies its own cap. */
export const SANDBOX_STATUS_WAIT_MAX_MS = 30_000;

export interface SandboxExecuteCancelInput {
  sessionID: string;
  sandboxId: string;
  generation: number;
  toolCallID: string;
  reason: string;
}

export function parseCommandTimeoutSeconds(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < 1 ||
    Number(value) > COMMAND_TIMEOUT_MAX_SECONDS
  ) {
    throw new Error(
      `timeoutSeconds must be an integer between 1 and ${String(COMMAND_TIMEOUT_MAX_SECONDS)}`,
    );
  }
  return Number(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

// A host call id contains the canonical session/turn/message tuple as well
// as the provider label, so it is intentionally larger than any one member.
const HOST_TOOL_CALL_ID_MAX = 2_048;

function generation(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error("generation must be a positive integer");
  }
  return Number(value);
}

export function parseSandboxEnsureInput(value: unknown): SandboxEnsureInput {
  const input = record(value, "sandbox ensure input");
  const workspace = record(input.workspace, "workspace");
  const deployment = record(input.deployment, "deployment");
  const artifact = record(deployment.artifact, "deployment.artifact");
  const sessionID = text(input.sessionID, "sessionID");
  // The workspace is normally the session's own; a consult's inner session
  // carries the consulting session's id instead, so its computer mounts the
  // shared workspace. Only session code ever builds this body — the field
  // travels inside the DO-authored sandbox context, so a differing id is a
  // deliberate share, not an input a caller can choose.
  const workspaceId = text(workspace.id, "workspace.id");
  if (workspace.mountPath !== "/workspace") {
    throw new Error("workspace.mountPath must be /workspace");
  }
  text(deployment.id, "deployment.id");
  text(deployment.agentId, "deployment.agentId");
  text(deployment.imageArn, "deployment.imageArn", 2_048);
  text(deployment.imageVersion, "deployment.imageVersion");
  text(artifact.bucket, "deployment.artifact.bucket");
  text(artifact.key, "deployment.artifact.key", 2_048);
  text(artifact.digest, "deployment.artifact.digest");
  return {
    accountId: text(input.accountId, "accountId"),
    sessionID,
    edge: text(input.edge, "edge", 2_048),
    runtimeToken: text(input.runtimeToken, "runtimeToken", 2_048),
    generation: generation(input.generation),
    workspace: { id: workspaceId, mountPath: "/workspace" },
    deployment: input.deployment as unknown as AgentDeployment,
  };
}

export function parseSandboxExecuteInput(value: unknown): SandboxExecuteInput {
  const input = record(value, "sandbox execute input");
  const request = record(input.request, "request");
  const common = {
    sessionID: text(input.sessionID, "sessionID"),
    sandboxId: text(input.sandboxId, "sandboxId"),
    generation: generation(input.generation),
    toolCallID: text(input.toolCallID, "toolCallID", HOST_TOOL_CALL_ID_MAX),
  };
  if (input.capability === "exec") {
    return {
      ...common,
      capability: "exec",
      request: {
        command: text(request.command, "request.command", 64 * 1_024),
        timeoutSeconds: parseCommandTimeoutSeconds(request.timeoutSeconds),
      },
    };
  }
  if (input.capability !== "code-tool") {
    throw new Error("Unsupported sandbox capability");
  }
  const identity = parseToolInvocationIdentity(request.identity);
  if (
    !identity ||
    identity.sessionId !== common.sessionID ||
    identity.toolCallId !== common.toolCallID
  ) {
    throw new Error("request.identity is invalid");
  }
  return {
    ...common,
    capability: "code-tool",
    request: {
      toolId: text(request.toolId, "request.toolId"),
      input: record(request.input, "request.input"),
      messageId: identity.messageId,
      agentId: identity.agentId,
      identity,
    },
  };
}

export function parseSandboxTerminateInput(
  value: unknown,
): SandboxTerminateInput {
  const input = record(value, "sandbox terminate input");
  return {
    sessionID: text(input.sessionID, "sessionID"),
    sandboxId:
      input.sandboxId === null || input.sandboxId === undefined
        ? input.sandboxId
        : text(input.sandboxId, "sandboxId"),
    generation: generation(input.generation),
    preserve: input.preserve === true,
  };
}

export function parseSandboxExecuteStatusInput(
  value: unknown,
): SandboxExecuteStatusInput {
  const input = record(value, "sandbox execute status input");
  if (!Number.isInteger(input.after) || Number(input.after) < 0) {
    throw new Error("after must be a non-negative integer");
  }
  if (
    input.waitMs !== undefined &&
    (!Number.isInteger(input.waitMs) || Number(input.waitMs) < 0)
  ) {
    throw new Error("waitMs must be a non-negative integer");
  }
  return {
    sessionID: text(input.sessionID, "sessionID"),
    sandboxId: text(input.sandboxId, "sandboxId"),
    generation: generation(input.generation),
    toolCallID: text(input.toolCallID, "toolCallID", HOST_TOOL_CALL_ID_MAX),
    after: Number(input.after),
    ...(input.waitMs === undefined
      ? {}
      : { waitMs: Math.min(Number(input.waitMs), SANDBOX_STATUS_WAIT_MAX_MS) }),
  };
}

export interface SandboxProbeInput {
  sessionID: string;
  sandboxId: string;
  generation: number;
}

/**
 * What a supervisor's `/health` reply establishes for a liveness probe
 * (C4). Alive only when the reply names this session and this generation
 * with a tool sandbox ready. A reply with no `generation` is a supervisor
 * from before the command contract (rollout compatibility): it also has
 * no cancel route and reports no containment, so nothing it says can be
 * verified; the probe answers `supervisor: "unverifiable"` and the host
 * retires the computer with confirmed termination instead of reusing it.
 */
export type SupervisorHealthVerdict =
  | { alive: true; bootId: string | null }
  | { alive: false; reason: string; supervisor?: "unverifiable" };

export function interpretSupervisorHealth(
  health: unknown,
  expected: { sessionID: string; generation: number },
): SupervisorHealthVerdict {
  if (typeof health !== "object" || health === null || Array.isArray(health)) {
    return { alive: false, reason: "supervisor health reply is not an object" };
  }
  const reply = health as Record<string, unknown>;
  if (reply.toolSandbox !== "ready") return { alive: false, reason: "supervisor has no tool sandbox" };
  if (reply.sessionId !== expected.sessionID) {
    return { alive: false, reason: "supervisor serves another session" };
  }
  if (!("generation" in reply) || typeof reply.generation !== "number") {
    return {
      alive: false,
      reason:
        "supervisor does not report its generation: an image from before the command contract, with no cancel route and no containment; the computer is retired",
      supervisor: "unverifiable",
    };
  }
  if (reply.generation !== expected.generation) {
    return { alive: false, reason: `supervisor serves generation ${String(reply.generation)}` };
  }
  return { alive: true, bootId: typeof reply.bootId === "string" ? reply.bootId : null };
}

/**
 * A running sandbox is not necessarily ready for commands: the provider can
 * report it running before the image has accepted its lifecycle hook and
 * initialized the tool sandbox. Keep acquisition in `starting` until the supervisor
 * proves it serves the requested session and generation.
 */
export async function waitForSupervisorReady(
  expected: { sessionID: string; generation: number },
  probe: () => Promise<Response>,
  options: {
    attempts?: number;
    delayMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<{ bootId: string | null }> {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let reason = "supervisor did not answer";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await probe();
      if (!response.ok) {
        reason = `supervisor returned ${String(response.status)}`;
      } else {
        const verdict = interpretSupervisorHealth(await response.json(), expected);
        if (verdict.alive) return { bootId: verdict.bootId };
        reason = verdict.reason;
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for sandbox supervisor readiness: ${reason}`);
}

export function parseSandboxProbeInput(value: unknown): SandboxProbeInput {
  const input = record(value, "sandbox probe input");
  return {
    sessionID: text(input.sessionID, "sessionID"),
    sandboxId: text(input.sandboxId, "sandboxId"),
    generation: generation(input.generation),
  };
}

export function parseSandboxExecuteCancelInput(
  value: unknown,
): SandboxExecuteCancelInput {
  const input = record(value, "sandbox execute cancel input");
  return {
    sessionID: text(input.sessionID, "sessionID"),
    sandboxId: text(input.sandboxId, "sandboxId"),
    generation: generation(input.generation),
    toolCallID: text(input.toolCallID, "toolCallID", HOST_TOOL_CALL_ID_MAX),
    reason:
      typeof input.reason === "string" && input.reason.trim()
        ? input.reason.slice(0, 256)
        : "stop",
  };
}

/** A supervisor's reachable endpoint and the proxy token that admits requests to it. */
export interface MicrovmEndpoint {
  base: string;
  token: string;
  port: number;
  /**
   * Header the token is sent on; Modal tunnel endpoints set it to
   * x-sandbox-token. Absent means the token is not sent.
   */
  tokenHeader?: string;
}

/**
 * The endpoint and proxy token for one sandbox MicroVM, kept for the
 * token's validity and the computer's runtime generation, so a command
 * followed by a status poll a second does not look the MicroVM up and
 * mint a five-minute token on every poll. `resolve` answers from the
 * cache while the entry is valid for the generation asked; otherwise it
 * runs `fresh` once, sharing that one refresh with concurrent callers of
 * the same sandbox. `invalidate` drops an entry the proxy or the network
 * rejected, so the next resolve refreshes. Entries are per isolate and
 * best effort; correctness never depends on one being present.
 */
export class MicrovmEndpointCache {
  private readonly entries = new Map<
    string,
    { generation: number; endpoint: MicrovmEndpoint; validUntilMs: number }
  >();
  private readonly refreshes = new Map<string, Promise<MicrovmEndpoint | null>>();

  constructor(
    private readonly options: {
      /** How long a minted token admits requests. */
      validityMs: number;
      /** How long before the token's end an entry stops being reused. */
      refreshMarginMs: number;
      now?: () => number;
    },
  ) {}

  /**
   * The endpoint for `sandboxId` under `generation`, from the cache or
   * from `fresh`. `fresh` answers null when the MicroVM is not running;
   * that is not cached.
   */
  async resolve(
    sandboxId: string,
    generation: number,
    fresh: () => Promise<MicrovmEndpoint | null>,
  ): Promise<MicrovmEndpoint | null> {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.entries.get(sandboxId);
    if (cached && cached.generation === generation && now < cached.validUntilMs) {
      return cached.endpoint;
    }
    this.entries.delete(sandboxId);
    let refresh = this.refreshes.get(sandboxId);
    if (!refresh) {
      const mintedAt = now;
      refresh = fresh().then((endpoint) => {
        if (endpoint) {
          this.entries.set(sandboxId, {
            generation,
            endpoint,
            validUntilMs: mintedAt + this.options.validityMs - this.options.refreshMarginMs,
          });
        }
        return endpoint;
      });
      this.refreshes.set(sandboxId, refresh);
      refresh.finally(() => {
        if (this.refreshes.get(sandboxId) === refresh) this.refreshes.delete(sandboxId);
      }).catch(() => undefined);
    }
    return refresh;
  }

  /** Drops the entry: the proxy refused the token, or the endpoint did not answer. */
  invalidate(sandboxId: string): void {
    this.entries.delete(sandboxId);
  }

  /** How many endpoints are held; for tests. */
  get size(): number {
    return this.entries.size;
  }
}
