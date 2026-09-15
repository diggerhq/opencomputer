// The shapes of the management API (docs/agents/api.mdx) and of the session
// event log (docs/agents/events.mdx), as the client sends and returns them.
// Field names are the API's own; nothing is renamed at the boundary.
//
// Fields marked "per design 1c07584, backend in flight" belong to routes and
// objects the API is gaining (session labels, filtered listing, the typed
// result, turn payloads, repository listing). They are typed here so an
// application compiles against the final shape; until the backend lands, the
// API leaves them absent and the routes answer 404 or 400.

import type { MemoryBindings, SessionMemoryBinding } from "./memory.js";
import type { TurnOutcomeDelivery } from "./event-subscriptions.js";

/** Development and Production are separate environments of a project. */
export type Environment = "development" | "production";

/**
 * A JSON value: what a turn payload, a tool input or output, and a result
 * carry. Strings, numbers, booleans, null, arrays and objects of the same.
 */
export type DataValue = string | number | boolean | null | DataValue[] | { [key: string]: DataValue };

// ── Sessions ──────────────────────────────────────────────────────────────────

/**
 * Where a session is in its life. `stopping` is the state between an
 * interrupt and the settlement of the stopped turn's work (per design
 * 1c07584, backend in flight).
 */
export type SessionStatus =
  | "new"
  | "connecting"
  | "idle"
  | "running"
  | "waiting_runtime"
  | "suspending"
  | "suspended"
  | "resuming"
  | "stopping"
  | "failed"
  | "ended";

/** The `source` given at creation; the dashboard groups sessions by it. */
export type SessionSource = "api" | "playground" | "channel" | "webhook" | (string & {});

export type TurnMode = "queue" | "steer" | "interrupt";

export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | (string & {});

