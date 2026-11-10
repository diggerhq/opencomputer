// The Computer's session API in the Computer DO (work 084): the session rows, the host's v4
// frames, and every HTTP operation that needs the single writer (create, writes) or the rows
// (list, get, /me, tickets). Reads of the log itself (events, turns, asks, subagents) go from the
// route straight to the session's SessionLog (api-http.ts) after an `access` check here.
//
// Invariants:
//   - One writer per session: the host (its runner, or its session-writer when no runner runs).
//     This object never writes events, except `SessionLog.recover` under a new epoch when the
//     writer is lost; every frame to the host carries the row's (epoch, lastSeq), so the writer
//     continues at lastSeq + 1 and a stale writer's frames are fenced.
//   - The row mirrors the SessionLog's summary monotonically in (logEpoch, lastSeq): an older
//     summary never overwrites a newer one, so `GET /sessions` never reads the log.
//   - A journal batch is acked only once the SessionLog stored it; batches of one session are
//     appended in arrival order (one promise chain per session).
//   - Slack sessions are unchanged for users: they get a `cs_` id lazily on delivery, their
//     title/mode/model stay the Slack path's, and only a v4 host sees any of it.

import type { ApiTelemetry } from "./telemetry/api.js";
import type { AssertedApiKey } from "../edge/auth.js";
import type { ApiScope, LogSummary, Origin, Person, Session, SessionStatus } from "./api-types.js";
import { DEFAULT_MODE, MODELS, capabilities, checkSettings } from "./capabilities.js";
import { type ComputerEdgeEnv, DEFAULT_WIRE_URL } from "./config.js";
import { sha256Hex } from "./crypto.js";
import type { ComputerKeys } from "./keys.js";
import {
  type CalvinApiActor,
  type CalvinApiError,
  type CalvinGatewayToHost,
  type CalvinHostToGatewayV4,
  type CalvinJournalReport,
  type CalvinMode,
  type CalvinPerson,
  type CalvinSessionReport,
  type CalvinSessionSpec,
  CALVIN_API_PROTOCOL,
  personForMember,
} from "./protocol.js";
import type { AppendResult, EpochTail, SessionLogRpc } from "./session-log-contract.js";
import { isSessionId, memberId, mintId } from "./session-ids.js";
import { slackThreadUrl } from "./slack.js";
import { TicketTooLongError, mintTicket, validateTicketRequest } from "./tickets.js";

/** A write's answer from the host: 15 s, then 503. */
export const HOST_CALL_TIMEOUT_MS = 15_000;
/**
 * The answer's wait while the session's epoch is moving (an `epoch` frame in flight or sent within
 * EPOCH_MOVING_MS): the host holds the write until its adoption commits, up to ~25 s (review r3 P2-2).
 */
export const HOST_CALL_HELD_TIMEOUT_MS = 40_000;
export const EPOCH_MOVING_MS = 30_000;
/** A keyed write whose answer outlived the client's wait is kept this long for its retry to take (review r3 P2-2). */
export const KEYED_CALL_KEEP_MS = 120_000;
/** Waits before each retry of a failed `epochTail` read (review r3 P1-1). */
export const EPOCH_TAIL_RETRY_MS = [250, 1_000, 4_000];
/** `minSeq` waits this long for the SessionLog to reach it (model.mdx#consistency). */
export const MIN_SEQ_WAIT_MS = 2_000;
/** Idempotency records (create) are kept this long (idempotency.mdx). */
export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
/** A writer silent this long with a turn open, its runner gone, is lost. */
export const RECOVER_AFTER_MS = 60_000;
/** A `stale_epoch` batch re-sends the session's `epoch` frame at most this often. */
export const STALE_EPOCH_RESEND_MS = 5_000;
/** Sessions whose last applied summary is kept in memory (applySummary's change check). */
const APPLIED_MAX = 1_024;
/** Expired idempotency records are swept at most this often (indexed by created_at). */
const IDEMPOTENCY_SWEEP_MS = 60_000;
/** A journal gap closes the host's socket (it reconnects and resends from the last ack) at most this often. */
export const GAP_CLOSE_INTERVAL_MS = 30_000;
const TICKETS_PER_MINUTE = 60;
const RETRY_COMPUTER_MS = 5_000;

/** Who is calling, as the route resolved it (api-http.ts). */
export interface ApiCaller {
  /** `usr_…`. */
  member: string;
  /** The dashboard (WorkOS) user id. */
  userId: string;
  /** The caller's organization role is owner or admin: they may open terminals in any session they can see. */
  admin?: boolean;
  name: string | null;
  email: string | null;
  /** The actor's `via`, and a new session's origin type: `opc`, `api` or `dashboard`. */
  via: "opc" | "api" | "dashboard";
  client: string | null;
  scopes: ApiScope[];
  apiKey?: AssertedApiKey;
  requestId: string;
  userAgent?: string | null;
}

export type ApiOp =
  | { op: "me" }
  | { op: "create"; body: unknown; idempotencyKey?: string }
  | { op: "list"; query: Array<[string, string]> }
  | { op: "get"; sessionId: string; minSeq?: number }
  | { op: "access"; sessionId: string }
  | { op: "call"; sessionId: string; method: WriteMethod; params: Record<string, unknown>; idempotencyKey?: string }
  | { op: "patch"; sessionId: string; body: unknown; idempotencyKey?: string }
  | { op: "ticket"; body: unknown };

export interface ApiErrorReply {
  code: string;
  message: string;
  retryable?: boolean;
  [field: string]: unknown;
}

export interface ApiReply {
  status: number;
  body?: unknown;
  error?: ApiErrorReply;
}

/** The writes that go to the session's writer as an `api` frame. */
export const WRITE_METHODS = [
  "turns.send",
  "turns.cancel",
  "sessions.interrupt",
  "sessions.compact",
  "sessions.suspend",
  "sessions.resume",
  "asks.answer",
  "asks.dismiss",
  "subagents.stop",
] as const;
export type WriteMethod = (typeof WRITE_METHODS)[number];

/** Writes that spend credits: admitted like a Slack message. */
const ADMITTED = new Set<string>(["turns.send", "sessions.compact", "sessions.resume"]);
/** Answered 202 when they acted (the seq advanced), 200 when there was nothing to do. */
const ACTS = new Set<string>(["sessions.interrupt", "sessions.suspend", "sessions.resume", "subagents.stop"]);

export interface ApiRow {
  key: string;
  sessionId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  ownerId: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  title: string;
  mode: CalvinMode | null;
  model: string | null;
  effort: string | null;
  speed: string | null;
  status: string | null;
  originType: string;
  originClient: string | null;
  lastSeq: number;
  logEpoch: number;
  epochStartSeq: number;
  summary: string | null;
  apiStatus: string | null;
  archived: number;
  metadata: string | null;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number | null;
  syncedAt: number | null;
  subagents: number;
  createHash: string | null;
  activeTurnId: string | null;
}

const ROW_SELECT = `SELECT runner_key AS key, session_id AS sessionId, team_id AS teamId, channel_id AS channelId,
  thread_ts AS threadTs, owner_id AS ownerId, owner_user_id AS ownerUserId, owner_name AS ownerName,
  owner_email AS ownerEmail, title, mode, model, effort, speed, status, origin_type AS originType,
  origin_client AS originClient, last_seq AS lastSeq, log_epoch AS logEpoch, epoch_start_seq AS epochStartSeq,
  summary, api_status AS apiStatus, archived, metadata, created_at AS createdAt, updated_at AS updatedAt,
  last_active_at AS lastActiveAt, synced_at AS syncedAt, subagents, create_hash AS createHash,
  active_turn_id AS activeTurnId FROM sessions`;

/** Columns work 084 adds to `sessions` (lifecycle.ts's pattern: added when missing). */
const COLUMNS: Array<[string, string]> = [
  ["session_id", "TEXT"],
  ["origin_type", "TEXT NOT NULL DEFAULT 'slack'"],
  ["origin_client", "TEXT"],
  ["owner_user_id", "TEXT"],
  ["owner_name", "TEXT"],
  ["owner_email", "TEXT"],
  ["effort", "TEXT"],
  ["speed", "TEXT"],
  ["last_seq", "INTEGER NOT NULL DEFAULT 0"],
  ["log_epoch", "INTEGER NOT NULL DEFAULT 1"],
  ["epoch_start_seq", "INTEGER NOT NULL DEFAULT 1"],
  ["summary", "TEXT"],
  ["api_status", "TEXT"],
  ["archived", "INTEGER NOT NULL DEFAULT 0"],
  ["metadata", "TEXT"],
  ["last_active_at", "INTEGER"],
  ["synced_at", "INTEGER"],
  ["subagents", "INTEGER NOT NULL DEFAULT 0"],
  ["create_hash", "TEXT"],
  ["active_turn_id", "TEXT"],
];

