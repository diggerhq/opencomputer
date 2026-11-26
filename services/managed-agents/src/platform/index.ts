import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DOMParser as XMLDOMParser } from "@xmldom/xmldom";
import { handleComputerArmRequest } from "./computers/routes.js";

import type {
  AgentDeployment,
  CreateDeploymentUploadInput,
  DeploymentUpload,
} from "../protocol.js";
import {
  MicrovmEndpointCache,
  interpretSupervisorHealth,
  parseSandboxEnsureInput,
  parseSandboxExecuteCancelInput,
  parseSandboxExecuteInput,
  parseSandboxExecuteStatusInput,
  parseSandboxProbeInput,
  parseSandboxTerminateInput,
} from "./sandbox-adapter.js";
import { RunMicrovmAdmission } from "./run-microvm-admission.js";
import {
  modalSessionRuntimeSelected,
  startModalSessionRuntime,
} from "./modal-session-runtime.js";
import {
  exportableWorkspacePath,
  scopedWorkspaceArtifactKey,
  workspaceArtifactPrefix,
  workspaceDownloadFilename,
  workspaceExportExpectation,
} from "./workspace-export.js";
import { modalProviderEnabled, modalSandboxList } from "./modal-sandbox.js";
import {
  toolSandboxForEnsure,
  toolSandboxForId,
  toolSandboxForWorkspace,
} from "./tool-sandbox/resolve.js";
import {
  type PlatformEnv,
  type SupervisorEndpoint,
  SUPERVISOR_TOKEN_MINUTES,
  WORKSPACE_DOWNLOAD_URL_TTL_SECONDS,
  awsOptions,
  json,
  refuseWorkspaceExport,
  required,
} from "./tool-sandbox/shared.js";

const platformGlobals = globalThis as typeof globalThis & {
  DOMParser?: typeof XMLDOMParser;
  Node?: { ELEMENT_NODE: number; TEXT_NODE: number };
};
platformGlobals.DOMParser ??= XMLDOMParser;
platformGlobals.Node ??= { ELEMENT_NODE: 1, TEXT_NODE: 3 };

export { RunMicrovmAdmission };

interface StartRuntimeInput {
  accountId: string;
  projectId: string;
  sessionId: string;
  runtimeToken: string;
  edge: string;
  deployment: AgentDeployment;
}

interface RuntimeActionInput {
  accountId: string;
  microvmId: string;
}

interface CodexRelayInput {
  accountId: string;
  microvmId: string;
  sessionId: string;
  upstreamUrl: string;
  headers: Record<string, string>;
  body: string;
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}


async function createUpload(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = await body<
    CreateDeploymentUploadInput & { accountId?: string }
  >(request);
  const accountId = required(input.accountId, "accountId");
  const agentId = required(input.agentId, "agentId");
  const digest = required(input.digest, "digest");
  if (!Number.isFinite(input.size) || input.size < 0) {
    return json({ message: "size must be a positive number" }, 400);
  }
  const key =
    `accounts/${encodeURIComponent(accountId)}/agents/` +
    `${encodeURIComponent(agentId)}/${digest}.json`;
  const command = new PutObjectCommand({
    Bucket: env.BLUE_ARTIFACT_BUCKET,
    Key: key,
    ContentType: input.contentType,
  });
  const uploadUrl = await getSignedUrl(
    new S3Client(awsOptions(env)),
    command,
    { expiresIn: 15 * 60 },
  );
  const result: DeploymentUpload = {
    uploadUrl,
    method: "PUT",
    headers: {
      "content-type": input.contentType,
    },
    artifact: {
      bucket: env.BLUE_ARTIFACT_BUCKET,
      key,
      digest,
      size: input.size,
    },
  };
  return json(result, 201);
}

async function readArtifact(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = await body<AgentDeployment["artifact"]>(request);
  const bucket = required(input.bucket, "artifact.bucket");
  const key = required(input.key, "artifact.key");
  const digest = required(input.digest, "artifact.digest");
  if (
    bucket !== env.BLUE_ARTIFACT_BUCKET ||
    !key.startsWith("accounts/") ||
    !/^[a-f0-9]{64}$/.test(digest)
  ) {
    return json({ message: "Artifact reference is invalid" }, 400);
  }
  const result = await new S3Client(awsOptions(env)).send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!result.Body) return json({ message: "Artifact body is missing" }, 502);
  const bytes = await result.Body.transformToByteArray();
  if (input.size !== bytes.byteLength) {
    return json({ message: "Artifact size does not match its deployment" }, 409);
  }
  return new Response(bytes, {
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
      "x-opencomputer-artifact-digest": digest,
    },
  });
}

