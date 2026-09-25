import { createHash } from "node:crypto";

import type { ResolvedConfig } from "./config.js";
import type { MemoryDeclaration, ProjectResourceManifest } from "./project.js";

export interface OpenComputerIdentity {
  user_id: string | null;
  email: string | null;
  org_id: string;
  org_name: string | null;
}

export interface ManagedAgentSummary {
  id: string;
  name?: string;
  activeAlias?: string;
  deploymentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedProject {
  id: string;
  slug: string;
  name: string;
  /** One row per project agent and environment: that member's active deployment there. */
  environments: Array<{
    name: "development" | "production";
    agentId?: string;
    activeDeploymentId?: string;
    updatedAt: string;
  }>;
  agents: Array<{ id: string; name: string }>;
  createdAt: string;
  updatedAt: string;
}

export type DatabaseValue = string | number | null;

export interface DatabaseResult {
  columns: string[];
  rows: Array<Record<string, DatabaseValue>>;
  rowsAffected: number;
  truncated: boolean;
}

export interface ManagedAgentDeployment {
  id: string;
  agentId: string;
  alias: string;
  projectDeploymentId?: string;
  localAgentId?: string;
  createdAt: string;
  models?: Array<{ provider: string; model: string }>;
  defaultModel?: { provider: string; model: string };
}

export interface ManagedAgentEvent {
  id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export interface ManagedSecretMetadata {
  name: string;
  projectId: string;
  environment: "development" | "production";
  agentId?: string;
  allowedOrigins: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ManagedGitHubInstallation {
  id: string;
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  state: "active" | "suspended" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface ManagedGitHubStatus {
  environments: Array<{
    environment: "development" | "production";
    state: "not_connected" | "active" | "suspended" | "deleted";
    installation?: ManagedGitHubInstallation;
  }>;
  connections: ManagedGitHubInstallation[];
  app: { slug: string } | null;
}

// Model access (work 011). The provider token is write-only; these shapes
// carry only normalized metadata.
/** An account the platform holds an OAuth credential for. */
export interface ServiceConnection {
  id: string;
  /** `google` or `github` — the grant, not the API being called. */
  provider: string;
  /** The alias it was connected under; what an agent passes as `label`. */
  label: string;
  /** Who the account belongs to, e.g. the mailbox address. */
  displayName?: string;
  scopes?: string[];
  status: string;
}

export interface ModelAccessConnection {
  id: string;
  organizationId: string;
  connectedByUserId: string;
  provider: "anthropic" | "openai" | "openrouter" | "openai_compatible";
  kind:
    | "claude_subscription"
    | "codex_subscription"
    | "openrouter_api_key"
    | "openai_compatible_api";
  label: string;
  baseUrl?: string;
  externalAccountHint?: string;
  status: string;
  checkedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModelAccessBinding {
  organizationId: string;
  projectId: string;
  environment: "development" | "production";
  provider: "anthropic" | "openai";
  connectionId: string;
  enabled: boolean;
  enabledByUserId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModelRoute {
  id: string;
  projectId: string;
  environment: "development" | "production";
  agentId?: string;
  connectionId: string;
  model: string;
  fallback: "fail" | "managed";
  revision: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentRuntimeVariableMetadata {
  name: string;
  projectId: string;
  environment: "development" | "production";
  agentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInspection {
  id: string;
  repository: {
    url: string;
    fullName: string;
    defaultBranch: "main";
    commitSha: string;
  };
  template: {
    name: string;
    description: string;
    documentation?: string;
    defaultProjectName?: string;
    firstRun?: { agent: string; prompt: string };
  };
  agents: Array<{ id: string; name: string }>;
  requirements: {
    secrets: Array<{
      name: string;
      description?: string;
      documentation?: string;
      required?: boolean;
      agentId?: string;
      allowedOrigins: string[];
    }>;
    runtimeVariables: Array<{
      name: string;
      description?: string;
      documentation?: string;
      required: boolean;
      example?: string;
      agentId?: string;
    }>;
    connections: Array<{
      id: string;
      description?: string;
      provider: string;
      permissions: string[];
    }>;
  };
  expiresAt: string;
}

interface TemplateInspectionPreparing {
  id: string;
  status: "preparing";
  repositoryUrl: string;
  retryAfterMs: number;
}

export interface TemplateInstallation {
  id: string;
  inspectionId: string;
  projectId: string;
  projectAgentId: string;
  projectUrl: string;
  state:
    | "awaiting_configuration"
    | "creating_project"
    | "building"
    | "deploying"
    | "ready"
    | "failed";
  error?: { stage: string; message: string };
}

export interface ManagedAgentWebhook {
  id: string;
  projectId: string;
  environment: "development" | "production";
  agentId: string;
  name: string;
  enabled: boolean;
  /** Delivery identity source, `header:<name>` or `body:<json-pointer>`. */
  identity?: string;
  invocationUrl: string;
  token?: string;
  createdAt: string;
  updatedAt: string;
  lastInvokedAt?: string;
}

export interface ManagedAgentLog {
  id: string;
  cursor: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  environment: "development" | "production";
  agentId: string;
  deploymentId: string;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface ManagedChannelStatus {
  id: string;
  channel: "slack";
  channelId?: string;
  agentId: string;
  alias: string;
  appName?: string;
  teamName?: string;
  status: string;
  verifiedAt?: string;
  lastEventAt?: string;
  lastDelivery?: {
    status: "delivered" | "failed";
    at: string;
  };
  lastError?: {
    category: string;
    at: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ManagedSessionSnapshot {
  id: string;
  status: string;
  agentId?: string;
  deploymentId?: string;
  microvmState?: string;
  createdAt?: string;
  updatedAt?: string;
  turns?: Array<{
    id: string;
    input: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

/** One row of `GET /sessions` (docs/agents/api.mdx, "Get and list"): no turns. */
export interface ManagedSessionSummary {
  id: string;
  projectId: string;
  agentId: string;
  deploymentId: string;
  environment: "development" | "production" | null;
  source: string;
  status: string;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  revision: number;
  activity: {
    activeTurnId: string | null;
    queued: number;
    lastSettledTurn: { id: string; status: string; at: string } | null;
  };
  result: {
    turnId: string;
    callId: string;
    reportedAt: string;
    data: unknown;
  } | null;
}

export interface ManagedSessionPage {
  sessions: ManagedSessionSummary[];
  nextCursor: string | null;
}

export type MemoryEnvironment = "development" | "production";

export type MemoryWriter =
  { kind: "owner" } | { kind: "agent"; sessionId: string };

/** One document's metadata, as the list route returns it (no text). */
export interface MemoryDocumentMeta {
  id: string;
  title: string;
  summary: string;
  agentWrites: "enabled" | "disabled";
  revision: string;
  bytes: number;
  maxBytes: number;
  updatedAt: string;
  writer: MemoryWriter;
}

/** A full document, as read, create, replace and patch return it. */
export interface MemoryDocument extends MemoryDocumentMeta {
  text: string;
}

export interface MemoryDocumentPage {
  documents: MemoryDocumentMeta[];
  nextCursor: string | null;
}

/**
 * One entry of the environment's resource inventory: storage outlives code,
 * so `declared` says whether an active deployment still names the resource
 * and `documents` counts the live documents it holds.
 */
export interface MemoryResource {
  id: string;
  provider: { kind?: string; maxBytes?: number };
  declared: boolean;
  documents: number;
}

/** A document together with the `ETag` the next conditional request must send back verbatim. */
export interface MemoryDocumentRead {
  document: MemoryDocument;
  etag: string;
}

/**
 * A session's memory binding (docs/agents/document-memory.mdx, "Session
 * bindings"), keyed by resource id in the session create body.
 */
export type MemoryBinding =
  | { scope: "document"; id: string; access?: "read" | "read-write" }
  | { scope: "collection"; access?: "read" };

export type MemoryBindings = Record<string, MemoryBinding>;

export interface CreateSessionResult {
  /** 201 created the session; 200 replayed an earlier create under the same Idempotency-Key. */
  created: boolean;
  session: ManagedSessionSnapshot;
  deployment?: ManagedAgentDeployment;
}

export class APIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The typed reason from `{ error: { code } }` when the API sent one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

function errorCode(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>).error;
    if (error && typeof error === "object") {
      const code = (error as Record<string, unknown>).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object") {
      const message = (record.error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof record.message === "string") return record.message;
  }
  return `OpenComputer request failed (${status})`;
}

export class OpenComputerClient {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly idempotencyKey?: string,
  ) {}

  /**
   * The caller's key scoped to one operation. Extra `parts` distinguish
   * operations that share a URL but target different resources (one export
   * per workspace path), so a stable key still retries each of them.
   */
  private derivedIdempotencyKey(
    method: string,
    path: string,
    ...parts: string[]
  ): string {
    const hash = createHash("sha256")
      .update(this.idempotencyKey ?? "")
      .update("\0")
      .update(method)
      .update("\0")
      .update(path);
    for (const part of parts) hash.update("\0").update(part);
    return hash.digest("hex");
  }

  private async response(
    path: string,
    init: RequestInit = {},
    authenticated = true,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (authenticated) {
      if (!this.config.apiKey) {
        throw new Error(
          "Not logged in. Run `opencomputer login` or set OPENCOMPUTER_API_KEY.",
        );
      }
      headers.set("x-api-key", this.config.apiKey);
    }
    const method = (init.method ?? "GET").toUpperCase();
    // The caller's key names an operation on a target; the body is what the
    // backend compares under that key. Hashing the body in would make a
    // retry with different inputs a new operation instead of the conflict
    // the key promises.
    if (
      this.idempotencyKey &&
      method !== "GET" &&
      method !== "HEAD" &&
      !headers.has("idempotency-key")
    ) {
      headers.set("idempotency-key", this.derivedIdempotencyKey(method, path));
    }
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      ...init,
      headers,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      throw new APIError(
        errorMessage(body, response.status),
        response.status,
        errorCode(body),
      );
    }
    return response;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    authenticated = true,
  ): Promise<T> {
    const response = await this.response(path, init, authenticated);
    if (response.status === 204) return undefined as T;
    const body: unknown = await response.json().catch(() => undefined);
    return body as T;
  }

  startLogin() {
    return this.request<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>("/auth/cli/device", { method: "POST" }, false);
  }

  exchangeLogin(deviceCode: string, credentialName: string) {
    return this.request<{
      status: "authorization_pending" | "authorized";
      retry_after?: number;
      credential?: {
        id: string;
        key: string;
        key_prefix: string;
        name: string;
      };
    }>(
      "/auth/cli/device/exchange",
      {
        method: "POST",
        body: JSON.stringify({
          device_code: deviceCode,
          credential_name: credentialName,
        }),
      },
      false,
    );
  }

  whoami() {
    return this.request<OpenComputerIdentity>("/api/whoami");
  }

  revokeCredential() {
    return this.request<void>("/auth/cli/credential", { method: "DELETE" });
  }

  async agents(): Promise<ManagedAgentSummary[]> {
    const result = await this.request<{ agents: ManagedAgentSummary[] }>(
      "/api/managed-agents/agents",
    );
    return result.agents;
  }

  async projects(): Promise<ManagedProject[]> {
    const result = await this.request<{ projects: ManagedProject[] }>(
      "/api/managed-agents/projects",
    );
    return result.projects;
  }

  createProject(name: string, slug: string) {
    return this.request<ManagedProject>("/api/managed-agents/projects", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
  }

  projectSourceArchive(projectId: string): Promise<Response> {
    return this.response(
      `/api/managed-agents/projects/${encodeURIComponent(projectId)}/source-archive`,
    );
  }

  githubStatus(projectId: string) {
    return this.request<ManagedGitHubStatus>(
      `/api/managed-agents/projects/${encodeURIComponent(projectId)}/github`,
    );
  }

  connectGitHub(input: {
    projectId: string;
    environments?: Array<"development" | "production">;
  }) {
    return this.request<{ installUrl: string; authorizeUrl: string }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/github/connect`,
      {
        method: "POST",
        body: JSON.stringify(
          input.environments ? { environments: input.environments } : {},
        ),
      },
    );
  }

  attachGitHub(input: {
    projectId: string;
    environment: "development" | "production";
    connectionId: string;
  }) {
    return this.request<{ attached: boolean }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/github/attach`,
      {
        method: "POST",
        body: JSON.stringify({
          environment: input.environment,
          connectionId: input.connectionId,
        }),
      },
    );
  }

  disconnectGitHub(input: {
    projectId: string;
    environment: "development" | "production";
  }) {
    return this.request<void>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/github?environment=${input.environment}`,
      { method: "DELETE" },
    );
  }

  async inspectTemplate(repositoryUrl: string): Promise<TemplateInspection> {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const result = await this.request<
        TemplateInspection | TemplateInspectionPreparing
      >("/api/managed-agents/template-inspections", {
        method: "POST",
        body: JSON.stringify({ repositoryUrl }),
      });
      if ((result as TemplateInspectionPreparing).status !== "preparing") {
        return result as TemplateInspection;
      }
      const preparing = result as TemplateInspectionPreparing;
      if (Date.now() >= deadline) {
        throw new Error(
          "Template preparation is still running; try again shortly",
        );
      }
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.max(500, preparing.retryAfterMs)),
      );
    }
  }

  createTemplateInstallation(input: {
    inspectionId: string;
    projectName: string;
    idempotencyKey: string;
  }) {
    return this.request<TemplateInstallation>(
      "/api/managed-agents/template-installations",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  finalizeTemplateInstallation(installationId: string) {
    return this.request<TemplateInstallation>(
      `/api/managed-agents/template-installations/${encodeURIComponent(installationId)}/finalize`,
      { method: "POST" },
    );
  }

  templateInstallation(installationId: string) {
    return this.request<TemplateInstallation>(
      `/api/managed-agents/template-installations/${encodeURIComponent(installationId)}`,
    );
  }

  async secrets(input: {
    projectId: string;
    environment?: "development" | "production";
    agentId?: string;
  }): Promise<ManagedSecretMetadata[]> {
    const query = new URLSearchParams();
    if (input.environment) query.set("environment", input.environment);
    if (input.agentId) query.set("agentId", input.agentId);
    const suffix = query.size ? `?${query.toString()}` : "";
    const result = await this.request<{ secrets: ManagedSecretMetadata[] }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/secrets${suffix}`,
    );
    return result.secrets;
  }

  putSecret(input: {
    projectId: string;
    name: string;
    value: string;
    environment: "development" | "production";
    agentId?: string;
    allowedOrigins: string[];
  }) {
    return this.request<ManagedSecretMetadata>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/secrets/${encodeURIComponent(input.name)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          value: input.value,
          environment: input.environment,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          allowedOrigins: input.allowedOrigins,
        }),
      },
    );
  }

  deleteSecret(input: {
    projectId: string;
    name: string;
    environment: "development" | "production";
    agentId?: string;
  }) {
    const query = new URLSearchParams({ environment: input.environment });
    if (input.agentId) query.set("agentId", input.agentId);
    return this.request<void>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/secrets/${encodeURIComponent(input.name)}?${query.toString()}`,
      { method: "DELETE" },
    );
  }

  // ── Connected services ───────────────────────────────────────────────────
  // Accounts the platform holds an OAuth credential for, reached from an agent
  // with callService(). The provider segment is the grant — google covers
  // gmail, calendar, drive and sheets; github and linear are their own.

  async serviceConnections(): Promise<ServiceConnection[]> {
    const result = await this.request<{ connections: ServiceConnection[] }>(
      "/api/managed-agents/connections",
    );
    return result.connections ?? [];
  }

  /**
   * Begin connecting an account. Returns a link for whoever owns it to open;
   * no credential passes through the CLI, and the person consenting never
   * signs in to OpenComputer.
   */
  linkServiceConnection(input: { service: string; label?: string }) {
    const provider =
      input.service === "github" || input.service === "linear"
        ? input.service
        : "google";
    return this.request<{
      service: string;
      label: string;
      status: string;
      authorizationUrl?: string;
      connectionId?: string;
      expiresAt?: string;
    }>(`/api/managed-agents/connections/${provider}/link`, {
      method: "POST",
      body: JSON.stringify({
        service: input.service,
        ...(input.label ? { label: input.label } : {}),
      }),
    });
  }

  /**
   * Live status for one connected account.
   *
   * Unlike the listing, this reconciles: it asks the provider whether the
   * consent completed and records the answer. A connection that was left
   * `pending` in the listing becomes `connected` here once someone has
   * actually authorized it.
   */
  serviceConnectionStatus(input: { service: string; label: string }) {
    const provider =
      input.service === "github" || input.service === "linear"
        ? input.service
        : "google";
    const query = new URLSearchParams({
      service: input.service,
      label: input.label,
    });
    return this.request<{
      service: string;
      label: string;
      status: string;
      connectionId?: string;
      scopes?: string[];
    }>(
      `/api/managed-agents/connections/${provider}/status?${query.toString()}`,
    );
  }

  disconnectServiceConnection(input: {
    service: string;
    connectionId: string;
  }) {
    const provider =
      input.service === "github" || input.service === "linear"
        ? input.service
        : "google";
    const query = new URLSearchParams({
      service: input.service,
      connectionId: input.connectionId,
    });
    return this.request<void>(
      `/api/managed-agents/connections/${provider}?${query.toString()}`,
      { method: "DELETE" },
    );
  }

  // ── Model access (work 011) ──────────────────────────────────────────────
  async modelAccessConnections(): Promise<ModelAccessConnection[]> {
    const result = await this.request<{ data: ModelAccessConnection[] }>(
      "/api/managed-agents/model-access/connections",
    );
    return result.data;
  }

  // Starts the personal Codex subscription OAuth flow. No token is given or
  // accepted; returns a pending intent with an authorize_url.
  connectModelAccess(input: { provider: "openai"; label?: string }) {
    return this.request<{
      connection: ModelAccessConnection;
      status: "pending";
      authorize_url: string;
      expires_at: string;
    }>("/api/managed-agents/model-access/connections", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  connectModelAccessApiKey(input: {
    provider: "openrouter" | "openai_compatible";
    api_key: string;
    base_url?: string;
    label?: string;
  }) {
    return this.request<ModelAccessConnection>(
      "/api/managed-agents/model-access/connections",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async modelRoutes(projectId: string): Promise<ModelRoute[]> {
    const result = await this.request<{ data: ModelRoute[] }>(
      `/api/managed-agents/projects/${encodeURIComponent(projectId)}/model-routes`,
    );
    return result.data;
  }

  putModelRoute(input: {
    projectId: string;
    environment: "development" | "production";
    connectionId: string;
    model: string;
    agentId?: string;
    fallback: "fail" | "managed";
  }) {
    return this.request<ModelRoute>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/model-routes/${input.environment}`,
      {
        method: "PUT",
        body: JSON.stringify({
          connection_id: input.connectionId,
          model: input.model,
          fallback: input.fallback,
          ...(input.agentId ? { agent_id: input.agentId } : {}),
        }),
      },
    );
  }

  deleteModelRoute(input: {
    projectId: string;
    environment: "development" | "production";
    agentId?: string;
  }) {
    return this.request<void>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/model-routes/${input.environment}`,
      {
        method: "DELETE",
        body: JSON.stringify(input.agentId ? { agent_id: input.agentId } : {}),
      },
    );
  }

  // Relays a credential the local CLI obtained through the authorized Codex
  // OAuth flow into a connected subscription (encrypted custody server-side).
  relayModelAccess(
    id: string,
    credential: {
      access_token: string;
      refresh_token?: string;
      token_type: string;
      expires_at: number;
    },
  ) {
    return this.request<ModelAccessConnection>(
      `/api/managed-agents/model-access/connections/${encodeURIComponent(id)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          access_token: credential.access_token,
          refresh_token: credential.refresh_token,
          token_type: credential.token_type,
          expires_at: credential.expires_at,
        }),
      },
    );
  }

  disconnectModelAccess(id: string) {
    return this.request<ModelAccessConnection>(
      `/api/managed-agents/model-access/connections/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async modelAccessBindings(projectId: string): Promise<ModelAccessBinding[]> {
    const result = await this.request<{ data: ModelAccessBinding[] }>(
      `/api/managed-agents/projects/${encodeURIComponent(projectId)}/model-access/bindings`,
    );
    return result.data;
  }

  putModelAccessBinding(input: {
    projectId: string;
    provider: "anthropic" | "openai";
    environment: "development" | "production";
    enabled: boolean;
  }) {
    return this.request<ModelAccessBinding>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/model-access/bindings/${input.provider}/${input.environment}`,
      { method: "PUT", body: JSON.stringify({ enabled: input.enabled }) },
    );
  }

  async runtimeVariables(input: {
    projectId: string;
    environment?: "development" | "production";
    agentId?: string;
  }): Promise<AgentRuntimeVariableMetadata[]> {
    const query = new URLSearchParams();
    if (input.environment) query.set("environment", input.environment);
    if (input.agentId) query.set("agentId", input.agentId);
    const suffix = query.size ? `?${query.toString()}` : "";
    const result = await this.request<{
      variables: AgentRuntimeVariableMetadata[];
    }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/runtime-variables${suffix}`,
    );
    return result.variables;
  }

  putRuntimeVariable(input: {
    projectId: string;
    name: string;
    value: string;
    environment: "development" | "production";
    agentId?: string;
  }) {
    return this.request<AgentRuntimeVariableMetadata>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/runtime-variables/${encodeURIComponent(input.name)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          value: input.value,
          environment: input.environment,
          ...(input.agentId ? { agentId: input.agentId } : {}),
        }),
      },
    );
  }

  deleteRuntimeVariable(input: {
    projectId: string;
    name: string;
    environment: "development" | "production";
    agentId?: string;
  }) {
    const query = new URLSearchParams({ environment: input.environment });
    if (input.agentId) query.set("agentId", input.agentId);
    return this.request<void>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/runtime-variables/${encodeURIComponent(input.name)}?${query.toString()}`,
      { method: "DELETE" },
    );
  }