export interface SessionsApiDeps {
  sql: SqlStorage;
  env: ComputerEdgeEnv;
  organizationId: () => string;
  /** The connected host's protocol; undefined when none is connected. */
  host: () => { protocol: number } | undefined;
  /** The rollout gate (api-gate.ts): false, and every operation but `me` answers 409 feature_unavailable. */
  enabled: () => boolean;
  send: (frame: CalvinGatewayToHost) => boolean;
  closeHost: (code: number, reason: string) => void;
  /** Starts or wakes the computer (no Slack notice). */
  wake: () => Promise<void>;
  computerStatus: () => "ready" | "asleep" | "not_set_up";
  /** Billing's admission (cached like Slack's); throws when billing is unavailable. */
  admitted: () => Promise<boolean>;
  slackPerson: (slackUserId: string) => CalvinPerson;
  linkOfSlack: (slackUserId: string) => string | undefined;
  slackTeamId: () => string | undefined;
  keys: ComputerKeys;
  tunnelId: () => string | null;
  waitUntil: (promise: Promise<unknown>) => void;
  scheduleRecover: (at: number) => Promise<void>;
  setting: (key: string) => string | undefined;
  put: (key: string, value: string) => void;
  remove: (key: string) => void;
  now?: () => number;
  /** Work 084 instrumentation: rollups and rare events (telemetry/api.ts). Absent: nothing is measured. */
  telemetry?: ApiTelemetry;
}

type HostOutcome = { result?: unknown; error?: CalvinApiError };

interface Pending {
  resolve: (outcome: HostOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  /** A keyed write's dedupe key (`keyed`). */
  key?: string;
}


export class ComputerSessionsApi {
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  /** Keyed writes awaiting the host's answer, by session, member, method and idempotency key: a retry takes the original's answer. */
  private readonly keyed = new Map<string, { id: string; result: Promise<HostOutcome> }>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Array<{ seq: number; done: () => void }>>();
  private readonly tickets = new Map<string, number[]>();
  private gapClosedAt = 0;

