// The Session object's ordered Linear activity queue (design 018, "What the
// agent writes"; work 037 stream S3, seams "Storage" and "Activity mapping").
//
// One Linear agent session per OpenComputer session. The binding is learned
// from the first admitted turn whose input came from the `linear` channel,
// so a session no Linear input reached never writes a row. Every activity is
// a row with a UUIDv4 generated once and persisted, posted in `seq` order
// through the Account object (which attaches the connection's token): a retry
// re-sends the same id, and Linear's `conflict on insert of AgentActivity`
// means the first attempt landed. At least once on our side, exactly once on
// Linear's.
//
// Order and policy, from the seam:
// - progress (`action` after a tool call returns, the ephemeral keepalive
//   `thought`, the pull request link) is best effort: four failed attempts
//   and the row is `dropped`, the queue moves on;
// - a terminal row (`response`, `elicitation`, `error`) is posted only after
//   its turn settled and after every earlier row; it retries with backoff
//   until it posts, and after its fourth failed attempt a `delivery.failed`
//   event says Linear has not been told yet;
// - a permanent failure ends the row at once, with a `delivery.failed`
//   event naming it, and the queue proceeds;
// - an unavailable connection (disconnected, revoked) invalidates the
//   session's pending rows;
// - progress for a turn whose terminal row exists is dropped;
// - an ended (superseded) session drains for a bounded window, then its
//   remaining rows are invalidated: an old session never keeps the authority
//   to post later.

import type {
  AgentEvent,
  QuestionOption,
  StructuredAgentInput,
} from "../protocol.js";
import { ASK_TOOL } from "../protocol.js";
import type {
  LinearActivityContent,
  LinearActivityEnqueue,
  LinearActivityPost,
  LinearActivityPostResult,
  LinearConnectionStore,
  LinearUnavailableReason,
} from "./linear-contract.js";

// ── Policy constants (work 037, "Activity mapping") ──────────────────────────

export const LINEAR_FAILURE_TEXT = "OpenComputer could not complete this request.";
export const LINEAR_STOPPED_TEXT = "Stopped.";
export const LINEAR_KEEPALIVE_TEXT = "Still working.";
/** Linear marks a session stale after 30 minutes; a silent turn is bridged every 10. */
export const LINEAR_KEEPALIVE_AFTER_MS = 10 * 60_000;
/** At most one tool `action` per this interval per session; the rest are not posted. */
export const LINEAR_ACTION_INTERVAL_MS = 3_000;
export const LINEAR_PARAMETER_LIMIT = 120;
export const LINEAR_RESULT_LIMIT = 200;
/** Attempts after which a progress row is dropped and a terminal row raises `delivery.failed`. */
export const LINEAR_ATTEMPT_LIMIT = 4;
/** Waits after attempt n (1-based); the last entry repeats for terminal rows. */
export const LINEAR_BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 300_000] as const;
/** An attempt in flight holds its row this long; a later caller leaves it alone. */
export const LINEAR_POST_LEASE_MS = 30_000;
/** How long an ended (superseded) session may still post what it queued. */
export const LINEAR_SUPERSEDED_DRAIN_MS = 5 * 60_000;
/** Rows posted per drain call; a longer queue continues on the next kick or alarm. */
const DRAIN_BATCH = 25;

export const LINEAR_PULL_REQUEST_LABEL = "Pull request";

/**
 * `error` on a public `delivery.failed` event: a fixed code, never the
 * provider's message. `provider_unavailable`: Linear did not take it (yet);
 * `provider_rejected`: Linear refused it for good; `connection_*`: the
 * connection is unavailable; `session_superseded`: a newer session owns the
 * Linear session.
 */
export type DeliveryFailedReason =
  | "provider_unavailable"
  | "provider_rejected"
  | `connection_${LinearUnavailableReason}`
  | "session_superseded";
const PROVIDER_UNAVAILABLE: DeliveryFailedReason = "provider_unavailable";

// ── Storage ──────────────────────────────────────────────────────────────────

type ActivityState =
  | "pending"
  | "posted"
  | "failed_transient"
  | "failed_permanent"
  | "invalidated"
  | "dropped";

/** What a row posts: an activity, or the session's external link. */
type StoredContent =
  | LinearActivityContent
  | { type: "external_url"; label: string; url: string };

type ActivityRow = {
  id: string;
  connection_id: string;
  agent_session_id: string;
  seq: number;
  kind: "progress" | "terminal";
  content_json: string;
  options_json: string;
  state: ActivityState;
  attempts: number;
  next_attempt_at_ms: number | null;
  lease_until_ms: number | null;
  turn_id: string | null;
  question_id: string | null;
  created_at_ms: number;
  error: string | null;
}

type BindingRow = {
  connection_id: string;
  agent_session_id: string;
  ended_at_ms: number | null;
}

interface RowOptions {
  ephemeral?: boolean;
  signal?: "select";
  signalMetadata?: { options: QuestionOption[] };
}

const prepared = new WeakSet<object>();
const scannedThrough = new WeakMap<object, number>();