  async webhooks(input: {
    projectId: string;
    environment?: "development" | "production";
    agentId?: string;
  }): Promise<ManagedAgentWebhook[]> {
    const query = new URLSearchParams();
    if (input.environment) query.set("environment", input.environment);
    if (input.agentId) query.set("agentId", input.agentId);
    const suffix = query.size ? `?${query.toString()}` : "";
    const result = await this.request<{ webhooks: ManagedAgentWebhook[] }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks${suffix}`,
    );
    return result.webhooks;
  }

  createWebhook(input: {
    projectId: string;
    name: string;
    environment: "development" | "production";
    agentId: string;
    identity?: string;
  }) {
    return this.request<{ webhook: ManagedAgentWebhook }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks`,
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          environment: input.environment,
          agentId: input.agentId,
          ...(input.identity !== undefined ? { identity: input.identity } : {}),
        }),
      },
    ).then((result) => result.webhook);
  }

  updateWebhook(input: {
    projectId: string;
    webhookId: string;
    name?: string;
    enabled?: boolean;
    /** A source sets it; null clears it. */
    identity?: string | null;
  }) {
    return this.request<{ webhook: ManagedAgentWebhook }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks/${encodeURIComponent(input.webhookId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.identity !== undefined ? { identity: input.identity } : {}),
        }),
      },
    ).then((result) => result.webhook);
  }

  rotateWebhookToken(input: { projectId: string; webhookId: string }) {
    return this.request<{ webhook: ManagedAgentWebhook }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks/${encodeURIComponent(input.webhookId)}/rotate-token`,
      { method: "POST" },
    ).then((result) => result.webhook);
  }

  deleteWebhook(input: { projectId: string; webhookId: string }) {
    return this.request<void>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks/${encodeURIComponent(input.webhookId)}`,
      { method: "DELETE" },
    );
  }

  deployment(deploymentId: string) {
    return this.request<
      ManagedAgentDeployment & {
        /** Memory resources the deployment declares; absent on older deployments. */
        memory?: Array<{
          id: string;
          description?: string;
          provider?: { kind?: string; maxBytes?: number };
        }>;
      }
    >(`/api/managed-agents/deployments/${encodeURIComponent(deploymentId)}`);
  }

  async databaseQuery(input: {
    projectId: string;
    environment: "development" | "production";
    sql: string;
    parameters?: Array<string | number | boolean | null>;
  }): Promise<DatabaseResult> {
    const response = await this.request<{
      environment: "development" | "production";
      result: DatabaseResult;
    }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/database/query`,
      {
        method: "POST",
        body: JSON.stringify({
          environment: input.environment,
          sql: input.sql,
          parameters: input.parameters ?? [],
        }),
      },
    );
    return response.result;
  }

  // Project memory (docs/agents/document-memory.mdx, "Management API").
  // Every mutation is conditional: the caller sends back the ETag it read.

  private memoryPath(input: {
    projectId: string;
    resource: string;
    id?: string;
    environment: MemoryEnvironment;
    cursor?: string;
  }): string {
    const query = new URLSearchParams({ environment: input.environment });
    if (input.cursor) query.set("cursor", input.cursor);
    return (
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}` +
      `/memory/${encodeURIComponent(input.resource)}/documents` +
      (input.id !== undefined ? `/${encodeURIComponent(input.id)}` : "") +
      `?${query.toString()}`
    );
  }

  private async memoryDocumentResponse(
    path: string,
    init: RequestInit,
  ): Promise<MemoryDocumentRead> {
    const response = await this.response(path, init);
    const document = (await response.json()) as MemoryDocument;
    return { document, etag: response.headers.get("etag") ?? "" };
  }

  async memoryResources(input: {
    projectId: string;
    environment: MemoryEnvironment;
  }): Promise<MemoryResource[]> {
    const query = new URLSearchParams({ environment: input.environment });
    const result = await this.request<{ resources: MemoryResource[] }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}` +
        `/memory?${query.toString()}`,
    );
    return result.resources;
  }

  memoryDocuments(input: {
    projectId: string;
    resource: string;
    environment: MemoryEnvironment;
    cursor?: string;
  }) {
    return this.request<MemoryDocumentPage>(
      this.memoryPath({
        projectId: input.projectId,
        resource: input.resource,
        environment: input.environment,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      }),
    );
  }

  memoryDocument(input: {
    projectId: string;
    resource: string;
    id: string;
    environment: MemoryEnvironment;
  }) {
    return this.memoryDocumentResponse(this.memoryPath(input), {});
  }

  createMemoryDocument(input: {
    projectId: string;
    resource: string;
    id: string;
    environment: MemoryEnvironment;
    title: string;
    text: string;
    summary?: string;
    agentWrites?: "enabled" | "disabled";
  }) {
    return this.memoryDocumentResponse(this.memoryPath(input), {
      method: "PUT",
      headers: { "if-none-match": "*" },
      body: JSON.stringify({
        title: input.title,
        text: input.text,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.agentWrites ? { agentWrites: input.agentWrites } : {}),
      }),
    });
  }

  replaceMemoryDocument(input: {
    projectId: string;
    resource: string;
    id: string;
    environment: MemoryEnvironment;
    etag: string;
    text: string;
    summary?: string;
  }) {
    return this.memoryDocumentResponse(this.memoryPath(input), {
      method: "PUT",
      headers: { "if-match": input.etag },
      body: JSON.stringify({
        text: input.text,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      }),
    });
  }

  patchMemoryDocument(input: {
    projectId: string;
    resource: string;
    id: string;
    environment: MemoryEnvironment;
    etag: string;
    title?: string;
    agentWrites?: "enabled" | "disabled";
  }) {
    return this.memoryDocumentResponse(this.memoryPath(input), {
      method: "PATCH",
      headers: { "if-match": input.etag },
      body: JSON.stringify({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.agentWrites ? { agentWrites: input.agentWrites } : {}),
      }),
    });
  }

  deleteMemoryDocument(input: {
    projectId: string;
    resource: string;
    id: string;
    environment: MemoryEnvironment;
    etag: string;
  }) {
    return this.request<void>(this.memoryPath(input), {
      method: "DELETE",
      headers: { "if-match": input.etag },
    });
  }

  logs(input: {
    agentId?: string;
    sessionId?: string;
    environment?: "development" | "production";
    after?: string;
    limit?: number;
  }) {
    const query = new URLSearchParams();
    if (input.agentId) query.set("agentId", input.agentId);
    if (input.sessionId) query.set("sessionId", input.sessionId);
    if (input.environment) query.set("environment", input.environment);
    if (input.after) query.set("after", input.after);
    if (input.limit) query.set("limit", String(input.limit));
    return this.request<{ logs: ManagedAgentLog[]; cursor: string }>(
      `/api/managed-agents/logs?${query.toString()}`,
    );
  }

  async channels(): Promise<ManagedChannelStatus[]> {
    const result = await this.request<{ channels: ManagedChannelStatus[] }>(
      "/api/managed-agents/channels",
    );
    return result.channels;
  }

  registerDeployment(input: {
    agentId: string;
    name: string;
    alias: string;
    channels: string[];
    connections: string[];
    httpConnections: Array<{
      id: string;
      origin: string;
      headers: Record<
        string,
        | string
        | {
            kind: "secret";
            name: string;
            prefix?: string;
            suffix?: string;
          }
      >;
      methods?: string[];
      pathPrefix?: string;
      redirectOrigins?: Array<{ origin: string; pathPrefix?: string }>;
    }>;
    githubConnections: Array<{
      id: string;
      provider: {
        kind: "github-app";
        permissions: Record<string, "read" | "write">;
      };
    }>;
    memory: MemoryDeclaration[];
    models: Array<{ provider: string; model: string }>;
    projectDeployment?: {
      id: string;
      digest: string;
      localAgentId: string;
      agents: Array<{
        localId: string;
        agentId: string;
        artifactDigest: string;
      }>;
      resources: ProjectResourceManifest;
    };
    source: {
      digest: string;
      size: number;
      contentType: string;
      body: string;
    };
  }) {
    return this.request<ManagedAgentDeployment>(
      "/api/managed-agents/deployments",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async createSession(
    agentId: string,
    options: { memory?: MemoryBindings } = {},
  ): Promise<CreateSessionResult> {
    const response = await this.response("/api/managed-agents/sessions", {
      method: "POST",
      body: JSON.stringify({
        agentId,
        ...(options.memory && Object.keys(options.memory).length
          ? { memory: options.memory }
          : {}),
      }),
    });
    const body = (await response.json()) as Omit<
      CreateSessionResult,
      "created"
    >;
    return { created: response.status === 201, ...body };
  }

  /** One page of session rows, newest created first; pass `cursor` for the next page. */
  async sessions(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ManagedSessionPage> {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<ManagedSessionPage>(
      `/api/managed-agents/sessions${suffix}`,
    );
  }

  session(sessionId: string) {
    return this.request<ManagedSessionSnapshot>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  createTurn(
    sessionId: string,
    input: string,
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    return this.request<{ turnId: string; duplicate: boolean }>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          input,
          idempotencyKey,
        }),
      },
    );
  }

  async events(sessionId: string, after: number) {
    const result = await this.request<{ events: ManagedAgentEvent[] }>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`,
    );
    return result.events;
  }

  suspendSession(sessionId: string) {
    return this.request<ManagedSessionSnapshot>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}/suspend`,
      { method: "POST" },
    );
  }

  resumeSession(sessionId: string) {
    return this.request<ManagedSessionSnapshot>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}/resume`,
      { method: "POST" },
    );
  }

  endSession(sessionId: string) {
    return this.request<ManagedSessionSnapshot>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}/end`,
      { method: "POST" },
    );
  }

  terminateSession(sessionId: string) {
    return this.request<ManagedSessionSnapshot>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}/terminate`,
      { method: "POST" },
    );
  }

  private workspacePath(sessionId: string, suffix: string) {
    return `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}/workspace${suffix}`;
  }

  /** Every file under the session's /workspace, across all list pages. */
  async workspaceFiles(sessionId: string): Promise<WorkspaceFile[]> {
    const files: WorkspaceFile[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor
        ? `?cursor=${encodeURIComponent(cursor)}`
        : "";
      const page: WorkspaceFilePage = await this.request<WorkspaceFilePage>(
        this.workspacePath(sessionId, `/files${query}`),
      );
      files.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor);
    return files;
  }

  async workspaceArtifacts(sessionId: string): Promise<WorkspaceArtifact[]> {
    const result = await this.request<{ artifacts: WorkspaceArtifact[] }>(
      this.workspacePath(sessionId, "/exports"),
    );
    return result.artifacts;
  }

  /** Provider-side export: retains and hashes the file, returns its manifest. */
  async exportWorkspaceFile(
    sessionId: string,
    path: string,
  ): Promise<WorkspaceArtifact> {
    const result = await this.request<{
      export?: WorkspaceExport;
      artifact: WorkspaceArtifact | null;
    }>(this.workspacePath(sessionId, "/exports"), {
      method: "POST",
      body: JSON.stringify({ path }),
      ...(this.idempotencyKey
        ? {
            headers: {
              "idempotency-key": this.derivedIdempotencyKey(
                "POST",
                this.workspacePath(sessionId, "/exports"),
                path,
              ),
            },
          }
        : {}),
    });
    if (!result.artifact) {
      throw new APIError(
        `Export of ${path} is still in progress (${result.export?.id ?? "unknown export"}); retry shortly`,
        202,
        "export_in_progress",
      );
    }
    return result.artifact;
  }

  /**
   * Raw bytes of a retained artifact; callers verify size and SHA-256. The
   * request always carries the one-hour deadline, combined with `signal`.
   */
  workspaceArtifactContent(
    artifact: Pick<WorkspaceArtifact, "sessionId" | "id">,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.response(
      this.workspacePath(
        artifact.sessionId,
        `/exports/${encodeURIComponent(artifact.id)}/content`,
      ),
      { signal: workspaceContentSignal(signal) },
    );
  }
}

/** Large artifacts stream for a while; the default 30 s budget is for JSON. */
export const WORKSPACE_CONTENT_TIMEOUT_MS = 60 * 60 * 1000;

/** The one-hour content deadline, also aborting when `signal` does. */
export function workspaceContentSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(WORKSPACE_CONTENT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type WorkspaceFile = {
  path: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
};

type WorkspaceFilePage = {
  files: WorkspaceFile[];
  nextCursor: string | null;
};

export type WorkspaceExport = {
  id: string;
  sessionId: string;
  path: string;
  state: "snapshotting" | "delivered" | "failed" | "expired";
  idempotencyKey: string | null;
  artifactId: string | null;
  error: { code: string; message: string; retrySafe: boolean } | null;
  createdAt: string;
  completedAt: string | null;
};

export type WorkspaceArtifact = {
  id: string;
  exportId?: string;
  sessionId: string;
  path: string;
  size: number;
  sha256: string;
  mediaType?: string;
  snapshotId?: string;
  receipt: {
    etag: string | null;
    sourceEtag: string | null;
    sourceVersionId: string | null;
  };
  exportedAt: string;
};
