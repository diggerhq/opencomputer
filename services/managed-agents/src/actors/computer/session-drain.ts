// The Computer's session API in the Computer DO (work 084): the session rows, the host's session
// frames, and every HTTP operation that needs the single writer (create, writes) or the rows
// (list, get, /me, tickets). Reads of the log itself (events, turns, asks, subagents) go from the
// route straight to the session's SessionLog (http/api/dispatch.ts) after an `access` check here.
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
//     title/mode/model stay the Slack path's.

import type { Access } from "../../auth/principal.js";
import type { DeliveredOutcome, Inbox, InboxEntry, InboxKind } from "../session-log/contract.js";
import type { DeltaPush, LiveRpc } from "../live/contract.js";
import type { ApiOp, ApiReply, ApiRequest, StartSpec } from "./contract.js";
import type { ApiTelemetry } from "./telemetry/api.js";
import type { RoutedApiSession } from "./held-for-org/model-access/api-session-route.js";
import { logOf } from "../addresses.js";
import { emitter } from "../../telemetry/log-emitter.js";
import type { Sql } from "../../durable/sql.js";
import { owed } from "../../durable/outbox.js";
import type { Ask, LogSummary } from "../../api-objects/objects.js";
import { DEFAULT_MODE, MODELS, capabilities } from "../../api-objects/capabilities.js";
import type { ComputerEdgeEnv } from "./config.js";
import type { ComputerKeys } from "./held-for-org/keys/keys.js";
import type { CalvinApiError, CalvinJournalReport } from "../../host-protocol/api-shapes.js";
import type { CalvinGatewayToHost, CalvinHostToGatewayV4 } from "../../host-protocol/frames.js";
import { type CalvinPerson, personForMember } from "../../host-protocol/person.js";
import type { SessionSecret } from "../../host-protocol/secrets.js";
import { sessionKey } from "../../host-protocol/session-key.js";
import type { CalvinHarness, CalvinMode, CalvinRoleSpec, CalvinSessionReport, CalvinSessionSpec } from "../../host-protocol/session.js";
import type { AppendResult, EpochTail, SessionLogRpc } from "../session-log/contract.js";
import { isId, isMemberId } from "../../ids/session-ids.js";
import { TicketTooLongError, mintTicket, validateTicketRequest } from "./held-for-org/keys/tickets.js";

/** A `start` frame's answer from the host: 15 s, then it is let go. */
export const HOST_CALL_TIMEOUT_MS = 15_000;
/**
 * A drained entry's answer from the host. The host holds a write while the session's epoch moves until
 * its adoption commits, up to ~25 s (review r3 P2-2).
 */
export const HOST_CALL_HELD_TIMEOUT_MS = 40_000;
/** A drain waiting for the host is made due by its `hello`; this is the backstop. */
export const HOST_AWAITED_MS = 10 * 60_000;
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
  metadata: string | null;
  createdAt: number;
  updatedAt: number;
  activeTurnId: string | null;
  /** The session's role (`RoleSpec` as JSON), from `start`. */
  role: string | null;
}

const ROW_SELECT = `SELECT runner_key AS key, session_id AS sessionId, team_id AS teamId, channel_id AS channelId,
  thread_ts AS threadTs, owner_id AS ownerId, owner_user_id AS ownerUserId, owner_name AS ownerName,
  owner_email AS ownerEmail, title, mode, model, effort, speed, status, origin_type AS originType,
  origin_client AS originClient, metadata, created_at AS createdAt, updated_at AS updatedAt,
  active_turn_id AS activeTurnId, role FROM sessions`;

/**
 * Columns work 084 adds to `sessions` (lifecycle.ts's pattern: added when missing). Objects from before
 * tracks and threads also hold `last_seq`, `log_epoch`, `epoch_start_seq`, `summary`, `api_status`, `archived`,
 * `last_active_at`, `synced_at`, `create_hash`, `aside_ref` and `drivers`, read by nothing (spec 35.4).
 */
