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

import type { Access, DeliveredOutcome, DeltaPush, DrainResult, ExportedSession, Inbox, InboxEntry, InboxKind, LiveRpc, SessionLogRpcAdded, StartSpec } from "../actor/contracts.js";
import type { ApiTelemetry } from "./telemetry/api.js";
import { decodeDrivers } from "./access.js";
import type { RoutedApiSession } from "./api-model-route.js";
import type { Principal } from "../actor/principal.js";
import type { AssertedApiKey } from "../edge/auth.js";
import type { Ask, LogSummary, Origin, Person, Session, SessionStatus } from "./api-types.js";
import { DEFAULT_MODE, MODELS, capabilities } from "./capabilities.js";
import { type ComputerEdgeEnv, DEFAULT_WIRE_URL } from "./config.js";
import type { ComputerKeys } from "./keys.js";
import {
  type CalvinApiError,
  type CalvinGatewayToHost,
  type CalvinHarness,
  type CalvinHostToGatewayV4,
  type CalvinJournalReport,
  type CalvinMode,
  type CalvinPerson,
  type CalvinRoleSpec,
  type CalvinSessionReport,
  type CalvinSessionSpec,
  type SessionSecret,
  personForMember,
  sessionKey,
} from "./protocol.js";
import type { AppendResult, EpochTail, SessionLogRpc } from "./session-log-contract.js";
import { isId, isMemberId, mintId } from "./session-ids.js";
import { slackThreadUrl } from "./slack.js";
import { TicketTooLongError, mintTicket, validateTicketRequest } from "./tickets.js";

/** A `start` frame's answer from the host: 15 s, then it is let go. */
export const HOST_CALL_TIMEOUT_MS = 15_000;
/**
 * A drained entry's answer from the host. The host holds a write while the session's epoch moves until
 * its adoption commits, up to ~25 s (review r3 P2-2).
 */
export const HOST_CALL_HELD_TIMEOUT_MS = 40_000;
/** Waits before each retry of a failed `epochTail` read (review r3 P1-1). */
export const EPOCH_TAIL_RETRY_MS = [250, 1_000, 4_000];
/** A writer silent this long with a turn open, its runner gone, is lost. */
export const RECOVER_AFTER_MS = 60_000;
/** A recovery reads the log's epoch and tries at most this many times. */
const RECOVER_READS = 3;
/** An inbox entry's kind as the host's method (spec 36.3). */
const DRAIN_METHODS: Record<InboxKind, string> = {
  turn: "turns.send",
  answer: "asks.answer",
  dismiss: "asks.dismiss",
  interrupt: "sessions.interrupt",
  settings: "sessions.update",
  compact: "sessions.compact",
  suspend: "sessions.suspend",
  resume: "sessions.resume",
  cancel: "turns.cancel",
  stop: "subagents.stop",
};
/** The entries that spend credits: admitted, and routed to the owner's model, before they go. */
const SPENDS = new Set<InboxKind>(["turn", "compact", "resume"]);
/** A `stale_epoch` batch re-sends the session's `epoch` frame at most this often. */
export const STALE_EPOCH_RESEND_MS = 5_000;
/** Sessions whose last applied summary is kept in memory (applySummary's change check). */
const APPLIED_MAX = 1_024;
/** A journal gap closes the host's socket (it reconnects and resends from the last ack) at most this often. */
export const GAP_CLOSE_INTERVAL_MS = 30_000;
const TICKETS_PER_MINUTE = 60;
const RETRY_COMPUTER_MS = 5_000;

/**
 * A request to the Computer's own routes: who asks is the one principal (spec 34.3); the rest
 * are facts of the request (the person's name and email, the key a ticket names).
 */
export interface ApiRequest {
  principal: Principal;
  name: string | null;
  email: string | null;
  client: string | null;
  apiKey?: AssertedApiKey;
  requestId: string;
  userAgent?: string | null;
}

export type ApiOp =
  | { op: "me" }
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
  asideRef: string | null;
  /** The session's role (`RoleSpec` as JSON), from `start`. */
  role: string | null;
}

const ROW_SELECT = `SELECT runner_key AS key, session_id AS sessionId, team_id AS teamId, channel_id AS channelId,
  thread_ts AS threadTs, owner_id AS ownerId, owner_user_id AS ownerUserId, owner_name AS ownerName,
  owner_email AS ownerEmail, title, mode, model, effort, speed, status, origin_type AS originType,
  origin_client AS originClient, last_seq AS lastSeq, log_epoch AS logEpoch, epoch_start_seq AS epochStartSeq,
  summary, api_status AS apiStatus, archived, metadata, created_at AS createdAt, updated_at AS updatedAt,
  last_active_at AS lastActiveAt, synced_at AS syncedAt, subagents, create_hash AS createHash,
  active_turn_id AS activeTurnId, aside_ref AS asideRef, role FROM sessions`;

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
  ["aside_ref", "TEXT"],
  ["role", "TEXT"],
];

