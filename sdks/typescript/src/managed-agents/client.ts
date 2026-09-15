// The management client: one class per API section, each method one route
// of docs/agents/api.mdx. Server-side only; the API key reaches every
// project, agent and session of the organization.

import { Http, type HttpOptions, segment } from "./http.js";
import {
  startOnDocument,
  type StartOnDocumentParams,
  type StartOnDocumentResult,
} from "./start-on-document.js";
import type {
  CreateEventSubscriptionBody,
  EventSubscription,
} from "./event-subscriptions.js";
import type {
  CreateMemoryDocumentBody,
  MemoryDocument,
  MemoryDocumentPage,
  MemoryResourceInventory,
  PatchMemoryDocumentBody,
  ReplaceMemoryDocumentBody,
} from "./memory.js";
import type {
  AgentSummary,
  CreateProjectParams,
  CreateSessionParams,
  CreateWebhookParams,
  Deployment,
  Environment,
  ListDeploymentsQuery,
  ListEventsQuery,
  ListRepositoriesQuery,
  ListSessionsQuery,
  ListWebhooksQuery,
  Project,
  ProjectDetail,
  RepositoryPage,
  SendTurnParams,
  Session,
  SessionCreated,
  SessionEvent,
  SessionPage,
  SetLabelsParams,
  TurnReceipt,
  UpdateWebhookParams,
  Webhook,
  WebhookRequest,
} from "./types.js";

export interface OpenComputerOptions extends HttpOptions {
  /** An OpenComputer API key. Server-side only; it must not reach a browser. */
  apiKey: string;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface CreateSessionOptions extends CallOptions {
  /**
   * At most 256 characters. The same key with the same agent, deployment,
   * environment and memory bindings returns the existing session; anything
   * else under the key is `409 idempotency_conflict`.
   */
  idempotencyKey?: string;
}

export interface EnvironmentOptions extends CallOptions {
  environment: Environment;
}

export interface DocumentWriteOptions extends EnvironmentOptions {
  /** The revision the write is conditional on; sent as `If-Match`. */
  revision: string;
}

export interface ListDocumentsOptions extends EnvironmentOptions {
  cursor?: string;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export class Turns {
  constructor(private readonly http: Http) {}

  /** `POST /sessions/<id>/turns`: admits a turn; follow it in the event log. */
  async send(sessionId: string, params: SendTurnParams, options: CallOptions = {}): Promise<TurnReceipt> {
    const body: Record<string, unknown> = { input: params.input };
    if (params.idempotencyKey !== undefined) body.idempotencyKey = params.idempotencyKey;
    if (params.mode !== undefined) body.mode = params.mode;
    if (params.payload !== undefined) body.payload = params.payload;
    const answer = await this.http.send<{ turnId: string; status: string; duplicate?: boolean }>(
      "POST",
      `/sessions/${segment(sessionId)}/turns`,
      { body, signal: options.signal },
    );
    return {
      turnId: answer.body.turnId,
      status: answer.body.status === "running" ? "running" : "queued",
      duplicate: answer.body.duplicate ?? answer.status === 200,
    };
  }
}

export class Events {
  constructor(private readonly http: Http) {}

  /**
   * `GET /sessions/<id>/events?after=<seq>`: up to 500 events with a greater
   * `seq`, ascending. Repeat from the last `seq` until a page is empty.
   */
  async list(sessionId: string, query: ListEventsQuery = {}, options: CallOptions = {}): Promise<SessionEvent[]> {
    const page = await this.http.request<{ events: SessionEvent[] }>("GET", `/sessions/${segment(sessionId)}/events`, {
      query: { after: query.after ?? 0 },
      signal: options.signal,
    });
    return page.events;
  }
}

export class Sessions {
  readonly turns: Turns;
  readonly events: Events;

  constructor(private readonly http: Http) {
    this.turns = new Turns(http);
    this.events = new Events(http);
  }