  constructor(private readonly deps: SessionsApiDeps) {
    this.now = deps.now ?? Date.now;
    const sql = deps.sql;
    const have = new Set([...sql.exec<{ name: string }>("PRAGMA table_info(sessions)")].map((c) => c.name));
    for (const [name, type] of COLUMNS) if (!have.has(name)) sql.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_id ON sessions (session_id);
      CREATE INDEX IF NOT EXISTS sessions_last_active ON sessions (last_active_at);
      CREATE TABLE IF NOT EXISTS api_idempotency (
        member TEXT NOT NULL,
        op TEXT NOT NULL,
        key TEXT NOT NULL,
        hash TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (member, op, key)
      );
      CREATE INDEX IF NOT EXISTS api_idempotency_created ON api_idempotency (created_at);
    `);
  }

  // ---------------------------------------------------------------- rows

  row(sessionId: string): ApiRow | undefined {
    return [...this.deps.sql.exec<Record<string, SqlStorageValue>>(`${ROW_SELECT} WHERE session_id = ?`, sessionId)][0] as unknown as ApiRow | undefined;
  }

  private rowByKey(key: string): ApiRow | undefined {
    return [...this.deps.sql.exec<Record<string, SqlStorageValue>>(`${ROW_SELECT} WHERE runner_key = ?`, key)][0] as unknown as ApiRow | undefined;
  }

  /** A session the caller may see: every API session; a Slack one only by its linked owner. */
  private visible(caller: ApiCaller, sessionId: string): ApiRow | undefined {
    if (!isSessionId(sessionId)) return undefined;
    const row = this.row(sessionId);
    if (!row) return undefined;
    if (row.originType === "slack" && row.ownerUserId !== caller.member) return undefined;
    return row;
  }

  private v4Host(): boolean {
    return (this.deps.host()?.protocol ?? 0) >= CALVIN_API_PROTOCOL;
  }

  private log(sessionId: string): SessionLogRpc {
    const ns = this.deps.env.SESSION_LOG;
    if (!ns) throw new Error("SESSION_LOG is not bound");
    return ns.getByName(sessionId) as unknown as SessionLogRpc;
  }

  /** The Session object: the row and the summary; `fresh` (a writer's result) wins for what the log owns. */
  compose(row: ApiRow, fresh?: Partial<Session>): Session {
    const summary = row.summary ? (JSON.parse(row.summary) as LogSummary) : null;
    const owner: Person = { id: row.ownerUserId ?? "", name: row.ownerName ?? "", email: row.ownerEmail };
    const origin: Origin =
      row.originType === "slack"
        ? {
            type: "slack",
            client: null,
            slack: {
              teamId: row.teamId || null,
              channelId: row.channelId,
              channelName: null,
              threadTs: row.threadTs || null,
              url: slackThreadUrl(row.teamId || null, row.channelId, row.threadTs),
            },
          }
        : { type: row.originType, client: row.originClient, slack: null };
    const status = (row.apiStatus as SessionStatus | null) ?? statusOfRunner(row.status);
    const base: Session = {
      id: row.sessionId,
      title: row.title,
      status,
      archived: row.archived === 1,
      owner,
      origin,
      settings: summary?.settings
        ? { ...summary.settings, speed: summary.settings.speed ?? row.speed }
        : { model: row.model ?? MODELS[0]!.id, effort: row.effort, mode: row.mode ?? DEFAULT_MODE, speed: row.speed },
      metadata: parseMetadata(row.metadata),
      activeTurnId: summary?.activeTurnId ?? null,
      queued: summary?.queued ?? [],
      asks: summary?.asks ?? [],
      subagents: summary?.subagents ?? [],
      lastTurn: summary?.lastTurn ?? null,
      lastText: summary?.lastText ?? null,
      context: summary?.context ?? { usedTokens: null, windowTokens: null },
      lastSeq: row.lastSeq,
      logEpoch: row.logEpoch,
      epochStartSeq: row.epochStartSeq,
      createdAt: new Date(row.createdAt).toISOString(),
      lastActiveAt: new Date(row.lastActiveAt ?? row.updatedAt).toISOString(),
      syncedAt: row.syncedAt ? new Date(row.syncedAt).toISOString() : null,
      urls: { dashboard: null },
    };
    if (!fresh) return base;
    // The writer's own view is newer than the row; the row owns who, where, archive and labels.
    return { ...base, ...fresh, id: base.id, owner, origin, archived: base.archived, metadata: base.metadata, urls: base.urls };
  }

  /** The runner's spec for a session: an API one (`kind: "api"`) or a Slack thread. */
  private spec(row: ApiRow): CalvinSessionSpec {
    const common = {
      sessionId: row.sessionId,
      title: row.title,
      mode: row.mode ?? DEFAULT_MODE,
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      ...(isSpeed(row.speed) ? { speed: row.speed } : {}),
      metadata: parseMetadata(row.metadata),
    };
    if (row.originType !== "slack") {
      return {
        key: row.key,
        kind: "api",
        origin: { type: row.originType, ...(row.originClient ? { client: row.originClient } : {}) },
        owner: personForMember(row.ownerUserId ?? "", { ...(row.ownerName ? { name: row.ownerName } : {}), ...(row.ownerEmail ? { email: row.ownerEmail } : {}) }),
        ...common,
      };
    }
    const person = this.deps.slackPerson(row.ownerId ?? "");
    return {
      key: row.key,
      kind: "thread",
      channel: row.channelId,
      threadTs: row.threadTs,
      origin: { type: "slack" },
      owner: row.ownerUserId ? { ...person, userId: row.ownerUserId } : person,
      ...(row.teamId ? { teamId: row.teamId } : {}),
      ...common,
    };
  }

  private actor(caller: ApiCaller): CalvinApiActor {
    return { id: caller.member, name: caller.name, via: caller.via, client: caller.client };
  }

  // ---------------------------------------------------------------- operations

  async handle(caller: ApiCaller, op: ApiOp): Promise<ApiReply> {
    // Gated off, the organization is v3: nothing is observed, stored or sent to its host. `me` still answers (opc's login check).
    if (op.op !== "me" && !this.deps.enabled()) {
      return { status: 409, error: { code: "feature_unavailable", message: "The sessions API is not enabled for this organization yet.", feature: "sessions" } };
    }
    if (caller.apiKey) this.deps.keys.observe(caller.apiKey, caller.member);
    if (caller.admin !== undefined) this.noteAdmin(caller.member, caller.admin);
    switch (op.op) {
      case "me":
        return this.me(caller);
      case "create":
        return this.create(caller, op.body, op.idempotencyKey);
      case "list":
        return this.list(caller, op.query);
      case "get":
        return this.get(caller, op.sessionId, op.minSeq);
      case "access": {
        const row = this.visible(caller, op.sessionId);
        return row ? { status: 200, body: { sessionId: row.sessionId, logEpoch: row.logEpoch, lastSeq: row.lastSeq } } : notFound();
      }
      case "call":
        return this.call(caller, op.sessionId, op.method, op.params, op.idempotencyKey);
      case "patch":
        return this.patch(caller, op.sessionId, op.body, op.idempotencyKey);
      case "ticket":
        return this.ticket(caller, op.body);
    }
  }

  private me(caller: ApiCaller): ApiReply {
    const key = caller.apiKey;
    return {
      status: 200,
      body: {
        person: { id: caller.member, name: caller.name ?? "", email: caller.email },
        organization: { id: this.deps.organizationId(), name: null },
        credential: key
          ? { id: key.id, name: key.name, kind: "key", scopes: caller.scopes, expiresAt: key.expiresAt, createdAt: key.createdAt }
          : { id: null, name: null, kind: "login", scopes: caller.scopes, expiresAt: null, createdAt: null },
        computer: { status: this.deps.computerStatus(), region: null, wireUrl: this.deps.env.WIRE_PUBLIC_URL || DEFAULT_WIRE_URL },
        defaults: { model: MODELS[0]!.id, effort: null, mode: DEFAULT_MODE, speed: null },
        capabilities: capabilities(),
      },
    };
  }

  private async create(caller: ApiCaller, body: unknown, idempotencyKey?: string): Promise<ApiReply> {
    const input = validateCreate(body);
    if ("error" in input) return input.error;
    const hash = await sha256Hex(stableJson(input.value));
    const v = input.value;
    if (idempotencyKey) {
      const record = this.idempotency(caller.member, "create", idempotencyKey);
      if (record) {
        if (record.hash !== hash) return conflict("idempotency_conflict", "This Idempotency-Key was used with a different body.");
        const stored = JSON.parse(record.body) as { sessionId: string; turn: unknown; delivery: unknown; seq: number };
        const row = this.row(stored.sessionId);
        if (row) {
          // The operation's result now (idempotency.mdx): the turn as the log has it, else as first answered.
          const turnId = (stored.turn as { id?: unknown } | null)?.id;
          const now = typeof turnId === "string" ? await this.log(stored.sessionId).turn(turnId, {}) : null;
          const turn = now?.ok ? now.turn : stored.turn;
          return { status: 200, body: { session: this.compose(row), turn, delivery: stored.delivery, duplicate: true, seq: stored.seq } };
        }
      }
    }
    const id = v.id ?? mintId("cs");
    let row = this.row(id);
    // The same create again (same id, body and member, e.g. a retry whose key the edge dropped): finish it.
    const repeat = row !== undefined && row.createHash === hash && row.ownerUserId === caller.member;
    if (row && !repeat) return conflict("id_conflict", `${id} belongs to another session.`);
    if (this.deps.computerStatus() === "not_set_up") return conflict("computer_not_set_up", "Your organization has not finished setting up its computer.");
    if (v.input !== undefined) {
      const refused = await this.admission();
      if (refused) return refused;
    }
    if (!this.v4Host()) return this.unavailable();

    if (!row) {
      const now = this.now();
      const title = v.title ?? (v.input ? titleFrom(v.input) : "Untitled");
      this.deps.sql.exec(
        `INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, mode, model, created_at, updated_at,
           session_id, origin_type, origin_client, owner_user_id, owner_name, owner_email, effort, speed, metadata, create_hash,
           api_status, last_active_at)
         VALUES (?, '', '', '', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?)`,
        id,
        title,
        v.mode ?? DEFAULT_MODE,
        v.model ?? MODELS[0]!.id,
        now,
        now,
        id,
        caller.via,
        caller.client,
        caller.member,
        caller.name,
        caller.email,
        v.effort ?? null,
        v.speed ?? null,
        v.metadata ? JSON.stringify(v.metadata) : null,
        hash,
        now,
      );
      row = this.row(id)!;
      this.sendAccess({ sessionId: id, originType: "api", ownerUserId: caller.member });
    }

    let turn: unknown = null;
    let delivery: unknown = null;
    let seq = row.lastSeq;
    let duplicate = false;
    if (v.input !== undefined) {
      const outcome = await this.hostCall({
        t: "api",
        id: crypto.randomUUID(),
        sessionId: id,
        method: "turns.send",
        params: { sessionId: id, input: v.input, ifBusy: "queue" },
        actor: this.actor(caller),
        member: caller.member,
        // One turn per create, whatever retries: the writer's idempotency keeps it.
        idempotencyKey: idempotencyKey ?? `create:${id}`,
        requestId: caller.requestId,
        session: this.spec(row),
        epoch: row.logEpoch,
        lastSeq: row.lastSeq,
      });
      if (outcome.error) return hostError(outcome.error);
      const result = outcome.result as { turn: unknown; delivery: unknown; seq: number; duplicate?: boolean };
      ({ turn, delivery, seq } = result);
      duplicate = repeat && result.duplicate === true;
    } else if (!repeat) {
      this.startSession(row);
    } else {
      duplicate = true;
    }
    if (idempotencyKey) this.remember(caller.member, "create", idempotencyKey, hash, { sessionId: id, turn, delivery, seq });
    return { status: duplicate ? 200 : 201, body: { session: this.compose(this.row(id) ?? row), turn, delivery, duplicate, seq } };
  }

  /** The host has no spec of the session: `start`, after an epoch send in flight (the host adopts the epoch first), with the row as it is then. */
  private async wake(sessionId: string): Promise<void> {
    await this.epochSends.get(sessionId);
    const row = this.row(sessionId);
    if (row) this.startSession(row);
  }

  /** A session with no first message: the host claims a spare and forks for it (answered by `started`). */
  private startSession(row: ApiRow): void {
    const id = crypto.randomUUID();
    const sent = this.deps.send({ t: "start", id, session: this.spec(row), epoch: row.logEpoch, lastSeq: row.lastSeq });
    if (!sent) return;
    // Nobody waits for it; a refusal is logged (the session stays `starting` until a send).
    this.pending.set(id, {
      resolve: (outcome) => {
        if (outcome.error) console.warn(JSON.stringify({ level: "warn", event: "computer.api_start_failed", sessionId: row.sessionId, code: outcome.error.code }));
      },
      timer: setTimeout(() => this.settle(id, {}), HOST_CALL_TIMEOUT_MS),
    });
  }

  private async get(caller: ApiCaller, sessionId: string, minSeq?: number): Promise<ApiReply> {
    let row = this.visible(caller, sessionId);
    if (!row) return notFound();
    if (minSeq !== undefined && row.lastSeq < minSeq) {
      await this.waitSeq(sessionId, minSeq, MIN_SEQ_WAIT_MS);
      row = this.row(sessionId)!;
      if (row.lastSeq < minSeq) return { status: 503, error: { code: "unavailable", message: `The session has not reached seq ${minSeq} yet.`, retryAfterMs: 500 } };
    }
    return { status: 200, body: { session: this.compose(row) } };
  }

  private async call(caller: ApiCaller, sessionId: string, method: WriteMethod, params: Record<string, unknown>, idempotencyKey?: string): Promise<ApiReply> {
    const row = this.visible(caller, sessionId);
    if (!row) return notFound();
    if (ADMITTED.has(method)) {
      const refused = await this.admission();
      if (refused) return refused;
    }
    if (!this.v4Host()) return this.unavailable();
    const before = row.lastSeq;
    const outcome = await this.hostCall({
      t: "api",
      id: crypto.randomUUID(),
      sessionId,
      method,
      params: { ...params, sessionId },
      actor: this.actor(caller),
      member: caller.member,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      requestId: caller.requestId,
      session: this.spec(row),
      epoch: row.logEpoch,
      lastSeq: row.lastSeq,
    });
    if (outcome.error) return hostError(outcome.error);
    const result = { ...(outcome.result as Record<string, unknown>) };
    // A new message brings an archived session back (sessions.mdx#update-a-session).
    if (method === "turns.send" && row.archived) this.deps.sql.exec("UPDATE sessions SET archived = 0 WHERE session_id = ?", sessionId);
    if (result.session && typeof result.session === "object") result.session = this.compose(this.row(sessionId) ?? row, result.session as Partial<Session>);
    let status = 200;
    if (method === "turns.send" || method === "sessions.compact") status = result.duplicate === true ? 200 : 202;
    else if (ACTS.has(method)) status = typeof result.seq === "number" && result.seq > before ? 202 : 200;
    return { status, body: result };
  }

  private async patch(caller: ApiCaller, sessionId: string, body: unknown, idempotencyKey?: string): Promise<ApiReply> {
    const row = this.visible(caller, sessionId);
    if (!row) return notFound();
    const parsed = validatePatch(body);
    if ("error" in parsed) return parsed.error;
    const p = parsed.value;
    const settings = checkSettings(
      { ...(p.model !== undefined ? { model: p.model } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}), ...(p.mode !== undefined ? { mode: p.mode } : {}) },
      { model: row.model, effort: row.effort },
    );
    if (!settings.ok) return { status: 400, error: { code: settings.code, message: settings.message, field: settings.field } };
    let metadata: Record<string, string> | undefined;
    if (p.metadata) {
      metadata = parseMetadata(row.metadata);
      for (const [k, value] of Object.entries(p.metadata)) {
        if (value === null) delete metadata[k];
        else metadata[k] = value;
      }
      if (Object.keys(metadata).length > 20) return invalid("metadata", "At most 20 metadata keys.");
    }
    const effort = settings.effort;
    const forWriter = p.title !== undefined || p.model !== undefined || p.effort !== undefined || p.mode !== undefined || p.speed !== undefined;
    let fresh: Partial<Session> | undefined;
    let seq = row.lastSeq;
    if (this.v4Host()) {
      const outcome = await this.hostCall({
        t: "api",
        id: crypto.randomUUID(),
        sessionId,
        method: "sessions.update",
        params: {
          sessionId,
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(effort !== undefined && effort !== null ? { effort } : {}),
          ...(p.mode !== undefined ? { mode: p.mode } : {}),
          ...(p.speed !== undefined ? { speed: p.speed } : {}),
          ...(p.archived !== undefined ? { archived: p.archived } : {}),
          ...(p.metadata ? { metadata: p.metadata } : {}),
        },
        actor: this.actor(caller),
        member: caller.member,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        requestId: caller.requestId,
        session: this.spec(row),
        epoch: row.logEpoch,
        lastSeq: row.lastSeq,
      });
      if (outcome.error) return hostError(outcome.error);
      const result = outcome.result as { session?: Partial<Session>; seq?: number };
      fresh = result.session;
      if (typeof result.seq === "number") seq = result.seq;
    } else if (forWriter) {
      return this.unavailable();
    }
    // The row follows at once (lists read it); the summary confirms it later, monotonically.
    const isSlack = row.originType === "slack";
    this.applied.delete(sessionId);
    this.deps.sql.exec(
      `UPDATE sessions SET title = COALESCE(?, title), model = COALESCE(?, model), mode = COALESCE(?, mode),
         effort = CASE WHEN ? THEN ? ELSE effort END, speed = COALESCE(?, speed), archived = COALESCE(?, archived),
         metadata = COALESCE(?, metadata)
       WHERE session_id = ?`,
      isSlack ? null : (p.title ?? null),
      isSlack ? null : (p.model ?? null),
      isSlack ? null : (p.mode ?? null),
      isSlack || effort === undefined ? 0 : 1,
      effort ?? null,
      isSlack ? null : (p.speed ?? null),
      p.archived === undefined ? null : p.archived ? 1 : 0,
      metadata ? JSON.stringify(metadata) : null,
      sessionId,
    );
    return { status: 200, body: { session: this.compose(this.row(sessionId)!, fresh), seq } };
  }

  private async ticket(caller: ApiCaller, body: unknown): Promise<ApiReply> {
    const began = performance.now();
    const facts: { sessions?: number; keyWritten?: boolean } = {};
    const reply = await this.mint(caller, body, facts);
    const t = this.deps.telemetry;
    if (t) {
      const reason = reply.error ? (reply.error as { reason?: unknown }).reason : undefined;
      const result = !reply.error
        ? "minted"
        : typeof reason === "string"
          ? reason
          : reply.error.code === "unavailable"
            ? "not_configured"
            : reply.error.code === "invalid_request"
              ? "invalid"
              : reply.error.code;
      t.ticket({ surface: caller.via === "opc" ? "cli" : "api", ms: performance.now() - began, result, ...facts });
    }
    return reply;
  }

  private async mint(caller: ApiCaller, body: unknown, facts: { sessions?: number; keyWritten?: boolean }): Promise<ApiReply> {
    const key = caller.apiKey;
    if (!key) return { status: 403, error: { code: "forbidden", message: "Tickets are minted for API keys.", reason: "api_key_required" } };
    if (key.kind === "project") return { status: 403, error: { code: "forbidden", message: "Project keys cannot mint tickets.", reason: "project_key" } };
    if (!this.deps.env.WIRE_TICKET_KEY) return { status: 503, error: { code: "unavailable", message: "Tickets are not available yet.", retryAfterMs: 60_000 } };
    const request = validateTicketRequest(body, caller.userAgent);
    if (!request.ok) return invalid(request.errors[0]!.field, request.errors[0]!.message);
    const now = this.now();
    const recent = (this.tickets.get(key.id) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= TICKETS_PER_MINUTE) {
      return { status: 429, error: { code: "rate_limited", message: "At most 60 tickets a minute per key.", retryAfterMs: 60_000 - (now - recent[0]!) } };
    }
    recent.push(now);
    this.tickets.set(key.id, recent);
    const tunnelId = this.deps.tunnelId();
    if (!tunnelId) return this.unavailable();
    facts.keyWritten = await this.deps.keys.ensure(key, caller.member);
    facts.sessions = request.value.sessionIds?.length ?? 0;
    try {
      const org = this.deps.organizationId();
      const ticket = await mintTicket(this.deps.env, { ...request.value, org, member: caller.member, computer: org, tunnelId, keyId: key.id }, now);
      return { status: 200, body: { ticket } };
    } catch (error) {
      if (error instanceof TicketTooLongError) return invalid("sessionIds", "Too many sessionIds for one ticket.");
      throw error;
    }
  }

  private list(caller: ApiCaller, query: Array<[string, string]>): ApiReply {
    const q = new Map<string, string>();
    const metadata: Array<[string, string]> = [];
    for (const [name, value] of query) {
      const m = /^metadata\[(.{1,40})\]$/.exec(name);
      if (m) metadata.push([m[1]!, value]);
      else q.set(name, value);
    }
    for (const name of q.keys()) {
      if (!["owner", "status", "origin", "archived", "q", "order", "limit", "cursor"].includes(name)) return invalid(name, `Unknown query parameter ${name}.`);
    }
    const where = ["session_id IS NOT NULL", "(origin_type != 'slack' OR owner_user_id = ?)"];
    const args: SqlStorageValue[] = [caller.member];
    const owner = q.get("owner") ?? "me";
    if (owner === "me") {
      where.push("owner_user_id = ?");
      args.push(caller.member);
    } else if (owner !== "anyone") {
      if (!/^usr_[0-9a-z]{1,64}$/.test(owner)) return invalid("owner", "owner is me, anyone or a member id.");
      where.push("owner_user_id = ?");
      args.push(owner);
    }
    const csv = (name: string, allowed: readonly string[]): string[] | ApiReply => {
      const values = (q.get(name) ?? "").split(",").filter(Boolean);
      const bad = values.find((x) => !allowed.includes(x));
      return bad ? invalid(name, `${name} must be among ${allowed.join(", ")}.`) : values;
    };
    const statuses = csv("status", ["starting", "running", "waiting", "idle", "suspended"]);
    if (!Array.isArray(statuses)) return statuses;
    if (statuses.length) {
      // The status compose shows: the API's, else the runner's (statusOfRunner).
      where.push(`${STATUS_SQL} IN (${statuses.map(() => "?").join(",")})`);
      args.push(...statuses);
    }
    const origins = (q.get("origin") ?? "").split(",").filter(Boolean);
    if (origins.length) {
      where.push(`origin_type IN (${origins.map(() => "?").join(",")})`);
      args.push(...origins);
    }
    const archived = q.get("archived") ?? "false";
    if (archived === "false" || archived === "true") {
      where.push("archived = ?");
      args.push(archived === "true" ? 1 : 0);
    } else if (archived !== "all") return invalid("archived", "archived is false, true or all.");
    for (const [k, value] of metadata) {
      where.push("json_extract(metadata, ?) = ?");
      args.push(`$."${k.replace(/["\\]/g, "")}"`, value);
    }
    const text = q.get("q");
    if (text) {
      where.push("title LIKE ? ESCAPE '\\'");
      args.push(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const order = q.get("order") ?? "active";
    if (order !== "active" && order !== "created") return invalid("order", "order is active or created.");
    const column = order === "active" ? "COALESCE(last_active_at, updated_at)" : "created_at";
    const limit = q.has("limit") ? Number(q.get("limit")) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return invalid("limit", "limit is 1 to 100.");
    // The cursor binds the filters it was made under (sessions.mdx: another set is invalid_cursor).
    const filter = fnv1a(
      JSON.stringify([owner, [...statuses].sort(), [...origins].sort(), archived, [...metadata].sort(), text ?? ""]),
    );
    const cursor = q.get("cursor");
    if (cursor) {
      const c = decodeCursor(cursor, order, filter);
      if (!c) return { status: 400, error: { code: "invalid_cursor", message: "The cursor is not valid for this list." } };
      where.push(`(${column} < ? OR (${column} = ? AND session_id < ?))`);
      args.push(c.at, c.at, c.id);
    }
    const rows = [
      ...this.deps.sql.exec<Record<string, SqlStorageValue>>(
        `${ROW_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${column} DESC, session_id DESC LIMIT ?`,
        ...args,
        limit + 1,
      ),
    ] as unknown as ApiRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor(order, order === "active" ? (last.lastActiveAt ?? last.updatedAt) : last.createdAt, last.sessionId, filter) : null;
    return { status: 200, body: { sessions: page.map((row) => this.compose(row)), nextCursor } };
  }

  // ---------------------------------------------------------------- the host

  private async admission(): Promise<ApiReply | null> {
    try {
      return (await this.deps.admitted()) ? null : { status: 402, error: { code: "insufficient_credits", message: "Your organization is out of credits." } };
    } catch {
      return { status: 503, error: { code: "unavailable", message: "Billing is unavailable; retry.", retryAfterMs: 2_000 } };
    }
  }

  private unavailable(): ApiReply {
    this.deps.telemetry?.unavailable();
    this.deps.waitUntil(
      this.deps.wake().catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.api_wake_failed", message: String(error) }))),
    );
    return { status: 503, error: { code: "computer_unavailable", message: "Your computer is starting. Retry.", retryAfterMs: RETRY_COMPUTER_MS } };
  }

  /** Sends a frame that the host answers by `id` (`api-result`, `started`); 503 after 15 s or a lost socket. */
  /**
   * One write to the host. The answer is awaited HOST_CALL_TIMEOUT_MS, or HOST_CALL_HELD_TIMEOUT_MS while the
   * session's epoch is moving (the host holds the write until it adopts). A keyed write's answer is kept past
   * the client's wait: a retry with the same idempotency key sends nothing and takes it (review r3 P2-2).
   */
  private async hostCall(frame: Extract<CalvinGatewayToHost, { t: "api" }>): Promise<HostOutcome> {
    const t = this.deps.telemetry;
    if (!t) return this.hostCallNow(frame);
    const note: HostCallNote = { held: false, heldMs: 0, replayed: false, wait: 0 };
    const began = performance.now();
    const outcome = await this.hostCallNow(frame, note);
    const ms = performance.now() - began;
    const code = outcome.error?.code;
    t.write({
      sessionId: frame.sessionId,
      surface: frame.actor?.via === "opc" ? "cli" : "api",
      method: frame.method,
      hostMs: ms,
      // In the DO before the frame left, beyond any hold behind an epoch send.
      ...(note.sentAt !== undefined ? { doMs: Math.max(0, note.sentAt - began - note.heldMs) } : {}),
      held: note.held,
      heldMs: note.heldMs,
      replayed: note.replayed,
      // A lost answer (hostLost) after the whole wait; a closed socket settles earlier.
      timedOut: code === "computer_unavailable" && note.wait > 0 && ms - note.heldMs >= note.wait - 5,
      ...(code ? { errorCode: code } : {}),
    });
    return outcome;
  }

  private async hostCallNow(frame: Extract<CalvinGatewayToHost, { t: "api" }>, note?: HostCallNote): Promise<HostOutcome> {
    const key = frame.idempotencyKey ? [frame.sessionId, frame.member ?? "", frame.method, frame.idempotencyKey].join("\n") : undefined;
    const earlier = key ? this.keyed.get(key) : undefined;
    if (earlier) {
      if (note) (note.replayed = true), (note.wait = this.answerWait(frame.sessionId, false));
      return this.awaitAnswer(earlier.result, frame.sessionId, false);
    }
    let resolve!: (outcome: HostOutcome) => void;
    const result = new Promise<HostOutcome>((r) => (resolve = r));
    if (key) this.keyed.set(key, { id: frame.id, result });
    const moving = this.epochSends.get(frame.sessionId);
    if (moving) {
      // The host hears the new epoch from `epoch` first; this frame then carries the row as it is now.
      const heldAt = performance.now();
      await moving;
      if (note) (note.held = true), (note.heldMs = performance.now() - heldAt);
      const row = this.row(frame.sessionId);
      if (row) frame = { ...frame, epoch: row.logEpoch, lastSeq: row.lastSeq, ...(frame.session ? { session: this.spec(row) } : {}) };
    }
    const wait = this.answerWait(frame.sessionId, moving !== undefined);
    if (note) note.wait = wait;
    const sent = this.deps.send(frame);
    if (note) note.sentAt = performance.now();
    if (!sent) {
      if (key && this.keyed.get(key)?.id === frame.id) this.keyed.delete(key);
      return { error: hostLost() };
    }
    // Unkeyed: the pending entry is the client's wait. Keyed: it outlives it, for a retry to take.
    this.pending.set(frame.id, { resolve, timer: setTimeout(() => this.settle(frame.id, { error: hostLost() }), key ? KEYED_CALL_KEEP_MS : wait), ...(key ? { key } : {}) });
    return key ? this.awaitAnswer(result, frame.sessionId, moving !== undefined, wait) : result;
  }

  private answerWait(sessionId: string, held: boolean): number {
    const moving = held || this.epochSends.has(sessionId) || this.now() - (this.epochSentAt.get(sessionId) ?? -Infinity) < EPOCH_MOVING_MS;
    return moving ? HOST_CALL_HELD_TIMEOUT_MS : HOST_CALL_TIMEOUT_MS;
  }

  private async awaitAnswer(result: Promise<HostOutcome>, sessionId: string, held: boolean, wait = this.answerWait(sessionId, held)): Promise<HostOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<HostOutcome>((r) => (timer = setTimeout(() => r({ error: hostLost() }), wait)));
    try {
      return await Promise.race([result, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private settle(id: string, outcome: HostOutcome): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.key && this.keyed.get(pending.key)?.id === id) this.keyed.delete(pending.key);
    pending.resolve(outcome);
  }

  /** A v4 frame from the host; false when it is not one. */
  async onHostFrame(frame: CalvinHostToGatewayV4): Promise<boolean> {
    switch (frame.t) {
      case "api-result":
        this.settle(frame.id, frame.error ? { error: frame.error } : { result: frame.result });
        return true;
      case "started":
        this.settle(frame.id, frame.error ? { error: frame.error } : { result: { status: frame.status } });
        return true;
      case "journal":
        await this.journal(frame.sessionId, frame.epoch, frame.events);
        return true;
      case "wake":
        void this.wake(frame.sessionId);
        return true;
      case "subagent-progress": {
        const row = this.row(frame.sessionId);
        if (row && frame.epoch === row.logEpoch && Array.isArray(frame.progress)) {
          this.deps.waitUntil(
            this.log(frame.sessionId)
              .progress({ sessionId: frame.sessionId, organizationId: this.deps.organizationId() }, frame.epoch, frame.progress)
              .catch(() => {}),
          );
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** One journal batch, after the session's previous ones: stored, mirrored to the row, acked. */
  journal(sessionId: string, epoch: number, events: Extract<CalvinHostToGatewayV4, { t: "journal" }>["events"]): Promise<void> {
    const received = performance.now();
    const run = async () => {
      const ran = performance.now();
      const rowEpoch = this.epochOf(sessionId);
      if (rowEpoch === null) {
        console.warn(JSON.stringify({ level: "warn", event: "computer.journal_unknown_session", sessionId }));
        return;
      }
      if (!Number.isInteger(epoch) || !Array.isArray(events)) return;
      // An empty batch is the host asking for the epoch it is missing (a held frame past its deadline,
      // review r3 P1-1): answered as a stale batch is, rate-limited. At the row's epoch it is nothing.
      if (events.length === 0) return epoch < rowEpoch ? this.staleEpoch(sessionId) : undefined;
      // Fenced: a writer of an older epoch than the row's (a lost runner, a host that missed the
      // recovery). Dropped unacked; the host is told the epoch (rate-limited) so it adopts it.
      if (epoch < rowEpoch) return this.staleEpoch(sessionId);
      const began = performance.now();
      const result = await this.log(sessionId).append({ sessionId, organizationId: this.deps.organizationId() }, epoch, events);
      const answered = performance.now();
      this.appended(sessionId, epoch, result);
      const acked = performance.now();
      this.deps.telemetry?.journaled({
        sessionId,
        epoch,
        events,
        appendMs: answered - began,
        chainWaitMs: ran - received,
        preMs: began - received,
        postMs: acked - answered,
        ...(result.ok ? { ackMs: acked - received } : {}),
        result,
      });
    };
    const next = (this.chains.get(sessionId) ?? Promise.resolve()).then(run).catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", event: "computer.journal_append_failed", sessionId, message: String(error) }));
    });
    this.chains.set(sessionId, next);
    void next.finally(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
    return next;
  }

  private appended(sessionId: string, epoch: number, result: AppendResult): void {
    if (result.ok) {
      this.applySummary(sessionId, result.summary);
      this.deps.send({ t: "journal-ack", sessionId, epoch, seq: result.ack });
      return;
    }
    if (result.reason === "stale_epoch") {
      // The log moved on (a recovery the host has not adopted): the row follows, and the host is told
      // the epoch with its tail (at most once per session per STALE_EPOCH_RESEND_MS).
      this.applied.delete(sessionId);
      this.deps.sql.exec("UPDATE sessions SET log_epoch = ? WHERE session_id = ? AND log_epoch < ?", result.logEpoch, sessionId, result.logEpoch);
      this.staleEpoch(sessionId);
      return;
    }
    // A gap: the host skipped events. Its socket is closed; it reconnects and resends from the last ack.
    console.warn(JSON.stringify({ level: "warn", event: "computer.journal_gap", sessionId, epoch, ack: result.ack }));
    const now = this.now();
    if (now - this.gapClosedAt >= GAP_CLOSE_INTERVAL_MS) {
      this.gapClosedAt = now;
      this.deps.closeHost(4010, "journal gap");
      this.deps.telemetry?.recovery("gap_4010", { sessionId, data: { epoch } });
    }
  }

  /**
   * What applySummary last wrote per session: the row's epoch and the summary minus its per-batch
   * fields. Most batches change only lastSeq (and lastActiveAt); those take a 4-column UPDATE.
   * Dropped wherever the row's mirrored columns are written outside applySummary. Bounded.
   */
  private readonly applied = new Map<string, { epoch: number; epochStartSeq: number; body: string }>();

  /** The row's log epoch, or null for an unknown session: a one-column read by the unique index. */
  private epochOf(sessionId: string): number | null {
    const hit = [...this.deps.sql.exec<{ e: number }>("SELECT log_epoch AS e FROM sessions WHERE session_id = ?", sessionId)][0];
    return hit ? hit.e : null;
  }

  /** The row follows the log, never backwards in (epoch, seq). */
  applySummary(sessionId: string, s: LogSummary): void {
    const now = this.now();
    const lastActive = s.lastActiveAt ? Date.parse(s.lastActiveAt) : null;
    const { lastSeq: _seq, lastActiveAt: _at, syncedAt: _synced, ...content } = s;
    const body = JSON.stringify(content);
    const prior = this.applied.get(sessionId);
    if (prior && prior.epoch === s.logEpoch && prior.epochStartSeq === s.epochStartSeq && prior.body === body) {
      // Same summary but for the cursor: the stored summary's lastSeq/lastActiveAt are never read (compose takes the columns).
      this.deps.sql.exec(
        `UPDATE sessions SET last_seq = ?, last_active_at = COALESCE(?, last_active_at), synced_at = ?, updated_at = MAX(updated_at, ?)
         WHERE session_id = ? AND log_epoch = ? AND last_seq <= ?`,
        s.lastSeq,
        lastActive,
        now,
        lastActive ?? 0,
        sessionId,
        s.logEpoch,
        s.lastSeq,
      );
      this.reached(sessionId, s.lastSeq);
      return;
    }
    const settings = s.settings;
    const written = this.deps.sql.exec(
      `UPDATE sessions SET summary = ?, last_seq = ?, log_epoch = ?, epoch_start_seq = ?,
         api_status = COALESCE(?, api_status), active_turn_id = ?, subagents = MAX(subagents, ?),
         last_active_at = COALESCE(?, last_active_at), synced_at = ?, updated_at = MAX(updated_at, ?),
         title = CASE WHEN origin_type != 'slack' AND ? IS NOT NULL THEN ? ELSE title END,
         model = CASE WHEN origin_type != 'slack' AND ? IS NOT NULL THEN ? ELSE model END,
         mode = CASE WHEN origin_type != 'slack' AND ? IS NOT NULL THEN ? ELSE mode END,
         effort = CASE WHEN origin_type != 'slack' AND ? THEN ? ELSE effort END,
         speed = CASE WHEN origin_type != 'slack' AND ? IS NOT NULL THEN ? ELSE speed END
       WHERE session_id = ? AND (log_epoch < ? OR (log_epoch = ? AND last_seq <= ?))`,
      JSON.stringify(s),
      s.lastSeq,
      s.logEpoch,
      s.epochStartSeq,
      s.status,
      s.activeTurnId,
      0,
      lastActive,
      now,
      lastActive ?? 0,
      s.title,
      s.title,
      settings?.model ?? null,
      settings?.model ?? null,
      settings?.mode ?? null,
      settings?.mode ?? null,
      settings ? 1 : 0,
      settings?.effort ?? null,
      settings?.speed ?? null,
      settings?.speed ?? null,
      sessionId,
      s.logEpoch,
      s.logEpoch,
      s.lastSeq,
    ).rowsWritten;
    if (written > 0) {
      if (!prior && this.applied.size >= APPLIED_MAX) this.applied.delete(this.applied.keys().next().value!);
      this.applied.set(sessionId, { epoch: s.logEpoch, epochStartSeq: s.epochStartSeq, body });
    } else {
      this.applied.delete(sessionId);
    }
    this.reached(sessionId, s.lastSeq);
  }

  /** Wakes the `minSeq` waiters `reached` satisfies. */
  private reached(sessionId: string, reached: number): void {
    const list = this.waiters.get(sessionId);
    if (!list) return;
    const left = list.filter((w) => {
      if (w.seq > reached) return true;
      w.done();
      return false;
    });
    if (left.length) this.waiters.set(sessionId, left);
    else this.waiters.delete(sessionId);
  }

  private waitSeq(sessionId: string, seq: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      const list = this.waiters.get(sessionId) ?? [];
      list.push({ seq, done });
      this.waiters.set(sessionId, list);
    });
  }

  /** The host's socket closed: what waits on it fails now; a writer silent past RECOVER_AFTER_MS is recovered. */
  onHostClosed(): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { error: { code: "computer_unavailable", message: "The computer disconnected. Retry.", status: 503, retryable: true, retryAfterMs: RETRY_COMPUTER_MS } });
    }
    if (!this.deps.setting("hostGoneAt")) this.deps.put("hostGoneAt", String(this.now()));
    if (this.activeCount() > 0) this.deps.waitUntil(this.deps.scheduleRecover(this.now() + RECOVER_AFTER_MS));
  }

  /**
   * The organization's admins (`usr_…`), as last seen on their own API calls (the edge asserts each caller's role;
   * blue has no membership list). A promotion or demotion takes effect on that member's next call.
   */
  private adminsCache: string[] | null = null;

  private admins(): string[] {
    if (!this.adminsCache) {
      try {
        const parsed: unknown = JSON.parse(this.deps.setting("apiAdmins") ?? "[]");
        this.adminsCache = Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
      } catch {
        this.adminsCache = [];
      }
    }
    return this.adminsCache;
  }

  /** Records whether `member` is an admin; on a change, every access list goes to the host again. */
  private noteAdmin(member: string, admin: boolean): void {
    const admins = this.admins();
    if (admins.includes(member) === admin) return;
    this.adminsCache = admin ? [...admins, member].sort() : admins.filter((m) => m !== member);
    this.deps.put("apiAdmins", JSON.stringify(this.adminsCache));
    if (this.v4Host()) this.sendAllAccess();
  }

  /** API sessions: every member attaches. Slack sessions: only their linked owner. Admins may open terminals in both. */
  private sendAccess(row: { sessionId: string; originType: string; ownerUserId: string | null }): void {
    const admins = this.admins();
    const extra = admins.length ? { admins } : {};
    if (row.originType !== "slack") this.deps.send({ t: "access", access: { sessionId: row.sessionId, owner: row.ownerUserId ?? "", members: null, ...extra } });
    else if (row.ownerUserId) this.deps.send({ t: "access", access: { sessionId: row.sessionId, owner: row.ownerUserId, members: [row.ownerUserId], ...extra } });
  }

  /**
   * Every session's access list, one frame each (the v4 contract after `welcome`; the host keeps them in
   * memory only). Rows that make no frame (Slack sessions with no linked owner, most of a busy
   * workspace's threads) are left out by the query, not read and skipped.
   */
  private sendAllAccess(): void {
    const rows = this.deps.sql.exec<{ sessionId: string; originType: string; ownerUserId: string | null }>(
      `SELECT session_id AS sessionId, origin_type AS originType, owner_user_id AS ownerUserId FROM sessions
       WHERE session_id IS NOT NULL AND (origin_type != 'slack' OR owner_user_id IS NOT NULL)`,
    );
    for (const row of rows) this.sendAccess(row);
  }

  /**
   * After the welcome: the epoch of every journal the log is ahead of (before anything else for it),
   * the relay's access lists, and a look at writers lost while the host was away.
   */
  onHello(journals: CalvinJournalReport[] = []): void {
    this.deps.remove("hostGoneAt");
    this.deps.telemetry?.hostBack();
    if (!this.v4Host()) return;
    for (const j of Array.isArray(journals) ? journals : []) {
      if (!j || typeof j.sessionId !== "string" || !Number.isInteger(j.epoch)) continue;
      // A recovery in flight sends `epoch` itself once it commits (the host is connected by then).
      if (this.epochSends.has(j.sessionId)) continue;
      const at = [...this.deps.sql.exec<{ e: number; s: number }>("SELECT log_epoch AS e, last_seq AS s FROM sessions WHERE session_id = ?", j.sessionId)][0];
      if (!at) continue;
      // Behind the log's epoch (0: a file torn before its epoch line), or at it but missing stored events
      // (`lastSeq < epochStartSeq - 1 + tail.length`, i.e. below the log's ack; calvin r2 P1-2): epoch again,
      // the host appends only what it lacks.
      const lastSeq = Number.isInteger(j.lastSeq) ? j.lastSeq : 0;
      if (at.e > j.epoch || (at.e === j.epoch && lastSeq < at.s)) void this.pushEpoch(j.sessionId, "hello");
    }
    this.sendAllAccess();
    if (this.activeCount() > 0) this.deps.waitUntil(this.deps.scheduleRecover(this.now() + RECOVER_AFTER_MS));
  }

  /** A runner's report: subagents keep the computer busy; a runner that stopped mid-turn is looked at later. */
  reported(report: CalvinSessionReport): void {
    const subagents = typeof report.subagents === "number" && report.subagents > 0 ? Math.floor(report.subagents) : 0;
    this.deps.sql.exec(
      `UPDATE sessions SET subagents = ?, api_status = CASE WHEN summary IS NULL AND session_id IS NOT NULL THEN ? ELSE api_status END WHERE runner_key = ?`,
      subagents,
      statusOfRunner(report.status),
      report.key,
    );
    if (report.status === "stopped" || report.status === "error") {
      const row = this.rowByKey(report.key);
      if (row?.activeTurnId) this.deps.waitUntil(this.deps.scheduleRecover(this.now() + RECOVER_AFTER_MS + 1_000));
    }
  }

  private activeCount(): number {
    return (
      [
        ...this.deps.sql.exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sessions WHERE session_id IS NOT NULL AND (active_turn_id IS NOT NULL OR api_status IN ('starting', 'running', 'waiting'))`,
        ),
      ][0]?.n ?? 0
    );
  }

  /**
   * The recovery tick (alarm purpose `recover`). With no host for RECOVER_AFTER_MS, every active
   * session's writer is lost; with a host, a session whose turn is open while its runner reported
   * stopped (or nothing) and the log has heard nothing for RECOVER_AFTER_MS. Each is recovered under
   * the log's epoch + 1, and a connected host is told the new epoch at once.
   */
  async recoverTick(): Promise<void> {
    const now = this.now();
    const host = this.v4Host();
    const goneAt = Number(this.deps.setting("hostGoneAt") ?? 0);
    let rows: ApiRow[];
    let deferred = 0;
    const reason = this.deps.host() ? "runner_stopped" : "host_gone";
    if (!this.deps.host()) {
      if (!goneAt) return;
      if (now - goneAt < RECOVER_AFTER_MS) return void (await this.deps.scheduleRecover(goneAt + RECOVER_AFTER_MS));
      rows = [
        ...this.deps.sql.exec<Record<string, SqlStorageValue>>(
          `${ROW_SELECT} WHERE session_id IS NOT NULL AND (active_turn_id IS NOT NULL OR api_status IN ('starting', 'running', 'waiting'))`,
        ),
      ] as unknown as ApiRow[];
    } else {
      if (!host) return;
      rows = [
        ...this.deps.sql.exec<Record<string, SqlStorageValue>>(
          `${ROW_SELECT} WHERE session_id IS NOT NULL AND active_turn_id IS NOT NULL AND (status IS NULL OR status IN ('stopped', 'error'))`,
        ),
      ] as unknown as ApiRow[];
      const later = rows.filter((r) => Math.max(r.syncedAt ?? 0, r.updatedAt) > now - RECOVER_AFTER_MS);
      rows = rows.filter((r) => !later.includes(r));
      deferred = later.length;
      if (later.length) {
        const next = Math.min(...later.map((r) => Math.max(r.syncedAt ?? 0, r.updatedAt))) + RECOVER_AFTER_MS + 1;
        await this.deps.scheduleRecover(next);
      }
    }
    if (rows.length || deferred) this.deps.telemetry?.recovery("recover_alarm", { reason, data: { sessions: rows.length, deferred } });
    for (const row of rows) {
      try {
        await this.recover(row);
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "computer.session_recover_failed", sessionId: row.sessionId, message: String(error) }));
      }
    }
  }

  /**
   * One session's recovery, registered with the in-flight `epoch` sends so that Slack deliveries and
   * host calls for it wait until the frame has gone (review r2 P1-1), and `onHello` defers to it.
   */
  private recover(row: ApiRow): Promise<void> {
    const sessionId = row.sessionId;
    const prior = this.epochSends.get(sessionId);
    const run = (async () => {
      if (prior) await prior;
      await this.recoverNow(row);
    })();
    // What waiters hold never rejects (recoverTick logs the failure); the slot clears when it settles.
    const held: Promise<void> = run
      .catch(() => undefined)
      .finally(() => {
        if (this.epochSends.get(sessionId) === held) this.epochSends.delete(sessionId);
      });
    this.epochSends.set(sessionId, held);
    return run;
  }

  private async recoverNow(row: ApiRow): Promise<void> {
    const epoch = row.logEpoch + 1;
    const identity = { sessionId: row.sessionId, organizationId: this.deps.organizationId() };
    const began = performance.now();
    const result = await this.log(row.sessionId).recover({ ...identity, epoch, at: new Date(this.now()).toISOString() });
    console.log(JSON.stringify({ level: "info", event: "computer.session_recovered", sessionId: row.sessionId, epoch, ok: result.ok }));
    this.deps.telemetry?.recovery("session_recovered", {
      sessionId: row.sessionId,
      ms: performance.now() - began,
      ok: result.ok,
      ...(result.ok ? {} : { reason: result.reason }),
      data: { epoch: result.ok ? epoch : result.logEpoch, ...(result.ok ? { events: result.stats?.rows ?? 0 } : {}) },
    });
    if (!result.ok) {
      this.applied.delete(row.sessionId);
      this.deps.sql.exec("UPDATE sessions SET log_epoch = ? WHERE session_id = ? AND log_epoch < ?", result.logEpoch, row.sessionId, result.logEpoch);
      // The log is past what this row (so the host) was told: an earlier recover committed and its result was
      // lost (an instance reset mid-RPC). Nothing else would send `epoch` while the link stays up (review r3 P1-1).
      if (result.logEpoch > row.logEpoch) await this.sendTail(row.sessionId, "recover");
      return;
    }
    // The row and the `epoch` frame in one turn: no frame carrying the new epoch can go before it. Whether to
    // send is decided now, from the committed epoch: a host that said hello during the recover RPC saw the
    // old epoch in the row (and `onHello` deferred to this), so it is told here.
    this.applySummary(row.sessionId, result.summary);
    if (this.v4Host()) {
      this.sendEpoch(row.sessionId, result.tail);
      this.deps.telemetry?.recovery("epoch_sent", { sessionId: row.sessionId, reason: "recover", ok: true, data: { epoch: result.tail.epoch, events: result.tail.tail.length, attempt: 0 } });
    }
  }

  // ---------------------------------------------------------------- epochs (recovery-fix.md)

  /** In-flight `epoch` sends by session: frames for that session wait for them. */
  private readonly epochSends = new Map<string, Promise<void>>();
  /** When each session's `epoch` frame last went, for the stale_epoch resend limit. */
  private readonly epochSentAt = new Map<string, number>();

  private sendEpoch(sessionId: string, t: EpochTail): void {
    this.epochSentAt.set(sessionId, this.now());
    if (this.epochSentAt.size > APPLIED_MAX) this.epochSentAt.delete(this.epochSentAt.keys().next().value!);
    this.deps.send({ t: "epoch", sessionId, epoch: t.epoch, startSeq: t.startSeq, lastSeq: t.lastSeq, tail: t.tail });
  }

  /** A batch under an epoch the log left: `epoch` again, at most once per session per STALE_EPOCH_RESEND_MS. */
  private staleEpoch(sessionId: string): void {
    if (this.now() - (this.epochSentAt.get(sessionId) ?? -Infinity) < STALE_EPOCH_RESEND_MS) return;
    console.warn(JSON.stringify({ level: "warn", event: "computer.journal_stale_epoch", sessionId }));
    this.deps.telemetry?.recovery("stale_epoch", { sessionId });
    void this.pushEpoch(sessionId, "stale");
  }

  /** Reads the log's tail and sends `epoch`; frames for the session wait on it (hostCall, slackDelivery). */
  private pushEpoch(sessionId: string, cause: EpochCause): Promise<void> {
    const inFlight = this.epochSends.get(sessionId);
    if (inFlight) return inFlight;
    // Claimed now, so a repeat within the read does not send twice.
    this.epochSentAt.set(sessionId, this.now());
    // A recovery may chain onto this send and take the slot; only this send's own entry is cleared.
    const slot: { run?: Promise<void>; done?: boolean } = {};
    const run = (async () => {
      try {
        await this.sendTail(sessionId, cause);
      } finally {
        slot.done = true;
        if (slot.run && this.epochSends.get(sessionId) === slot.run) this.epochSends.delete(sessionId);
      }
    })();
    slot.run = run;
    if (!slot.done) this.epochSends.set(sessionId, run);
    this.deps.waitUntil(run);
    return run;
  }

  /**
   * Reads the log's tail and sends `epoch`, retrying a failed read (EPOCH_TAIL_RETRY_MS, review r3 P1-1).
   * Never rejects; when every read fails the resend limit is lifted, so the next stale batch asks again.
   */
  private async sendTail(sessionId: string, cause: EpochCause): Promise<void> {
    const began = performance.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const tail = await this.log(sessionId).epochTail({ sessionId, organizationId: this.deps.organizationId() });
        if (!tail || !this.v4Host()) return;
        // The row follows the log's epoch (a host batch may never have told it).
        this.deps.sql.exec("UPDATE sessions SET log_epoch = ? WHERE session_id = ? AND log_epoch < ?", tail.epoch, sessionId, tail.epoch);
        this.applied.delete(sessionId);
        this.sendEpoch(sessionId, tail);
        this.deps.telemetry?.recovery("epoch_sent", {
          sessionId,
          reason: cause,
          ms: performance.now() - began,
          ok: true,
          data: { epoch: tail.epoch, events: tail.tail.length, attempt },
        });
        return;
      } catch (error) {
        const last = attempt >= EPOCH_TAIL_RETRY_MS.length;
        console.error(JSON.stringify({ level: "error", event: "computer.epoch_send_failed", sessionId, attempt, final: last, message: String(error) }));
        this.deps.telemetry?.recovery(last ? "epoch_sent" : "tail_retry", { sessionId, reason: cause, ms: performance.now() - began, ok: false, data: { attempt, final: last } });
        if (last) {
          this.epochSentAt.delete(sessionId);
          return;
        }
        await new Promise((r) => setTimeout(r, EPOCH_TAIL_RETRY_MS[attempt]));
      }
    }
  }

  /**
   * A Slack delivery's API fields (v4 host only): the session's `cs_` id, minted on its first
   * delivery, its owner's member id once they linked the dashboard, and the log's (epoch, lastSeq).
   */
  async slackDelivery(key: string, ownerSlackId: string): Promise<{ sessionId: string; userId?: string; epoch: number; lastSeq: number } | null> {
    if (!this.v4Host()) return null;
    let row = this.rowByKey(key);
    if (!row) return null;
    const moving = row.sessionId ? this.epochSends.get(row.sessionId) : undefined;
    if (moving) {
      // The host hears the new epoch from `epoch` before this delivery carries it.
      await moving;
      row = this.rowByKey(key);
      if (!row) return null;
    }
    const minted = !row.sessionId;
    const linked = !row.ownerUserId ? this.deps.linkOfSlack(ownerSlackId) : undefined;
    if (minted || linked) {
      const member = linked ? await memberId(linked) : row.ownerUserId;
      const person = this.deps.slackPerson(ownerSlackId);
      const name = person.name ?? (person.gitName.endsWith(" via Computer") ? person.gitName.slice(0, -" via Computer".length) : null);
      this.deps.sql.exec(
        `UPDATE sessions SET session_id = COALESCE(session_id, ?), origin_type = 'slack', owner_user_id = COALESCE(owner_user_id, ?),
           owner_name = COALESCE(owner_name, ?), owner_email = COALESCE(owner_email, ?) WHERE runner_key = ?`,
        mintId("cs"),
        member ?? null,
        name,
        person.gitEmail.endsWith("@users.noreply.opencomputer.dev") ? null : person.gitEmail,
        key,
      );
      row = this.rowByKey(key)!;
      this.sendAccess({ sessionId: row.sessionId, originType: "slack", ownerUserId: row.ownerUserId });
    }
    return { sessionId: row.sessionId, ...(row.ownerUserId ? { userId: row.ownerUserId } : {}), epoch: row.logEpoch, lastSeq: row.lastSeq };
  }

  // ---------------------------------------------------------------- idempotency

  private idempotency(member: string, op: string, key: string): { hash: string; body: string } | undefined {
    return [
      ...this.deps.sql.exec<{ hash: string; body: string }>(
        "SELECT hash, body FROM api_idempotency WHERE member = ? AND op = ? AND key = ? AND created_at > ?",
        member,
        op,
        key,
        this.now() - IDEMPOTENCY_TTL_MS,
      ),
    ][0];
  }

  private remember(member: string, op: string, key: string, hash: string, body: unknown): void {
    const now = this.now();
    this.deps.sql.exec(
      "INSERT INTO api_idempotency (member, op, key, hash, body, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET hash = excluded.hash, body = excluded.body, created_at = excluded.created_at",
      member,
      op,
      key,
      hash,
      JSON.stringify(body),
      now,
    );
    if (now - this.sweptAt < IDEMPOTENCY_SWEEP_MS) return;
    this.sweptAt = now;
    this.deps.sql.exec("DELETE FROM api_idempotency WHERE created_at < ?", now - IDEMPOTENCY_TTL_MS);
  }

  private sweptAt = 0;
}

// ---------------------------------------------------------------- helpers

/** statusOfRunner in SQL, behind api_status: the list's status filter matches what compose shows. */
const STATUS_SQL =
  "COALESCE(api_status, CASE status WHEN 'busy' THEN 'running' WHEN 'idle' THEN 'idle' WHEN 'starting' THEN 'starting' ELSE 'suspended' END)";

/** Why an `epoch` frame is sent (sessionlog.recovery `reason`). */
type EpochCause = "recover" | "stale" | "hello";

/** What a host call's telemetry learns on the way (hostCall). */
interface HostCallNote {
  held: boolean;
  heldMs: number;
  replayed: boolean;
  /** The answer wait applied, ms. */
  wait: number;
  /** When the frame went to the host (performance.now()). */
  sentAt?: number;
}

export function statusOfRunner(status: string | null): SessionStatus {
  if (status === "busy") return "running";
  if (status === "idle") return "idle";
  if (status === "starting") return "starting";
  return "suspended";
}

/** 32-bit FNV-1a, hex: a filter set's fingerprint in a cursor (not a security boundary). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

function parseMetadata(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function titleFrom(input: string): string {
  const line = input.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "Untitled";
}

/** No answer from the host in time: retryable. */
function hostLost(): CalvinApiError {
  return { code: "computer_unavailable", message: "The computer did not answer. Retry.", status: 503, retryable: true, retryAfterMs: RETRY_COMPUTER_MS };
}

function notFound(): ApiReply {
  return { status: 404, error: { code: "session_not_found", message: "No such session." } };
}

function conflict(code: string, message: string): ApiReply {
  return { status: 409, error: { code, message } };
}

export function invalid(field: string, message: string, code = "invalid_request"): ApiReply {
  return { status: 400, error: { code, message, field } };
}

/** The writer's error as the HTTP error: its `status` is the response's. */
function hostError(error: CalvinApiError): ApiReply {
  const { status, ...rest } = error;
  return { status: Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, error: rest };
}

/** JSON with sorted keys: the body's hash for idempotency. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function encodeCursor(order: string, at: number, id: string, filter: string): string {
  return btoa(JSON.stringify({ o: order, a: at, i: id, f: filter })).replace(/=+$/, "");
}

function decodeCursor(cursor: string, order: string, filter: string): { at: number; id: string } | null {
  try {
    const c = JSON.parse(atob(cursor)) as { o?: unknown; a?: unknown; i?: unknown; f?: unknown };
    if (c.o !== order || c.f !== filter || typeof c.a !== "number" || typeof c.i !== "string" || !isSessionId(c.i)) return null;
    return { at: c.a, id: c.i };
  } catch {
    return null;
  }
}

/** A session's speed: `fast` (the default, used when absent) or `standard`. */
type Speed = "fast" | "standard";
const isSpeed = (value: unknown): value is Speed => value === "fast" || value === "standard";
const SPEED_MESSAGE = "speed must be fast or standard.";

interface CreateInput {
  id?: string;
  input?: string;
  title?: string;
  model?: string;
  effort?: string;
  mode?: string;
  speed?: Speed;
  metadata?: Record<string, string>;
}

const CREATE_FIELDS = new Set(["id", "input", "title", "model", "effort", "mode", "speed", "metadata"]);

function object(body: unknown): Record<string, unknown> | ApiReply {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) return invalid("", "The body must be a JSON object.");
  return body as Record<string, unknown>;
}

function str(input: Record<string, unknown>, field: string, min: number, max: number): string | undefined | ApiReply {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < min || value.length > max) return invalid(field, `${field} must be a string of ${min} to ${max} characters.`);
  return value;
}

const isReply = (value: unknown): value is ApiReply => typeof value === "object" && value !== null && "status" in value && "error" in value;

function metadataOf(value: unknown, nullable: boolean): Record<string, string | null> | ApiReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("metadata", "metadata must be an object.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) return invalid("metadata", "At most 20 metadata keys.");
  for (const [k, v] of entries) {
    if (k.length < 1 || k.length > 40) return invalid(`metadata.${k}`, "Metadata keys are 1 to 40 characters.");
    if (!(typeof v === "string" && v.length <= 500) && !(nullable && v === null)) return invalid(`metadata.${k}`, "Metadata values are strings of at most 500 characters.");
  }
  return value as Record<string, string | null>;
}

export function validateCreate(body: unknown): { value: CreateInput } | { error: ApiReply } {
  const input = object(body);
  if (isReply(input)) return { error: input };
  for (const field of Object.keys(input)) if (!CREATE_FIELDS.has(field)) return { error: invalid(field, `Unknown field ${field}.`) };
  const value: CreateInput = {};
  if (input.id !== undefined) {
    if (!isSessionId(input.id)) return { error: invalid("id", "id must be cs_ and 16 lowercase Crockford base32 characters.") };
    value.id = input.id;
  }
  for (const [field, min, max] of [["input", 1, 100_000], ["title", 0, 200], ["model", 1, 200], ["effort", 1, 50], ["mode", 1, 50]] as const) {
    const s = str(input, field, min, max);
    if (isReply(s)) return { error: s };
    if (s !== undefined) value[field] = s;
  }
  if (input.speed !== undefined) {
    if (!isSpeed(input.speed)) return { error: invalid("speed", SPEED_MESSAGE) };
    value.speed = input.speed;
  }
  if (input.metadata !== undefined) {
    const m = metadataOf(input.metadata, false);
    if (isReply(m)) return { error: m };
    value.metadata = m as Record<string, string>;
  }
  const settings = checkSettings({
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.effort !== undefined ? { effort: value.effort } : {}),
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
  });
  if (!settings.ok) return { error: { status: 400, error: { code: settings.code, message: settings.message, field: settings.field } } };
  return { value };
}

interface PatchInput {
  title?: string;
  model?: string;
  effort?: string;
  mode?: string;
  speed?: Speed;
  archived?: boolean;
  metadata?: Record<string, string | null>;
}

const PATCH_FIELDS = new Set(["title", "model", "effort", "mode", "speed", "archived", "metadata"]);

export function validatePatch(body: unknown): { value: PatchInput } | { error: ApiReply } {
  const input = object(body);
  if (isReply(input)) return { error: input };
  const fields = Object.keys(input);
  if (!fields.length) return { error: invalid("", "The body names nothing to change.") };
  for (const field of fields) if (!PATCH_FIELDS.has(field)) return { error: invalid(field, `Unknown field ${field}.`) };
  const value: PatchInput = {};
  for (const [field, min, max] of [["title", 1, 200], ["model", 1, 200], ["effort", 1, 50], ["mode", 1, 50]] as const) {
    const s = str(input, field, min, max);
    if (isReply(s)) return { error: s };
    if (s !== undefined) value[field] = s;
  }
  if (input.speed !== undefined) {
    if (!isSpeed(input.speed)) return { error: invalid("speed", SPEED_MESSAGE) };
    value.speed = input.speed;
  }
  if (input.archived !== undefined) {
    if (typeof input.archived !== "boolean") return { error: invalid("archived", "archived must be a boolean.") };
    value.archived = input.archived;
  }
  if (input.metadata !== undefined) {
    const m = metadataOf(input.metadata, true);
    if (isReply(m)) return { error: m };
    value.metadata = m;
  }
  return { value };
}
