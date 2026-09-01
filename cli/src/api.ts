import type { ResolvedConfig } from "./config.js";
import type { ProjectResourceManifest } from "./project.js";

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
  environments: Array<{
    name: "development" | "production";
    activeDeploymentId?: string;
    updatedAt: string;
  }>;
  agents: Array<{ id: string; name: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedAgentDeployment {
  id: string;
  agentId: string;
  alias: string;
  projectDeploymentId?: string;
  localAgentId?: string;
  createdAt: string;
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

// Model access (work 011). The provider token is write-only; these shapes
// carry only normalized metadata.
export interface ModelAccessConnection {
  id: string;
  organizationId: string;
  connectedByUserId: string;
  provider: "anthropic" | "openai";
  kind: "claude_subscription" | "codex_subscription";
  label: string;
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

export interface TemplateInstallation {
  id: string;
  inspectionId: string;
  projectId: string;
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

interface CreateSessionResult {
  session: ManagedSessionSnapshot;
  deployment?: ManagedAgentDeployment;
}

export class APIError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
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
  constructor(private readonly config: ResolvedConfig) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    authenticated = true,
  ): Promise<T> {
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
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204) return undefined as T;
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new APIError(errorMessage(body, response.status), response.status);
    }
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

  inspectTemplate(repositoryUrl: string) {
    return this.request<TemplateInspection>(
      "/api/managed-agents/template-inspections",
      {
        method: "POST",
        body: JSON.stringify({ repositoryUrl }),
      },
    );
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
  }) {
    return this.request<{ webhook: ManagedAgentWebhook }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks`,
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          environment: input.environment,
          agentId: input.agentId,
        }),
      },
    ).then((result) => result.webhook);
  }

  updateWebhook(input: {
    projectId: string;
    webhookId: string;
    name?: string;
    enabled?: boolean;
  }) {
    return this.request<{ webhook: ManagedAgentWebhook }>(
      `/api/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks/${encodeURIComponent(input.webhookId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
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

  createSession(agentId: string) {
    return this.request<CreateSessionResult>("/api/managed-agents/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId }),
    });
  }

  async sessions(): Promise<ManagedSessionSnapshot[]> {
    const result = await this.request<{
      sessions: ManagedSessionSnapshot[];
    }>("/api/managed-agents/sessions");
    return result.sessions;
  }

  session(sessionId: string) {
    return this.request<ManagedSessionSnapshot>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  createTurn(sessionId: string, input: string) {
    return this.request<{ turnId: string; duplicate: boolean }>(
      `/api/managed-agents/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          input,
          idempotencyKey: crypto.randomUUID(),
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
}