export interface SessionsApiDeps {
  sql: SqlStorage;
  env: ComputerEdgeEnv;
  organizationId: () => string;
  /** The connected host, once welcomed; undefined when none is. */
  host: () => object | undefined;
  send: (frame: CalvinGatewayToHost) => boolean;
  /** Resolves the owner's subscription and runner before starting or delivering a turn. */
  routeSession?: (session: CalvinSessionSpec, member?: string) => Promise<RoutedApiSession>;
  closeHost: (code: number, reason: string) => void;
  /** Starts or wakes the computer (no Slack notice). */
  wake: () => Promise<void>;
  computerStatus: () => "ready" | "asleep" | "not_set_up";
  /** Billing's admission (cached like Slack's); throws when billing is unavailable. */
  admitted: () => Promise<boolean>;
  slackPerson: (slackUserId: string) => CalvinPerson;
  linkOfSlack: (slackUserId: string) => string | undefined;
  /** The vault's secrets for a session (secrets-store.ts `forSession`), sent with its `start`. Absent: none. */
  secretsFor?: (row: Pick<ApiRow, "key" | "ownerId" | "ownerUserId">) => Promise<SessionSecret[]>;
  slackTeamId: () => string | undefined;
  keys: ComputerKeys;
  tunnelId: () => string | null;
  waitUntil: (promise: Promise<unknown>) => void;
  scheduleRecover: (at: number) => Promise<void>;
  setting: (key: string) => string | undefined;
  put: (key: string, value: string) => void;
  remove: (key: string) => void;
  now?: () => number;
  /** A session's SessionLog (stubs.ts `logOf`). Absent: the `SESSION_LOG` binding. */
  log?: (sessionId: string) => SessionLogRpc & SessionLogRpcAdded;
  /** The organization's Live (stubs.ts `liveOf`). */
  live: () => LiveRpc;
  /** `start`: the session's harness, the spec's or its owner's (model access's `harnessFor`). */
  chooseHarness?: (row: Pick<ApiRow, "key" | "ownerId" | "ownerUserId">, harness?: CalvinHarness) => void;
  /** The Slack user a member linked, for a Slack thread started by one. */
  slackOfMember?: (member: string) => string | undefined;
  /** Runs `fn` in one storage transaction. Absent: as is. */
  transaction?: <T>(fn: () => T) => T;
  /** Work 084 instrumentation: rollups and rare events (telemetry/api.ts). Absent: nothing is measured. */
  telemetry?: ApiTelemetry;
}

type HostOutcome = { result?: unknown; error?: CalvinApiError };

