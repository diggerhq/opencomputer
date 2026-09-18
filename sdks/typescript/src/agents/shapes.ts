// The documented shapes of the management API, as checks a response body
// passes before it is typed. Hand-written and small on purpose: the subpath
// carries no dependency, and the shapes it needs are a few dozen fields of
// strings, numbers, arrays and objects. A body that does not match fails the
// call with code `invalid_response` (see http.ts) rather than flowing inward
// under a type it does not have.
//
// Unknown fields pass through: the API adds fields, and a client that
// rejected them would break on every addition. Application data — a result's
// `data`, a turn's `payload`, a tool's `input` and `output` — is checked only
// as a JSON value; its content belongs to the application.

import type { EventSubscription, OutcomeEventType, TurnOutcomeDelivery } from "./event-subscriptions.js";
import type {
  MemoryDocument,
  MemoryDocumentMeta,
  MemoryDocumentPage,
  MemoryResourceInventory,
  MemoryWriter,
  SessionMemoryBinding,
} from "./memory.js";
import type {
  AgentSummary,
  DataValue,
  Deployment,
  Environment,
  Project,
  ProjectDetail,
  ProjectEnvironment,
  Repository,
  RepositoryPage,
  Session,
  SessionCreated,
  SessionEvent,
  SessionPage,
  SessionResult,
  SessionStatus,
  SessionSummary,
  Turn,
  TurnStatus,
  Webhook,
  WebhookRequest,
} from "./types.js";

/** Checks `value` at `path` and returns it typed, or throws a `ShapeError`. */
export type Shape<T> = (value: unknown, path: string) => T;

/** Where a body stopped matching its documented shape, and what was expected there. */
export class ShapeError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
  ) {
    super(`${path}: expected ${expected}`);
    this.name = "ShapeError";
  }
}

const at = (path: string, key: string | number): string =>
  typeof key === "number" ? `${path}[${String(key)}]` : path === "body" ? key : `${path}.${key}`;

export const string: Shape<string> = (value, path) => {
  if (typeof value !== "string") throw new ShapeError(path, "a string");
  return value;
};

export const nonEmptyString: Shape<string> = (value, path) => {
  if (typeof value !== "string" || !value) throw new ShapeError(path, "a non-empty string");
  return value;
};

export const number: Shape<number> = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ShapeError(path, "a number");
  return value;
};

export const boolean: Shape<boolean> = (value, path) => {
  if (typeof value !== "boolean") throw new ShapeError(path, "a boolean");
  return value;
};

/**
 * A string whose documented values form an open set (session and turn
 * statuses, sources, failure codes): checked as a non-empty string, typed
 * as the union the docs list today, so a value the API adds later reaches
 * the caller as itself instead of failing the call.
 */
export const stringAs = <T extends string>(): Shape<T> => nonEmptyString as Shape<T>;