interface WorkspaceRequest {
  accountId?: unknown;
  sessionId?: unknown;
  path?: unknown;
  expected?: unknown;
  cursor?: unknown;
  key?: unknown;
}


function sessionScope(input: WorkspaceRequest): {
  accountId: string;
  sessionId: string;
} {
  const accountId = required(input.accountId, "accountId");
  const sessionId = required(input.sessionId, "sessionId");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    throw new Error("sessionId is invalid");
  }
  return { accountId, sessionId };
}

async function listWorkspaceFiles(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = await body<WorkspaceRequest>(request);
  const scope = sessionScope(input);
  const provider = await toolSandboxForWorkspace(env, scope.sessionId);
  return provider.listFiles(
    scope,
    typeof input.cursor === "string" && input.cursor ? input.cursor : undefined,
  );
}

async function exportWorkspaceFile(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = await body<WorkspaceRequest>(request);
  const scope = sessionScope(input);
  const path = exportableWorkspacePath(input.path);
  if (!path) return refuseWorkspaceExport("artifact_path_invalid", "Workspace path is not exportable");
  const expected = workspaceExportExpectation(input.expected);
  if (expected === undefined) {
    return refuseWorkspaceExport("artifact_path_invalid", "Expected bytes, sha256 or mediaType is malformed");
  }
  const provider = await toolSandboxForWorkspace(env, scope.sessionId);
  return provider.exportFile(scope, path, expected);
}


async function readWorkspaceArtifact(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = await body<WorkspaceRequest>(request);
  const { accountId, sessionId } = sessionScope(input);
  const key = required(input.key, "key");
  const prefix = workspaceArtifactPrefix(accountId, sessionId);
  if (!key.startsWith(prefix) || !/^[a-f0-9]{64}\/[a-f0-9]{64}$/.test(key.slice(prefix.length))) {
    return json({ message: "Artifact reference is invalid" }, 400);
  }
  const object = await new S3Client(awsOptions(env)).send(
    new GetObjectCommand({ Bucket: env.BLUE_ARTIFACT_BUCKET, Key: key }),
  );
  if (!object.Body) return json({ message: "Artifact body is missing" }, 502);
  const headers = new Headers({
    "content-type": object.ContentType ?? "application/octet-stream",
  });
  if (object.ContentLength !== undefined) {
    headers.set("content-length", String(object.ContentLength));
  }
  if (object.ETag) headers.set("etag", object.ETag);
  return new Response(object.Body.transformToWebStream(), { headers });
}


async function signWorkspaceArtifactDownload(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = await body<WorkspaceRequest & { filename?: unknown; mediaType?: unknown }>(request);
  const { accountId, sessionId } = sessionScope(input);
  const key = scopedWorkspaceArtifactKey(accountId, sessionId, input.key);
  if (!key) return json({ message: "Artifact reference is invalid" }, 400);
  const filename = workspaceDownloadFilename(input.filename);
  if (!filename) return json({ message: "Artifact filename is invalid" }, 400);
  const mediaType = required(input.mediaType, "mediaType");
  if (mediaType.length > 255 || /[\r\n]/.test(mediaType)) {
    return json({ message: "Artifact media type is invalid" }, 400);
  }
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
  const url = await getSignedUrl(
    new S3Client(awsOptions(env)),
    new GetObjectCommand({
      Bucket: env.BLUE_ARTIFACT_BUCKET,
      Key: key,
      ResponseContentDisposition: disposition,
      ResponseContentType: mediaType,
    }),
    { expiresIn: WORKSPACE_DOWNLOAD_URL_TTL_SECONDS },
  );
  return json({
    url,
    expiresAt: new Date(Date.now() + WORKSPACE_DOWNLOAD_URL_TTL_SECONDS * 1_000).toISOString(),
  });
}

async function signWorkspaceFileDownload(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = await body<WorkspaceRequest>(request);
  const scope = sessionScope(input);
  const path = exportableWorkspacePath(input.path);
  if (!path) return json({ code: "artifact_path_invalid", message: "Workspace path is not downloadable" }, 400);
  const provider = await toolSandboxForWorkspace(env, scope.sessionId);
  return provider.signDownload(scope, path);
}