  /** `POST /sessions`: creates a session without a turn. `created` is false when the key had already created it. */
  async create(params: CreateSessionParams, options: CreateSessionOptions = {}): Promise<SessionCreated> {
    const answer = await this.http.send<{ session: SessionCreated["session"]; deployment?: Deployment }>(
      "POST",
      "/sessions",
      {
        body: params,
        headers: options.idempotencyKey !== undefined ? { "idempotency-key": options.idempotencyKey } : undefined,
        signal: options.signal,
      },
    );
    return { session: answer.body.session, deployment: answer.body.deployment, created: answer.status === 201 };
  }

  /** `GET /sessions/<id>`. */
  get(sessionId: string, options: CallOptions = {}): Promise<Session> {
    return this.http.request<Session>("GET", `/sessions/${segment(sessionId)}`, { signal: options.signal });
  }

  /**
   * `GET /sessions`: rows ordered by `createdAt` descending then `id`, with
   * `nextCursor` for the next page. Sort the pages you hold by `updatedAt`
   * for recent activity first.
   */
  async list(query: ListSessionsQuery = {}, options: CallOptions = {}): Promise<SessionPage> {
    const { labels, ...rest } = query;
    const q: Record<string, string | number | undefined> = { ...rest };
    for (const [key, value] of Object.entries(labels ?? {})) q[`label.${key}`] = value;
    const page = await this.http.request<{ sessions: SessionPage["sessions"]; nextCursor?: string | null }>(
      "GET",
      "/sessions",
      { query: q, signal: options.signal },
    );
    return { sessions: page.sessions, nextCursor: page.nextCursor ?? null };
  }

  /** `POST /sessions/<id>/end`: cancels queued and running turns and revokes memory writes. */
  end(sessionId: string, options: CallOptions = {}): Promise<Session> {
    return this.http.request<Session>("POST", `/sessions/${segment(sessionId)}/end`, { signal: options.signal });
  }

  /** `POST /sessions/<id>/interrupt`: stops the running turn; the next queued turn starts. */
  interrupt(sessionId: string, options: CallOptions = {}): Promise<Session> {
    return this.http.request<Session>("POST", `/sessions/${segment(sessionId)}/interrupt`, { signal: options.signal });
  }

  /** `PATCH /sessions/<id>/labels`: per-key last-write-wins (per design 1c07584, backend in flight). */
  setLabels(sessionId: string, params: SetLabelsParams, options: CallOptions = {}): Promise<Session> {
    return this.http.request<Session>("PATCH", `/sessions/${segment(sessionId)}/labels`, {
      body: params,
      signal: options.signal,
    });
  }

  /** Creates a memory document if needed, then a session bound to it, under one key. */
  startOnDocument(params: StartOnDocumentParams): Promise<StartOnDocumentResult> {
    return startOnDocument(this.http, params);
  }
}

// ── Projects ──────────────────────────────────────────────────────────────────

export class MemoryDocuments {
  constructor(private readonly http: Http) {}

  private path(projectId: string, resource: string, documentId?: string): string {
    const base = `/projects/${segment(projectId)}/memory/${segment(resource)}/documents`;
    return documentId === undefined ? base : `${base}/${segment(documentId)}`;
  }

  /** `GET .../documents`: metadata without `text`; follow `nextCursor`. */
  list(projectId: string, resource: string, options: ListDocumentsOptions): Promise<MemoryDocumentPage> {
    return this.http.request<MemoryDocumentPage>("GET", this.path(projectId, resource), {
      query: { environment: options.environment, cursor: options.cursor },
      signal: options.signal,
    });
  }

  /** `GET .../documents/<id>`. */
  get(projectId: string, resource: string, documentId: string, options: EnvironmentOptions): Promise<MemoryDocument> {
    return this.http.request<MemoryDocument>("GET", this.path(projectId, resource, documentId), {
      query: { environment: options.environment },
      signal: options.signal,
    });
  }

