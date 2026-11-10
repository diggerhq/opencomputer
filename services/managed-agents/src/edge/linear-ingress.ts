// Linear ingress (design 018, "Ingress, acceptance and acknowledgement",
// "Session identity and provider context", "Stop"; work 037 S2).
//
// Owned by the Account object. Two tables:
// - `linear_deliveries`, the delivery ledger: one row per `Linear-Delivery`,
//   written before Linear is answered, so an accepted delivery cannot be lost;
//   the Account alarm enacts its steps with backoff.
// - `linear_sessions`, the session map: one entry per Linear agent session,
//   naming the current OpenComputer session and the frozen provider facts.
//
// A conversational delivery (`created`, an ordinary `prompted`) is
// acknowledged, then admitted. A control delivery (`prompted` with the stop
// signal, `OAuthApp revoked`, `PermissionChange teamAccessChanged`) is
// applied, then confirmed. Admission is the cross-object sequence of work
// 037's Identity seam: reserve the map entry and the admission target on the
// ledger row in one Account transaction, initialize and admit on the Session
// object (both idempotent on derived ids), record the receipt.
//
// Everything that crosses into another object goes through `LinearIngressHost`
// so the whole state machine is testable against the real SQLite storage with
// fake sessions and a fake connection store.

import {
  LINEAR_PROVIDER,
  parseLinearWebhook,
  verifyLinearDelivery,
  type LinearIssueFacts,
  type LinearSessionEvent,
  type LinearWebhookEvent,
} from "../channels/linear.js";
import type {
  AgentInputValue,
  EnqueueTurnInput,
  LinearConnection,
  LinearInputPayload,
  SessionStatus,
  StructuredAgentInput,
  TurnReceipt,
} from "../protocol.js";
import { isRecord } from "../protocol.js";
import type {
  LinearActivityContent,
  LinearConnectionStore,
  LinearGraphqlResult,
  SessionControlInput,
  SessionControlResult,
} from "./linear-contract.js";
import { STRUCTURED_INPUT_LIMIT, structuredInputLength } from "./structured-input.js";

/** Delay after each failed attempt of a step; a failure with no entry left is final. */
export const LINEAR_STEP_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];
/**
 * Attempts at the acknowledgement before admission goes ahead without it.
 * Kept short: admission waits for it (a thought posted after the agent's own
 * activities would put a finished Linear session back to active), and
 * Linear's 10-second responsiveness window is spent after the first retry.
 */
export const LINEAR_ACK_ATTEMPTS = 2;
/** Held while a step runs, so an overlapping alarm skips the row. */
const LINEAR_STEP_LEASE_MS = 600_000;
/** A deferred row waits at least this long before it is looked at again. */
const LINEAR_HOLD_MS = 1_000;
/**
 * How often a row that would supersede an ended session asks again whether
 * that session's Linear activity queue has drained (work 037 review D3).
 */
export const LINEAR_DRAIN_POLL_MS = 15_000;
/** Raw bodies above this are refused before verification. */
export const LINEAR_WEBHOOK_BODY_LIMIT = 512 * 1024;

export const LINEAR_ACK_TEXT = "Reading the issue.";
export const LINEAR_FAILURE_TEXT = "OpenComputer could not complete this request.";
export const LINEAR_STOPPED_TEXT = "Stopped.";

// ── Storage ───────────────────────────────────────────────────────────────────

export type LinearDeliveryKind = "conversational" | "control";
export type LinearDeliveryEvent = "created" | "prompted" | "stop" | "revoked" | "teams";
export type LinearDeliveryState =
  | "accepted"
  | "acknowledged"
  | "admitted"
  | "applied"
  | "confirmed"
  | "invalidated"
  | "failed";
/**
 * A side activity the ledger itself posts (the acknowledgement, a failure
 * notice). `queued`: handed to the Session object's ordered activity queue.
 */
type SideActivityState = "pending" | "posted" | "queued" | "abandoned" | "skipped";

export interface LinearDeliveryRow {
  [key: string]: SqlStorageValue;
  id: string;
  connection_id: string;
  account_id: string;
  edge_origin: string;
  received_at: string;
  payload_json: string;
  event: LinearDeliveryEvent;
  kind: LinearDeliveryKind;
  agent_session_id: string | null;
  state: LinearDeliveryState;
  provider_time: string;
  attempts: number;
  next_attempt_at: string | null;
  error: string | null;
  receipt_json: string | null;
  response_json: string;
  ack_activity_id: string | null;
  ack_state: SideActivityState | null;
  error_activity_id: string | null;
  error_activity_state: SideActivityState | null;
  session_id: string | null;
  input_json: string | null;
  updated_at: string;
}

export interface LinearSessionRow {
  [key: string]: SqlStorageValue;
  connection_id: string;
  agent_session_id: string;
  session_id: string;
  supersession: number;
  issue_id: string | null;
  issue_json: string | null;
  parent_issue_id: string | null;
  parent_identifier: string | null;
  created_by_agent: number;
  prompt_context: string | null;
  superseded_json: string;
  origin_delivery_id: string;
  /** Provider time of the last stop applied to this Linear session (review D1). */
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS linear_deliveries (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    edge_origin TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    event TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('conversational', 'control')),
    agent_session_id TEXT,
    state TEXT NOT NULL CHECK (state IN (
      'accepted', 'acknowledged', 'admitted', 'applied', 'confirmed', 'invalidated', 'failed'
    )),
    provider_time TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    error TEXT,
    receipt_json TEXT,
    response_json TEXT NOT NULL,
    ack_activity_id TEXT,
    ack_state TEXT,
    error_activity_id TEXT,
    error_activity_state TEXT,
    session_id TEXT,
    input_json TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS linear_deliveries_due
    ON linear_deliveries(next_attempt_at);
  CREATE INDEX IF NOT EXISTS linear_deliveries_session
    ON linear_deliveries(connection_id, agent_session_id, kind, state, provider_time);
  CREATE TABLE IF NOT EXISTS linear_sessions (
    connection_id TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    supersession INTEGER NOT NULL DEFAULT 0,
    issue_id TEXT,
    issue_json TEXT,
    parent_issue_id TEXT,
    parent_identifier TEXT,
    created_by_agent INTEGER NOT NULL DEFAULT 0,
    prompt_context TEXT,
    superseded_json TEXT NOT NULL DEFAULT '[]',
    origin_delivery_id TEXT NOT NULL,
    stopped_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, agent_session_id)
  );
  CREATE INDEX IF NOT EXISTS linear_sessions_session
    ON linear_sessions(session_id);