const COLUMNS: Array<[string, string]> = [
  ["session_id", "TEXT"],
  ["origin_type", "TEXT NOT NULL DEFAULT 'slack'"],
  ["origin_client", "TEXT"],
  ["owner_user_id", "TEXT"],
  ["owner_name", "TEXT"],
  ["owner_email", "TEXT"],
  ["effort", "TEXT"],
  ["speed", "TEXT"],
  ["metadata", "TEXT"],
  ["subagents", "INTEGER NOT NULL DEFAULT 0"],
  ["active_turn_id", "TEXT"],
  ["role", "TEXT"],
];

export interface SessionsApiDeps {
  sql: SqlStorage;
  /** The same storage as the shared actor module's `Sql`: the drains owed here (spec 36.7). */
  store: Sql;
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
  /**
   * Billing's admission for a session's spending entries, asked before the machine is woken or a frame
   * sent (cached); a refusal owes the session's paywall. Throws when billing is unavailable.
   */
  admitted: (row: ApiRow) => Promise<boolean>;
  /** The calls owed here that are not drains (the Computer's own, on the same outbox). */
  sendOwed: (call: string, body: unknown) => Promise<void>;
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
  /** A session's SessionLog (actors/addresses.ts `logOf`). Absent: the `SESSION_LOG` binding. */
  log?: (sessionId: string) => SessionLogRpc;
  /** The organization's Live (actors/addresses.ts `liveOf`). */
  live: () => LiveRpc;
  /** `start`: the session's harness, the spec's or its owner's (model access's `harnessFor`). */
  chooseHarness?: (row: Pick<ApiRow, "key" | "ownerId" | "ownerUserId">, harness?: CalvinHarness) => void;
  /** The Slack user a member linked, for a Slack thread started by one. */
  slackOfMember?: (member: string) => string | undefined;
  /** Runs `fn` in one storage transaction. Absent: as is. */
  transaction?: <T>(fn: () => T) => T;
  /** Work 084 instrumentation: rollups and rare events (telemetry/api.ts). Absent: nothing is measured. */
  telemetry?: ApiTelemetry;
  /** Tests: the catalog events' Tinybird POST goes here instead of `fetch`. */
  telemetryFetch?: typeof fetch;
}

/** `timedOut`: no answer within the frame's timeout (not a host that closed). */
type HostOutcome = { result?: unknown; error?: CalvinApiError; timedOut?: true };

/** A session's owed drain; `start`: its runner's `start` frame is owed too, sent when no entry waits. */
interface OwedDrain {
  sessionId: string;
  start?: true;
  /** This drain, told from one owed after it while it ran (rows written before it have none). */
  token?: string;
}