interface Pending {
  resolve: (outcome: HostOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}


export class ComputerSessionsApi {
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly chains = new Map<string, Promise<void>>();
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
    `);
  }

  // ---------------------------------------------------------------- rows

  row(sessionId: string): ApiRow | undefined {
    return [...this.deps.sql.exec<Record<string, SqlStorageValue>>(`${ROW_SELECT} WHERE session_id = ?`, sessionId)][0] as unknown as ApiRow | undefined;
  }

  rowByKey(key: string): ApiRow | undefined {
    return [...this.deps.sql.exec<Record<string, SqlStorageValue>>(`${ROW_SELECT} WHERE runner_key = ?`, key)][0] as unknown as ApiRow | undefined;
  }

  private v4Host(): boolean {
    return this.deps.host() !== undefined;
  }

  private log(sessionId: string): SessionLogRpc & SessionLogRpcAdded {
    if (this.deps.log) return this.deps.log(sessionId);
    const ns = this.deps.env.SESSION_LOG;
    if (!ns) throw new Error("SESSION_LOG is not bound");
    return ns.getByName(sessionId) as unknown as SessionLogRpc & SessionLogRpcAdded;
  }

  /**
   * The Session object from the row as it was last written. Left for the Work API's context (work/briefs.ts)
   * and the export; the session API reads Org. `fresh` (a writer's result) wins for what the log owns.
   */
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
      aside: row.asideRef !== null && row.asideRef === attentionRef(summary?.asks ?? []),
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
      createdAt: new Date(row.createdAt).toISOString(),
      lastActiveAt: new Date(row.lastActiveAt ?? row.updatedAt).toISOString(),
      syncedAt: row.syncedAt ? new Date(row.syncedAt).toISOString() : null,
      urls: { dashboard: null },
    };
    if (!fresh) return base;
    // The writer's own view is newer than the row; the row owns who, where, archive, aside and labels.
    const asks = fresh.asks ?? base.asks;
    const aside = row.asideRef !== null && row.asideRef === attentionRef(asks);
    return { ...base, ...fresh, id: base.id, owner, origin, archived: base.archived, aside, metadata: base.metadata, urls: base.urls };
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
      ...(row.role ? { role: JSON.parse(row.role) as CalvinRoleSpec } : {}),
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

  // ---------------------------------------------------------------- operations

  async handle(caller: ApiRequest, op: ApiOp): Promise<ApiReply> {
    if (caller.apiKey) this.deps.keys.observe(caller.apiKey, caller.principal.subject);
    switch (op.op) {
      case "me":
        return this.me(caller);
      case "ticket":
        return this.ticket(caller, op.body);
    }
  }

  private me(caller: ApiRequest): ApiReply {
    const key = caller.apiKey;
    return {
      status: 200,
      body: {
        person: { id: caller.principal.subject, name: caller.name ?? "", email: caller.email },
        organization: { id: this.deps.organizationId(), name: null },
        credential: key
          ? { id: key.id, name: key.name, kind: "key", scopes: caller.principal.scopes, expiresAt: key.expiresAt, createdAt: key.createdAt }
          : { id: null, name: null, kind: "login", scopes: caller.principal.scopes, expiresAt: null, createdAt: null },
        computer: { status: this.deps.computerStatus(), region: null, wireUrl: this.deps.env.WIRE_PUBLIC_URL || DEFAULT_WIRE_URL },
        defaults: { model: MODELS[0]!.id, effort: null, mode: DEFAULT_MODE, speed: null },
        capabilities: capabilities(),
      },
    };
  }

  private async ticket(caller: ApiRequest, body: unknown): Promise<ApiReply> {
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
      t.ticket({ surface: caller.principal.via === "opc" ? "cli" : "api", ms: performance.now() - began, result, ...facts });
    }
    return reply;
  }

  private async mint(caller: ApiRequest, body: unknown, facts: { sessions?: number; keyWritten?: boolean }): Promise<ApiReply> {
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
    facts.keyWritten = await this.deps.keys.ensure(key, caller.principal.subject);
    facts.sessions = request.value.sessionIds?.length ?? 0;
    try {
      const org = this.deps.organizationId();
      const ticket = await mintTicket(this.deps.env, { ...request.value, org, member: caller.principal.subject, computer: org, tunnelId, keyId: key.id }, now);
      return { status: 200, body: { ticket } };
    } catch (error) {
      if (error instanceof TicketTooLongError) return invalid("sessionIds", "Too many sessionIds for one ticket.");
      throw error;
    }
  }

  // ---------------------------------------------------------------- tracks and threads (spec 36.3)

  /** One drain per session at a time; `again` is the one follow-up queued behind it. */
  private readonly drains = new Map<string, { run: Promise<DrainResult>; again: Promise<DrainResult> | null }>();
  /** Watch leases (spec 40.5), in memory only: session → until (ms). */
  private readonly watches = new Map<string, number>();

  /**
   * Writes only the runner's row (spec 35.4) and answers; the `start` frame goes at once if the host is up,
   * else at `hello`; then the session is drained.
   */
  async start(spec: StartSpec): Promise<void> {
    const s = spec.session;
    const slack = s.origin.slack;
    const key = slack?.teamId && slack.threadTs ? sessionKey(slack.teamId, slack.channelId, slack.threadTs) : s.id;
    const member = isMemberId(s.owner.id) ? s.owner.id : null;
    const slackUser = s.owner.id.startsWith("slack:") ? s.owner.id.slice(s.owner.id.lastIndexOf(":") + 1) : member && slack ? (this.deps.slackOfMember?.(member) ?? null) : null;
    const now = this.now();
    const role = spec.role ? JSON.stringify(spec.role) : null;
    const metadata = Object.keys(s.metadata ?? {}).length ? JSON.stringify(s.metadata) : null;
    const set = [s.title, spec.settings.mode, spec.settings.model, spec.settings.effort, spec.settings.speed, metadata, role];
    if (this.row(s.id)) {
      this.deps.sql.exec("UPDATE sessions SET title = ?, mode = ?, model = ?, effort = ?, speed = ?, metadata = ?, role = ? WHERE session_id = ?", ...set, s.id);
    } else if (this.rowByKey(key)) {
      // A Slack thread this Computer already ran: the same row, now named by its session.
      this.deps.sql.exec(
        "UPDATE sessions SET title = ?, mode = ?, model = ?, effort = ?, speed = ?, metadata = ?, role = ?, session_id = ?, owner_user_id = COALESCE(?, owner_user_id) WHERE runner_key = ?",
        ...set, s.id, member, key,
      );
    } else {
      this.deps.sql.exec(
        `INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, mode, model, effort, speed, metadata, role,
           created_at, updated_at, session_id, origin_type, origin_client, owner_user_id, owner_name, owner_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        key, slack?.teamId ?? "", slack?.channelId ?? "", slack?.threadTs ?? "", slackUser,
        ...set, now, now, s.id, s.origin.type, s.origin.client, member, s.owner.name || null, s.owner.email,
      );
    }
    const row = this.row(s.id)!;
    this.deps.chooseHarness?.(row, spec.harness === "claude" || spec.harness === "codex" ? spec.harness : undefined);
    this.owe("startOwed", s.id);
    this.deps.waitUntil(this.started(s.id).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.start_failed", sessionId: s.id, message: String(error) }))));
  }

  /** After the row: the drain (its `api` frame carries the spec and starts the runner), or the `start` frame when nothing waits. */
  private async started(sessionId: string): Promise<void> {
    const drained = await this.drainQueued(sessionId);
    if (!this.v4Host()) return;
    const row = this.row(sessionId);
    if (!row) return this.unowe("startOwed", sessionId);
    if (drained.state === "waking") return;
    if (drained.results.length === 0) {
      const inbox = await this.log(sessionId).inbox();
      const routed = await this.deps.routeSession?.(this.spec(row), row.ownerUserId ?? undefined);
      const secrets = this.deps.secretsFor && (await this.deps.secretsFor(row));
      const id = crypto.randomUUID();
      const sent = !routed?.error && this.deps.send({
        t: "start", id, session: routed?.session ?? this.spec(row), epoch: inbox.epoch, lastSeq: inbox.lastSeq,
        ...(secrets ? { secrets } : {}), role: row.role ? (JSON.parse(row.role) as CalvinRoleSpec) : null,
      });
      // A refused route starts nothing: the first turn reports it. A lost host: at the next `hello`.
      if (!sent && !routed?.error) return;
      if (sent) this.pending.set(id, { resolve: () => undefined, timer: setTimeout(() => this.settle(id, {}), HOST_CALL_TIMEOUT_MS) });
    }
    this.unowe("startOwed", sessionId);
  }

  /** The runner is suspended (the host's `sessions.suspend`); the row stays. Nothing when the host is down: no runner runs. */
  async stop(sessionId: string): Promise<void> {
    const row = this.row(sessionId);
    this.unowe("startOwed", sessionId);
    this.watches.delete(sessionId);
    if (!row || !this.v4Host()) return;
    await this.ask({
      t: "api", id: crypto.randomUUID(), sessionId, method: "sessions.suspend", params: { sessionId },
      actor: { id: "platform", name: null, via: "system", client: null },
      member: "platform",
    });
  }

  /**
   * Spec 36.3: the session's waiting inbox entries, in order, each as one `api` frame, each then reported to
   * its SessionLog. `wait: false` answers at once and drains behind the answer.
   */
  drain(sessionId: string, opts: { wait: boolean }): Promise<DrainResult> {
    const run = this.drainQueued(sessionId);
    if (opts.wait) return run;
    this.deps.waitUntil(run.catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.drain_failed", sessionId, message: String(error) }))));
    return Promise.resolve(this.v4Host() || !this.row(sessionId) ? { state: "delivered", results: [] } : { state: "waking" });
  }

  private drainQueued(sessionId: string): Promise<DrainResult> {
    const current = this.drains.get(sessionId);
    if (current) {
      // Entries accepted while it runs are read by one more drain behind it.
      current.again ??= current.run.then(() => undefined, () => undefined).then(() => this.drainQueued(sessionId));
      return current.again;
    }
    const run: Promise<DrainResult> = this.drainNow(sessionId).finally(() => {
      if (this.drains.get(sessionId)?.run === run) this.drains.delete(sessionId);
    });
    this.drains.set(sessionId, { run, again: null });
    return run;
  }

  private async drainNow(sessionId: string): Promise<DrainResult> {
    // No runner row, no drain.
    if (!this.row(sessionId)) return { state: "delivered", results: [] };
    const log = this.log(sessionId);
    let inbox = await log.inbox();
    if (inbox.entries.length === 0) {
      this.unowe("drainOwed", sessionId);
      return { state: "delivered", results: [] };
    }
    if (!this.v4Host()) return this.waking(sessionId);
    const moving = this.epochSends.get(sessionId);
    if (moving) {
      // The host hears the new epoch first; the frames then carry the log as it is after.
      await moving;
      inbox = await log.inbox();
    }
    const results: Extract<DrainResult, { state: "delivered" }>["results"] = [];
    for (const entry of inbox.entries) {
      const row = this.row(sessionId);
      if (!row) break;
      const outcome = await this.deliver(row, entry, inbox);
      // No answer: the entry waits; the host's idempotency (the entry's id) covers a frame that did land.
      if (outcome === "lost") return this.waking(sessionId);
      await log.delivered(entry.id, outcome);
      results.push(
        outcome.ok
          ? { id: entry.id, result: outcome.result }
          : { id: entry.id, error: { code: outcome.code, message: outcome.message, requestId: entry.trace ?? "", retryable: false } },
      );
    }
    this.unowe("drainOwed", sessionId);
    this.unowe("startOwed", sessionId);
    return { state: "delivered", results };
  }

  /** One entry to the host: admission and the model route first (a turn's), then the `api` frame. */
  private async deliver(row: ApiRow, entry: InboxEntry, inbox: Inbox): Promise<DeliveredOutcome | "lost"> {
    let session = this.spec(row);
    let model: RoutedApiSession["model"];
    if (SPENDS.has(entry.kind)) {
      // Billing unavailable throws: the entry waits and the caller's owed drain retries.
      if (!(await this.deps.admitted())) return { ok: false, code: "insufficient_credits", message: "Your organization is out of credits." };
      if (this.deps.routeSession) {
        const routed = await this.deps.routeSession(session, entry.actor.subject);
        if (routed.refused) return { ok: false, code: "model_refused", message: routed.error?.message ?? "The model is not available." };
        if (routed.error?.code === "computer_unavailable") return "lost";
        if (routed.error) return { ok: false, code: routed.error.code, message: routed.error.message };
        session = routed.session;
        model = routed.model;
      }
    }
    const secrets = this.deps.secretsFor && (await this.deps.secretsFor(row));
    const body = entry.body && typeof entry.body === "object" ? (entry.body as Record<string, unknown>) : {};
    const outcome = await this.ask({
      t: "api",
      id: crypto.randomUUID(),
      sessionId: row.sessionId,
      method: DRAIN_METHODS[entry.kind],
      // One turn id end to end (spec 40.2): the entry's id is the turn's in the log. An id the host would not take is left to it.
      params: { ...body, sessionId: row.sessionId, ...(entry.kind === "turn" && isId("tn", entry.id) ? { turnId: entry.id } : {}) },
      actor: { id: entry.actor.subject, name: null, via: entry.actor.via, client: null },
      member: entry.actor.subject,
      idempotencyKey: entry.id,
      ...(entry.trace ? { requestId: entry.trace } : {}),
      session,
      epoch: inbox.epoch,
      lastSeq: inbox.lastSeq,
      ...(secrets ? { secrets } : {}),
      ...(model ? { model } : {}),
    });
    if (!outcome.error) return { ok: true, result: outcome.result };
    if (outcome.error.code === "computer_unavailable") return "lost";
    return { ok: false, code: outcome.error.code, message: outcome.error.message };
  }

  /** A frame the host answers by `id`; `computer_unavailable` when it is gone or silent. */
  private ask(frame: Extract<CalvinGatewayToHost, { t: "api" }>): Promise<HostOutcome> {
    if (!this.deps.send(frame)) return Promise.resolve({ error: hostLost() });
    return new Promise<HostOutcome>((resolve) =>
      this.pending.set(frame.id, { resolve, timer: setTimeout(() => this.settle(frame.id, { error: hostLost() }), HOST_CALL_HELD_TIMEOUT_MS) }),
    );
  }

  /** The machine is not up: the wake starts, the session is drained at `hello`. */
  private waking(sessionId: string): DrainResult {
    this.owe("drainOwed", sessionId);
    this.deps.waitUntil(this.deps.wake().catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.api_wake_failed", message: String(error) }))));
    return { state: "waking" };
  }

  /** Whether a session waits for the machine: a wake that fails then owes `wakeFailed`. */
  owes(): boolean {
    return this.owed("drainOwed").length > 0;
  }

  /** A wake that failed for good: each waiting entry of each waiting session is reported `computer_unavailable`. */
  async wakeFailed(): Promise<void> {
    for (const sessionId of this.owed("drainOwed")) {
      const log = this.log(sessionId);
      for (const entry of (await log.inbox()).entries) {
        await log.delivered(entry.id, { ok: false, code: "computer_unavailable", message: "The computer could not start." });
      }
      this.unowe("drainOwed", sessionId);
    }
  }

  /** At `hello`: the starts and drains that waited for the host, and the watch leases still live. */
  private helloOwed(): void {
    const quiet = (what: string, sessionId: string) => (error: unknown) =>
      console.warn(JSON.stringify({ level: "warn", event: `computer.${what}_failed`, sessionId, message: String(error) }));
    const starts = new Set(this.owed("startOwed"));
    for (const sessionId of starts) this.deps.waitUntil(this.started(sessionId).catch(quiet("start", sessionId)));
    for (const sessionId of this.owed("drainOwed")) if (!starts.has(sessionId)) this.deps.waitUntil(this.drainQueued(sessionId).catch(quiet("drain", sessionId)));
    const now = this.now();
    for (const [sessionId, until] of this.watches) {
      if (until <= now) this.watches.delete(sessionId);
      else this.deps.send({ t: "watch", sessionId, until });
    }
  }

  /** Spec 40.5: relayed while the lease is later than now; never wakes a machine, never counted by parking. */
  watch(sessionId: string, until: number): void {
    if (!this.hasRow(sessionId)) return;
    if (until <= this.now()) return void this.watches.delete(sessionId);
    this.watches.set(sessionId, until);
    if (this.v4Host()) this.deps.send({ t: "watch", sessionId, until });
  }

  /** "Send this block so far." */
  block(sessionId: string, blockId: string): void {
    if (this.hasRow(sessionId) && this.v4Host()) this.deps.send({ t: "block", sessionId, blockId });
  }

  /** Org's access for a session, as the host's `access` frame (kept by the host in memory; read again from Org at `hello`). */
  setAccess(sessionId: string, access: Access, admins: string[]): void {
    if (!this.v4Host()) return;
    const members = access.audience === "org" ? null : [access.audience.replace(/^member:/, "")];
    this.deps.send({ t: "access", access: { sessionId, owner: access.owner, members, ...(admins.length ? { admins } : {}) } });
  }

  private owed(key: "startOwed" | "drainOwed"): string[] {
    try {
      const parsed: unknown = JSON.parse(this.deps.setting(key) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  private owe(key: "startOwed" | "drainOwed", sessionId: string): void {
    const ids = this.owed(key);
    if (!ids.includes(sessionId)) this.deps.put(key, JSON.stringify([...ids, sessionId]));
  }

  private unowe(key: "startOwed" | "drainOwed", sessionId: string): void {
    const ids = this.owed(key);
    if (!ids.includes(sessionId)) return;
    if (ids.length === 1) this.deps.remove(key);
    else this.deps.put(key, JSON.stringify(ids.filter((id) => id !== sessionId)));
  }

  /**
   * Spec 43.1: the session rows Org adopts, oldest first, a page at a time. A row with no `cs_` id (a Slack
   * thread from before the API) gets one in the export's transaction.
   */
  exportSessions(after: string | null, limit: number): { rows: ExportedSession[]; next: string | null; newestCreatedAt: number } {
    const n = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 200, 500));
    let at = 0;
    let key = "";
    if (after) {
      const cut = after.indexOf(":");
      at = Number(after.slice(0, cut)) || 0;
      key = after.slice(cut + 1);
    }
    const run = (): ApiRow[] => {
      const where = "WHERE created_at > ? OR (created_at = ? AND runner_key > ?) ORDER BY created_at, runner_key LIMIT ?";
      const bare = [...this.deps.sql.exec<{ key: string }>(`SELECT runner_key AS key FROM (SELECT runner_key, session_id FROM sessions ${where}) WHERE session_id IS NULL`, at, at, key, n + 1)];
      for (const row of bare) this.deps.sql.exec("UPDATE sessions SET session_id = ? WHERE runner_key = ? AND session_id IS NULL", mintId("cs"), row.key);
      return [...this.deps.sql.exec(`${ROW_SELECT} ${where}`, at, at, key, n + 1)] as unknown as ApiRow[];
    };
    const rows = this.deps.transaction ? this.deps.transaction(run) : run();
    const page = rows.slice(0, n);
    const last = page[page.length - 1];
    const drivers = new Map(
      [...this.deps.sql.exec<{ key: string; drivers: string | null }>("SELECT runner_key AS key, drivers FROM sessions WHERE created_at >= ? AND created_at <= ?", page[0]?.createdAt ?? 0, last?.createdAt ?? 0)].map((r) => [r.key, r.drivers]),
    );
    const dayAgo = this.now() - 86_400_000;
    const newest = [...this.deps.sql.exec<{ at: number | null }>("SELECT MAX(created_at) AS at FROM sessions")][0]?.at ?? 0;
    return {
      rows: page.map((row) => {
        const slack = row.originType === "slack";
        const writers = decodeDrivers(drivers.get(row.key));
        return {
          id: row.sessionId,
          owner: row.ownerUserId ?? (row.ownerId ? `slack:${row.teamId}:${row.ownerId}` : ""),
          origin: this.compose(row).origin,
          title: row.title,
          archived: Boolean(row.archived),
          metadata: parseMetadata(row.metadata),
          asideRef: row.asideRef,
          writers: writers === "*" ? "members" : [...writers],
          slackThreadKey: slack ? row.key : null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastActiveAt: row.lastActiveAt,
          summary: row.summary ? (JSON.parse(row.summary) as LogSummary) : null,
          createHash: row.createHash && row.createdAt > dayAgo ? row.createHash : null,
        };
      }),
      next: rows.length > n && last ? `${last.createdAt}:${last.key}` : null,
      newestCreatedAt: newest,
    };
  }

  // ---------------------------------------------------------------- the host

  private unavailable(): ApiReply {
    this.deps.telemetry?.unavailable();
    this.deps.waitUntil(
      this.deps.wake().catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.api_wake_failed", message: String(error) }))),
    );
    return { status: 503, error: { code: "computer_unavailable", message: "Your computer is starting. Retry.", retryAfterMs: RETRY_COMPUTER_MS } };
  }

  private settle(id: string, outcome: HostOutcome): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
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
        // The host has no spec of the session: owed a start, as one sent while it was away.
        if (this.hasRow(frame.sessionId)) {
          this.owe("startOwed", frame.sessionId);
          this.deps.waitUntil(this.started(frame.sessionId).catch(() => undefined));
        }
        return true;
      case "delta": {
        // Never acknowledged, never stored; dropped for a session with no runner row here (spec 36.3).
        if (Array.isArray(frame.deltas) && this.hasRow(frame.sessionId)) {
          const live = this.deps.live();
          const push = { epoch: frame.epoch, deltas: frame.deltas } as unknown as DeltaPush;
          this.deps.waitUntil(live.publish(`deltas:${frame.sessionId}`, push).then(() => undefined, () => undefined));
        }
        return true;
      }
      case "subagent-progress": {
        // The log fences an older epoch itself.
        if (this.hasRow(frame.sessionId) && Array.isArray(frame.progress)) {
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
      // A frame naming a session with no runner row here is dropped (spec 36.3).
      if (!this.hasRow(sessionId)) {
        console.warn(JSON.stringify({ level: "warn", event: "computer.journal_unknown_session", sessionId }));
        return;
      }
      if (!Number.isInteger(epoch) || !Array.isArray(events)) return;
      // An empty batch is the host asking for the epoch it is missing (a held frame past its deadline,
      // review r3 P1-1): answered as a stale batch is, rate-limited. At the log's epoch it is nothing.
      // The epoch is the SessionLog's (spec 40.10): read there, never kept here.
      if (events.length === 0) {
        const at = await this.log(sessionId).epochTail(this.identity(sessionId));
        return at && epoch < at.epoch ? this.staleEpoch(sessionId) : undefined;
      }
      // A writer of an older epoch is fenced by the log itself (`stale_epoch`, in `appended`).
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
      this.mirror(sessionId, result.summary);
      this.deps.send({ t: "journal-ack", sessionId, epoch, seq: result.ack });
      return;
    }
    if (result.reason === "stale_epoch") {
      // The log moved on (a recovery the host has not adopted): the row follows, and the host is told
      // the epoch with its tail (at most once per session per STALE_EPOCH_RESEND_MS).
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

  /** Whether this Computer holds the session's runner row: a read by the unique index. */
  private hasRow(sessionId: string): boolean {
    return typeof sessionId === "string" && [...this.deps.sql.exec("SELECT 1 FROM sessions WHERE session_id = ?", sessionId)].length > 0;
  }

  /** The runner's facts the log's summary carries (spec 35.4): the open turn and the settings. Nothing else is kept here. */
  private mirror(sessionId: string, s: LogSummary): void {
    const settings = s.settings;
    this.deps.sql.exec(
      `UPDATE sessions SET active_turn_id = ?, updated_at = ?,
         model = COALESCE(?, model), mode = COALESCE(?, mode), speed = COALESCE(?, speed),
         effort = CASE WHEN ? THEN ? ELSE effort END
       WHERE session_id = ?`,
      s.activeTurnId,
      this.now(),
      settings?.model ?? null,
      settings?.mode ?? null,
      settings?.speed ?? null,
      settings ? 1 : 0,
      settings?.effort ?? null,
      sessionId,
    );
  }

  private identity(sessionId: string): { sessionId: string; organizationId: string } {
    return { sessionId, organizationId: this.deps.organizationId() };
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
      if (!this.hasRow(j.sessionId)) continue;
      this.helloEpoch(j.sessionId, j.epoch, Number.isInteger(j.lastSeq) ? j.lastSeq : 0);
    }
    this.helloOwed();
    if (this.activeCount() > 0) this.deps.waitUntil(this.deps.scheduleRecover(this.now() + RECOVER_AFTER_MS));
  }

  /**
   * One journal of a `hello` against the log's epoch and tail (spec 40.10): `epoch` when the log is ahead
   * (0: a file torn before its epoch line), or at the same epoch with stored events the host lacks; the host
   * appends only what it lacks. Frames for the session wait on it.
   */
  private helloEpoch(sessionId: string, epoch: number, lastSeq: number): void {
    const run: Promise<void> = (async (): Promise<void> => {
      await null;
      try {
        const t = await this.log(sessionId).epochTail(this.identity(sessionId));
        if (t && this.v4Host() && (t.epoch > epoch || (t.epoch === epoch && lastSeq < t.lastSeq))) {
          this.sendEpoch(sessionId, t);
          this.deps.telemetry?.recovery("epoch_sent", { sessionId, reason: "hello", ok: true, data: { epoch: t.epoch, events: t.tail.length, attempt: 0 } });
        }
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "computer.epoch_send_failed", sessionId, final: true, message: String(error) }));
      }
    })().finally(() => {
      if (this.epochSends.get(sessionId) === run) this.epochSends.delete(sessionId);
    });
    this.epochSends.set(sessionId, run);
    this.deps.waitUntil(run);
  }

  /** A runner's report: subagents keep the computer busy; a runner that stopped mid-turn is looked at later. */
  reported(report: CalvinSessionReport): void {
    const subagents = typeof report.subagents === "number" && report.subagents > 0 ? Math.floor(report.subagents) : 0;
    this.deps.sql.exec(
      "UPDATE sessions SET subagents = ? WHERE runner_key = ?",
      subagents,
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
          `SELECT COUNT(*) AS n FROM sessions WHERE session_id IS NOT NULL AND active_turn_id IS NOT NULL`,
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
          `${ROW_SELECT} WHERE session_id IS NOT NULL AND active_turn_id IS NOT NULL`,
        ),
      ] as unknown as ApiRow[];
    } else {
      if (!host) return;
      rows = [
        ...this.deps.sql.exec<Record<string, SqlStorageValue>>(
          `${ROW_SELECT} WHERE session_id IS NOT NULL AND active_turn_id IS NOT NULL AND (status IS NULL OR status IN ('stopped', 'error'))`,
        ),
      ] as unknown as ApiRow[];
      const later = rows.filter((r) => r.updatedAt > now - RECOVER_AFTER_MS);
      rows = rows.filter((r) => !later.includes(r));
      deferred = later.length;
      if (later.length) {
        const next = Math.min(...later.map((r) => r.updatedAt)) + RECOVER_AFTER_MS + 1;
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

  /** Spec 40.10: the log's epoch is read (`epochTail`), then `recover` under epoch + 1; read again when refused. */
  private async recoverNow(row: ApiRow): Promise<void> {
    const identity = this.identity(row.sessionId);
    const log = this.log(row.sessionId);
    for (let attempt = 0; attempt < RECOVER_READS; attempt++) {
      const epoch = ((await log.epochTail(identity))?.epoch ?? 0) + 1;
      const began = performance.now();
      const result = await log.recover({ ...identity, epoch, at: new Date(this.now()).toISOString() });
      console.log(JSON.stringify({ level: "info", event: "computer.session_recovered", sessionId: row.sessionId, epoch, ok: result.ok }));
      this.deps.telemetry?.recovery("session_recovered", {
        sessionId: row.sessionId,
        ms: performance.now() - began,
        ok: result.ok,
        ...(result.ok ? {} : { reason: result.reason }),
        data: { epoch: result.ok ? epoch : result.logEpoch, ...(result.ok ? { events: result.stats?.rows ?? 0 } : {}) },
      });
      if (!result.ok) continue;
      // The `epoch` frame in the same turn as the answer: no frame carrying the new epoch can go before it.
      this.mirror(row.sessionId, result.summary);
      if (this.v4Host()) {
        this.sendEpoch(row.sessionId, result.tail);
        this.deps.telemetry?.recovery("epoch_sent", { sessionId: row.sessionId, reason: "recover", ok: true, data: { epoch: result.tail.epoch, events: result.tail.tail.length, attempt: 0 } });
      }
      return;
    }
    // Refused each time: another recovery is moving the log. The host is told where it is.
    await this.sendTail(row.sessionId, "recover");
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
}

/** Why an `epoch` frame is sent (sessionlog.recovery `reason`). */
type EpochCause = "recover" | "stale" | "hello";

export function statusOfRunner(status: string | null): SessionStatus {
  if (status === "busy") return "running";
  if (status === "idle") return "idle";
  if (status === "starting") return "starting";
  return "suspended";
}

function parseMetadata(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** No answer from the host in time: retryable. */
function hostLost(): CalvinApiError {
  return { code: "computer_unavailable", message: "The computer did not answer. Retry.", status: 503, retryable: true, retryAfterMs: RETRY_COMPUTER_MS };
}

/**
 * What needs the person now, as one ref: the oldest open ask's id, or null. Set aside compares
 * against it. Work-tracking step 4 replaces it with `attention.ref`.
 */
export function attentionRef(asks: readonly Ask[]): string | null {
  let oldest: Ask | null = null;
  for (const a of asks) if (a.status === "open" && (!oldest || a.createdAt < oldest.createdAt)) oldest = a;
  return oldest?.id ?? null;
}


export function invalid(field: string, message: string, code = "invalid_request"): ApiReply {
  return { status: 400, error: { code, message, field } };
}

/** The writer's error as the HTTP error: its `status` is the response's. */

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

/** A session's speed: `fast` (the default, used when absent) or `standard`. */
type Speed = "fast" | "standard";
const isSpeed = (value: unknown): value is Speed => value === "fast" || value === "standard";
const SPEED_MESSAGE = "speed must be fast or standard.";

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