`;

const ensured = new WeakSet<object>();

/** Idempotent; called by every entry point so the constructor needs no hook. */
export function ensureLinearIngressSchema(sql: SqlStorage): void {
  if (ensured.has(sql)) return;
  sql.exec(SCHEMA);
  const columns = sql
    .exec<{ name: string }>("PRAGMA table_info(linear_sessions)")
    .toArray()
    .map((column) => column.name);
  if (!columns.includes("stopped_at")) {
    sql.exec("ALTER TABLE linear_sessions ADD COLUMN stopped_at TEXT");
  }
  ensured.add(sql);
}

/** The earliest due step, for the Account object's single alarm. */
export function nextLinearDeliveryAttempt(sql: SqlStorage): string | undefined {
  ensureLinearIngressSchema(sql);
  return sql
    .exec<{ next_attempt_at: string }>(
      `SELECT next_attempt_at FROM linear_deliveries
       WHERE next_attempt_at IS NOT NULL
       ORDER BY next_attempt_at LIMIT 1`,
    )
    .toArray()[0]?.next_attempt_at;
}

// ── Identity ──────────────────────────────────────────────────────────────────

/** Work 037, Identity seam: what the OpenComputer session id is derived from. */
export function linearSessionKey(
  connectionId: string,
  agentSessionId: string,
  supersession: number,
): string {
  return `linear:${connectionId}:${agentSessionId}:${String(supersession)}`;
}

/** Turn keys: one turn per delivery, whichever session it lands on. */
export function linearTurnKey(deliveryId: string): string {
  return `linear:${deliveryId}`;
}

// ── Host ──────────────────────────────────────────────────────────────────────

/** What admission needs from a Session object. */
export interface LinearSessionPort {
  findTurn(idempotencyKey: string): Promise<{ turnId: string; status: string } | null>;
  /**
   * Null when never initialized. `ready`: a turn can be enqueued now (a
   * Workerd session, or a microVM session whose runtime is bound).
   * `admitted`: the session holds at least one turn.
   */
  state(): Promise<{ status: SessionStatus; ready: boolean; admitted: boolean } | null>;
  /** A turn, or an input held behind the session's open question (S4). */
  enqueueTurn(input: EnqueueTurnInput): Promise<TurnReceipt>;
  end(): Promise<void>;
  applyControl(input: SessionControlInput): Promise<SessionControlResult>;
  /** The session's Linear activity queue is empty, or its drain window passed. */
  linearQueueDrained(): Promise<boolean>;
  /**
   * Enqueue a terminal `error` behind the session's queued activities, once
   * per key. False when no Linear input reached the session.
   */
  enqueueLinearTerminal(input: { key: string; body: string }): Promise<boolean>;
}

export interface LinearLaunchInput {
  sessionId: string;
  accountId: string;
  connection: LinearConnection;
  edgeOrigin: string;
  text: string;
  idempotencyKey: string;
  agentInput: StructuredAgentInput;
  providerTime: string;
}

export interface LinearIngressHost {
  storage: DurableObjectStorage;
  /** Read at each use: S1 replaces the Account object's store. */
  connections(): LinearConnectionStore;
  /**
   * The Session object under `sessionId`. With `connection`, a session not yet
   * created starts in the region of the connection's deployment (work 057).
   */
  session(sessionId: string, connection?: LinearConnection): LinearSessionPort;
  /**
   * Initialize the session under `sessionId`, owned by the connection's
   * principal, and enqueue its first turn (the Account object's
   * `launchSession`). Ends the session and throws when nothing was admitted.
   */
  launch(input: LinearLaunchInput): Promise<void>;
  deriveSessionId(accountId: string, key: string): Promise<string>;
  resetAlarm(): Promise<void>;
  now?(): number;
  uuid?(): string;
}

export interface LinearWebhookDelivery {
  connectionId: string;
  accountId: string;
  edgeOrigin: string;
  /** `Linear-Delivery`. */
  deliveryId: string | null;
  /** `Linear-Signature`. */
  signature: string | null;
  /** The raw body, exactly as received. */
  payload: string;
}

/** What the route answers. Concrete fields: an RPC return type cannot carry `unknown`. */
export interface LinearAcceptBody {
  ok?: boolean;
  deliveryId?: string;
  kind?: LinearDeliveryKind;
  duplicate?: boolean;
  ignored?: boolean;
  error?: string;
}

export interface LinearAcceptResult {
  status: number;
  body: LinearAcceptBody;
}

/** A step failure no retry can change. `notify`: say so on the Linear session. */
class LinearStepFailure extends Error {
  constructor(
    message: string,
    readonly notify: boolean,
  ) {
    super(message);
  }
}

/** Not a failure: the step waits and asks again without spending an attempt. */
class LinearStepDeferral extends Error {}

type PostOutcome =
  | { outcome: "posted"; duplicate: boolean }
  | { outcome: "transient"; message: string }
  | { outcome: "permanent"; message: string }
  | { outcome: "unavailable"; message: string };

const ACTIVITY_MUTATION = `mutation LinearAgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity { id createdAt content { __typename } }
  }
}`;

const ISSUE_CONTEXT_QUERY = `query LinearIssueContext($id: String!) {
  issue(id: $id) { id parent { id identifier } creator { id } }
}`;

const SESSION_CONTEXT_QUERY = `query LinearSessionContext($id: String!) {
  agentSession(id: $id) {
    id
    issue {
      id identifier title description url
      team { id key name }
      parent { id identifier }
      creator { id }
    }
  }
}`;

function graphqlErrorText(result: LinearGraphqlResult & { outcome: "ok" }): string {
  return (result.errors ?? []).map((error) => error.message).join("; ").slice(0, 500);
}

function rateLimited(result: LinearGraphqlResult & { outcome: "ok" }): boolean {
  return (result.errors ?? []).some((error) => {
    const code = isRecord(error.extensions) ? error.extensions.code : undefined;
    return code === "RATELIMITED" || code === "INTERNAL_SERVER_ERROR";
  });
}

/**
 * One `agentActivityCreate` with a persisted client id. A conflict on the id
 * means an earlier attempt posted it (spike part 1).
 */
export async function postLinearActivityOnce(
  connections: LinearConnectionStore,
  connectionId: string,
  activity: { id: string; agentSessionId: string; content: LinearActivityContent },
): Promise<PostOutcome> {
  const result = await connections.graphql(connectionId, {
    query: ACTIVITY_MUTATION,
    variables: {
      input: {
        id: activity.id,
        agentSessionId: activity.agentSessionId,
        content: activity.content,
      },
    },
  });
  if (result.outcome === "unavailable") {
    return { outcome: "unavailable", message: `connection ${result.reason}` };
  }
  if (result.outcome === "transient") return { outcome: "transient", message: result.message };
  if (result.outcome === "permanent") return { outcome: "permanent", message: result.message };
  if (result.errors?.some((error) => error.message.includes("conflict on insert of AgentActivity"))) {
    return { outcome: "posted", duplicate: true };
  }
  if (result.errors?.length) {
    return rateLimited(result)
      ? { outcome: "transient", message: graphqlErrorText(result) }
      : { outcome: "permanent", message: graphqlErrorText(result) };
  }
  const created = isRecord(result.data) ? result.data.agentActivityCreate : undefined;
  if (isRecord(created) && created.success === true) return { outcome: "posted", duplicate: false };
  return { outcome: "transient", message: "agentActivityCreate did not report success" };
}

interface ProviderContext {
  issue: LinearIssueFacts | null;
  parent: { id: string; identifier: string } | null;
  createdByAgent: boolean;
}

function readParent(value: unknown): { id: string; identifier: string } | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.identifier === "string"
    ? { id: value.id, identifier: value.identifier }
    : null;
}

function readIssueFacts(value: unknown): LinearIssueFacts | null {
  if (!isRecord(value)) return null;
  const team = isRecord(value.team) ? value.team : null;
  if (
    typeof value.id !== "string" ||
    typeof value.identifier !== "string" ||
    typeof value.url !== "string" ||
    typeof team?.id !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    identifier: value.identifier,
    title: typeof value.title === "string" ? value.title : "",
    description: typeof value.description === "string" ? value.description : null,
    url: value.url,
    team: {
      id: team.id,
      key: typeof team.key === "string" ? team.key : "",
      name: typeof team.name === "string" ? team.name : "",
    },
  };
}

function nowIso(host: LinearIngressHost): string {
  return new Date(host.now?.() ?? Date.now()).toISOString();
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}

/** Build the turn input once; it is frozen on the ledger row at reservation. */
export function buildLinearTurnInput(input: {
  event: LinearSessionEvent;
  connectionId: string;
  entry: Pick<
    LinearSessionRow,
    "issue_json" | "parent_issue_id" | "parent_identifier" | "created_by_agent" | "prompt_context"
  >;
}): { text: string; agentInput: StructuredAgentInput } {
  const { event, entry } = input;
  const storedIssue = entry.issue_json ? (JSON.parse(entry.issue_json) as LinearIssueFacts) : null;
  const issue = event.issue ?? storedIssue;
  const promptContext = event.promptContext ?? entry.prompt_context ?? undefined;
  const payload: LinearInputPayload = {
    action: event.action,
    issue: issue ?? {
      id: event.issueId ?? "",
      identifier: "",
      title: "",
      description: null,
      url: "",
      team: { id: "", key: "", name: "" },
    },
    origin: {
      ...(entry.parent_issue_id && entry.parent_identifier
        ? { parent: { id: entry.parent_issue_id, identifier: entry.parent_identifier } }
        : {}),
      createdByAgent: entry.created_by_agent === 1,
    },
    session: {
      id: event.agentSessionId,
      ...(event.session.url ? { url: event.session.url } : {}),
      ...(event.session.creator ? { creator: event.session.creator } : {}),
    },
    ...(promptContext ? { promptContext } : {}),
    ...(event.comment ? { comment: event.comment } : {}),
    ...(event.previousComments !== undefined ? { previousComments: event.previousComments } : {}),
    ...(event.guidance !== undefined ? { guidance: event.guidance } : {}),
  };
  let text =
    event.action === "prompted"
      ? (event.activity?.body ?? "")
      : (promptContext ?? (issue ? `${issue.identifier}: ${issue.title}` : "Linear agent session"));
  const userId =
    event.action === "prompted" ? event.activity?.userId : event.session.creator?.id;
  const build = (): StructuredAgentInput => ({
    source: "channel",
    text,
    channel: {
      provider: LINEAR_PROVIDER,
      connectionId: input.connectionId,
      workspaceId: event.organizationId,
      conversationId: event.agentSessionId,
      ...(userId ? { userId } : {}),
    },
    payload: payload as unknown as AgentInputValue,
  });
  // An accepted delivery must never be refused at storage: shed the bulkiest
  // optional context first, then cut the long texts.
  let agentInput = build();
  for (const key of ["previousComments", "guidance"] as const) {
    if (structuredInputLength(agentInput) <= STRUCTURED_INPUT_LIMIT) break;
    delete payload[key];
    agentInput = build();
  }
  if (structuredInputLength(agentInput) > STRUCTURED_INPUT_LIMIT) {
    const budget = Math.floor(STRUCTURED_INPUT_LIMIT / 4);
    if (payload.promptContext) payload.promptContext = payload.promptContext.slice(0, budget);
    if (payload.issue.description) payload.issue.description = payload.issue.description.slice(0, budget);
    if (payload.comment) payload.comment = { ...payload.comment, body: payload.comment.body.slice(0, budget) };
    text = text.slice(0, budget);
    agentInput = build();
  }
  return { text, agentInput };
}

// ── The ingress ───────────────────────────────────────────────────────────────

export class LinearIngress {
  constructor(private readonly host: LinearIngressHost) {
    ensureLinearIngressSchema(host.storage.sql);
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  private uuid(): string {
    return this.host.uuid?.() ?? crypto.randomUUID();
  }

  delivery(id: string): LinearDeliveryRow | null {
    return (
      this.sql
        .exec<LinearDeliveryRow>("SELECT * FROM linear_deliveries WHERE id = ?", id)
        .toArray()[0] ?? null
    );
  }

  entry(connectionId: string, agentSessionId: string): LinearSessionRow | null {
    return (
      this.sql
        .exec<LinearSessionRow>(
          "SELECT * FROM linear_sessions WHERE connection_id = ? AND agent_session_id = ?",
          connectionId,
          agentSessionId,
        )
        .toArray()[0] ?? null
    );
  }

  /**
   * Durable acceptance. Verification first (signature over the raw bytes,
   * then freshness); nothing is stored for a delivery that fails it. Then the
   * ledger row, idempotent on `Linear-Delivery`; only then the 200. A
   * redelivery is answered with the original result.
   */
  async accept(delivery: LinearWebhookDelivery): Promise<LinearAcceptResult> {
    const connections = this.host.connections();
    const now = this.host.now?.() ?? Date.now();
    const at = new Date(now).toISOString();
    const connection = connections.get(delivery.connectionId);
    const secret = connection ? await connections.signingSecret(delivery.connectionId) : null;
    if (!connection || !secret) {
      return { status: 404, body: { error: "connection_unavailable" } };
    }
    const verified = await verifyLinearDelivery({
      payload: delivery.payload,
      signature: delivery.signature,
      secret,
      now,
    });
    if (!verified.ok) {
      log("warn", "linear.webhook_rejected", {
        connectionId: delivery.connectionId,
        reason: verified.reason,
      });
      return {
        status: verified.reason === "invalid_body" ? 400 : 401,
        body: { error: verified.reason },
      };
    }
    if (!delivery.deliveryId) {
      return { status: 400, body: { error: "missing_delivery_id" } };
    }
    const event = parseLinearWebhook(verified.body);
    if (!event) return { status: 400, body: { error: "invalid_payload" } };
    if (event.kind === "ignored") {
      return { status: 200, body: { ok: true, ignored: true } };
    }
    // A signed delivery from another workspace or client cannot be ours; the
    // signature makes this near impossible, so it is logged, not stored.
    const organizationId = "organizationId" in event ? event.organizationId : undefined;
    const oauthClientId = "oauthClientId" in event ? event.oauthClientId : undefined;
    if (
      (connection.organizationId && organizationId && connection.organizationId !== organizationId) ||
      (connection.clientId && oauthClientId && connection.clientId !== oauthClientId)
    ) {
      log("warn", "linear.webhook_foreign", { connectionId: delivery.connectionId });
      return { status: 200, body: { ok: true, ignored: true } };
    }
    // Health reads "session received" only from an agent session event
    // (review D5); an authorization or a permission change is not one.
    if (event.kind === "session") connections.recordEvent(delivery.connectionId, at);
    const existing = this.delivery(delivery.deliveryId);
    if (existing) {
      return {
        status: 200,
        body: { ...(JSON.parse(existing.response_json) as LinearAcceptBody), duplicate: true },
      };
    }
    const shape = deliveryShape(event);
    const response: LinearAcceptBody = { ok: true, deliveryId: delivery.deliveryId, kind: shape.kind };
    const deliveryId = delivery.deliveryId;
    this.host.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO linear_deliveries (
           id, connection_id, account_id, edge_origin, received_at, payload_json,
           event, kind, agent_session_id, state, provider_time, attempts,
           next_attempt_at, response_json, ack_activity_id, ack_state, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        delivery.deliveryId,
        delivery.connectionId,
        delivery.accountId,
        delivery.edgeOrigin,
        at,
        delivery.payload,
        shape.event,
        shape.kind,
        shape.agentSessionId ?? null,
        shape.providerTime,
        at,
        JSON.stringify(response),
        // The acknowledgement's id exists before its first attempt.
        shape.event === "created" ? this.uuid() : null,
        shape.event === "created" ? "pending" : null,
        at,
      );
      // Linear releases messages held during a run after its "Stopped.",
      // with their earlier `createdAt` (spike part 5): a conversational
      // delivery older than the last applied stop is never admitted (D1).
      const stored = this.delivery(deliveryId);
      if (stored?.kind === "conversational" && stored.state === "accepted") {
        this.invalidateIfStopped(stored, event.kind === "session" ? event.promptContext : undefined);
      }
    });
    await this.host.resetAlarm();
    const stored = this.delivery(delivery.deliveryId);
    log("info", "linear.webhook_accepted", {
      connectionId: delivery.connectionId,
      deliveryId: delivery.deliveryId,
      linearEvent: shape.event,
      agentSessionId: shape.agentSessionId,
    });
    return {
      status: 200,
      body: stored ? (JSON.parse(stored.response_json) as LinearAcceptBody) : response,
    };
  }

  /** The alarm's entry: every due row, controls first, then in provider order. */
  async enactDue(at?: string): Promise<void> {
    const now = at ?? nowIso(this.host);
    const due = this.sql
      .exec<LinearDeliveryRow>(
        `SELECT * FROM linear_deliveries
         WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= ?
         ORDER BY CASE kind WHEN 'control' THEN 0 ELSE 1 END, provider_time, received_at
         LIMIT 50`,
        now,
      )
      .toArray();
    for (const row of due) {
      try {
        await this.enact(row.id);
      } catch (error) {
        // A bug in one row must not starve the others; it is retried by backoff.
        log("error", "linear.enact_crashed", { deliveryId: row.id, error: errorText(error) });
      }
    }
  }

  /** Run every step of one row that is due now. */
  async enact(deliveryId: string): Promise<void> {
    for (let step = 0; step < 5; step += 1) {
      const row = this.delivery(deliveryId);
      if (!row || row.next_attempt_at === null) return;
      if (row.next_attempt_at > nowIso(this.host)) return;
      const advanced = await this.step(row);
      // A step that moved the row to another state (a failure with a notice
      // to post, say) lets the next step run in the same pass.
      if (!advanced && this.delivery(deliveryId)?.state === row.state) return;
    }
  }

  /** One step. True when the row advanced and its next step may run at once. */
  private async step(row: LinearDeliveryRow): Promise<boolean> {
    if (!this.lease(row)) return false;
    const leased = this.delivery(row.id)!;
    if (leased.state === "failed") return this.postFailureNotice(leased);
    if (leased.kind === "control") return this.control(leased);
    if (
      (leased.state === "accepted" || leased.state === "acknowledged") &&
      this.host.storage.transactionSync(() => this.invalidateIfStopped(leased))
    ) {
      return false;
    }
    if (leased.state === "accepted") return this.acknowledge(leased);
    if (leased.state === "acknowledged") return this.admit(leased);
    this.update(leased.id, { next_attempt_at: null });
    return false;
  }

  /** Take the row for this attempt; false when another attempt holds it. */
  private lease(row: LinearDeliveryRow): boolean {
    const until = new Date((this.host.now?.() ?? Date.now()) + LINEAR_STEP_LEASE_MS).toISOString();
    return (
      this.sql.exec(
        `UPDATE linear_deliveries SET next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND state = ? AND attempts = ? AND next_attempt_at = ?`,
        until,
        nowIso(this.host),
        row.id,
        row.state,
        row.attempts,
        row.next_attempt_at,
      ).rowsWritten > 0
    );
  }

  private update(id: string, fields: Partial<Record<keyof LinearDeliveryRow, SqlStorageValue>>): void {
    const entries = Object.entries({ ...fields, updated_at: nowIso(this.host) });
    this.sql.exec(
      `UPDATE linear_deliveries SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
      ...entries.map(([, value]) => value as SqlStorageValue),
      id,
    );
  }

  /** Advance to the next step, due at once, with a fresh attempt count. */
  private advance(id: string, fields: Partial<Record<keyof LinearDeliveryRow, SqlStorageValue>>): void {
    this.update(id, { ...fields, attempts: 0, next_attempt_at: nowIso(this.host), error: null });
  }

  /**
   * A failed attempt: retry by backoff, or, once exhausted (or at once for a
   * failure no retry changes), call `exhausted`.
   */
  private retry(row: LinearDeliveryRow, message: string, final: boolean, exhausted: () => void): void {
    const attempts = row.attempts + 1;
    const backoff = LINEAR_STEP_BACKOFF_MS[attempts - 1];
    if (final || backoff === undefined) {
      exhausted();
      return;
    }
    this.update(row.id, {
      attempts,
      error: message.slice(0, 1_000),
      next_attempt_at: new Date((this.host.now?.() ?? Date.now()) + backoff).toISOString(),
    });
  }

  /** Mark failed; when the Linear session can be told, a notice with a persisted id follows. */
  private fail(row: LinearDeliveryRow, message: string, notify: boolean): void {
    const canNotify = notify && Boolean(row.agent_session_id);
    this.update(row.id, {
      state: "failed",
      error: message.slice(0, 1_000),
      attempts: 0,
      error_activity_id: canNotify ? (row.error_activity_id ?? this.uuid()) : row.error_activity_id,
      error_activity_state: canNotify ? "pending" : "skipped",
      next_attempt_at: canNotify ? nowIso(this.host) : null,
    });
    log("error", "linear.delivery_failed", {
      connectionId: row.connection_id,
      deliveryId: row.id,
      linearEvent: row.event,
      error: message.slice(0, 300),
    });
  }

  private event(row: LinearDeliveryRow): LinearWebhookEvent {
    const event = parseLinearWebhook(JSON.parse(row.payload_json) as Record<string, unknown>);
    if (!event) throw new LinearStepFailure("Stored delivery no longer parses", false);
    return event;
  }

  /**
   * Provider time of the last stop applied to a Linear session: the map
   * entry's, or, before any entry exists, the latest stop the ledger applied
   * (a stop that reached no session). Null when none was.
   */
  private lastStop(connectionId: string, agentSessionId: string): string | null {
    const entry = this.entry(connectionId, agentSessionId);
    if (entry) return entry.stopped_at;
    return (
      this.sql
        .exec<{ stopped_at: string | null }>(
          `SELECT MAX(provider_time) AS stopped_at FROM linear_deliveries
           WHERE connection_id = ? AND agent_session_id = ? AND event = 'stop'
             AND state IN ('applied', 'confirmed')`,
          connectionId,
          agentSessionId,
        )
        .toArray()[0]?.stopped_at ?? null
    );
  }

  /**
   * Inside the caller's transaction: invalidate a pending conversational row
   * written before the last applied stop of its Linear session (review D1).
   * A late `created` still leaves its prompt context on the map entry.
   */
  private invalidateIfStopped(row: LinearDeliveryRow, promptContext?: string): boolean {
    if (row.kind !== "conversational" || !row.agent_session_id) return false;
    const stoppedAt = this.lastStop(row.connection_id, row.agent_session_id);
    if (!stoppedAt || !(row.provider_time < stoppedAt)) return false;
    if (row.event === "created" && promptContext) {
      this.sql.exec(
        `UPDATE linear_sessions SET prompt_context = ?, updated_at = ?
         WHERE connection_id = ? AND agent_session_id = ? AND prompt_context IS NULL`,
        promptContext,
        nowIso(this.host),
        row.connection_id,
        row.agent_session_id,
      );
    }
    this.update(row.id, {
      state: "invalidated",
      next_attempt_at: null,
      ack_state: row.ack_state === "pending" ? "skipped" : row.ack_state,
      error: `older than the stop at ${stoppedAt}`,
      receipt_json: JSON.stringify({ stopped: true, stoppedAt }),
    });
    log("info", "linear.delivery_stopped", {
      connectionId: row.connection_id,
      deliveryId: row.id,
      agentSessionId: row.agent_session_id,
    });
    return true;
  }

  // ── Conversational: acknowledge ─────────────────────────────────────────────

  private async acknowledge(row: LinearDeliveryRow): Promise<boolean> {
    const event = this.event(row);
    if (event.kind !== "session") {
      this.fail(row, "Conversational row without a session event", false);
      return false;
    }
    if (event.action === "prompted") {
      this.advance(row.id, { state: "acknowledged", ack_state: "skipped" });
      return true;
    }
    // A `created` whose Linear session another delivery already opened: the
    // prompt that arrived first became the first input (design 018). Record
    // it as superseded, keep its prompt context, admit nothing and post
    // nothing (a late thought would reopen a finished session).
    const entry = this.entry(row.connection_id, event.agentSessionId);
    if (entry && entry.origin_delivery_id !== row.id) {
      this.host.storage.transactionSync(() => {
        if (event.promptContext && !entry.prompt_context) {
          this.sql.exec(
            `UPDATE linear_sessions SET prompt_context = ?, updated_at = ?
             WHERE connection_id = ? AND agent_session_id = ?`,
            event.promptContext,
            nowIso(this.host),
            row.connection_id,
            event.agentSessionId,
          );
        }
        this.update(row.id, {
          state: "invalidated",
          ack_state: "skipped",
          next_attempt_at: null,
          receipt_json: JSON.stringify({
            superseded: true,
            reason: "created_after_prompted",
            sessionId: entry.session_id,
            by: entry.origin_delivery_id,
          }),
        });
      });
      return false;
    }
    const posted = await postLinearActivityOnce(this.host.connections(), row.connection_id, {
      id: row.ack_activity_id!,
      agentSessionId: event.agentSessionId,
      content: { type: "thought", body: LINEAR_ACK_TEXT },
    });
    if (posted.outcome === "posted") {
      this.advance(row.id, { state: "acknowledged", ack_state: "posted" });
      return true;
    }
    if (posted.outcome === "unavailable") {
      this.fail(row, `Linear connection unavailable: ${posted.message}`, false);
      return false;
    }
    // A late acknowledgement shows the agent as slow, never as having lost
    // the message: once its retries are spent, admission goes ahead.
    let abandoned = false;
    const final = posted.outcome === "permanent" || row.attempts + 1 >= LINEAR_ACK_ATTEMPTS;
    this.retry(row, posted.message, final, () => {
      abandoned = true;
      this.advance(row.id, { state: "acknowledged", ack_state: "abandoned" });
      this.update(row.id, { error: `acknowledgement abandoned: ${posted.message}`.slice(0, 1_000) });
    });
    return abandoned;
  }

  // ── Conversational: admit ───────────────────────────────────────────────────

  /**
   * Rows of one Linear session wait for an unapplied stop on it and for
   * every older pending row, so admissions follow provider order and a stop
   * is applied before anything after it.
   */
  private blocker(row: LinearDeliveryRow): string | null | undefined {
    const blocking = this.sql
      .exec<{ next_attempt_at: string | null }>(
        `SELECT next_attempt_at FROM linear_deliveries
         WHERE connection_id = ? AND agent_session_id = ? AND id != ?
           AND (
             (kind = 'control' AND state = 'accepted')
             OR (kind = 'conversational' AND state IN ('accepted', 'acknowledged')
                 AND (provider_time < ? OR (provider_time = ? AND received_at < ?)))
           )
         ORDER BY next_attempt_at LIMIT 1`,
        row.connection_id,
        row.agent_session_id,
        row.id,
        row.provider_time,
        row.provider_time,
        row.received_at,
      )
      .toArray()[0];
    return blocking === undefined ? undefined : blocking.next_attempt_at;
  }

  private async admit(row: LinearDeliveryRow): Promise<boolean> {
    const blockedUntil = this.blocker(row);
    if (blockedUntil !== undefined) {
      const floor = (this.host.now?.() ?? Date.now()) + LINEAR_HOLD_MS;
      const until = blockedUntil ? Math.max(Date.parse(blockedUntil), floor) : floor;
      this.update(row.id, { next_attempt_at: new Date(until).toISOString() });
      return false;
    }
    try {
      const receipt = await this.admitOnce(row);
      this.update(row.id, {
        state: "admitted",
        session_id: receipt.sessionId,
        receipt_json: JSON.stringify(receipt),
        next_attempt_at: null,
        error: null,
      });
      log("info", "linear.delivery_admitted", {
        connectionId: row.connection_id,
        deliveryId: row.id,
        sessionId: receipt.sessionId,
        ...("turnId" in receipt
          ? { turnId: receipt.turnId }
          : { held: receipt.held ?? false, discarded: receipt.discarded ?? false, questionId: receipt.questionId }),
        duplicate: receipt.duplicate,
      });
      return false;
    } catch (error) {
      const message = errorText(error);
      if (error instanceof LinearStepDeferral) {
        this.update(row.id, {
          error: message,
          next_attempt_at: new Date((this.host.now?.() ?? Date.now()) + LINEAR_DRAIN_POLL_MS).toISOString(),
        });
        log("info", "linear.admit_deferred", {
          connectionId: row.connection_id,
          deliveryId: row.id,
          reason: message.slice(0, 300),
        });
        return false;
      }
      const final = error instanceof LinearStepFailure;
      const notify = final ? error.notify : true;
      this.retry(this.delivery(row.id)!, message, final, () => this.fail(row, message, notify));
      log("warn", "linear.admit_failed", {
        connectionId: row.connection_id,
        deliveryId: row.id,
        error: message.slice(0, 300),
      });
      return false;
    }
  }

  private connection(connectionId: string): LinearConnection {
    const connection = this.host.connections().get(connectionId);
    if (!connection || connection.status !== "connected") {
      throw new LinearStepFailure(
        `Linear connection is ${connection?.status ?? "not found"}`,
        false,
      );
    }
    return connection;
  }

  /** Read the frozen provider facts with the app token (work 037, Provider context). */
  private async providerContext(
    connection: LinearConnection,
    event: LinearSessionEvent,
  ): Promise<ProviderContext> {
    const fromSession = event.action === "prompted";
    const issueId = event.issueId ?? event.issue?.id;
    if (!fromSession && !issueId) {
      throw new LinearStepFailure("The created event names no issue", true);
    }
    const result = await this.host.connections().graphql(connection.id, {
      query: fromSession ? SESSION_CONTEXT_QUERY : ISSUE_CONTEXT_QUERY,
      variables: { id: fromSession ? event.agentSessionId : issueId },
    });
    if (result.outcome === "unavailable") {
      throw new LinearStepFailure(`Linear connection unavailable: ${result.reason}`, false);
    }
    if (result.outcome === "transient" || result.outcome === "permanent") {
      throw new Error(`Linear provider context: ${result.message}`);
    }
    if (result.errors?.length) {
      throw new Error(`Linear provider context: ${graphqlErrorText(result)}`);
    }
    const data = isRecord(result.data) ? result.data : {};
    const issue = fromSession
      ? isRecord(data.agentSession)
        ? data.agentSession.issue
        : undefined
      : data.issue;
    if (!isRecord(issue)) throw new Error("Linear provider context: no issue returned");
    const creator = isRecord(issue.creator) ? issue.creator : null;
    const appUserId = connection.appUserId ?? event.appUserId;
    return {
      issue: fromSession ? readIssueFacts(issue) : null,
      parent: readParent(issue.parent),
      createdByAgent: Boolean(appUserId) && creator?.id === appUserId,
    };
  }

  /**
   * The cross-object sequence. Every id is derived, so a retry at any point
   * finds the same session and the same turn and returns the same receipt.
   */
  private async admitOnce(row: LinearDeliveryRow): Promise<LinearAdmissionReceipt> {
    const event = this.event(row);
    if (event.kind !== "session") throw new LinearStepFailure("Not a session event", false);
    const connection = this.connection(row.connection_id);
    const key = linearTurnKey(row.id);

    // 1. Reserve the map entry and the admission target in one transaction
    //    (review D7): a crash leaves both or neither.
    let entry = this.entry(row.connection_id, event.agentSessionId);
    let reserved = this.delivery(row.id)!;
    if (!entry || !reserved.session_id || !reserved.input_json) {
      const created = entry
        ? null
        : {
            context: await this.providerContext(connection, event),
            sessionId: await this.host.deriveSessionId(
              row.account_id,
              linearSessionKey(row.connection_id, event.agentSessionId, 0),
            ),
          };
      this.host.storage.transactionSync(() => {
        if (created && !this.entry(row.connection_id, event.agentSessionId)) {
          const at = nowIso(this.host);
          const issue = event.issue ?? created.context.issue;
          // A stop applied before the entry existed stays in force on it.
          const stoppedAt = this.lastStop(row.connection_id, event.agentSessionId);
          this.sql.exec(
            `INSERT INTO linear_sessions (
               connection_id, agent_session_id, session_id, supersession, issue_id,
               issue_json, parent_issue_id, parent_identifier, created_by_agent,
               prompt_context, superseded_json, origin_delivery_id, stopped_at,
               created_at, updated_at
             ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
            row.connection_id,
            event.agentSessionId,
            created.sessionId,
            issue?.id ?? event.issueId ?? null,
            issue ? JSON.stringify(issue) : null,
            created.context.parent?.id ?? null,
            created.context.parent?.identifier ?? null,
            created.context.createdByAgent ? 1 : 0,
            event.promptContext ?? null,
            row.id,
            stoppedAt,
            at,
            at,
          );
        }
        const current = this.entry(row.connection_id, event.agentSessionId)!;
        const latest = this.delivery(row.id)!;
        if (!latest.session_id || !latest.input_json) {
          this.update(row.id, {
            session_id: latest.session_id ?? current.session_id,
            input_json:
              latest.input_json ??
              JSON.stringify(buildLinearTurnInput({ event, connectionId: row.connection_id, entry: current })),
          });
        }
      });
      entry = this.entry(row.connection_id, event.agentSessionId)!;
      reserved = this.delivery(row.id)!;
    }
    const frozen = JSON.parse(reserved.input_json!) as {
      text: string;
      agentInput: StructuredAgentInput;
    };
    const providerTime = row.provider_time;

    // 2. Initialize and admit on the Session object; 3. the caller records.
    for (let hop = 0; hop < 3; hop += 1) {
      const sessionId = reserved.session_id!;
      const session = this.host.session(sessionId, connection);
      const committed = await session.findTurn(key);
      if (committed) {
        return { sessionId, turnId: committed.turnId, duplicate: true, supersession: entry.supersession };
      }
      const state = await session.state();
      if (!state) {
        await this.host.launch({
          sessionId,
          accountId: row.account_id,
          connection,
          edgeOrigin: row.edge_origin,
          text: frozen.text,
          idempotencyKey: key,
          agentInput: frozen.agentInput,
          providerTime,
        });
        const launched = await session.findTurn(key);
        if (!launched) throw new Error("Launched session holds no turn for the delivery");
        return { sessionId, turnId: launched.turnId, duplicate: false, supersession: entry.supersession };
      }
      const live = state.status !== "ended" && state.status !== "failed";
      if (live && state.ready) {
        const enqueued = await session.enqueueTurn({
          input: frozen.text,
          idempotencyKey: key,
          agentInput: frozen.agentInput,
          providerTime,
        });
        // An input that arrived while the session's question was open runs
        // no turn of its own (S4): record that, never a turn id (review B4).
        if ("questionId" in enqueued) {
          return {
            sessionId,
            ...(enqueued.status === "held" ? { held: true } : { discarded: true }),
            questionId: enqueued.questionId,
            duplicate: enqueued.duplicate,
            supersession: entry.supersession,
          };
        }
        return {
          sessionId,
          turnId: enqueued.turnId,
          duplicate: enqueued.duplicate,
          supersession: entry.supersession,
        };
      }
      if (live) {
        // Not ready (a MicroVM booting, or suspended without a bound
        // runtime). Only a session nothing was admitted to is ended and
        // superseded, as webhook admission does; one that holds turns is
        // waited for (review R2).
        if (state.admitted) {
          throw new Error("The session is not ready to admit a turn");
        }
        await session.end();
      }
      // Never reuse an ended session: supersede it, but only once its Linear
      // activities have drained or their window passed, so the successor
      // never posts between them (review D3).
      if (!(await session.linearQueueDrained())) {
        throw new LinearStepDeferral("waiting for the ended session's Linear activities to drain");
      }
      entry = await this.supersede(row, entry, sessionId);
      reserved = this.delivery(row.id)!;
    }
    throw new Error("Session supersession did not settle");
  }

  /**
   * Point the map entry (if it still names `endedSessionId`) and this row at
   * the next supersession, recording the old session. Persisted before the
   * new session is touched, so every retry finds it.
   */
  private async supersede(
    row: LinearDeliveryRow,
    entry: LinearSessionRow,
    endedSessionId: string,
  ): Promise<LinearSessionRow> {
    const current = this.entry(row.connection_id, entry.agent_session_id)!;
    if (current.session_id !== endedSessionId) {
      this.update(row.id, { session_id: current.session_id });
      return current;
    }
    const supersession = current.supersession + 1;
    const sessionId = await this.host.deriveSessionId(
      row.account_id,
      linearSessionKey(row.connection_id, current.agent_session_id, supersession),
    );
    const at = nowIso(this.host);
    const superseded = [
      ...(JSON.parse(current.superseded_json) as unknown[]),
      { sessionId: endedSessionId, supersession: current.supersession, supersededAt: at, by: row.id },
    ];
    this.host.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE linear_sessions
         SET session_id = ?, supersession = ?, superseded_json = ?, updated_at = ?
         WHERE connection_id = ? AND agent_session_id = ? AND session_id = ?`,
        sessionId,
        supersession,
        JSON.stringify(superseded),
        at,
        row.connection_id,
        current.agent_session_id,
        endedSessionId,
      );
      this.update(row.id, { session_id: sessionId });
    });
    log("info", "linear.session_superseded", {
      connectionId: row.connection_id,
      agentSessionId: current.agent_session_id,
      endedSessionId,
      sessionId,
      supersession,
    });
    return this.entry(row.connection_id, current.agent_session_id)!;
  }

  // ── Control: apply, then confirm ────────────────────────────────────────────

  private async control(row: LinearDeliveryRow): Promise<boolean> {
    if (row.state === "applied") return this.confirm(row);
    if (row.state !== "accepted") {
      this.update(row.id, { next_attempt_at: null });
      return false;
    }
    try {
      const receipt = await this.apply(row);
      this.update(row.id, {
        state: "applied",
        receipt_json: JSON.stringify(receipt),
        attempts: 0,
        error: null,
        next_attempt_at: nowIso(this.host),
      });
      return true;
    } catch (error) {
      const message = errorText(error);
      const final = error instanceof LinearStepFailure;
      const notify = final ? error.notify : true;
      this.retry(row, message, final, () => this.fail(row, message, notify));
      log("warn", "linear.control_failed", {
        connectionId: row.connection_id,
        deliveryId: row.id,
        linearEvent: row.event,
        error: message.slice(0, 300),
      });
      return false;
    }
  }

  private async apply(row: LinearDeliveryRow): Promise<Record<string, unknown>> {
    const connections = this.host.connections();
    if (row.event === "revoked") {
      connections.markRevoked(row.connection_id, row.provider_time);
      return { revoked: true };
    }
    if (row.event === "teams") {
      const event = this.event(row);
      if (event.kind !== "teams") throw new LinearStepFailure("Not a permission change", false);
      const current = connections.get(row.connection_id)?.teams?.teamIds ?? [];
      const removed = new Set(event.removedTeamIds);
      const teamIds = [...new Set([...current, ...event.addedTeamIds])].filter((id) => !removed.has(id));
      const teams = { allPublic: event.canAccessAllPublicTeams, teamIds };
      connections.updateTeams(row.connection_id, teams);
      return { teams };
    }
    // Stop (review D1, D2): first, in one transaction, record its provider
    // time on the map entry and invalidate every pending admission of this
    // Linear session older than it, so no older prompt is admitted while the
    // Session call below is retried. Then apply it to the session
    // (idempotent on the delivery id). Both steps repeat safely.
    const agentSessionId = row.agent_session_id;
    const reason = `stopped by ${row.id}`;
    const entry = this.host.storage.transactionSync(() => {
      if (agentSessionId) {
        this.sql.exec(
          `UPDATE linear_sessions SET stopped_at = ?, updated_at = ?
           WHERE connection_id = ? AND agent_session_id = ?
             AND (stopped_at IS NULL OR stopped_at < ?)`,
          row.provider_time,
          nowIso(this.host),
          row.connection_id,
          agentSessionId,
          row.provider_time,
        );
      }
      this.sql.exec(
        `UPDATE linear_deliveries
         SET state = 'invalidated', next_attempt_at = NULL, error = ?, updated_at = ?
         WHERE connection_id = ? AND agent_session_id = ? AND kind = 'conversational'
           AND state IN ('accepted', 'acknowledged') AND provider_time < ?`,
        reason,
        nowIso(this.host),
        row.connection_id,
        agentSessionId,
        row.provider_time,
      );
      return agentSessionId ? this.entry(row.connection_id, agentSessionId) : null;
    });
    const result = entry
      ? await this.host.session(entry.session_id).applyControl({
          deliveryId: row.id,
          kind: "stop",
          providerTime: row.provider_time,
        })
      : null;
    const invalidated = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM linear_deliveries
         WHERE connection_id = ? AND agent_session_id = ? AND state = 'invalidated' AND error = ?
         ORDER BY provider_time, received_at`,
        row.connection_id,
        agentSessionId,
        reason,
      )
      .toArray()
      .map((invalid) => invalid.id);
    return {
      ...(entry ? { sessionId: entry.session_id, control: result } : { noSession: true }),
      invalidated,
    };
  }

  /**
   * The confirming activity. For a stop on a live session it is the Session
   * object's ("Stopped." from its activity queue, work 037 S3), so the
   * ledger's part is done. A stop that reached no session is confirmed here,
   * with a persisted id, because Linear requires a final activity.
   */
  private async confirm(row: LinearDeliveryRow): Promise<boolean> {
    const receipt = row.receipt_json ? (JSON.parse(row.receipt_json) as { noSession?: boolean }) : {};
    if (row.event === "stop" && receipt.noSession && row.agent_session_id) {
      const id = row.error_activity_id ?? this.uuid();
      if (!row.error_activity_id) this.update(row.id, { error_activity_id: id });
      const posted = await postLinearActivityOnce(this.host.connections(), row.connection_id, {
        id,
        agentSessionId: row.agent_session_id,
        content: { type: "error", body: LINEAR_STOPPED_TEXT },
      });
      if (posted.outcome !== "posted") {
        const final = posted.outcome !== "transient";
        this.retry(row, posted.message, final, () =>
          this.update(row.id, {
            state: "confirmed",
            error_activity_state: "abandoned",
            error: posted.message.slice(0, 1_000),
            next_attempt_at: null,
          }),
        );
        return false;
      }
      this.update(row.id, { error_activity_state: "posted" });
    }
    this.update(row.id, { state: "confirmed", next_attempt_at: null, error: null });
    return false;
  }

  // ── Failure notice ──────────────────────────────────────────────────────────

  /**
   * The failure notice. When the delivery reached a session that answers
   * this Linear session, the notice goes through that Session object's
   * ordered activity queue, behind what it already queued (review R3);
   * otherwise it is posted here with its persisted id.
   */
  private async postFailureNotice(row: LinearDeliveryRow): Promise<boolean> {
    if (row.error_activity_state !== "pending" || !row.error_activity_id || !row.agent_session_id) {
      this.update(row.id, { next_attempt_at: null });
      return false;
    }
    let posted: PostOutcome;
    try {
      const queued = row.session_id
        ? await this.host.session(row.session_id).enqueueLinearTerminal({
            key: row.error_activity_id,
            body: LINEAR_FAILURE_TEXT,
          })
        : false;
      if (queued) {
        this.update(row.id, { error_activity_state: "queued", next_attempt_at: null });
        return false;
      }
      posted = await postLinearActivityOnce(this.host.connections(), row.connection_id, {
        id: row.error_activity_id,
        agentSessionId: row.agent_session_id,
        content: { type: "error", body: LINEAR_FAILURE_TEXT },
      });
    } catch (error) {
      posted = { outcome: "transient", message: errorText(error) };
    }
    if (posted.outcome === "posted") {
      this.update(row.id, { error_activity_state: "posted", next_attempt_at: null });
      return false;
    }
    const final = posted.outcome !== "transient";
    const attempts = row.attempts + 1;
    const backoff = LINEAR_STEP_BACKOFF_MS[attempts - 1];
    if (final || backoff === undefined) {
      this.update(row.id, { error_activity_state: "abandoned", next_attempt_at: null });
    } else {
      this.update(row.id, {
        attempts,
        next_attempt_at: new Date((this.host.now?.() ?? Date.now()) + backoff).toISOString(),
      });
    }
    return false;
  }
}

/**
 * What the ledger row records once admitted: the turn, or an input held
 * behind the session's open question (`held`) or discarded by a stop
 * (`discarded`), with the question it was held behind.
 */
export type LinearAdmissionReceipt =
  | { sessionId: string; turnId: string; duplicate: boolean; supersession: number }
  | {
      sessionId: string;
      held?: true;
      discarded?: true;
      questionId: string;
      duplicate: boolean;
      supersession: number;
    };

function deliveryShape(event: Exclude<LinearWebhookEvent, { kind: "ignored" }>): {
  event: LinearDeliveryEvent;
  kind: LinearDeliveryKind;
  agentSessionId?: string;
  providerTime: string;
} {
  if (event.kind === "revoked") {
    return { event: "revoked", kind: "control", providerTime: event.createdAt };
  }
  if (event.kind === "teams") {
    return { event: "teams", kind: "control", providerTime: event.createdAt };
  }
  if (event.action === "prompted") {
    return {
      event: event.stop ? "stop" : "prompted",
      kind: event.stop ? "control" : "conversational",
      agentSessionId: event.agentSessionId,
      // The prompt's own `createdAt`: when the person wrote it.
      providerTime: event.activity!.createdAt,
    };
  }
  return {
    event: "created",
    kind: "conversational",
    agentSessionId: event.agentSessionId,
    // The session's creation event time.
    providerTime: event.sessionCreatedAt ?? event.createdAt,
  };
}