const drainKey = (sessionId: string) => `drain:${sessionId}`;

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

  private log(sessionId: string): SessionLogRpc {
    if (this.deps.log) return this.deps.log(sessionId);
    return logOf(this.deps.env, sessionId);
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
    // The wire authorizes by a key's record (scopes, member), not by SessionLog's `access`, so an
    // agent's key, bound to its session (spec 34.3), gets no record: it cannot be used on the wire.
    if (caller.apiKey && caller.principal.kind !== "agent") this.deps.keys.observe(caller.apiKey, caller.principal.subject);
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
        computer: { status: this.deps.computerStatus(), region: null, wireUrl: this.deps.env.WIRE_PUBLIC_URL || null },
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
    if (caller.principal.kind === "agent") return { status: 403, error: { code: "forbidden", message: "A session's key cannot mint tickets.", reason: "agent_key" } };
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

  /** Watch leases (spec 40.5), in memory only: session → until (ms). */
  private readonly watches = new Map<string, number>();

  /**
   * Writes only the runner's row (spec 35.4) and answers; the session's drain is owed with its start: the
   * `start` frame goes when nothing waits, at once if the host is up, else at `hello`.
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
    this.owe(s.id, { start: true });
    this.deps.waitUntil(this.runOwed(s.id).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.start_failed", sessionId: s.id, message: String(error) }))));
  }

  /** The runner is suspended (the host's `sessions.suspend`); the row stays. Nothing when the host is down: no runner runs. */
  async stop(sessionId: string): Promise<void> {
    const row = this.row(sessionId);
    // A start still owed is not sent: the drain stays owed for the entries that wait, if any.
    if (owed.has(this.deps.store, drainKey(sessionId))) this.owe(sessionId);
    this.watches.delete(sessionId);
    if (!row || !this.v4Host()) return;
    await this.ask({
      t: "api", id: crypto.randomUUID(), sessionId, method: "sessions.suspend", params: { sessionId },
      actor: { id: "platform", name: null, via: "system", client: null },
      member: "platform",
    });
  }

  /**
   * Spec 36.3, called only by the session's SessionLog (its owed `drain`): the session's drain is owed here,
   * on the shared outbox, and run. Resolves when the waiting entries were delivered, or wait for the host.
   */
  async drain(sessionId: string): Promise<void> {
    this.owe(sessionId);
    await this.runOwed(sessionId);
  }

  /** The calls owed here: one group's (a session's drain, or the Computer's own `group`), or all that are due (the alarm). */
  runOwed(group?: string): Promise<void> {
    return owed.run(this.deps.store, this.sendOwed, Date.now(), this.emit, group);
  }

  private readonly emit = emitter("computer", () => ({ org: this.deps.organizationId() }), {
    env: () => this.deps.env,
    waitUntil: (promise) => this.deps.waitUntil(promise),
    fetch: () => this.deps.telemetryFetch,
  });

  private readonly sendOwed = async (call: string, body: unknown): Promise<void> => {
    if (call !== "drain") return this.deps.sendOwed(call, body);
    const { sessionId, start, token } = body as OwedDrain;
    await this.drainNow(sessionId, start === true, token);
  };

  /** One owed drain per session (its group, its key): a later one replaces it, so it reads the inbox again. */
  private owe(sessionId: string, opts: { start?: boolean; at?: number } = {}): void {
    const body: OwedDrain = { sessionId, ...(opts.start ? { start: true } : {}), token: crypto.randomUUID() };
    owed.add(this.deps.store, { group: sessionId, key: drainKey(sessionId), call: "drain", body, ...(opts.at ? { at: opts.at } : {}) });
  }

  /**
   * The session's waiting inbox entries, in order, each as one `api` frame (the first starts the runner),
   * each then reported to its SessionLog; with none, the `start` frame if one is owed.
   */
  private async drainNow(sessionId: string, start: boolean, token?: string): Promise<void> {
    // No runner row, no drain.
    if (!this.row(sessionId)) return;
    const log = this.log(sessionId);
    let inbox = await this.admit(sessionId, await log.inbox());
    if (!this.v4Host()) return this.awaitHost(sessionId, start, inbox.entries, token);
    if (inbox.entries.length === 0) return start ? this.sendStart(sessionId, inbox, token) : undefined;
    const moving = this.epochSends.get(sessionId);
    if (moving) {
      // The host hears the new epoch first; the frames then carry the log as it is after.
      await moving;
      inbox = await this.admit(sessionId, await log.inbox());
    }
    for (const entry of inbox.entries) {
      const row = this.row(sessionId);
      if (!row) return;
      const outcome = await this.deliver(row, entry, inbox);
      if (outcome === "lost") {
        // No answer: the entry waits and the drain is tried again; the host's idempotency (the entry's id) covers a frame that did land.
        this.wakeHost();
        throw new Error("the host did not answer");
      }
      await log.delivered(entry.id, outcome);
    }
  }

  /**
   * The credit gate, before anything wakes the machine: when entries that spend wait and billing refuses
   * the organization, each is reported `insufficient_credits` here, and the inbox goes on with the rest.
   * Billing unavailable throws: the entries wait and the owed drain is tried again, waking nothing.
   */
  private async admit(sessionId: string, inbox: Inbox): Promise<Inbox> {
    const spending = inbox.entries.filter((entry) => SPENDS.has(entry.kind));
    const row = this.row(sessionId);
    if (spending.length === 0 || !row || (await this.deps.admitted(row))) return inbox;
    const log = this.log(sessionId);
    for (const entry of spending) await log.delivered(entry.id, { ok: false, code: "insufficient_credits", message: "Your organization is out of credits." });
    return { ...inbox, entries: inbox.entries.filter((entry) => !SPENDS.has(entry.kind)) };
  }

  /** The `start` frame: the runner up before its first entry. A refused route starts nothing: the first turn reports it. */
  private async sendStart(sessionId: string, inbox: Inbox, token?: string): Promise<void> {
    const row = this.row(sessionId)!;
    const routed = await this.deps.routeSession?.(this.spec(row), row.ownerUserId ?? undefined);
    if (routed?.error) return;
    const secrets = this.deps.secretsFor && (await this.deps.secretsFor(row));
    const id = crypto.randomUUID();
    const sent = this.deps.send({
      t: "start", id, session: routed?.session ?? this.spec(row), epoch: inbox.epoch, lastSeq: inbox.lastSeq,
      ...(secrets ? { secrets } : {}), role: row.role ? (JSON.parse(row.role) as CalvinRoleSpec) : null,
    });
    if (!sent) return this.awaitHost(sessionId, true, [], token);
    this.pending.set(id, { resolve: () => undefined, timer: setTimeout(() => this.settle(id, {}), HOST_CALL_TIMEOUT_MS) });
  }

  /**
   * No host: the drain stays owed until `hello` makes it due (`helloOwed`), HOST_AWAITED_MS at the latest.
   * Entries that wait wake the machine, each reported `dispatch.parked` (the no-host alert); a start alone does not.
   */
  private awaitHost(sessionId: string, start: boolean, entries: InboxEntry[], token?: string): void {
    // A drain owed while this one ran replaces it and runs next, reading the inbox again: it waits and reports, not this one.
    const current = owed.body(this.deps.store, drainKey(sessionId)) as OwedDrain | undefined;
    if (current && current.token !== token) return;
    this.owe(sessionId, { start, at: Date.now() + HOST_AWAITED_MS });
    if (entries.length === 0) return;
    const key = this.row(sessionId)?.key;
    for (const entry of entries) this.emit("dispatch.parked", { ...dispatchOf(entry), session_key: key, method: DRAIN_METHODS[entry.kind] });
    this.wakeHost();
  }

  private wakeHost(): void {
    this.deps.waitUntil(this.deps.wake().catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.api_wake_failed", message: String(error) }))));
  }

  /** One entry to the host: the model route first (a turn's; admitted already, `admit`), then the `api` frame. */
  private async deliver(row: ApiRow, entry: InboxEntry, inbox: Inbox): Promise<DeliveredOutcome | "lost"> {
    let session = this.spec(row);
    let model: RoutedApiSession["model"];
    if (SPENDS.has(entry.kind)) {
      if (this.deps.routeSession) {
        const routed = await this.deps.routeSession(session, entry.actor.subject);
        if (routed.refused) return { ok: false, code: "model_refused", message: routed.error?.message ?? "The model is not available." };
        if (routed.error?.code === "computer_unavailable") return "lost";
        if (routed.error) {
          const { retryable: _retryable, requestId: _requestId, ...error } = routed.error;
          return { ok: false, ...error };
        }
        session = routed.session;
        model = routed.model;
      }
    }
    const secrets = this.deps.secretsFor && (await this.deps.secretsFor(row));
    const body = entry.body && typeof entry.body === "object" ? (entry.body as Record<string, unknown>) : {};
    const method = DRAIN_METHODS[entry.kind];
    const dims = { ...dispatchOf(entry), session_key: row.key, method };
    let sentAt: number | undefined;
    const sent = () => {
      sentAt = Date.now();
      this.emit("dispatch.sent", { ...dims, wait_ms: Math.max(0, sentAt - entry.at) });
    };
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
    }, sent);
    if (sentAt !== undefined) {
      const duration_ms = Date.now() - sentAt;
      if (outcome.timedOut) this.emit("dispatch.replied", { ...dims, duration_ms, outcome: "timed_out", error_type: "timeout" }, "warn");
      else if (outcome.error) this.emit("dispatch.replied", { ...dims, duration_ms, outcome: "failed", code: outcome.error.code });
      else this.emit("dispatch.replied", { ...dims, duration_ms, outcome: "completed" });
    }
    if (!outcome.error) return { ok: true, result: outcome.result };
    if (outcome.error.code === "computer_unavailable") return "lost";
    // The host's error whole: its status (409 `turn_not_cancellable`, …) and fields are the response's.
    const { retryable: _retryable, requestId: _requestId, ...error } = outcome.error;
    return { ok: false, ...error };
  }

  /** A frame the host answers by `id`; `computer_unavailable` when it is gone or silent. */
  private ask(frame: Extract<CalvinGatewayToHost, { t: "api" }>, sent?: () => void): Promise<HostOutcome> {
    if (!this.deps.send(frame)) return Promise.resolve({ error: hostLost() });
    sent?.();
    return new Promise<HostOutcome>((resolve) =>
      this.pending.set(frame.id, { resolve, timer: setTimeout(() => this.settle(frame.id, { error: hostLost(), timedOut: true }), HOST_CALL_HELD_TIMEOUT_MS) }),
    );
  }

  /** Whether a session's drain waits for the machine: a wake that fails then owes `wakeFailed`. */
  owes(): boolean {
    return this.drainsOwed().length > 0;
  }

  /** The sessions whose drain is owed (the outbox also holds the Computer's other calls). */
  private drainsOwed(): string[] {
    return owed.groups(this.deps.store).filter((group) => owed.has(this.deps.store, drainKey(group)));
  }

  /** A wake that failed for good: each waiting entry of each waiting session is reported `computer_unavailable`. */
  async wakeFailed(): Promise<void> {
    for (const sessionId of this.drainsOwed()) {
      const log = this.log(sessionId);
      for (const entry of (await log.inbox()).entries) {
        await log.delivered(entry.id, { ok: false, code: "computer_unavailable", message: "The computer could not start." });
      }
      owed.drop(this.deps.store, { group: sessionId });
    }
  }

  /** At `hello`: the drains that waited for the host, and the watch leases still live. */
  private helloOwed(): void {
    owed.due(this.deps.store);
    this.deps.waitUntil(this.runOwed().catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "computer.drain_failed", message: String(error) }))));
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

  /**
   * Org's access for a session, as the host's `access` frame (kept by the host in memory; read again from Org at `hello`):
   * `members` null for the `org` audience, else the people it is shared with (the owner is implicit).
   */
  setAccess(sessionId: string, access: Access, admins: string[]): void {
    if (!this.v4Host()) return;
    const people = access.writers === "members" ? [] : access.writers.filter((by) => by.startsWith("user:") && by !== `user:${access.owner}`).map((by) => by.slice(5));
    const members = access.audience === "org" ? null : people;
    this.deps.send({ t: "access", access: { sessionId, owner: access.owner, members, ...(admins.length ? { admins } : {}) } });
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

  /** A session frame from the host; false when it is not one. */
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
          this.owe(frame.sessionId, { start: true });
          this.deps.waitUntil(this.runOwed(frame.sessionId).catch(() => undefined));
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

function parseMetadata(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** An inbox entry as a dispatch's dimensions (the dispatch alerts): its id, and its trace when it has one. */
function dispatchOf(entry: InboxEntry): { dispatch_id: string; trace_id?: string } {
  return { dispatch_id: entry.id, ...(entry.trace ? { trace_id: entry.trace } : {}) };
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

/** A session's speed: `fast` (the default, used when absent) or `standard`. */
type Speed = "fast" | "standard";
const isSpeed = (value: unknown): value is Speed => value === "fast" || value === "standard";
