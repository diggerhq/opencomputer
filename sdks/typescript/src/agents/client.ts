// The management client: one class per API section, each method one route
// of docs/agents/api.mdx. Server-side only; the API key reaches every
// project, agent and session of the organization. Every call names the
// documented shape of its answer (shapes.ts); the transport checks the body
// against it before the method returns.

import { Http, type HttpOptions, segment } from "./http.js";
import * as shapes from "./shapes.js";
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

  /**
   * `POST /sessions/<id>/turns`: admits a turn; follow it in the event log.
   * The key travels as the `Idempotency-Key` header, the one rule for both
   * create and send; the body field of the same name is the form a browser
   * send proxied through the application's own server uses.
   */
  async send(sessionId: string, params: SendTurnParams, options: CallOptions = {}): Promise<TurnReceipt> {
    const body: Record<string, unknown> = { input: params.input };
    if (params.mode !== undefined) body.mode = params.mode;
    if (params.payload !== undefined) body.payload = params.payload;
    const answer = await this.http.send("POST", `/sessions/${segment(sessionId)}/turns`, shapes.turnReceipt, {
      body,
      headers: params.idempotencyKey !== undefined ? { "idempotency-key": params.idempotencyKey } : undefined,
      signal: options.signal,
    });
    // The receipt says what the platform persisted. A repeated key answers
    // with the existing turn, which may have settled since; mapping that to
    // "queued" told a retrying caller its finished work was waiting.
    return {
      turnId: answer.body.turnId,
      status: answer.body.status,
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
    const page = await this.http.request("GET", `/sessions/${segment(sessionId)}/events`, shapes.eventsPage, {
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
    const answer = await this.http.send("POST", "/sessions", shapes.sessionCreated, {
      body: params,
      headers: options.idempotencyKey !== undefined ? { "idempotency-key": options.idempotencyKey } : undefined,
      signal: options.signal,
    });
    return { session: answer.body.session, deployment: answer.body.deployment, created: answer.status === 201 };
  }

  /** `GET /sessions/<id>`. */
  get(sessionId: string, options: CallOptions = {}): Promise<Session> {
    return this.http.request("GET", `/sessions/${segment(sessionId)}`, shapes.session, { signal: options.signal });
  }

  /**
   * `GET /sessions`: rows ordered by `createdAt` descending then `id`, with
   * `nextCursor` for the next page. Sort the pages you hold by `updatedAt`
   * for recent activity first.
   */
  list(query: ListSessionsQuery = {}, options: CallOptions = {}): Promise<SessionPage> {
    const { labels, ...rest } = query;
    const q: Record<string, string | number | undefined> = { ...rest };
    for (const [key, value] of Object.entries(labels ?? {})) q[`label.${key}`] = value;
    return this.http.request("GET", "/sessions", shapes.sessionPage, { query: q, signal: options.signal });
  }

  /** `POST /sessions/<id>/end`: cancels queued and running turns and revokes memory writes. */
  end(sessionId: string, options: CallOptions = {}): Promise<Session> {
    return this.http.request("POST", `/sessions/${segment(sessionId)}/end`, shapes.session, { signal: options.signal });
  }

  /** `POST /sessions/<id>/interrupt`: stops the running turn; the next queued turn starts. */
  interrupt(sessionId: string, options: CallOptions = {}): Promise<Session> {
    return this.http.request("POST", `/sessions/${segment(sessionId)}/interrupt`, shapes.session, {
      signal: options.signal,
    });
  }

  /** `PATCH /sessions/<id>/labels`: per-key last-write-wins. */
  setLabels(sessionId: string, params: SetLabelsParams, options: CallOptions = {}): Promise<Session> {
    return this.http.request("PATCH", `/sessions/${segment(sessionId)}/labels`, shapes.session, {
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
    return this.http.request("GET", this.path(projectId, resource), shapes.memoryDocumentPage, {
      query: { environment: options.environment, cursor: options.cursor },
      signal: options.signal,
    });
  }

  /** `GET .../documents/<id>`. */
  get(projectId: string, resource: string, documentId: string, options: EnvironmentOptions): Promise<MemoryDocument> {
    return this.http.request("GET", this.path(projectId, resource, documentId), shapes.memoryDocument, {
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
    return this.http.request("PUT", this.path(projectId, resource, documentId), shapes.memoryDocument, {
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
    return this.http.request("PUT", this.path(projectId, resource, documentId), shapes.memoryDocument, {
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
    return this.http.request("PATCH", this.path(projectId, resource, documentId), shapes.memoryDocument, {
      query: { environment: options.environment },
      headers: { "if-match": quote(options.revision) },
      body,
      signal: options.signal,
    });
  }

  /** `DELETE .../documents/<id>` with `If-Match`. The id stays reserved. */
  async delete(projectId: string, resource: string, documentId: string, options: DocumentWriteOptions): Promise<void> {
    await this.http.request("DELETE", this.path(projectId, resource, documentId), shapes.none, {
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
  resources(projectId: string, options: EnvironmentOptions): Promise<MemoryResourceInventory> {
    return this.http.request("GET", `/projects/${segment(projectId)}/memory`, shapes.memoryResourceInventory, {
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
    const page = await this.http.request("GET", this.path(projectId), shapes.webhooksPage, {
      query: { ...query },
      signal: options.signal,
    });
    return page.webhooks;
  }

  /** `POST /projects/<p>/webhooks`: `token` and the full `invocationUrl` appear once. */
  async create(projectId: string, params: CreateWebhookParams, options: CallOptions = {}): Promise<Webhook> {
    const answer = await this.http.request("POST", this.path(projectId), shapes.webhookEnvelope, {
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
    const answer = await this.http.request("PATCH", this.path(projectId, webhookId), shapes.webhookEnvelope, {
      body: params,
      signal: options.signal,
    });
    return answer.webhook;
  }

  /** `POST /projects/<p>/webhooks/<id>/rotate-token`: the webhook with its new token. */
  async rotateToken(projectId: string, webhookId: string, options: CallOptions = {}): Promise<Webhook> {
    const answer = await this.http.request(
      "POST",
      `${this.path(projectId, webhookId)}/rotate-token`,
      shapes.webhookEnvelope,
      { signal: options.signal },
    );
    return answer.webhook;
  }

  /** `DELETE /projects/<p>/webhooks/<id>`. */
  async delete(projectId: string, webhookId: string, options: CallOptions = {}): Promise<void> {
    await this.http.request("DELETE", this.path(projectId, webhookId), shapes.none, { signal: options.signal });
  }

  /** `GET /projects/<p>/webhooks/<id>/requests`: the request ledger. */
  async requests(projectId: string, webhookId: string, options: CallOptions = {}): Promise<WebhookRequest[]> {
    const page = await this.http.request(
      "GET",
      `${this.path(projectId, webhookId)}/requests`,
      shapes.webhookRequestsPage,
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
    const answer = await this.http.request("POST", this.path(projectId), shapes.eventSubscriptionEnvelope, {
      body: params,
      signal: options.signal,
    });
    return answer.subscription;
  }

  /** `GET /projects/<p>/event-subscriptions`. */
  async list(projectId: string, options: CallOptions = {}): Promise<EventSubscription[]> {
    const page = await this.http.request("GET", this.path(projectId), shapes.eventSubscriptionsPage, {
      signal: options.signal,
    });
    return page.subscriptions;
  }

  /** `GET /projects/<p>/event-subscriptions/<id>`. */
  async get(projectId: string, subscriptionId: string, options: CallOptions = {}): Promise<EventSubscription> {
    const answer = await this.http.request(
      "GET",
      this.path(projectId, subscriptionId),
      shapes.eventSubscriptionEnvelope,
      { signal: options.signal },
    );
    return answer.subscription;
  }

  /** `DELETE /projects/<p>/event-subscriptions/<id>`: pending deliveries stop. */
  async delete(projectId: string, subscriptionId: string, options: CallOptions = {}): Promise<void> {
    await this.http.request("DELETE", this.path(projectId, subscriptionId), shapes.none, { signal: options.signal });
  }
}

export class GitHub {
  constructor(private readonly http: Http) {}

  /**
   * `GET /projects/<p>/github/repositories?environment=`: the repositories
   * the environment's installation covers, read live from GitHub, at most
   * 100 per page. `404 github_connection_not_found` without an installation;
   * `502 github_unavailable` when GitHub fails.
   */
  repositories(projectId: string, query: ListRepositoriesQuery, options: CallOptions = {}): Promise<RepositoryPage> {
    return this.http.request(
      "GET",
      `/projects/${segment(projectId)}/github/repositories`,
      shapes.repositoryPage,
      { query: { ...query }, signal: options.signal },
    );
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
    const page = await this.http.request("GET", "/projects", shapes.projectsPage, { signal: options.signal });
    return page.projects;
  }

  /** `GET /projects/<p>`: the project with its deployments, sessions, connections, channels and schedules. */
  get(projectId: string, options: CallOptions = {}): Promise<ProjectDetail> {
    return this.http.request("GET", `/projects/${segment(projectId)}`, shapes.projectDetail, {
      signal: options.signal,
    });
  }

  /** `POST /projects`. */
  create(params: CreateProjectParams, options: CallOptions = {}): Promise<Project> {
    return this.http.request("POST", "/projects", shapes.project, { body: params, signal: options.signal });
  }
}

// ── Agents and deployments ────────────────────────────────────────────────────

export class Agents {
  constructor(private readonly http: Http) {}

  /** `GET /agents`. */
  async list(options: CallOptions = {}): Promise<AgentSummary[]> {
    const page = await this.http.request("GET", "/agents", shapes.agentsPage, { signal: options.signal });
    return page.agents;
  }
}

export class Deployments {
  constructor(private readonly http: Http) {}

  /** `GET /deployments/<id>`. */
  get(deploymentId: string, options: CallOptions = {}): Promise<Deployment> {
    return this.http.request("GET", `/deployments/${segment(deploymentId)}`, shapes.deployment, {
      signal: options.signal,
    });
  }

  /** `GET /deployments?agentId=`. */
  async list(query: ListDeploymentsQuery, options: CallOptions = {}): Promise<Deployment[]> {
    const page = await this.http.request("GET", "/deployments", shapes.deploymentsPage, {
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
 * import { OpenComputer } from "@opencomputer/sdk/agents";
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