function ensureTables(storage: DurableObjectStorage): void {
  if (prepared.has(storage)) return;
  const sql = storage.sql;
  // The seam's table, plus the bookkeeping the worker needs: the turn and
  // question a row belongs to, the dedupe key of a tool call's action, the
  // attempt lease, and Linear's own createdAt once posted.
  sql.exec(`CREATE TABLE IF NOT EXISTS linear_activities (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    seq INTEGER NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    content_json TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER,
    lease_until_ms INTEGER,
    error TEXT,
    turn_id TEXT,
    question_id TEXT,
    source_key TEXT UNIQUE,
    created_at_ms INTEGER NOT NULL,
    posted_at TEXT,
    provider_created_at TEXT
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS linear_activities_open
     ON linear_activities(state, seq)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS linear_activities_turn
     ON linear_activities(turn_id, kind)`,
  );
  // The session's Linear agent session, learned once from its first Linear
  // input, and when the worker first saw the session ended.
  sql.exec(`CREATE TABLE IF NOT EXISTS linear_binding (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    connection_id TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    learned_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER
  )`);
  // Turns whose outcome the queue has already accounted for (terminal row
  // enqueued, or deliberately none), so a replayed settlement adds nothing.
  sql.exec(`CREATE TABLE IF NOT EXISTS linear_turns (
    turn_id TEXT PRIMARY KEY,
    handled_at_ms INTEGER NOT NULL
  )`);
  prepared.add(storage);
}

function tableExists(storage: DurableObjectStorage, name: string): boolean {
  return (
    storage.sql
      .exec<{ found: number }>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        name,
      )
      .toArray().length > 0
  );
}

/**
 * The Linear agent session this OpenComputer session answers, or null. Learned
 * from the first admitted turn whose input is `channel.provider: "linear"`
 * (connection id and `conversationId` = the agent session id) and then fixed.
 */
export function linearBinding(storage: DurableObjectStorage): BindingRow | null {
  ensureTables(storage);
  const known = storage.sql
    .exec<BindingRow>(
      "SELECT connection_id, agent_session_id, ended_at_ms FROM linear_binding WHERE slot = 1",
    )
    .toArray()[0];
  if (known) return known;
  if (!tableExists(storage, "turns")) return null;
  // Turns already looked at are not scanned again: a session that is not a
  // Linear one pays for each turn once, not on every event.
  const after = scannedThrough.get(storage) ?? 0;
  const scanned = storage.sql
    .exec<{ input_json: string | null; last: number | null }>(
      `SELECT
         (SELECT input_json FROM turns
          WHERE rowid > ? AND json_extract(input_json, '$.channel.provider') = 'linear'
          ORDER BY created_at, rowid LIMIT 1) AS input_json,
         (SELECT MAX(rowid) FROM turns) AS last`,
      after,
    )
    .one();
  if (!scanned.input_json) {
    scannedThrough.set(storage, Number(scanned.last ?? after));
    return null;
  }
  const input = parseRecord(scanned.input_json);
  const channel = (input as StructuredAgentInput | null)?.channel;
  if (!channel?.connectionId || !channel.conversationId) return null;
  storage.sql.exec(
    `INSERT INTO linear_binding (slot, connection_id, agent_session_id, learned_at_ms)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(slot) DO NOTHING`,
    channel.connectionId,
    channel.conversationId,
    Date.now(),
  );
  return {
    connection_id: channel.connectionId,
    agent_session_id: channel.conversationId,
    ended_at_ms: null,
  };
}