/** A string from a closed set of documented values. */
export function oneOf<T extends string>(...values: readonly T[]): Shape<T> {
  return (value, path) => {
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      throw new ShapeError(path, `one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
    }
    return value as T;
  };
}

export function optional<T>(shape: Shape<T>): Shape<T | undefined> {
  return (value, path) => (value === undefined ? undefined : shape(value, path));
}

export function nullable<T>(shape: Shape<T>): Shape<T | null> {
  return (value, path) => (value === null ? null : shape(value, path));
}

export function array<T>(item: Shape<T>): Shape<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw new ShapeError(path, "an array");
    return value.map((entry, index) => item(entry, at(path, index)));
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Any object; its fields are not looked at. */
export const anyRecord: Shape<Record<string, unknown>> = (value, path) => {
  if (!isRecord(value)) throw new ShapeError(path, "an object");
  return value;
};

/**
 * An object whose values all match `item`, keyed by strings. Built from its
 * entries, never by assignment: a key named `__proto__` is a key of the body,
 * and assigning it would set the copy's prototype and drop the key instead.
 */
export function record<T>(item: Shape<T>): Shape<Record<string, T>> {
  return (value, path) => {
    if (!isRecord(value)) throw new ShapeError(path, "an object");
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, item(entry, at(path, key))]));
  };
}

type Fields = Record<string, Shape<unknown>>;
type Inferred<F extends Fields> = { [K in keyof F]: F[K] extends Shape<infer T> ? T : never };

/**
 * An object with the named fields checked and every other field passed
 * through as it came. A field whose shape is `optional(...)` may be absent.
 */
export function object<F extends Fields>(fields: F): Shape<Inferred<F>> {
  return (value, path) => {
    if (!isRecord(value)) throw new ShapeError(path, "an object");
    const result: Record<string, unknown> = { ...value };
    for (const [key, shape] of Object.entries(fields)) {
      const checked = shape(value[key], at(path, key));
      if (checked === undefined) delete result[key];
      else result[key] = checked;
    }
    return result as Inferred<F>;
  };
}

/**
 * A JSON value: strings, numbers, booleans, null, arrays and objects of the
 * same. Application data is checked as this and nothing more, and returned
 * as it came: nothing is rebuilt, so every key stays a key (one named
 * `__proto__` included) and an object keeps the prototype parsing gave it.
 */
export const jsonValue: Shape<DataValue> = (value, path) => {
  checkJsonValue(value, path);
  return value as DataValue;
};

function checkJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ShapeError(path, "a JSON value");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkJsonValue(entry, at(path, index)));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) checkJsonValue(entry, at(path, key));
    return;
  }
  throw new ShapeError(path, "a JSON value");
}

/** A `204` or an empty body. */
export const none: Shape<void> = (value, path) => {
  if (value !== undefined) throw new ShapeError(path, "no body");
};

// ── Sessions ──────────────────────────────────────────────────────────────────

export const environment: Shape<Environment> = oneOf("development", "production");

const labels = record(string);

export const sessionResult: Shape<SessionResult> = object({
  turnId: string,
  callId: string,
  reportedAt: string,
  data: jsonValue,
});

const outcomeEventType: Shape<OutcomeEventType> = oneOf("turn.completed", "turn.failed", "turn.cancelled");

const sessionDestination = object({ type: oneOf("session"), sessionId: string });

const turnOutcomeDelivery: Shape<TurnOutcomeDelivery> = object({
  id: string,
  subscriptionId: string,
  eventId: string,
  eventType: outcomeEventType,
  destination: sessionDestination,
  status: oneOf("pending", "delivered", "failed"),
  attempt: number,
  receipt: optional(object({ sessionId: string, turnId: string })),
  nextAttemptAt: optional(string),
  error: optional(oneOf("subscription_unavailable", "target_missing", "target_ended", "delivery_failed")),
  updatedAt: string,
});

export const turn: Shape<Turn> = object({
  id: string,
  input: string,
  mode: oneOf("queue", "steer", "interrupt"),
  status: stringAs<TurnStatus>(),
  payload: optional(jsonValue),
  deliveries: optional(array(turnOutcomeDelivery)),
  createdAt: string,
  updatedAt: string,
});

const sessionMemoryBinding: Shape<SessionMemoryBinding> = (value, path) => {
  const binding = object({
    resource: string,
    scope: oneOf("document", "collection"),
    id: optional(string),
    access: oneOf("read", "read-write"),
    writable: boolean,
  })(value, path);
  if (binding.scope === "document") {
    if (binding.id === undefined) throw new ShapeError(at(path, "id"), "a string");
    return { ...binding, scope: "document", id: binding.id };
  }
  if (binding.access !== "read") throw new ShapeError(at(path, "access"), '"read"');
  return { resource: binding.resource, scope: "collection", access: "read", writable: binding.writable };
};

export const session: Shape<Session> = object({
  id: string,
  projectId: optional(string),
  agentId: string,
  deploymentId: string,
  environment: optional(environment),
  status: stringAs<SessionStatus>(),
  source: optional(string),
  executionMode: optional(string),
  memory: optional(array(sessionMemoryBinding)),
  turns: array(turn),
  labels: optional(labels),
  labelsUpdatedAt: optional(string),
  revision: optional(number),
  result: optional(nullable(sessionResult)),
  createdAt: string,
  updatedAt: string,
}) as Shape<Session>;

export const sessionCreated: Shape<Omit<SessionCreated, "created">> = object({
  session: object({
    id: string,
    status: stringAs<SessionStatus>(),
    createdAt: string,
    executionMode: optional(string),
  }),
  deployment: optional((value, path) => deployment(value, path)),
});

export const sessionSummary: Shape<SessionSummary> = object({
  id: string,
  projectId: optional(string),
  agentId: string,
  deploymentId: string,
  environment: optional(nullable(environment)),
  source: optional(string),
  status: stringAs<SessionStatus>(),
  labels: optional(labels),
  createdAt: string,
  updatedAt: string,
  revision: optional(number),
  activity: optional(
    object({
      activeTurnId: nullable(string),
      queued: number,
      lastSettledTurn: nullable(object({ id: string, status: stringAs<TurnStatus>(), at: string })),
    }),
  ),
  result: optional(nullable(sessionResult)),
}) as Shape<SessionSummary>;

export const sessionPage: Shape<SessionPage> = (value, path) => {
  const page = object({ sessions: array(sessionSummary), nextCursor: optional(nullable(string)) })(value, path);
  return { sessions: page.sessions, nextCursor: page.nextCursor ?? null };
};

export const turnReceipt = object({
  turnId: string,
  status: nonEmptyString,
  duplicate: optional(boolean),
});

/**
 * One log entry. `seq`, `type` and `data` are what a reader keys on and are
 * required; the identity fields are checked when present.
 */
export const sessionEvent: Shape<SessionEvent> = object({
  id: optional(string),
  seq: number,
  timestamp: optional(string),
  sessionId: optional(string),
  turnId: optional(string),
  type: string,
  data: anyRecord,
}) as unknown as Shape<SessionEvent>;

export const eventsPage = object({ events: array(sessionEvent) });

// ── Projects, agents and deployments ──────────────────────────────────────────

const projectEnvironment: Shape<ProjectEnvironment> = object({
  name: environment,
  agentId: optional(string),
  activeDeploymentId: optional(string),
  updatedAt: optional(string),
});

export const project: Shape<Project> = object({
  id: string,
  slug: string,
  name: string,
  environments: array(projectEnvironment),
  agents: array(object({ id: string, name: string })),
  createdAt: string,
  updatedAt: string,
});

export const projectsPage = object({ projects: array(project) });

export const deployment: Shape<Deployment> = object({
  id: string,
  agentId: string,
  alias: string,
  memory: optional(array(object({ id: string, description: optional(string), provider: object({ kind: string }) }))),
  createdAt: string,
});

export const deploymentsPage = object({ deployments: array(deployment) });

export const projectDetail: Shape<ProjectDetail> = object({
  project,
  deployments: array(deployment),
  sessions: array(sessionSummary),
  connections: array(jsonValue),
  channels: array(jsonValue),
  schedules: array(jsonValue),
});

// `activeAlias` and `activeDeploymentId` are `null` while the agent has no
// active deployment, which every agent a new project creates starts as.
export const agentSummary: Shape<AgentSummary> = object({
  id: string,
  name: string,
  activeAlias: optional(nullable(string)),
  activeDeploymentId: optional(nullable(string)),
  deploymentCount: optional(number),
  createdAt: optional(string),
  updatedAt: optional(string),
});

export const agentsPage = object({ agents: array(agentSummary) });

// ── Webhooks and event subscriptions ──────────────────────────────────────────

export const webhook: Shape<Webhook> = object({
  id: string,
  projectId: string,
  environment,
  agentId: string,
  name: string,
  enabled: boolean,
  identity: optional(string),
  invocationUrl: optional(string),
  token: optional(string),
  createdAt: string,
  updatedAt: string,
  lastInvokedAt: optional(string),
}) as Shape<Webhook>;

export const webhooksPage = object({ webhooks: array(webhook) });
export const webhookEnvelope = object({ webhook });

export const webhookRequest: Shape<WebhookRequest> = anyRecord;
export const webhookRequestsPage = object({ requests: array(webhookRequest) });

export const eventSubscription: Shape<EventSubscription> = object({
  id: string,
  projectId: string,
  agentId: optional(string),
  environment: optional(environment),
  events: array(outcomeEventType),
  destination: sessionDestination,
  createdAt: string,
});

export const eventSubscriptionsPage = object({ subscriptions: array(eventSubscription) });
export const eventSubscriptionEnvelope = object({ subscription: eventSubscription });

// ── Memory ────────────────────────────────────────────────────────────────────

const memoryWriter: Shape<MemoryWriter> = (value, path) => {
  const writer = object({ kind: oneOf("owner", "agent"), sessionId: optional(string) })(value, path);
  if (writer.kind === "owner") return { kind: "owner" };
  if (writer.sessionId === undefined) throw new ShapeError(at(path, "sessionId"), "a string");
  return { kind: "agent", sessionId: writer.sessionId };
};

const memoryDocumentFields = {
  id: string,
  title: string,
  summary: string,
  agentWrites: oneOf("enabled", "disabled"),
  revision: string,
  bytes: number,
  maxBytes: number,
  updatedAt: string,
  writer: memoryWriter,
};

export const memoryDocumentMeta: Shape<MemoryDocumentMeta> = object(memoryDocumentFields);

export const memoryDocument: Shape<MemoryDocument> = object({ ...memoryDocumentFields, text: string });

export const memoryDocumentPage: Shape<MemoryDocumentPage> = (value, path) => {
  const page = object({ documents: array(memoryDocumentMeta), nextCursor: optional(nullable(string)) })(value, path);
  return { ...page, nextCursor: page.nextCursor ?? null };
};

export const memoryResourceInventory: Shape<MemoryResourceInventory> = object({
  resources: array(
    object({
      id: string,
      provider: object({ kind: string, maxBytes: optional(number) }),
      declared: boolean,
      documents: number,
    }),
  ),
});

// ── GitHub repositories ───────────────────────────────────────────────────────

const numberOrString: Shape<number | string> = (value, path) => {
  if (typeof value === "number" || typeof value === "string") return value;
  throw new ShapeError(path, "a number or a string");
};

export const repository: Shape<Repository> = object({
  id: numberOrString,
  fullName: string,
  private: boolean,
  defaultBranch: string,
  archived: boolean,
});

export const repositoryPage: Shape<RepositoryPage> = (value, path) => {
  const page = object({ repositories: array(repository), nextCursor: optional(nullable(string)) })(value, path);
  return { repositories: page.repositories, nextCursor: page.nextCursor ?? null };
};