  /** `PUT .../documents/<id>` with `If-None-Match: *`; `412` when the id is already used. */
  create(
    projectId: string,
    resource: string,
    documentId: string,
    body: CreateMemoryDocumentBody,
    options: EnvironmentOptions,
  ): Promise<MemoryDocument> {
    return this.http.request<MemoryDocument>("PUT", this.path(projectId, resource, documentId), {
      query: { environment: options.environment },
      headers: { "if-none-match": "*" },
      body,
      signal: options.signal,
    });
  }

  /** `PUT .../documents/<id>` with `If-Match`: replaces text, and summary when given. */
  replace(
    projectId: string,
    resource: string,
    documentId: string,
    body: ReplaceMemoryDocumentBody,
    options: DocumentWriteOptions,
  ): Promise<MemoryDocument> {
    return this.http.request<MemoryDocument>("PUT", this.path(projectId, resource, documentId), {
      query: { environment: options.environment },
      headers: { "if-match": quote(options.revision) },
      body,
      signal: options.signal,
    });
  }

  /** `PATCH .../documents/<id>` with `If-Match`: title or write policy. */
  patch(
    projectId: string,
    resource: string,
    documentId: string,
    body: PatchMemoryDocumentBody,
    options: DocumentWriteOptions,
  ): Promise<MemoryDocument> {
    return this.http.request<MemoryDocument>("PATCH", this.path(projectId, resource, documentId), {
      query: { environment: options.environment },
      headers: { "if-match": quote(options.revision) },
      body,
      signal: options.signal,
    });
  }

  /** `DELETE .../documents/<id>` with `If-Match`. The id stays reserved. */
  async delete(projectId: string, resource: string, documentId: string, options: DocumentWriteOptions): Promise<void> {
    await this.http.request<void>("DELETE", this.path(projectId, resource, documentId), {
      query: { environment: options.environment },
      headers: { "if-match": quote(options.revision) },
      signal: options.signal,
    });
  }
}

export class Memory {
  readonly documents: MemoryDocuments;

  constructor(private readonly http: Http) {
    this.documents = new MemoryDocuments(http);
  }

  /** `GET /projects/<p>/memory`: the environment's resource inventory. */
  async resources(projectId: string, options: EnvironmentOptions): Promise<MemoryResourceInventory> {
    return this.http.request<MemoryResourceInventory>("GET", `/projects/${segment(projectId)}/memory`, {
      query: { environment: options.environment },
      signal: options.signal,
    });
  }
}

export class Webhooks {
  constructor(private readonly http: Http) {}

  private path(projectId: string, webhookId?: string): string {
    const base = `/projects/${segment(projectId)}/webhooks`;
    return webhookId === undefined ? base : `${base}/${segment(webhookId)}`;
  }

  /** `GET /projects/<p>/webhooks`: URLs without tokens. */
  async list(projectId: string, query: ListWebhooksQuery = {}, options: CallOptions = {}): Promise<Webhook[]> {
    const page = await this.http.request<{ webhooks: Webhook[] }>("GET", this.path(projectId), {
      query: { ...query },
      signal: options.signal,
    });
    return page.webhooks;
  }

  /** `POST /projects/<p>/webhooks`: `token` and the full `invocationUrl` appear once. */
  async create(projectId: string, params: CreateWebhookParams, options: CallOptions = {}): Promise<Webhook> {
    const answer = await this.http.request<{ webhook: Webhook }>("POST", this.path(projectId), {
      body: params,
      signal: options.signal,
    });
    return answer.webhook;
  }

  /** `PATCH /projects/<p>/webhooks/<id>`. */
  async update(
    projectId: string,
    webhookId: string,
    params: UpdateWebhookParams,
    options: CallOptions = {},
  ): Promise<Webhook> {
    const answer = await this.http.request<{ webhook: Webhook }>("PATCH", this.path(projectId, webhookId), {
      body: params,
      signal: options.signal,
    });
    return answer.webhook;
  }