function nextSeq(storage: DurableObjectStorage): number {
  return storage.sql
    .exec<{ next: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM linear_activities")
    .one().next;
}

function turnHasTerminal(storage: DurableObjectStorage, turnId: string): boolean {
  return (
    storage.sql
      .exec<{ found: number }>(
        `SELECT 1 AS found FROM linear_activities WHERE turn_id = ? AND kind = 'terminal'
         UNION ALL
         SELECT 1 AS found FROM linear_turns WHERE turn_id = ?
         LIMIT 1`,
        turnId,
        turnId,
      )
      .toArray().length > 0
  );
}

/** The turn that asked a question: S4's `questions` row, else its `question.asked` event. */
function turnOfQuestion(storage: DurableObjectStorage, questionId: string): string | null {
  if (tableExists(storage, "questions")) {
    const row = storage.sql
      .exec<{ turn_id: string | null }>("SELECT turn_id FROM questions WHERE id = ?", questionId)
      .toArray()[0];
    if (row?.turn_id) return row.turn_id;
  }
  if (!tableExists(storage, "events")) return null;
  const event = storage.sql
    .exec<{ turn_id: string | null }>(
      `SELECT turn_id FROM events
       WHERE type = 'question.asked' AND json_extract(data, '$.questionId') = ?
       ORDER BY seq DESC LIMIT 1`,
      questionId,
    )
    .toArray()[0];
  return event?.turn_id ?? null;
}

function insertRow(
  storage: DurableObjectStorage,
  binding: BindingRow,
  row: {
    kind: "progress" | "terminal";
    content: StoredContent;
    options?: RowOptions;
    turnId?: string | null;
    questionId?: string | null;
    sourceKey?: string | null;
  },
): string | null {
  const id = crypto.randomUUID();
  const inserted = storage.sql.exec(
    `INSERT INTO linear_activities (
       id, connection_id, agent_session_id, seq, kind, content_json, options_json,
       state, attempts, turn_id, question_id, source_key, created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO NOTHING`,
    id,
    binding.connection_id,
    binding.agent_session_id,
    nextSeq(storage),
    row.kind,
    JSON.stringify(row.content),
    JSON.stringify(row.options ?? {}),
    row.turnId ?? null,
    row.questionId ?? null,
    row.sourceKey ?? null,
    Date.now(),
  ).rowsWritten;
  return inserted > 0 ? id : null;
}

/**
 * Enqueues one activity for this session's Linear agent session, inside the
 * caller's transaction. A no-op for a session no Linear input reached.
 * Synchronous; assigns `seq` and a persisted UUIDv4. An elicitation names its
 * question; its turn is resolved from the question so that the turn's outcome
 * is accounted for and no `response` follows it.
 */
export function enqueueLinearActivity(
  storage: DurableObjectStorage,
  activity: LinearActivityEnqueue,
): void {
  const binding = linearBinding(storage);
  if (!binding) return;
  const turnId =
    activity.turnId ??
    (activity.questionId ? turnOfQuestion(storage, activity.questionId) : null);
  if (activity.kind === "progress" && turnId && turnHasTerminal(storage, turnId)) {
    return;
  }
  const options: RowOptions = {
    ...(activity.ephemeral ? { ephemeral: true } : {}),
    ...(activity.signal ? { signal: activity.signal } : {}),
    ...(activity.signalMetadata ? { signalMetadata: activity.signalMetadata } : {}),
  };
  insertRow(storage, binding, {
    kind: activity.kind,
    content: activity.content,
    options,
    turnId,
    questionId: activity.questionId ?? null,
  });
  if (activity.kind === "terminal" && turnId) markTurnHandled(storage, turnId);
}

/**
 * Read-only: whether this session's queue may be left behind by a successor
 * (work 037 D3). True when no row is waiting to post, or once the bounded
 * drain window of an ended or failed session has passed (the worker
 * invalidates what remains then). The window starts when the worker first saw
 * the session ended, else at the session's last update. Writes nothing.
 */
export function linearQueueDrained(storage: DurableObjectStorage, nowMs = Date.now()): boolean {
  if (!tableExists(storage, "linear_activities")) return true;
  const open = storage.sql
    .exec<{ found: number }>(
      `SELECT 1 AS found FROM linear_activities
       WHERE state IN ('pending', 'failed_transient') LIMIT 1`,
    )
    .toArray();
  if (open.length === 0) return true;
  const endedAtMs = tableExists(storage, "linear_binding")
    ? storage.sql
        .exec<{ ended_at_ms: number | null }>(
          "SELECT ended_at_ms FROM linear_binding WHERE slot = 1",
        )
        .toArray()[0]?.ended_at_ms ?? null
    : null;
  let since = endedAtMs;
  if (since === null && tableExists(storage, "session")) {
    const session = storage.sql
      .exec<{ status: string; updated_at: string }>("SELECT status, updated_at FROM session LIMIT 1")
      .toArray()[0];
    if (session && (session.status === "ended" || session.status === "failed")) {
      const updated = Date.parse(session.updated_at);
      if (Number.isFinite(updated)) since = updated;
    }
  }
  return since !== null && nowMs >= since + LINEAR_SUPERSEDED_DRAIN_MS;
}

function markTurnHandled(storage: DurableObjectStorage, turnId: string): void {
  storage.sql.exec(
    `INSERT INTO linear_turns (turn_id, handled_at_ms) VALUES (?, ?)
     ON CONFLICT(turn_id) DO NOTHING`,
    turnId,
    Date.now(),
  );
}

// ── Mapping (work 037, "Activity mapping") ───────────────────────────────────

function parseRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function oneLine(value: string, limit: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  return `${line.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

/**
 * Keys whose value says what a call worked on without being its payload. Not
 * `query`: a GraphQL or SQL query is the call's raw input.
 */
const SUBJECT_KEYS = ["filePath", "path", "pattern", "name"] as const;

/**
 * What a tool call did, in at most 120 characters. Never the raw arguments:
 * a path, a pattern or a name when the call has one (first line,
 * truncated), a URL as origin and path only (no query string, which can
 * carry credentials), a shell command as the fact that one ran. The
 * arguments themselves stay in OpenComputer's trace.
 */
export function summarizeToolParameter(tool: string, input: Record<string, unknown>): string {
  for (const key of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return oneLine(value.split(/\r?\n/, 1)[0] ?? "", LINEAR_PARAMETER_LIMIT);
    }
  }
  if (typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      return oneLine(`${url.origin}${url.pathname}`, LINEAR_PARAMETER_LIMIT);
    } catch {
      // not a URL; fall through
    }
  }
  if (typeof input.command === "string") return "Ran a shell command";
  return oneLine(`Called ${tool}`, LINEAR_PARAMETER_LIMIT);
}

/** How a tool call ended, in at most 200 characters, without its output. */
export function summarizeToolResult(event: AgentEvent): string {
  if (event.type === "tool.failed") return "Failed";
  const output = event.data.output;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) return "Completed with no output";
    const lines = trimmed.split(/\r?\n/).length;
    return oneLine(
      `Completed (${String(lines)} line${lines === 1 ? "" : "s"} of output)`,
      LINEAR_RESULT_LIMIT,
    );
  }
  return "Completed";
}

const PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

/** The last GitHub pull request URL in a message, if any. */
export function pullRequestUrl(text: string): string | null {
  const matches = text.match(PULL_REQUEST_URL);
  return matches ? matches[matches.length - 1]! : null;
}

// ── The worker ───────────────────────────────────────────────────────────────

export interface LinearSessionLink {
  label: string;
  url: string;
}

export type LinearSessionUpdateResult =
  | { outcome: "updated" }
  | { outcome: "transient"; message: string; retryAfterSeconds?: number }
  | { outcome: "permanent"; message: string }
  | { outcome: "unavailable"; reason: LinearUnavailableReason };

/** The Account RPCs the worker calls; both attach the connection's token. */
export interface LinearActivityAccount {
  postLinearActivity(
    connectionId: string,
    post: LinearActivityPost,
  ): Promise<LinearActivityPostResult>;
  setLinearSessionExternalLink(
    connectionId: string,
    agentSessionId: string,
    link: LinearSessionLink,
  ): Promise<LinearSessionUpdateResult>;
}

/** What the Session object lends the worker. */
export interface LinearActivityHost {
  storage: DurableObjectStorage;
  account(): LinearActivityAccount;
  /**
   * Inside the worker's transaction: append a session-level event (no turn
   * id, so a settled turn's terminal event stays its last; the turn is named
   * in the data).
   */
  appendEvent(type: "delivery.failed", turnId: string | undefined, data: Record<string, unknown>): AgentEvent;
  /**
   * Inside the worker's transaction: a question's elicitation posted (with
   * Linear's `createdAt`, which decides answer versus steering) or can never
   * post (failed permanently or invalidated). The Session object records the
   * time and reclassifies what the question holds, or closes it
   * `undeliverable` and runs what it held; returns the events it appended.
   */
  questionElicitation(
    questionId: string,
    outcome: { kind: "posted"; providerTime: string } | { kind: "undeliverable" },
  ): AgentEvent[];
  /** After commit, when `questionElicitation` admitted turns: dispatch the next one. */
  dispatch(): void;
  /** After commit: publish appended events to clients. */
  broadcast(events: AgentEvent[]): void;
  scheduleAlarm(): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
}

type TurnFacts = {
  id: string;
  status: string;
  updated_at: string;
}

const SETTLED = new Set(["completed", "failed", "cancelled"]);

export class LinearActivityQueue {
  private draining: Promise<void> | undefined;
  private drainAgain = false;

  constructor(private readonly host: LinearActivityHost) {}

  private get storage(): DurableObjectStorage {
    return this.host.storage;
  }

  /**
   * Progress hook: a running turn's events. A tool call that returned becomes
   * one `action`, at most one per call and one per three seconds per session.
   * Synchronous bookkeeping, then a drain in the background.
   */
  onTurnEvents(turnId: string, events: readonly AgentEvent[]): void {
    if (!events.some((event) => event.type === "tool.completed" || event.type === "tool.failed")) {
      return;
    }
    const binding = linearBinding(this.storage);
    if (!binding) return;
    let enqueued = false;
    this.storage.transactionSync(() => {
      this.reconcileSettledTurns(binding);
      for (const event of events) {
        if (event.turnId !== turnId) continue;
        if (event.type !== "tool.completed" && event.type !== "tool.failed") continue;
        if (this.enqueueToolAction(binding, turnId, event)) enqueued = true;
      }
    });
    if (enqueued) this.kick();
  }

  /**
   * Settlement hook, beside the Slack reply: account for every settled turn's
   * outcome (response, error, or nothing after a question), then post.
   */
  afterSettlement(): Promise<void> {
    try {
      const binding = linearBinding(this.storage);
      if (!binding) return Promise.resolve();
      this.storage.transactionSync(() => this.reconcileSettledTurns(binding));
    } catch (error) {
      this.logDrainError(error);
      return Promise.resolve();
    }
    return this.drain().catch((error: unknown) => this.logDrainError(error));
  }

  /**
   * Alarm hook: outcomes, the keepalive for a silent running turn, then post.
   * Never throws: the alarm's other duties must not wait on Linear.
   */
  async onAlarm(): Promise<void> {
    try {
      const binding = linearBinding(this.storage);
      if (!binding) return;
      this.storage.transactionSync(() => {
        this.reconcileSettledTurns(binding);
        this.enqueueKeepalive(binding);
      });
      await this.drain();
    } catch (error) {
      this.logDrainError(error);
    }
  }

  /** When the alarm is next needed for this queue, or null. */
  nextDueAtMs(): number | null {
    const binding = linearBinding(this.storage);
    if (!binding) return null;
    const candidates: number[] = [];
    // A turn settled by a path without the settlement hook (a stop drive, an
    // interrupt, a session end) is accounted for by the alarm, at once.
    if (this.unhandledSettledTurns(1).length > 0) candidates.push(Date.now());
    const head = this.headRow();
    if (head && this.headReady(head)) {
      candidates.push(Math.max(head.next_attempt_at_ms ?? 0, head.lease_until_ms ?? 0));
    }
    if (binding.ended_at_ms !== null && head) {
      candidates.push(binding.ended_at_ms + LINEAR_SUPERSEDED_DRAIN_MS);
    }
    const running = this.runningTurn();
    if (running && !this.sessionEnded()) {
      candidates.push(this.lastActivityAtMs(running) + LINEAR_KEEPALIVE_AFTER_MS);
    }
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  /** Post due rows in order. One drain at a time per activation; a kick during it runs it again. */
  drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    const run = (async () => {
      try {
        do {
          this.drainAgain = false;
          await this.drainOnce();
        } while (this.drainAgain);
      } finally {
        this.draining = undefined;
      }
      await this.host.scheduleAlarm();
    })();
    this.draining = run;
    return run;
  }

  private kick(): void {
    this.host.waitUntil(this.drain().catch((error: unknown) => this.logDrainError(error)));
  }

  private logDrainError(error: unknown): void {
    console.error(
      JSON.stringify({
        level: "error",
        event: "linear.activity_drain_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // ── enqueue side ──

  private enqueueToolAction(binding: BindingRow, turnId: string, event: AgentEvent): boolean {
    const tool = typeof event.data.tool === "string" ? event.data.tool : "tool";
    // `ask` is answered by its elicitation, not reported as work.
    if (tool === ASK_TOOL) return false;
    if (turnHasTerminal(this.storage, turnId)) return false;
    const callId = typeof event.data.callId === "string" ? event.data.callId : event.id;
    const sourceKey = `tool:${turnId}:${callId}`;
    const already = this.storage.sql
      .exec<{ found: number }>(
        "SELECT 1 AS found FROM linear_activities WHERE source_key = ?",
        sourceKey,
      )
      .toArray()[0];
    if (already) return false;
    const recent = this.storage.sql
      .exec<{ at: number | null }>(
        `SELECT MAX(created_at_ms) AS at FROM linear_activities
         WHERE kind = 'progress' AND json_extract(content_json, '$.type') = 'action'`,
      )
      .one().at;
    if (recent !== null && Date.now() - Number(recent) < LINEAR_ACTION_INTERVAL_MS) return false;
    const started = this.storage.sql
      .exec<{ data: string }>(
        `SELECT data FROM events
         WHERE turn_id = ? AND type = 'tool.started' AND json_extract(data, '$.callId') = ?
         ORDER BY seq DESC LIMIT 1`,
        turnId,
        callId,
      )
      .toArray()[0];
    const startedInput = parseRecord(started?.data)?.input;
    const input =
      startedInput && typeof startedInput === "object" && !Array.isArray(startedInput)
        ? (startedInput as Record<string, unknown>)
        : event.data.input && typeof event.data.input === "object" && !Array.isArray(event.data.input)
          ? (event.data.input as Record<string, unknown>)
          : {};
    return (
      insertRow(this.storage, binding, {
        kind: "progress",
        content: {
          type: "action",
          action: oneLine(tool, LINEAR_PARAMETER_LIMIT),
          parameter: summarizeToolParameter(tool, input),
          result: summarizeToolResult(event),
        },
        turnId,
        sourceKey,
      }) !== null
    );
  }

  private enqueueKeepalive(binding: BindingRow): void {
    if (this.sessionEnded()) return;
    const running = this.runningTurn();
    if (!running) return;
    if (Date.now() - this.lastActivityAtMs(running) < LINEAR_KEEPALIVE_AFTER_MS) return;
    insertRow(this.storage, binding, {
      kind: "progress",
      content: { type: "thought", body: LINEAR_KEEPALIVE_TEXT },
      options: { ephemeral: true },
      turnId: running.id,
    });
  }

  private lastActivityAtMs(running: TurnFacts): number {
    const last = this.storage.sql
      .exec<{ at: number | null }>(
        "SELECT MAX(created_at_ms) AS at FROM linear_activities WHERE turn_id = ?",
        running.id,
      )
      .one().at;
    const since = Date.parse(running.updated_at);
    return Math.max(last === null ? 0 : Number(last), Number.isFinite(since) ? since : 0);
  }

  private runningTurn(): TurnFacts | null {
    return (
      this.storage.sql
        .exec<TurnFacts>(
          "SELECT id, status, updated_at FROM turns WHERE status = 'running' ORDER BY created_at, rowid LIMIT 1",
        )
        .toArray()[0] ?? null
    );
  }

  private sessionEnded(): boolean {
    const session = this.storage.sql
      .exec<{ status: string }>("SELECT status FROM session LIMIT 1")
      .toArray()[0];
    return session?.status === "ended";
  }

  /**
   * Every settled turn since the binding, once: a completed turn's final
   * message becomes a `response` (and a pull request URL in it the session's
   * external link, first); a completed turn that asked has its elicitation
   * from the question code and gets nothing more; a failed turn an `error`; a
   * cancelled turn "Stopped.", unless another turn replaced it, which answers
   * instead, or it never ran (held behind a question, or discarded by a
   * stop). Inside the caller's transaction.
   */
  private unhandledSettledTurns(limit: number): Array<{ id: string; status: string }> {
    return this.storage.sql
      .exec<{ id: string; status: string }>(
        `SELECT t.id, t.status FROM turns t
         WHERE t.status IN ('completed', 'failed', 'cancelled')
           AND NOT EXISTS (SELECT 1 FROM linear_turns h WHERE h.turn_id = t.id)
           AND NOT EXISTS (
             SELECT 1 FROM linear_activities a WHERE a.turn_id = t.id AND a.kind = 'terminal'
           )
         ORDER BY COALESCE(t.settled_seq, 0), t.updated_at, t.rowid
         LIMIT ?`,
        limit,
      )
      .toArray();
  }

  private reconcileSettledTurns(binding: BindingRow): void {
    for (const turn of this.unhandledSettledTurns(50)) {
      for (const row of this.outcomeRows(turn)) insertRow(this.storage, binding, row);
      markTurnHandled(this.storage, turn.id);
    }
  }

  private outcomeRows(turn: { id: string; status: string }): Array<{
    kind: "progress" | "terminal";
    content: StoredContent;
    turnId: string;
  }> {
    const terminalEvent = (type: string) =>
      parseRecord(
        this.storage.sql
          .exec<{ data: string }>(
            "SELECT data FROM events WHERE turn_id = ? AND type = ? ORDER BY seq DESC LIMIT 1",
            turn.id,
            type,
          )
          .toArray()[0]?.data,
      );
    if (turn.status === "failed") {
      return [{ kind: "terminal", content: { type: "error", body: LINEAR_FAILURE_TEXT }, turnId: turn.id }];
    }
    if (turn.status === "cancelled") {
      const cancelled = terminalEvent("turn.cancelled");
      if (typeof cancelled?.replacementTurnId === "string") return [];
      // A turn converted into held steering behind an open question (reason
      // `held`) never ran and must not answer: "Stopped." would replace the
      // elicitation as Linear's last activity. Queued turns a stop discarded
      // (`discarded: true`) never ran either; the stop is confirmed once, by
      // the turn it interrupted or by applyControl when nothing ran.
      if (cancelled?.reason === "held" || cancelled?.discarded === true) return [];
      return [{ kind: "terminal", content: { type: "error", body: LINEAR_STOPPED_TEXT }, turnId: turn.id }];
    }
    const completed = terminalEvent("turn.completed");
    if (completed?.outcome === "question") return [];
    const message = terminalEvent("message.completed");
    const body = (
      typeof message?.finalText === "string"
        ? message.finalText
        : typeof message?.text === "string"
          ? message.text
          : ""
    ).trim();
    // GAP(L-S3-a): Linear keeps a session `active` until a terminal
    // activity and releases held messages only then, so a turn that said
    // nothing still has to finish the session with a fixed "Done.". Slack
    // sends nothing in that case (silence as an answer); Linear cannot.
    const rows: Array<{ kind: "progress" | "terminal"; content: StoredContent; turnId: string }> = [];
    const pr = pullRequestUrl(body);
    if (pr) {
      rows.push({
        kind: "progress",
        content: { type: "external_url", label: LINEAR_PULL_REQUEST_LABEL, url: pr },
        turnId: turn.id,
      });
    }
    rows.push({
      kind: "terminal",
      content: { type: "response", body: body || "Done." },
      turnId: turn.id,
    });
    return rows;
  }

  // ── post side ──

  private headRow(): ActivityRow | null {
    return (
      this.storage.sql
        .exec<ActivityRow>(
          `SELECT * FROM linear_activities
           WHERE state IN ('pending', 'failed_transient')
           ORDER BY seq LIMIT 1`,
        )
        .toArray()[0] ?? null
    );
  }

  /** A terminal row waits for its turn to settle; the settlement hook kicks it then. */
  private headReady(row: ActivityRow): boolean {
    if (row.kind !== "terminal" || !row.turn_id) return true;
    const turn = this.storage.sql
      .exec<{ status: string }>("SELECT status FROM turns WHERE id = ?", row.turn_id)
      .toArray()[0];
    return !turn || SETTLED.has(turn.status);
  }

  private async drainOnce(): Promise<void> {
    for (let posted = 0; posted < DRAIN_BATCH; posted += 1) {
      const binding = linearBinding(this.storage);
      if (!binding) return;
      if (this.expireIfSuperseded(binding)) return;
      const row = this.headRow();
      if (!row) return;
      const nowMs = Date.now();
      if ((row.next_attempt_at_ms ?? 0) > nowMs || (row.lease_until_ms ?? 0) > nowMs) return;
      if (!this.headReady(row)) return;
      if (row.kind === "progress" && row.turn_id && this.terminalBefore(row)) {
        this.skip(row, "progress after the turn's terminal activity");
        continue;
      }
      // The lease, before any await: whoever else arrives finds it and leaves.
      const attempt = row.attempts + 1;
      const leased = this.storage.sql.exec(
        `UPDATE linear_activities
         SET attempts = ?, lease_until_ms = ?
         WHERE id = ? AND attempts = ? AND state IN ('pending', 'failed_transient')`,
        attempt,
        nowMs + LINEAR_POST_LEASE_MS,
        row.id,
        row.attempts,
      ).rowsWritten;
      if (!leased) return;
      const result = await this.post(row);
      if (!this.settle(row, attempt, result)) return;
    }
    this.drainAgain = true;
  }

  private terminalBefore(row: ActivityRow): boolean {
    return (
      this.storage.sql
        .exec<{ found: number }>(
          `SELECT 1 AS found FROM linear_activities
           WHERE turn_id = ? AND kind = 'terminal' AND seq < ? LIMIT 1`,
          row.turn_id,
          row.seq,
        )
        .toArray().length > 0
    );
  }

  /**
   * An ended session is superseded (a later prompt continues the Linear
   * thread on a new session). It may finish posting for a bounded window;
   * then what remains is invalidated.
   */
  private expireIfSuperseded(binding: BindingRow): boolean {
    if (!this.sessionEnded()) return false;
    const nowMs = Date.now();
    if (binding.ended_at_ms === null) {
      this.storage.sql.exec(
        "UPDATE linear_binding SET ended_at_ms = ? WHERE slot = 1 AND ended_at_ms IS NULL",
        nowMs,
      );
      return false;
    }
    if (nowMs < binding.ended_at_ms + LINEAR_SUPERSEDED_DRAIN_MS) return false;
    this.invalidateOpen("session superseded", "session_superseded");
    return true;
  }

  private async post(row: ActivityRow): Promise<LinearActivityPostResult> {
    const content = JSON.parse(row.content_json) as StoredContent;
    const account = this.host.account();
    try {
      if (content.type === "external_url") {
        const result = await account.setLinearSessionExternalLink(
          row.connection_id,
          row.agent_session_id,
          { label: content.label, url: content.url },
        );
        return result.outcome === "updated"
          ? { outcome: "posted", createdAt: new Date().toISOString(), duplicate: false }
          : result;
      }
      const options = (parseRecord(row.options_json) ?? {}) as RowOptions;
      return await account.postLinearActivity(row.connection_id, {
        id: row.id,
        agentSessionId: row.agent_session_id,
        content,
        ...(options.ephemeral ? { ephemeral: true } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.signalMetadata ? { signalMetadata: options.signalMetadata } : {}),
      });
    } catch (error) {
      // The RPC itself failed (the Account object restarted, a network
      // blip): Linear may or may not have it, and the id makes a retry safe.
      return { outcome: "transient", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Writes the attempt's outcome if the row is still this attempt's. */
  private settle(row: ActivityRow, attempt: number, result: LinearActivityPostResult): boolean {
    const events = this.storage.transactionSync(() => {
      const current = this.storage.sql
        .exec<{ attempts: number; state: string }>(
          "SELECT attempts, state FROM linear_activities WHERE id = ?",
          row.id,
        )
        .toArray()[0];
      if (
        !current ||
        current.attempts !== attempt ||
        (current.state !== "pending" && current.state !== "failed_transient")
      ) {
        return null;
      }
      const output: AgentEvent[] = [];
      if (result.outcome === "posted") {
        this.storage.sql.exec(
          `UPDATE linear_activities
           SET state = 'posted', lease_until_ms = NULL, next_attempt_at_ms = NULL, error = NULL,
               posted_at = ?, provider_created_at = ?
           WHERE id = ?`,
          new Date().toISOString(),
          result.createdAt,
          row.id,
        );
        // Linear's time for the question decides answer versus steering.
        if (row.question_id) {
          output.push(
            ...this.host.questionElicitation(row.question_id, {
              kind: "posted",
              providerTime: result.createdAt,
            }),
          );
        }
        return output;
      }
      if (result.outcome === "unavailable") {
        output.push(...this.invalidateOpenInTransaction(`connection ${result.reason}`, `connection_${result.reason}`));
        return output;
      }
      if (result.outcome === "permanent") {
        output.push(...this.finishInTransaction(row, "failed_permanent", result.message, attempt));
        return output;
      }
      // Transient.
      if (row.kind === "progress" && attempt >= LINEAR_ATTEMPT_LIMIT) {
        output.push(...this.finishInTransaction(row, "dropped", result.message, attempt));
        return output;
      }
      const backoff =
        LINEAR_BACKOFF_MS[Math.min(attempt, LINEAR_BACKOFF_MS.length) - 1] ??
        LINEAR_BACKOFF_MS[LINEAR_BACKOFF_MS.length - 1]!;
      const wait = Math.max(backoff, (result.retryAfterSeconds ?? 0) * 1_000);
      this.storage.sql.exec(
        `UPDATE linear_activities
         SET state = 'failed_transient', lease_until_ms = NULL, next_attempt_at_ms = ?, error = ?
         WHERE id = ?`,
        Date.now() + wait,
        result.message.slice(0, 500),
        row.id,
      );
      if (row.kind === "terminal" && attempt === LINEAR_ATTEMPT_LIMIT) {
        // Linear has not been told yet; the row keeps retrying.
        output.push(
          this.host.appendEvent("delivery.failed", undefined, {
            ...this.describe(row, "failed_transient", attempt, PROVIDER_UNAVAILABLE),
            retrying: true,
          }),
        );
      }
      return output;
    });
    if (events === null) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "linear.activity_attempt_superseded",
          activityId: row.id,
          attempt,
        }),
      );
      return false;
    }
    if (events.length > 0) this.host.broadcast(events);
    if (events.some((event) => event.type !== "delivery.failed")) this.host.dispatch();
    if (result.outcome !== "posted") {
      console.warn(
        JSON.stringify({
          level: result.outcome === "transient" ? "warn" : "error",
          event: "linear.activity_post_failed",
          activityId: row.id,
          kind: row.kind,
          attempt,
          outcome: result.outcome,
          message: "message" in result ? result.message : result.reason,
        }),
      );
    }
    // A transient head blocks the queue until its next attempt; the loop
    // finds it not yet due.
    return true;
  }

  /**
   * The public `delivery.failed` data. `error` is one of a fixed set of
   * codes (`DeliveryFailedReason`); the provider's own message, which can
   * quote workspace content, stays on the row and in the log, never in the
   * event.
   */
  private describe(row: ActivityRow, state: ActivityState, attempts: number, reason: DeliveryFailedReason): Record<string, unknown> {
    const content = parseRecord(row.content_json);
    return {
      channel: "linear",
      activityId: row.id,
      agentSessionId: row.agent_session_id,
      kind: row.kind,
      contentType: typeof content?.type === "string" ? content.type : "unknown",
      state,
      attempts,
      error: reason,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.question_id ? { questionId: row.question_id } : {}),
    };
  }

  /** A progress row overtaken by its turn's terminal activity: skipped, no event. */
  private skip(row: ActivityRow, reason: string): void {
    this.storage.sql.exec(
      `UPDATE linear_activities
       SET state = 'dropped', lease_until_ms = NULL, next_attempt_at_ms = NULL, error = ?
       WHERE id = ?`,
      reason,
      row.id,
    );
  }

  /**
   * Ends a row unposted and appends the `delivery.failed` event that names
   * it. An elicitation that will never post closes its question
   * `undeliverable` (the Session object runs what it held as turns).
   */
  private finishInTransaction(
    row: ActivityRow,
    state: ActivityState,
    error: string,
    attempts: number,
    reason: DeliveryFailedReason = state === "dropped" ? PROVIDER_UNAVAILABLE : "provider_rejected",
  ): AgentEvent[] {
    this.storage.sql.exec(
      `UPDATE linear_activities
       SET state = ?, lease_until_ms = NULL, next_attempt_at_ms = NULL, error = ?
       WHERE id = ?`,
      state,
      error.slice(0, 500),
      row.id,
    );
    const output = [
      this.host.appendEvent("delivery.failed", undefined, this.describe(row, state, attempts, reason)),
    ];
    if (row.question_id && (state === "failed_permanent" || state === "invalidated")) {
      output.push(...this.host.questionElicitation(row.question_id, { kind: "undeliverable" }));
    }
    return output;
  }

  private invalidateOpen(reason: string, code: DeliveryFailedReason): void {
    const events = this.storage.transactionSync(() => this.invalidateOpenInTransaction(reason, code));
    if (events.length > 0) this.host.broadcast(events);
    if (events.some((event) => event.type !== "delivery.failed")) this.host.dispatch();
  }

  /** Every open row is never attempted again; each gets a `delivery.failed` naming it. */
  private invalidateOpenInTransaction(reason: string, code: DeliveryFailedReason): AgentEvent[] {
    const open = this.storage.sql
      .exec<ActivityRow>(
        `SELECT * FROM linear_activities
         WHERE state IN ('pending', 'failed_transient') ORDER BY seq`,
      )
      .toArray();
    return open.flatMap((row) =>
      this.finishInTransaction(row, "invalidated", reason, row.attempts, code),
    );
  }
}

// ── The Account side: posting through the connection's token ─────────────────

const ACTIVITY_CREATE = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity { id createdAt content { __typename } }
  }
}`;

const ACTIVITY_BY_ID = `query AgentActivity($id: String!) {
  agentActivity(id: $id) { id createdAt content { __typename } }
}`;

const SESSION_UPDATE = `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $id, input: $input) { success }
}`;

const CONFLICT = "conflict on insert of AgentActivity";

type GraphqlError = { message: string; extensions?: unknown };

/**
 * Linear reports most failures as GraphQL errors with HTTP 200. Rate limits
 * and Linear's own internal faults are retried; everything else (invalid
 * input, forbidden, not found, a validation error) is the payload's or the
 * session's fault and will not change on retry.
 */
function classifyErrors(errors: GraphqlError[]): { transient: boolean; message: string } {
  const message = errors.map((error) => error.message).join("; ").slice(0, 500);
  const transient = errors.some((error) => {
    const extensions =
      error.extensions && typeof error.extensions === "object"
        ? (error.extensions as Record<string, unknown>)
        : {};
    const tag = `${String(extensions.type ?? "")} ${String(extensions.code ?? "")}`.toLowerCase();
    return /ratelimit|rate limit|internal|lock timeout|network|timeout|unavailable/.test(
      `${tag} ${error.message.toLowerCase()}`,
    );
  });
  return { transient, message };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `agentActivityCreate` with the client id. A repeat of an id Linear already
 * has comes back as `conflict on insert of AgentActivity`: posted, reconciled
 * by reading the activity back for its `createdAt`. The Account RPC
 * `postLinearActivity` is this function over `this.linearConnections`.
 */
export async function postLinearActivityWith(
  store: Pick<LinearConnectionStore, "graphql">,
  connectionId: string,
  post: LinearActivityPost,
): Promise<LinearActivityPostResult> {
  const input: Record<string, unknown> = {
    id: post.id,
    agentSessionId: post.agentSessionId,
    content: post.content,
  };
  if (post.ephemeral) input.ephemeral = true;
  if (post.signal) input.signal = post.signal;
  // The options object itself; Linear stores it and reads it back as a string.
  if (post.signalMetadata) input.signalMetadata = post.signalMetadata;
  const created = await store.graphql(connectionId, {
    query: ACTIVITY_CREATE,
    variables: { input },
  });
  if (created.outcome !== "ok") return created;
  if (created.errors?.length) {
    if (created.errors.some((error) => error.message.includes(CONFLICT))) {
      return reconcileActivity(store, connectionId, post.id);
    }
    const classified = classifyErrors(created.errors);
    return classified.transient
      ? { outcome: "transient", message: classified.message }
      : { outcome: "permanent", message: classified.message };
  }
  const payload = record(record(created.data)?.agentActivityCreate);
  const activity = record(payload?.agentActivity);
  if (payload?.success !== true || typeof activity?.createdAt !== "string") {
    return { outcome: "permanent", message: "agentActivityCreate did not succeed" };
  }
  return { outcome: "posted", createdAt: activity.createdAt, duplicate: false };
}

async function reconcileActivity(
  store: Pick<LinearConnectionStore, "graphql">,
  connectionId: string,
  id: string,
): Promise<LinearActivityPostResult> {
  const found = await store.graphql(connectionId, { query: ACTIVITY_BY_ID, variables: { id } });
  if (found.outcome !== "ok") return found;
  const activity = record(record(found.data)?.agentActivity);
  if (typeof activity?.createdAt === "string") {
    return { outcome: "posted", createdAt: activity.createdAt, duplicate: true };
  }
  // Linear said the id exists but will not show it yet: ask again later.
  return {
    outcome: "transient",
    message: `activity ${id} conflicted but could not be read back`,
  };
}

/** `agentSessionUpdate(id, { externalUrls: [link] })`. */
export async function setLinearSessionExternalLinkWith(
  store: Pick<LinearConnectionStore, "graphql">,
  connectionId: string,
  agentSessionId: string,
  link: LinearSessionLink,
): Promise<LinearSessionUpdateResult> {
  const updated = await store.graphql(connectionId, {
    query: SESSION_UPDATE,
    variables: { id: agentSessionId, input: { externalUrls: [{ label: link.label, url: link.url }] } },
  });
  if (updated.outcome !== "ok") return updated;
  if (updated.errors?.length) {
    const classified = classifyErrors(updated.errors);
    return classified.transient
      ? { outcome: "transient", message: classified.message }
      : { outcome: "permanent", message: classified.message };
  }
  const payload = record(record(updated.data)?.agentSessionUpdate);
  return payload?.success === true
    ? { outcome: "updated" }
    : { outcome: "permanent", message: "agentSessionUpdate did not succeed" };
}