async function startRuntime(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const startedAt = Date.now();
  const input = await body<StartRuntimeInput>(request);
  const accountId = required(input.accountId, "accountId");
  const sessionId = required(input.sessionId, "sessionId");
  required(input.runtimeToken, "runtimeToken");
  required(input.edge, "edge");
  if (modalSessionRuntimeSelected(env)) {
    const started = await startModalSessionRuntime(env, {
      accountId,
      projectId: required(input.projectId, "projectId"),
      sessionId,
      runtimeToken: input.runtimeToken,
      edge: input.edge,
      deployment: input.deployment,
    });
    console.log(
      JSON.stringify({
        level: "info",
        event: "platform.session_runtime_started",
        provider: "modal",
        sessionId,
        deploymentId: input.deployment.id,
        sandboxId: started.microvmId,
        resumedFromSnapshot: started.resumedFromSnapshot,
        shimReadyMs: started.shimReadyMs,
        hookMs: started.hookMs,
        totalMs: Date.now() - startedAt,
      }),
    );
    return json(
      {
        microvmId: started.microvmId,
        endpoint: started.endpoint,
        accessPointId: started.accessPointId,
        provider: started.provider,
      },
      201,
    );
  }
  return json({ message: "No session runtime provider is configured" }, 503);
}

/**
 * Whether a session runtime sandbox is still up. Only a provider that claims
 * the id answers; any other id reads `unknown` and the caller trusts its own state.
 */
async function runtimeStatus(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = await body<RuntimeActionInput>(request);
  const microvmId = required(input.microvmId, "microvmId");
  const sandbox = toolSandboxForId(env, microvmId);
  const state = sandbox.runtimeStatus
    ? await sandbox.runtimeStatus(microvmId)
    : "unknown";
  return json({ microvmId, state });
}

/**
 * Every running Modal sandbox, with the session it was created for, for the
 * edge's idle sweep. Empty where Modal is not configured.
 */
async function liveSandboxes(env: PlatformEnv): Promise<Response> {
  if (!modalProviderEnabled(env)) return json({ sandboxes: [] });
  const sandboxes = await modalSandboxList(env);
  return json({
    sandboxes: sandboxes.map((sandbox) => ({
      sandboxId: sandbox.sandbox_id,
      sessionId: sandbox.session_id,
      seenAtMs: sandbox.seen_at * 1_000,
    })),
  });
}

async function changeRuntime(
  request: Request,
  env: PlatformEnv,
  action: "resume" | "suspend" | "terminate",
): Promise<Response> {
  const input = await body<RuntimeActionInput>(request);
  required(input.accountId, "accountId");
  const microvmId = required(input.microvmId, "microvmId");
  // Only a provider that claims the id (Modal, for sb- ids) acts on it; any
  // other id must never reach the shim (its terminate swallows not-found,
  // which would report a sandbox it never looked at as gone).
  const sandbox = toolSandboxForId(env, microvmId);
  if (!sandbox.runtimeAction) {
    throw new Error(`No sandbox provider can ${action} ${microvmId}`);
  }
  await sandbox.runtimeAction(microvmId, action);
  return json({ microvmId, state: action });
}

async function sandboxEnsure(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const startedAt = Date.now();
  const input = parseSandboxEnsureInput(await body<unknown>(request));
  const provider = await toolSandboxForEnsure(env, input);
  return provider.ensure(input, startedAt, (sandboxId, generation, path, timeoutMs) =>
    supervisorRequest(env, sandboxId, generation, path, undefined, timeoutMs),
  );
}


/**
 * Endpoints and tokens of the sandboxes this isolate talks to, reused
 * across the status polls of a command (about one a second) for the
 * token's validity and the computer's generation. A refresh looks the
 * sandbox up, once.
 */
const supervisorEndpoints = new MicrovmEndpointCache({
  validityMs: SUPERVISOR_TOKEN_MINUTES * 60_000,
  refreshMarginMs: 30_000,
});

/**
 * Looks the sandbox up through the provider that owns it. Unavailable when
 * it is not running, with its state.
 */
function freshSupervisorEndpoint(
  env: PlatformEnv,
  sandboxId: string,
): Promise<SupervisorEndpoint | { unavailable: string }> {
  return toolSandboxForId(env, sandboxId).endpoint(sandboxId);
}


/**
 * One request to the supervisor inside a running sandbox, with the
 * sandbox's token. The endpoint and token come from the cache within
 * their validity and the generation asked; a token the supervisor refuses
 * (401/403) is dropped and the request retried once with a fresh one; an
 * endpoint that does not answer is dropped and the sandbox looked up
 * again, so a computer that is gone answers 503 here as it did when every
 * request looked it up.
 */
