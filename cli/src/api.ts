import type { ResolvedConfig } from "./config.js";

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
  createdAt: string;
}

export interface ManagedConnection {
  id: string;
  kind?: "channel" | "tool";
  provider: string;
  label: string;
  agentId?: string;
  alias?: string;
  externalAccountId?: string;
  displayName?: string;
  scopes?: string[];
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ManagedSlackConnection {
  id: string;
  agentId: string;
  alias: string;
  appId?: string;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedAgentEvent {
  id: string;
  seq: number;
  type: string;
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

  registerDeployment(input: {
    agentId: string;
    name: string;
    alias: string;
    channels: string[];
    connections: string[];
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

  async connections(): Promise<ManagedConnection[]> {
    const result = await this.request<{ connections: ManagedConnection[] }>(
      "/api/managed-agents/connections",
    );
    return result.connections;
  }

  disconnectConnection(connectionId: string) {
    return this.request<ManagedConnection>(
      `/api/managed-agents/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  }

  linkManagedConnection(service: string, label: string) {
    return this.request<{
      connectionId: string;
      label: string;
      service: string;
      toolkit: string;
      status: "connected" | "pending";
      connectedAccountId?: string;
      authorizationUrl?: string;
      expiresAt?: string;
    }>("/api/managed-agents/connections/link", {
      method: "POST",
      body: JSON.stringify({ service, label }),
    });
  }

  managedConnection(connectionId: string, service: string) {
    const provider = service === "github" ? "github" : "google";
    return this.request<{
      connectionId: string;
      label: string;
      service: string;
      toolkit: string;
      status: "connected" | "pending";
      connectedAccountId?: string;
      authorizationUrl?: string;
      expiresAt?: string;
    }>(
      `/api/managed-agents/connections/${provider}/status?service=${encodeURIComponent(service)}&connectionId=${encodeURIComponent(connectionId)}`,
    );
  }

  disconnectManagedConnection(connectionId: string, service: string) {
    const provider = service === "github" ? "github" : "google";
    return this.request<{
      connectionId: string;
      label: string;
      service: string;
      toolkit: string;
      status: "disconnected";
      connectedAccountId?: string;
    }>(
      `/api/managed-agents/connections/${provider}?service=${encodeURIComponent(service)}&connectionId=${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  }

  createSlackConnection(agentId: string) {
    return this.request<{
      connection: ManagedSlackConnection;
      webhookUrl: string;
    }>("/api/managed-agents/channels/slack/connections", {
      method: "POST",
      body: JSON.stringify({ agentId }),
    });
  }

  async channelConnections(): Promise<ManagedSlackConnection[]> {
    const result = await this.request<{
      channels?: ManagedSlackConnection[];
      connections?: ManagedSlackConnection[];
    }>("/api/managed-agents/channels");
    return result.channels ?? result.connections ?? [];
  }

  completeSlackConnection(connectionId: string, botToken: string) {
    return this.request<ManagedSlackConnection>(
      `/api/managed-agents/channels/slack/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ botToken }),
      },
    );
  }

  disconnectSlack(connectionId: string) {
    return this.request<ManagedSlackConnection>(
      `/api/managed-agents/channels/slack/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
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