  /** `POST /projects/<p>/webhooks/<id>/rotate-token`: the webhook with its new token. */
  async rotateToken(projectId: string, webhookId: string, options: CallOptions = {}): Promise<Webhook> {
    const answer = await this.http.request<{ webhook: Webhook }>(
      "POST",
      `${this.path(projectId, webhookId)}/rotate-token`,
      { signal: options.signal },
    );
    return answer.webhook;
  }

  /** `DELETE /projects/<p>/webhooks/<id>`. */
  async delete(projectId: string, webhookId: string, options: CallOptions = {}): Promise<void> {
    await this.http.request<void>("DELETE", this.path(projectId, webhookId), { signal: options.signal });
  }

  /** `GET /projects/<p>/webhooks/<id>/requests`: the request ledger. */
  async requests(projectId: string, webhookId: string, options: CallOptions = {}): Promise<WebhookRequest[]> {
    const page = await this.http.request<{ requests: WebhookRequest[] }>(
      "GET",
      `${this.path(projectId, webhookId)}/requests`,
      { signal: options.signal },
    );
    return page.requests;
  }
}

export class EventSubscriptions {
  constructor(private readonly http: Http) {}

  private path(projectId: string, subscriptionId?: string): string {
    const base = `/projects/${segment(projectId)}/event-subscriptions`;
    return subscriptionId === undefined ? base : `${base}/${segment(subscriptionId)}`;
  }

  /** `POST /projects/<p>/event-subscriptions`. */
  async create(
    projectId: string,
    params: CreateEventSubscriptionBody,
    options: CallOptions = {},
  ): Promise<EventSubscription> {
    const answer = await this.http.request<{ subscription: EventSubscription }>("POST", this.path(projectId), {
      body: params,
      signal: options.signal,
    });
    return answer.subscription;
  }

  /** `GET /projects/<p>/event-subscriptions`. */
  async list(projectId: string, options: CallOptions = {}): Promise<EventSubscription[]> {
    const page = await this.http.request<{ subscriptions: EventSubscription[] }>("GET", this.path(projectId), {
      signal: options.signal,
    });
    return page.subscriptions;
  }

  /** `GET /projects/<p>/event-subscriptions/<id>`. */
  async get(projectId: string, subscriptionId: string, options: CallOptions = {}): Promise<EventSubscription> {
    const answer = await this.http.request<{ subscription: EventSubscription }>(
      "GET",
      this.path(projectId, subscriptionId),
      { signal: options.signal },
    );
    return answer.subscription;
  }

  /** `DELETE /projects/<p>/event-subscriptions/<id>`: pending deliveries stop. */
  async delete(projectId: string, subscriptionId: string, options: CallOptions = {}): Promise<void> {
    await this.http.request<void>("DELETE", this.path(projectId, subscriptionId), { signal: options.signal });
  }
}

export class GitHub {
  constructor(private readonly http: Http) {}

  /**
   * `GET /projects/<p>/github/repositories?environment=`: the repositories
   * the environment's installation covers, read live (per design 1c07584,
   * backend in flight). `404 github_connection_not_found` without an
   * installation; `502 github_unavailable` when GitHub fails.
   */
  async repositories(projectId: string, query: ListRepositoriesQuery, options: CallOptions = {}): Promise<RepositoryPage> {
    const page = await this.http.request<{ repositories: RepositoryPage["repositories"]; nextCursor?: string | null }>(
      "GET",
      `/projects/${segment(projectId)}/github/repositories`,
      { query: { ...query }, signal: options.signal },
    );
    return { repositories: page.repositories, nextCursor: page.nextCursor ?? null };
  }
}

export class Projects {
  readonly memory: Memory;
  readonly webhooks: Webhooks;
  readonly eventSubscriptions: EventSubscriptions;
  readonly github: GitHub;