async function supervisorRequest(
  env: PlatformEnv,
  sandboxId: string,
  generation: number,
  path: string,
  payload: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<Response> {
  const unavailable = (state: string) =>
    json({ message: "The sandbox MicroVM is unavailable", state }, 503);
  const resolve = async (): Promise<
    { base: string; token: string; port: number; tokenHeader?: string } | Response
  > => {
    let state = "unknown";
    const endpoint = await supervisorEndpoints.resolve(sandboxId, generation, async () => {
      const fresh = await freshSupervisorEndpoint(env, sandboxId);
      if ("unavailable" in fresh) {
        state = fresh.unavailable;
        return null;
      }
      return fresh;
    });
    return endpoint ?? unavailable(state);
  };
  const send = async (
    endpoint: { base: string; token: string; port: number; tokenHeader?: string },
    attempt: "initial" | "network-retry" | "auth-retry",
  ): Promise<Response> => {
    const startedAt = Date.now();
    try {
      const response = await fetch(`${endpoint.base}${path}`, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          // Modal tunnel endpoints authenticate with the per-sandbox bearer
          // the supervisor expects on x-sandbox-token. An empty token means
          // the endpoint needs none.
          ...(endpoint.token && endpoint.tokenHeader
            ? { [endpoint.tokenHeader]: endpoint.token }
            : {}),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      console.log(
        JSON.stringify({
          level: "info",
          event: "platform.supervisor_proxy_response",
          sandboxId,
          generation,
          path,
          method: payload === undefined ? "GET" : "POST",
          selectedPort: endpoint.port,
          attempt,
          status: response.status,
          durationMs: Date.now() - startedAt,
          cacheStatus: response.headers.get("cf-cache-status"),
          age: response.headers.get("age"),
          server: response.headers.get("server"),
          via: response.headers.get("via"),
        }),
      );
      return response;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "platform.supervisor_proxy_error",
          sandboxId,
          generation,
          path,
          method: payload === undefined ? "GET" : "POST",
          selectedPort: endpoint.port,
          attempt,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  };
  let endpoint = await resolve();
  if (endpoint instanceof Response) return endpoint;
  let response: Response;
  try {
    response = await send(endpoint, "initial");
  } catch (error) {
    // The cached endpoint did not answer: look the MicroVM up again. A
    // computer that is gone is reported so; one still running gets the
    // request once more.
    supervisorEndpoints.invalidate(sandboxId);
    endpoint = await resolve();
    if (endpoint instanceof Response) return endpoint;
    try {
      response = await send(endpoint, "network-retry");
    } catch {
      throw error;
    }
  }
  if (response.status === 401 || response.status === 403) {
    supervisorEndpoints.invalidate(sandboxId);
    endpoint = await resolve();
    if (endpoint instanceof Response) return endpoint;
    response = await send(endpoint, "auth-retry");
  }
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

async function sandboxExecute(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = parseSandboxExecuteInput(await body<unknown>(request));
  return supervisorRequest(
    env,
    input.sandboxId,
    input.generation,
    "/tool-exec",
    {
      sessionId: input.sessionID,
      generation: input.generation,
      toolCallId: input.toolCallID,
      capability: input.capability,
      request: input.request,
    },
    15_000,
  );
}

async function sandboxExecuteStatus(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = parseSandboxExecuteStatusInput(await body<unknown>(request));
  const waitMs = input.waitMs ?? 0;
  return supervisorRequest(
    env,
    input.sandboxId,
    input.generation,
    "/tool-exec/status",
    {
      sessionId: input.sessionID,
      generation: input.generation,
      toolCallId: input.toolCallID,
      after: input.after,
      ...(input.waitMs === undefined ? {} : { waitMs }),
    },
    // A long poll holds the upstream request for its wait before the
    // supervisor answers, so the proxy's own timeout must exceed it.
    15_000 + waitMs,
  );
}

/**
 * Terminates one operation's process unit and returns the supervisor's
 * settlement reply. The wait is bounded by the supervisor's own grace and
 * empty-unit waits plus transport; a reply that does not arrive is not a
 * settlement, and the host treats it as such.
 */
async function sandboxExecuteCancel(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = parseSandboxExecuteCancelInput(await body<unknown>(request));
  return supervisorRequest(
    env,
    input.sandboxId,
    input.generation,
    "/tool-exec/cancel",
    {
      sessionId: input.sessionID,
      generation: input.generation,
      toolCallId: input.toolCallID,
      reason: input.reason,
    },
    20_000,
  );
}

/**
 * Liveness of a sandbox computer: the MicroVM is running and its supervisor
 * answers for the session and generation the lease names. A probe never
 * fails as a request; whatever could not be established is `alive: false`
 * with the reason, and the host treats that as uncertainty to be resolved
 * by confirmed termination.
 */
async function sandboxProbe(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = parseSandboxProbeInput(await body<unknown>(request));
  const result = (alive: boolean, reason?: string, extra: Record<string, unknown> = {}) =>
    json({
      alive,
      sandboxId: input.sandboxId,
      generation: input.generation,
      ...(reason ? { reason } : {}),
      ...extra,
    });
  try {
    const response = await supervisorRequest(env, input.sandboxId, input.generation, "/health", undefined, 5_000);
    if (!response.ok) {
      return result(false, `supervisor returned ${String(response.status)}`);
    }
    const verdict = interpretSupervisorHealth(await response.json(), input);
    if (!verdict.alive) {
      return result(false, verdict.reason, verdict.supervisor ? { supervisor: verdict.supervisor } : {});
    }
    return result(true, undefined, verdict.bootId !== null ? { bootId: verdict.bootId } : {});
  } catch (error) {
    return result(false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Terminates a sandbox computer and returns only once the platform reports
 * it terminated. Idempotent: a MicroVM already terminated, or one the
 * platform no longer knows, is reported terminated without a second call.
 */
async function sandboxTerminate(
  request: Request,
  env: PlatformEnv,
): Promise<Response> {
  const input = parseSandboxTerminateInput(await body<unknown>(request));
  if (!input.sandboxId) {
    return json({ state: "not_found", generation: input.generation });
  }
  await toolSandboxForId(env, input.sandboxId).retire({
    sandboxId: input.sandboxId,
    sessionID: input.sessionID,
    generation: input.generation,
    preserve: input.preserve,
  });
  return json({
    sandboxId: input.sandboxId,
    generation: input.generation,
    state: "terminated",
  });
}


async function relayCodexRequest(request: Request): Promise<Response> {
  const input = await body<CodexRelayInput>(request);
  required(input.accountId, "accountId");
  required(input.microvmId, "microvmId");
  required(input.sessionId, "sessionId");
  if (input.upstreamUrl !== "https://chatgpt.com/backend-api/codex/responses") {
    return json({ message: "Unsupported Codex upstream" }, 400);
  }
  if (
    !input.headers ||
    typeof input.headers !== "object" ||
    Array.isArray(input.headers) ||
    typeof input.body !== "string" ||
    input.body.length > 16 * 1024 * 1024
  ) {
    return json({ message: "Invalid Codex relay request" }, 400);
  }

  // Nothing relays a Codex request into a session runtime now.
  return json({ message: "Codex relay runtime is unavailable" }, 503);
}

export default {
  async fetch(request: Request, env: PlatformEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === "/v1/deployment-uploads"
      ) {
        return createUpload(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/artifacts/read") {
        return readArtifact(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/workspaces/list") {
        return listWorkspaceFiles(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/workspaces/export") {
        return exportWorkspaceFile(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/workspaces/download") {
        return signWorkspaceFileDownload(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/workspaces/artifacts/read"
      ) {
        return readWorkspaceArtifact(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/workspaces/artifacts/download"
      ) {
        return signWorkspaceArtifactDownload(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sandboxes/ensure"
      ) {
        return sandboxEnsure(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sandboxes/execute"
      ) {
        return sandboxExecute(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sandboxes/execute/status"
      ) {
        return sandboxExecuteStatus(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sandboxes/execute/cancel"
      ) {
        return sandboxExecuteCancel(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sandboxes/probe"
      ) {
        return sandboxProbe(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sandboxes/terminate"
      ) {
        return sandboxTerminate(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/computers/arm") {
        return handleComputerArmRequest(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        return startRuntime(request, env);
      }
      if (request.method === "POST" && url.pathname === "/v1/codex-relay") {
        return relayCodexRequest(request);
      }
      if (request.method === "GET" && url.pathname === "/v1/sandboxes/live") {
        return liveSandboxes(env);
      }
      if (
        request.method === "POST" &&
        /^\/v1\/sessions\/[^/]+\/status$/.test(url.pathname)
      ) {
        return runtimeStatus(request, env);
      }
      const match = url.pathname.match(
        /^\/v1\/sessions\/[^/]+\/(resume|suspend|terminate)$/,
      );
      if (request.method === "POST" && match?.[1]) {
        return changeRuntime(
          request,
          env,
          match[1] as "resume" | "suspend" | "terminate",
        );
      }
      return json({ message: "Route not found" }, 404);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "platform.request_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ message: "Platform operation failed" }, 500);
    }
  },
} satisfies ExportedHandler<PlatformEnv>;