/** One entry of a session's `turns`. */
export interface Turn {
  id: string;
  /** The user text for the turn. */
  input: string;
  mode: TurnMode;
  status: TurnStatus;
  /** The structured input sent with the turn (per design 1c07584, backend in flight). */
  payload?: DataValue;
  /** Present when an event subscription selected the turn's outcome. */
  deliveries?: TurnOutcomeDelivery[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The latest committed output of the agent's result tool, with its
 * provenance (per design 1c07584, backend in flight).
 */
export interface SessionResult {
  /** The turn whose tool call reported it. */
  turnId: string;
  callId: string;
  reportedAt: string;
  /** The tool's output as committed; at most 8 KB of JSON. */
  data: DataValue;
}

/** Application metadata on a session. Not authorization, not visible to the agent. */
export type SessionLabels = Record<string, string>;

/** A session as `GET /sessions/<id>` returns it. */
export interface Session {
  id: string;
  agentId: string;
  /** The deployment the session pins. */
  deploymentId: string;
  /** Present when the request named an environment. */
  environment?: Environment;
  status: SessionStatus;
  source: SessionSource;
  /** How the runtime hosts the session, as the create response reports it. */
  executionMode?: string;
  /** Present when the session was created with bindings. */
  memory?: SessionMemoryBinding[];
  /** Every turn, oldest first. */
  turns: Turn[];
  /** Per design 1c07584, backend in flight. */
  labels?: SessionLabels;
  /** Per design 1c07584, backend in flight. */
  labelsUpdatedAt?: string;
  /** Monotonic; every listed mutation increments it (per design 1c07584, backend in flight). */
  revision?: number;
  /** Per design 1c07584, backend in flight. */
  result?: SessionResult | null;
  createdAt: string;
  updatedAt: string;
}

/** What `POST /sessions` returns. */
export interface SessionCreated {
  session: Pick<Session, "id" | "status" | "createdAt"> & Partial<Session>;
  /** The deployment the session pinned. */
  deployment?: Deployment;
  /**
   * `true` when this call created the session (`201`); `false` when the
   * `Idempotency-Key` had already created it (`200`).
   */
  created: boolean;
}

export interface CreateSessionParams {
  /** `<agent-id>@development` or `<agent-id>@production`; a bare id means `production`. */
  agentId?: string;
  /** Pin one deployment instead of resolving an alias. Send `environment` with it. */
  deploymentId?: string;
  environment?: Environment;
  /** Bindings keyed by resource id, at most eight. */
  memory?: MemoryBindings;
  source?: SessionSource;
  /** Applied at creation and ignored on an idempotent replay (per design 1c07584, backend in flight). */
  labels?: SessionLabels;
}

/** Turn admission, as `POST /sessions/<id>/turns` answers it. */
export interface TurnReceipt {
  turnId: string;
  /** `queued` behind earlier turns, or `running` at once. */
  status: "queued" | "running";
  /** `true` when the `idempotencyKey` had already created the turn. */
  duplicate: boolean;
}

export interface SendTurnParams {
  /** The user text. Required, not empty. */
  input: string;
  /** The same key returns the existing turn; without one every request starts a turn. */
  idempotencyKey?: string;
  /** `queue` (default), `steer` or `interrupt`. */
  mode?: TurnMode;
  /** Structured input the agent reads as `useInput().payload`; at most 32 KB of JSON (per design 1c07584, backend in flight). */
  payload?: DataValue;
}

/** What a session's activity looks like from a list row (per design 1c07584, backend in flight). */
export interface SessionActivity {
  activeTurnId: string | null;
  /** Turns admitted and not yet started. */
  queued: number;
  lastSettledTurn: { id: string; status: TurnStatus; at: string } | null;
}

/**
 * A row of `GET /sessions`. Rows carry no `turns` and no `memory`;
 * `GET /sessions/<id>` has those. `activity`, `revision`, `result` and
 * `labels` are per design 1c07584, backend in flight.
 */
export interface SessionSummary {
  id: string;
  projectId?: string;
  agentId: string;
  deploymentId: string;
  environment?: Environment;
  source: SessionSource;
  status: SessionStatus;
  labels?: SessionLabels;
  createdAt: string;
  updatedAt: string;
  revision?: number;
  activity?: SessionActivity;
  result?: SessionResult | null;
}

/**
 * Filters and paging for `GET /sessions` (per design 1c07584, backend in
 * flight; the API without them returns the fifty most recently updated
 * sessions and ignores nothing, so pass none until they land).
 */
export interface ListSessionsQuery {
  project?: string;
  environment?: Environment;
  agent?: string;
  status?: SessionStatus;
  /** Up to three equality filters, sent as `label.<key>=<value>`. */
  labels?: SessionLabels;
  cursor?: string;
  /** Default 50, at most 100. */
  limit?: number;
}

export interface SessionPage {
  sessions: SessionSummary[];
  /** Pass as `cursor` for the next page; `null` on the last. */
  nextCursor: string | null;
}

/** Body of `PATCH /sessions/<id>/labels` (per design 1c07584, backend in flight). */
export interface SetLabelsParams {
  set?: SessionLabels;
  unset?: string[];
}

// ── Events ────────────────────────────────────────────────────────────────────

export interface EventBase {
  id: string;
  /** Position in the log, starting at 1. */
  seq: number;
  timestamp: string;
  sessionId: string;
  /** Absent on session-level events. */
  turnId?: string;
}

/** A public failure: a stable code, a fixed message and at most one parameter. */
export type FailureCode =
  | "interrupted"
  | "session_ended"
  | "runtime_lost"
  | "runtime_failed"
  | "deployment_invalid"
  | "model_unavailable"
  | "model_rejected"
  | "context_too_long"
  | "tool_failed"
  | "sandbox_timeout"
  | "sandbox_failed"
  | "agent_failed"
  | (string & {});

export interface Failure {
  code: FailureCode;
  message: string;
  model?: string;
  tool?: string;
}

/**
 * One entry of `GET /sessions/<id>/events`, discriminated on `type`. New
 * types can appear; the last member keeps them readable.
 */
export type SessionEvent =
  | (EventBase & { type: "session.created"; data: { agentId: string; deploymentId: string } })
  | (EventBase & { type: "session.status_changed"; data: { from: SessionStatus; to: SessionStatus } })
  | (EventBase & { type: "session.ended"; data: Record<string, never> })
  | (EventBase & { type: "session.failed"; data: Failure })
  | (EventBase & { type: "message.received"; data: { input: string; mode: TurnMode; payload?: DataValue } })
  | (EventBase & { type: "turn.queued"; data: { mode: TurnMode } })
  | (EventBase & { type: "turn.steered"; data: { activeTurnId: string } })
  | (EventBase & { type: "turn.interrupted"; data: { interruptedTurnIds: string[] } })
  | (EventBase & { type: "turn.started"; data: Record<string, never> })
  | (EventBase & { type: "turn.completed"; data: Record<string, never> })
  | (EventBase & { type: "turn.failed"; data: Failure })
  | (EventBase & { type: "turn.cancelled"; data: { reason: "interrupted" | (string & {}); replacementTurnId?: string } })
  | (EventBase & { type: "message.delta"; data: { text: string } })
  | (EventBase & { type: "message.completed"; data: { text: string } })
  | (EventBase & { type: "reasoning.delta"; data: { text: string } })
  | (EventBase & { type: "reasoning.completed"; data: { text: string } })
  | (EventBase & { type: "tool.started"; data: { tool: string; callId?: string; title?: string; input?: DataValue } })
  | (EventBase & { type: "tool.progress"; data: Record<string, unknown> })
  | (EventBase & {
      type: "tool.completed";
      data: {
        tool: string;
        callId?: string;
        title?: string;
        output?: DataValue;
        /** `true` on the call that committed the session's result (per design 1c07584, backend in flight). */
        result?: boolean;
      };
    })
  | (EventBase & { type: "tool.failed"; data: { tool: string; callId?: string; title?: string; message?: string } })
  | (EventBase & { type: "memory.saved"; data: { resource: string; documentId: string; revision: string; bytes: number } })
  | (EventBase & {
      type: "model.route_resolved";
      data: {
        providerCallId: string;
        requested: { provider: string; model: string };
        effective: { provider: string; model: string };
        runtime?: string;
        access?: string;
      };
    })
  | (EventBase & {
      type: "model.access_fallback";
      data: { providerCallId: string; requested: { provider: string; model: string }; from: string; reason: string };
    })
  | (EventBase & {
      type: "usage.recorded";
      data: {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        reasoningTokens?: number;
        cachedTokens?: number;
        cacheWriteTokens?: number;
        costUsd?: number;
        payer?: string;
      };
    })
  | (EventBase & { type: "egress.request"; data: { connectionId: string; method: string; path: string } })
  | (EventBase & {
      type: "egress.response";
      data: { connectionId: string; method: string; path: string; status: number; durationMs: number };
    })
  | (EventBase & { type: "egress.failed"; data: { connectionId: string; method: string; path: string; message: string } })
  | (EventBase & { type: "runtime.connected"; data: Record<string, never> })
  | (EventBase & { type: "runtime.disconnected"; data: Record<string, never> })
  | (EventBase & { type: "runtime.suspended"; data: Record<string, never> })
  | (EventBase & { type: "runtime.resumed"; data: Record<string, never> })
  | (EventBase & { type: "runtime.log"; data: { level?: string; stream?: string; phase?: string; message: string } })
  | (EventBase & { type: "agent.rendered"; data: Record<string, unknown> })
  | (EventBase & { type: string; data: Record<string, unknown> });

export type SessionEventType = SessionEvent["type"];

export interface ListEventsQuery {
  /** Return events with a greater `seq`; start at 0. */
  after?: number;
}

// ── Projects, agents and deployments ──────────────────────────────────────────

export interface ProjectEnvironment {
  name: Environment;
  agentId?: string;
  activeDeploymentId?: string;
  updatedAt?: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  environments: ProjectEnvironment[];
  agents: Array<{ id: string; name: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectParams {
  name: string;
  slug?: string;
}

/** What `GET /projects/<p>` returns. */
export interface ProjectDetail {
  project: Project;
  deployments: Deployment[];
  sessions: SessionSummary[];
  connections: unknown[];
  channels: unknown[];
  schedules: unknown[];
}

/** A row of `GET /agents`. */
export interface AgentSummary {
  id: string;
  name: string;
  activeAlias?: string;
  activeDeploymentId?: string;
  deploymentCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** A memory resource as a deployment declares it. */
export interface MemoryDeclaration {
  id: string;
  description?: string;
  provider: { kind: string; [key: string]: unknown };
}

export interface Deployment {
  id: string;
  agentId: string;
  alias: string;
  memory?: MemoryDeclaration[];
  createdAt: string;
  [key: string]: unknown;
}

export interface ListDeploymentsQuery {
  agentId: string;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export interface Webhook {
  id: string;
  projectId: string;
  environment: Environment;
  agentId: string;
  name: string;
  enabled: boolean;
  /** `header:<name>` or `body:<json-pointer>`. */
  identity?: string;
  /** Without its token on list, get and update; with it once on create and rotate. */
  invocationUrl: string;
  /** Present once, on create and on rotate. */
  token?: string;
  createdAt: string;
  updatedAt: string;
  lastInvokedAt?: string;
}

export interface ListWebhooksQuery {
  environment?: Environment;
  agentId?: string;
}

export interface CreateWebhookParams {
  name: string;
  agentId: string;
  environment: Environment;
  identity?: string;
}

export interface UpdateWebhookParams {
  name?: string;
  enabled?: boolean;
  /** `null` removes the identity source. */
  identity?: string | null;
}

/** One entry of a webhook's request ledger. */
export type WebhookRequest = Record<string, unknown>;

// ── GitHub connection ─────────────────────────────────────────────────────────

/** A repository the environment's GitHub installation covers (per design 1c07584, backend in flight). */
export interface Repository {
  id: number | string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
}

export interface ListRepositoriesQuery {
  environment: Environment;
  cursor?: string;
  /** At most 100. */
  limit?: number;
}

export interface RepositoryPage {
  repositories: Repository[];
  nextCursor: string | null;
}