  constructor(private readonly http: Http) {
    this.memory = new Memory(http);
    this.webhooks = new Webhooks(http);
    this.eventSubscriptions = new EventSubscriptions(http);
    this.github = new GitHub(http);
  }

  /** `GET /projects`. */
  async list(options: CallOptions = {}): Promise<Project[]> {
    const page = await this.http.request<{ projects: Project[] }>("GET", "/projects", { signal: options.signal });
    return page.projects;
  }

  /** `GET /projects/<p>`: the project with its deployments, sessions, connections, channels and schedules. */
  get(projectId: string, options: CallOptions = {}): Promise<ProjectDetail> {
    return this.http.request<ProjectDetail>("GET", `/projects/${segment(projectId)}`, { signal: options.signal });
  }

  /** `POST /projects`. */
  create(params: CreateProjectParams, options: CallOptions = {}): Promise<Project> {
    return this.http.request<Project>("POST", "/projects", { body: params, signal: options.signal });
  }
}

// ── Agents and deployments ────────────────────────────────────────────────────

export class Agents {
  constructor(private readonly http: Http) {}

  /** `GET /agents`. */
  async list(options: CallOptions = {}): Promise<AgentSummary[]> {
    const page = await this.http.request<{ agents: AgentSummary[] }>("GET", "/agents", { signal: options.signal });
    return page.agents;
  }
}

export class Deployments {
  constructor(private readonly http: Http) {}

  /** `GET /deployments/<id>`. */
  get(deploymentId: string, options: CallOptions = {}): Promise<Deployment> {
    return this.http.request<Deployment>("GET", `/deployments/${segment(deploymentId)}`, { signal: options.signal });
  }

  /** `GET /deployments?agentId=`. */
  async list(query: ListDeploymentsQuery, options: CallOptions = {}): Promise<Deployment[]> {
    const page = await this.http.request<{ deployments: Deployment[] }>("GET", "/deployments", {
      query: { ...query },
      signal: options.signal,
    });
    return page.deployments;
  }
}

// ── The client ────────────────────────────────────────────────────────────────

/**
 * The management API client.
 *
 * ```ts
 * import { OpenComputer } from "@opencomputer/sdk/managed-agents";
 * const oc = new OpenComputer({ apiKey: process.env.OPENCOMPUTER_API_KEY! });
 * const { session } = await oc.sessions.create({ agentId: "worker@development" }, { idempotencyKey: taskId });
 * await oc.sessions.turns.send(session.id, { input: "Plan the workshop.", idempotencyKey: `${taskId}/start` });
 * ```
 */
export class OpenComputer {
  readonly sessions: Sessions;
  readonly projects: Projects;
  readonly agents: Agents;
  readonly deployments: Deployments;

  constructor(options: OpenComputerOptions) {
    const http = new Http(options.apiKey, options);
    this.sessions = new Sessions(http);
    this.projects = new Projects(http);
    this.agents = new Agents(http);
    this.deployments = new Deployments(http);
  }
}

/** `startOnDocument` as a standalone call, for code that holds a key and no client. */
export interface StartSessionOnDocumentParams extends StartOnDocumentParams, HttpOptions {
  /** An OpenComputer API key with access to the project. Server-side only. */
  apiKey: string;
}

export type StartSessionOnDocumentResult = StartOnDocumentResult;

/** The same call as `oc.sessions.startOnDocument`, building the client from `apiKey`, `baseUrl` and `fetch`. */
export function startSessionOnDocument(params: StartSessionOnDocumentParams): Promise<StartSessionOnDocumentResult> {
  const { apiKey, baseUrl, fetch, ...rest } = params;
  return new OpenComputer({ apiKey, baseUrl, fetch }).sessions.startOnDocument(rest);
}

/** Quotes a revision for `If-Match`, as the API returns it in `ETag`. */
function quote(revision: string): string {
  return revision.startsWith('"') ? revision : `"${revision}"`;
}
