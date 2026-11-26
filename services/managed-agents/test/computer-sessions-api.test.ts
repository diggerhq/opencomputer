import { describe, expect, it } from "vitest";

import type { DeliveredOutcome, InboxEntry, InboxKind } from "../src/actor/contracts.js";
import type { ApiEvent, LogSummary } from "../src/computer/api-types.js";
import { matchApiRoute, writeParams } from "../src/computer/api-http.js";
import { ComputerKeys } from "../src/computer/keys.js";
import type { CalvinGatewayToHost, CalvinPerson } from "../src/computer/protocol.js";
import type { AppendResult, EpochTail, RecoverInput, RecoverResult } from "../src/computer/session-log-contract.js";
import {
  type ApiRequest,
  ComputerSessionsApi,
  GAP_CLOSE_INTERVAL_MS,
  RECOVER_AFTER_MS,
} from "../src/computer/sessions-api.js";
import { ApiTelemetry } from "../src/computer/telemetry/api.js";
import { createTelemetry } from "../src/computer/telemetry/emitter.js";
import type { SessionsApiDeps } from "../src/computer/sessions-api.js";
import { sqlStorage } from "./fixtures/computer-sql.js";
import type { Sql } from "../src/durable/sql.js";
import { migrate } from "../src/durable/migrations.js";
import { owed } from "../src/durable/outbox.js";

/**
 * Work 084: the session API in the Computer DO against a fake v4 host and a fake SessionLog.
 * Epoch fencing, minSeq and the journal's order first; then create, writes, visibility, recovery
 * and the Slack path.
 */

const ORG = "org_sessions";
const OWNER = "usr_01jabcdefghjkmnpqrstvwxyz0";
const SID = "cs_7f3a9k2m4q8r1t6v";

const caller = (member = OWNER, { admin = false, ...extra }: Partial<ApiRequest> & { admin?: boolean } = {}): ApiRequest => ({
  principal: {
    org: ORG,
    subject: member,
    kind: "key",
    via: "opc",
    scopes: ["sessions:read", "sessions:write", "asks:answer"],
    audiences: ["org", `member:${member}`],
    admin,
    credential: { id: "key_test", expiresAt: null },
  },
  name: member === OWNER ? "Owner" : "Mo",
  email: null,
  client: "opc/0.1.0",
  requestId: "req_test0001",
  ...extra,
});

function summary(_sessionId: string, lastSeq: number, logEpoch: number, extra: Partial<LogSummary> = {}): LogSummary {
  return {
    lastSeq,
    logEpoch,
    epochStartSeq: 1,
    status: "idle",
    title: null,
    settings: null,
    activeTurnId: null,
    queued: [],
    asks: [],
    subagents: [],
    lastTurn: null,
    lastText: null,
    context: { usedTokens: null, windowTokens: null },
    lastActiveAt: null,
    syncedAt: null,
    ...extra,
  };
}

/** A SessionLog that keeps seqs contiguous per epoch, as session-log.ts does. */
class FakeLog {
  ack = 0;
  epoch = 1;
  appends: Array<{ epoch: number; seqs: number[] }> = [];
  recovered: RecoverInput[] = [];
  delay = 0;
  constructor(readonly sessionId: string) {}
  async append(_identity: unknown, epoch: number, events: ApiEvent[]): Promise<AppendResult> {
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    this.appends.push({ epoch, seqs: events.map((e) => e.seq) });
    if (epoch < this.epoch) return { ok: false, reason: "stale_epoch", logEpoch: this.epoch, ack: this.ack };
    const first = events[0]!.seq;
    if (epoch > this.epoch) {
      this.epoch = epoch;
      this.ack = Math.min(this.ack, first - 1);
    }
    if (first > this.ack + 1) return { ok: false, reason: "gap", logEpoch: this.epoch, ack: this.ack };
    this.ack = Math.max(this.ack, events[events.length - 1]!.seq);
    return { ok: true, ack: this.ack, summary: summary(this.sessionId, this.ack, this.epoch, { title: "From the log" }) };
  }
  epochStartSeq = 1;
  tailReads = 0;
  /** Holds `recover` until it resolves (a cross-DO RPC in flight). */
  gate: Promise<void> | null = null;
  async recover(input: RecoverInput): Promise<RecoverResult> {
    this.recovered.push(input);
    if (this.gate) await this.gate;
    if (input.epoch <= this.epoch) return { ok: false, reason: "stale_epoch", logEpoch: this.epoch, ack: this.ack };
    this.epoch = input.epoch;
    this.epochStartSeq = this.ack + 1;
    this.ack += 2;
    return {
      ok: true,
      ack: this.ack,
      summary: summary(this.sessionId, this.ack, this.epoch, { status: "suspended", epochStartSeq: this.epochStartSeq }),
      tail: this.tail(),
    };
  }
  async epochTail(): Promise<EpochTail | null> {
    this.tailReads++;
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    return this.tail();
  }
  private tail(): EpochTail {
    const tail: ApiEvent[] = [];
    for (let seq = this.epochStartSeq; seq <= this.ack; seq++) tail.push(event(seq, this.sessionId));
    return { epoch: this.epoch, startSeq: this.epochStartSeq, lastSeq: this.ack, tail };
  }
  turns = new Map<string, unknown>();
  async turn(turnId: string) {
    const turn = this.turns.get(turnId);
    return turn ? { ok: true as const, turn, lastSeq: this.ack } : { ok: false as const, error: "turn_not_found" as const };
  }
  async progress() {}
  entries: InboxEntry[] = [];
  outcomes: Array<{ id: string; outcome: DeliveredOutcome }> = [];
  async inbox() {
    return { entries: this.entries, epoch: this.epoch, lastSeq: this.ack };
  }
  async delivered(id: string, outcome: DeliveredOutcome) {
    this.outcomes.push({ id, outcome });
    this.entries = this.entries.filter((e) => e.id !== id);
  }
}

const entry = (id: string, kind: InboxKind, body: unknown = {}): InboxEntry => ({
  id,
  kind,
  body,
  by: `user:${OWNER}`,
  actor: { subject: OWNER, kind: "key", via: "opc", admin: false },
  trace: null,
  at: 0,
});

const event = (seq: number, sessionId = SID): ApiEvent => ({
  id: `ev_${String(seq).padStart(16, "0")}`,
  seq,
  createdAt: new Date(1_800_000_000_000 + seq).toISOString(),
  sessionId,
  turnId: null,
  type: "message.received",
  actor: null,
  data: {},
});

function fixture(options: { protocol?: number | null; status?: "ready" | "asleep" | "not_set_up"; admitted?: boolean | "throws"; ticketKey?: boolean; telemetry?: ApiTelemetry; routeSession?: SessionsApiDeps["routeSession"]; secretsFor?: SessionsApiDeps["secretsFor"] } = {}) {
  const sql = sqlStorage();
  sql.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE alarms (purpose TEXT PRIMARY KEY, at INTEGER);
    CREATE TABLE sessions (
      runner_key TEXT PRIMARY KEY, team_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL,
      owner_id TEXT, title TEXT NOT NULL, mode TEXT, model TEXT, sdk_session_id TEXT, fork_path TEXT, status TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const logs = new Map<string, FakeLog>();
  const logOf = (id: string) => {
    let log = logs.get(id);
    if (!log) logs.set(id, (log = new FakeLog(id)));
    return log;
  };
  const sent: CalvinGatewayToHost[] = [];
  const closed: Array<[number, string]> = [];
  const recovers: number[] = [];
  const pendingWork: Promise<unknown>[] = [];
  let clock = 1_800_000_000_000;
  const state = { protocol: options.protocol === undefined ? 6 : options.protocol, wakes: 0, links: new Map<string, string>() };
  const settings = new Map<string, string>();
  const env = {
    SESSION_LOG: { getByName: (id: string) => logOf(id) },
    ...(options.ticketKey ? { WIRE_TICKET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" } : {}),
  } as never;
  const keys = new ComputerKeys({ sql, kv: undefined, organizationId: () => ORG, tunnelId: () => "tun", revoked: () => {}, waitUntil: () => {} });
  /** The host answers each `api` frame with this (by method). */
  const answers = new Map<string, (frame: Extract<CalvinGatewayToHost, { t: "api" }>) => { result?: unknown; error?: unknown } | null>();
  // The shared actor module's tables on the same storage (the drains owed here).
  const store: Sql = { exec: <T>(query: string, ...params: unknown[]) => sql.exec(query, ...params).toArray() as T[], transaction: (fn) => fn(), arm: () => {} };
  migrate(store, []);
  const api: ComputerSessionsApi = new ComputerSessionsApi({
    sql,
    store,
    env,
    organizationId: () => ORG,
    host: () => (state.protocol === null ? undefined : {}),
    routeSession: options.routeSession,
    live: () => ({ publish: async () => ({ head: "" }) }) as never,
    ...(options.secretsFor ? { secretsFor: options.secretsFor } : {}),
    send: (frame) => {
      if (state.protocol === null) return false;
      sent.push(frame);
      if (frame.t === "api") {
        const answer = answers.get(frame.method)?.(frame);
        if (answer) queueMicrotask(() => void api.onHostFrame({ t: "api-result", id: frame.id, ...answer } as never));
      }
      return true;
    },
    closeHost: (code, reason) => closed.push([code, reason]),
    wake: async () => {
      state.wakes++;
    },
    computerStatus: () => options.status ?? "ready",
    admitted: async () => {
      if (options.admitted === "throws") throw new Error("billing down");
      return options.admitted ?? true;
    },
    slackPerson: (slackUserId): CalvinPerson => ({ slackUserId, name: "Owner", gitName: "Owner via Computer", gitEmail: "owner@example.com" }) as CalvinPerson,
    linkOfSlack: (slackUserId) => state.links.get(slackUserId),
    slackTeamId: () => "T1",
    keys,
    tunnelId: () => "tun",
    waitUntil: (p) => void pendingWork.push(p),
    scheduleRecover: async (at) => void recovers.push(at),
    setting: (key) => settings.get(key),
    put: (key, value) => void settings.set(key, value),
    remove: (key) => void settings.delete(key),
    now: () => clock,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  });
  const slackRow = (key: string, owner = "U1") =>
    sql.exec(
      "INSERT INTO sessions (runner_key, team_id, channel_id, thread_ts, owner_id, title, status, created_at, updated_at) VALUES (?, 'T1', 'C1', '1.2', ?, 'Slack thread', 'idle', ?, ?)",
      key,
      owner,
      clock,
      clock,
    );
  return {
    api,
    sql,
    store,
    sent,
    closed,
    recovers,
    logs,
    logOf,
    answers,
    state,
    settings,
    slackRow,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    pending: () => pendingWork.splice(0),
    frames: <T extends CalvinGatewayToHost["t"]>(t: T) => sent.filter((f): f is Extract<CalvinGatewayToHost, { t: T }> => f.t === t),
  };
}

/** A session started here by Org (a `start`), owned by `member`. */
async function created(f: ReturnType<typeof fixture>, id = SID, member = OWNER) {
  const at = new Date(f.now()).toISOString();
  const settings = { model: null, effort: null, mode: "auto", speed: null };
  await f.api.start({
    session: {
      id, title: "A thread", status: "idle", archived: false,
      owner: { id: member, name: member === OWNER ? "Owner" : "Mo", email: null },
      origin: { type: "api", client: null, slack: null },
      settings, metadata: {}, machine: ORG, role: null, createdAt: at, lastActiveAt: at,
    },
    settings,
    role: null,
  } as never);
}

describe("journal: single writer, no gaps, no duplicates", () => {

  it("appends one session's batches in arrival order, even when the log is slow", async () => {
    const f = fixture();
    await created(f);
    f.logOf(SID).delay = 5;
    await Promise.all([f.api.journal(SID, 1, [event(1)]), f.api.journal(SID, 1, [event(2)]), f.api.journal(SID, 1, [event(3)])]);
    expect(f.logOf(SID).appends.map((a) => a.seqs[0])).toEqual([1, 2, 3]);
    expect(f.frames("journal-ack").map((a) => a.seq)).toEqual([1, 2, 3]);
  });

  it("a gap is never acked: the socket closes (4010) so the host resends from its ack, at most every 30 s", async () => {
    const f = fixture();
    await created(f);
    await f.api.journal(SID, 1, [event(1)]);
    await f.api.journal(SID, 1, [event(3)]);
    await f.api.journal(SID, 1, [event(4)]);
    expect(f.closed).toEqual([[4010, "journal gap"]]);
    expect(f.frames("journal-ack").map((a) => a.seq)).toEqual([1]);
    f.advance(GAP_CLOSE_INTERVAL_MS);
    await f.api.journal(SID, 1, [event(5)]);
    expect(f.closed).toHaveLength(2);
  });

  it("drops a batch for a session it does not know", async () => {
    const f = fixture();
    await f.api.journal("cs_0000000000000000", 1, [event(1, "cs_0000000000000000")]);
    expect(f.logs.size).toBe(0);
  });
});

describe("writes: every one through the inbox and the drain (spec 36.2, 36.3)", () => {
  it("compact, suspend, resume, turn cancel and subagent stop are each their host method, keyed by the entry", async () => {
    const f = fixture();
    await created(f);
    for (const method of ["sessions.compact", "sessions.suspend", "sessions.resume", "turns.cancel", "subagents.stop"]) {
      f.answers.set(method, (frame) => ({ result: { method: frame.method } }));
    }
    f.logOf(SID).entries = [
      entry("ie_0000000000000001", "compact", { instructions: "short" }),
      entry("ie_0000000000000002", "suspend", { ifIdle: true }),
      entry("ie_0000000000000003", "resume"),
      entry("ie_0000000000000004", "cancel", { turnId: "tn_4m8q2x7c1v9b" }),
      entry("ie_0000000000000005", "stop", { subagentId: "sa_000000000001" }),
    ];
    await f.api.drain(SID);
    expect(f.frames("api").map((frame) => [frame.method, frame.idempotencyKey, frame.params])).toEqual([
      ["sessions.compact", "ie_0000000000000001", { instructions: "short", sessionId: SID }],
      ["sessions.suspend", "ie_0000000000000002", { ifIdle: true, sessionId: SID }],
      ["sessions.resume", "ie_0000000000000003", { sessionId: SID }],
      ["turns.cancel", "ie_0000000000000004", { turnId: "tn_4m8q2x7c1v9b", sessionId: SID }],
      ["subagents.stop", "ie_0000000000000005", { subagentId: "sa_000000000001", sessionId: SID }],
    ]);
    expect(f.logOf(SID).outcomes.map((o) => o.outcome)).toEqual([
      { ok: true, result: { method: "sessions.compact" } },
      { ok: true, result: { method: "sessions.suspend" } },
      { ok: true, result: { method: "sessions.resume" } },
      { ok: true, result: { method: "turns.cancel" } },
      { ok: true, result: { method: "subagents.stop" } },
    ]);
  });

  it("a host's error keeps its code, status and fields through the drain and the inbox", async () => {
    const f = fixture();
    await created(f);
    const turn = { id: "tn_4m8q2x7c1v9b", status: "running" };
    f.answers.set("turns.cancel", () => ({ error: { code: "turn_not_cancellable", message: "the turn is running", status: 409, retryable: false, requestId: "rq", turn } }));
    f.logOf(SID).entries = [entry("ie_0000000000000004", "cancel", { turnId: turn.id })];
    await f.api.drain(SID);
    expect(f.logOf(SID).outcomes.map((o) => o.outcome)).toEqual([{ ok: false, code: "turn_not_cancellable", message: "the turn is running", status: 409, turn }]);
  });

  it("only what spends (a turn, compact, resume) needs credits", async () => {
    const f = fixture({ admitted: false });
    await created(f);
    f.answers.set("turns.cancel", () => ({ result: {} }));
    f.logOf(SID).entries = [entry("ie_0000000000000001", "compact"), entry("ie_0000000000000002", "cancel", { turnId: "tn_4m8q2x7c1v9b" }), entry("ie_0000000000000003", "resume")];
    await f.api.drain(SID);
    expect(f.frames("api").map((frame) => frame.method)).toEqual(["turns.cancel"]);
    expect(f.logOf(SID).outcomes.map((o) => (o.outcome.ok ? "ok" : o.outcome.code))).toEqual(["insufficient_credits", "ok", "insufficient_credits"]);
  });

  it("a host that disconnects mid-drain leaves the entry waiting and the drain owed here, the machine woken", async () => {
    const f = fixture();
    await created(f);
    f.logOf(SID).entries = [entry("ie_0000000000000001", "suspend")];
    const pending = f.api.drain(SID);
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.api.onHostClosed();
    await pending;
    expect(f.logOf(SID).entries).toHaveLength(1);
    expect(f.logOf(SID).outcomes).toEqual([]);
    expect(f.api.owes()).toBe(true);
    expect(f.store.exec("SELECT grp, tries FROM _owed")).toEqual([{ grp: SID, tries: 1 }]);
  });

  it("one path, one owner: a drain held for the host replaces none and doubles none; hello delivers it once", async () => {
    const f = fixture();
    await created(f);
    f.answers.set("sessions.suspend", () => ({ result: {} }));
    f.state.protocol = null;
    f.logOf(SID).entries = [entry("ie_0000000000000001", "suspend")];
    await f.api.drain(SID);
    await f.api.drain(SID);
    expect(f.store.exec("SELECT grp FROM _owed")).toEqual([{ grp: SID }]);
    expect(f.settings.get("drainOwed")).toBeUndefined();
    f.state.protocol = 6;
    f.api.onHello([]);
    await Promise.all(f.pending());
    expect(f.frames("api").map((frame) => frame.idempotencyKey)).toEqual(["ie_0000000000000001"]);
    expect(owed.groups(f.store)).toEqual([]);
  });
});

describe("recovery: a lost writer", () => {
  it("host connected, runner stopped mid-turn and the log silent 60 s: recovered, and the host told at once", async () => {
    const f = fixture();
    await created(f);
    await f.api.journal(SID, 1, [event(1)]);
    f.sql.exec("UPDATE sessions SET active_turn_id = 'tn_4m8q2x7c1v9b', status = 'stopped' WHERE session_id = ?", SID);
    await f.api.recoverTick();
    expect(f.logOf(SID).recovered).toHaveLength(0);
    f.advance(RECOVER_AFTER_MS + 1);
    await f.api.recoverTick();
    expect(f.logOf(SID).recovered).toHaveLength(1);
    // The new epoch and its tail (the recovery's events), seqs continuing at ack + 1; no api call.
    const sent = f.frames("epoch");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sessionId: SID, epoch: 2, startSeq: 2, lastSeq: 3 });
    expect(sent[0]!.tail.map((e) => e.seq)).toEqual([2, 3]);
    expect(f.frames("api")).toHaveLength(0);
    // The host truncates at startSeq, appends the tail and writes on at lastSeq + 1 under the new epoch.
    await f.api.journal(SID, 2, [event(4)]);
    expect(f.frames("journal-ack").at(-1)).toEqual({ t: "journal-ack", sessionId: SID, epoch: 2, seq: 4 });
  });

  it("epoch goes before any other frame carrying the new epoch", async () => {
    const f = fixture();
    await created(f);
    await f.api.journal(SID, 1, [event(1)]);
    f.sql.exec("UPDATE sessions SET active_turn_id = 'tn_4m8q2x7c1v9b', status = 'stopped' WHERE session_id = ?", SID);
    f.advance(RECOVER_AFTER_MS + 1);
    f.answers.set("turns.send", () => ({ result: { turn: {}, delivery: "started", duplicate: false, seq: 4 } }));
    await Promise.all([
      f.api.recoverTick(),
      ((f.logOf(SID).entries = [entry("tn_4m8q2x7c1v9b", "turn", { input: "go on" })]), f.api.drain(SID)),
    ]);
    const firstAtTwo = f.sent.findIndex((x) => "epoch" in x && (x as { epoch: number }).epoch === 2);
    expect(f.sent[firstAtTwo]!.t).toBe("epoch");
  });

  it("an empty journal batch under an older epoch asks for epoch (rate-limited); at the row's epoch it is nothing (calvin 424bd40)", async () => {
    const f = fixture();
    await created(f);
    Object.assign(f.logOf(SID), { epoch: 2, ack: 0, epochStartSeq: 1 });
    f.sent.length = 0;
    await f.api.journal(SID, 2, []);
    await Promise.all(f.pending());
    expect(f.frames("epoch")).toHaveLength(0);
    await f.api.journal(SID, 1, []);
    await f.api.journal(SID, 1, []);
    await Promise.all(f.pending());
    expect(f.frames("epoch")).toMatchObject([{ sessionId: SID, epoch: 2 }]);
    expect(f.logOf(SID).appends).toHaveLength(0);
    f.advance(10_000);
    await f.api.journal(SID, 1, []);
    await Promise.all(f.pending());
    expect(f.frames("epoch")).toHaveLength(2);
  });

  it("hello: a journal at the log's epoch but short of its stored events (or torn, epoch 0) hears epoch (calvin r2 P1-2)", async () => {
    const f = fixture();
    await created(f);
    await created(f, "cs_2222222222222222");
    await created(f, "cs_3333333333333333");
    for (const sid of [SID, "cs_2222222222222222", "cs_3333333333333333"]) {
      Object.assign(f.logOf(sid), { epoch: 2, ack: 6, epochStartSeq: 4 });
    }
    f.sent.length = 0;
    f.api.onHello([
      { sessionId: SID, epoch: 2, lastSeq: 5, startSeq: 4 }, // lacks seq 6
      { sessionId: "cs_2222222222222222", epoch: 2, lastSeq: 9, startSeq: 4 }, // ahead (unacked): nothing
      { sessionId: "cs_3333333333333333", epoch: 0, lastSeq: 5 }, // torn before its epoch line
    ]);
    await Promise.all(f.pending());
    expect(f.frames("epoch").map((e) => [e.sessionId, e.epoch, e.startSeq, e.lastSeq])).toEqual([
      [SID, 2, 4, 6],
      ["cs_3333333333333333", 2, 4, 6],
    ]);
  });

  it("a drain waits for an in-flight epoch send and carries the new epoch after it", async () => {
    const f = fixture();
    await created(f);
    f.logOf(SID).epoch = 2;
    f.logOf(SID).delay = 5;
    f.answers.set("turns.send", () => ({ result: { turn: {}, delivery: "started", duplicate: false, seq: 1 } }));
    f.api.onHello([{ sessionId: SID, epoch: 0, lastSeq: 0 }]);
    f.sent.length = 0;
    f.logOf(SID).entries = [entry("tn_4m8q2x7c1v9b", "turn", { input: "hi" })];
    await f.api.drain(SID);
    expect(f.sent.map((x) => x.t).filter((t) => t === "epoch" || t === "api")).toEqual(["epoch", "api"]);
    expect(f.frames("api")[0]).toMatchObject({ epoch: 2 });
  });
});

describe("hello and tickets", () => {

  it("tickets: API keys only, project keys refused, 60 a minute", async () => {
    const key = { id: "key_1", hash: "a".repeat(64), name: "laptop", kind: "user" as const, scopes: ["sessions:read"], expiresAt: null, createdAt: null };
    const f = fixture({ ticketKey: true });
    expect(await f.api.handle(caller(), { op: "ticket", body: {} })).toMatchObject({ status: 403, error: { reason: "api_key_required" } });
    expect(await f.api.handle(caller(OWNER, { apiKey: { ...key, kind: "project" } }), { op: "ticket", body: {} })).toMatchObject({ status: 403, error: { reason: "project_key" } });
    const ok = await f.api.handle(caller(OWNER, { apiKey: key }), { op: "ticket", body: { client: "browser" } });
    expect(ok).toMatchObject({ status: 200, body: { ticket: { url: "wss://wire.opencomputer.dev/v1", expiresInMs: 600_000 } } });
    for (let i = 0; i < 59; i++) await f.api.handle(caller(OWNER, { apiKey: key }), { op: "ticket", body: { client: "browser" } });
    expect(await f.api.handle(caller(OWNER, { apiKey: key }), { op: "ticket", body: { client: "browser" } })).toMatchObject({ status: 429, error: { code: "rate_limited" } });
  });

  it("an agent's key mints no ticket and never reaches the wire", async () => {
    const key = { id: "key_agent", hash: "b".repeat(64), name: "Computer session", kind: "user" as const, scopes: ["sessions:read", "sessions:write"], expiresAt: null, createdAt: null };
    const f = fixture({ ticketKey: true });
    const agent = (): ApiRequest => {
      const c = caller(SID, { apiKey: key });
      return { ...c, principal: { ...c.principal, kind: "agent", via: "agent", audiences: [], session: SID } };
    };
    expect(await f.api.handle(agent(), { op: "ticket", body: {} })).toMatchObject({ status: 403, error: { reason: "agent_key" } });
    await f.api.handle(agent(), { op: "me" });
    // The wire authorizes by a key's record; an agent's key has none, so it cannot be used there directly either.
    expect([...f.sql.exec("SELECT key_id FROM wire_keys")]).toEqual([]);
  });

  it("/me names the wire and the credential", async () => {
    const f = fixture();
    const me = await f.api.handle(caller(), { op: "me" });
    expect(me.body).toMatchObject({ person: { id: OWNER }, credential: { kind: "login" }, computer: { status: "ready", wireUrl: "wss://wire.opencomputer.dev/v1" }, defaults: { model: "claude-opus-5-5" } });
  });
});

describe("api-http", () => {
  it("routes", () => {
    expect(matchApiRoute("POST", `/sessions/${SID}/asks/ak_7c1v9b4m8q2x/answer`)).toEqual({ op: "asks.answer", sessionId: SID, sub: "ak_7c1v9b4m8q2x" });
    expect(matchApiRoute("POST", `/sessions/${SID}/subagents/sa_000000000001/stop`)).toEqual({ op: "subagents.stop", sessionId: SID, sub: "sa_000000000001" });
    expect(matchApiRoute("GET", "/me")).toEqual({ op: "me" });
    expect(matchApiRoute("GET", "/capabilities")).toEqual({ op: "capabilities" });
    expect(matchApiRoute("DELETE", `/sessions/${SID}`)).toBeNull();
  });

  it("an answer's mode: calvin's plan-exit set, only with allow", () => {
    const route = { op: "asks.answer", sessionId: SID, sub: "ak_7c1v9b4m8q2x" };
    expect(writeParams(route, { decision: "allow", mode: "acceptEdits" })).toEqual({ value: { askId: "ak_7c1v9b4m8q2x", answer: { decision: "allow", mode: "acceptEdits" } } });
    expect(writeParams(route, { decision: "allow", mode: "auto" })).toMatchObject({ value: { answer: { mode: "auto" } } });
    for (const body of [
      { decision: "deny", mode: "acceptEdits" },
      { decision: "allow", mode: "plan" },
      { decision: "always", mode: "acceptEdits" },
      { decision: "always", mode: "yolo" },
    ]) {
      expect(writeParams(route, body)).toMatchObject({ code: "invalid_answer", field: "mode" });
    }
  });

  it("refuses unknown write fields", () => {
    expect(writeParams({ op: "turns.send", sessionId: SID }, { input: "x", colour: 1 })).toMatchObject({ field: "colour" });
    expect(writeParams({ op: "turns.send", sessionId: SID }, { input: "x", ifBusy: "now" })).toMatchObject({ field: "ifBusy" });
    expect(writeParams({ op: "sessions.compact", sessionId: SID }, { instructions: "short" })).toEqual({ value: { instructions: "short" } });
  });
});

describe("telemetry hooks (work 084 instrumentation): one event per unit of work", () => {
  function recorded() {
    const events: Array<Record<string, any>> = [];
    const telemetry = new ApiTelemetry({
      emit: (write) => {
        const t = createTelemetry({ service: "gateway", version: "test", region: "test", send: (b) => void events.push(...b.events) });
        write(t);
        expect(t.dropped.invalid ?? 0).toBe(0);
        void t.flush();
      },
      surfaceOf: () => "cli",
    });
    return { telemetry, events, names: () => events.filter((e) => e.event_name !== "telemetry.dropped").map((e) => e.event_name as string) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("a journal batch is one sessionlog.append, never one per event; a gap is one gap_4010", async () => {
    const r = recorded();
    const f = fixture({ telemetry: r.telemetry });
    await created(f);
    await f.api.journal(SID, 1, Array.from({ length: 40 }, (_, i) => event(i + 1)));
    await f.api.journal(SID, 1, [event(42)]);
    await tick();
    // The gap's 4010 is reported as it closes the socket, before its batch's append event.
    expect(r.names()).toEqual(["sessionlog.append", "sessionlog.recovery", "sessionlog.append"]);
    expect(r.events[0]!.data).toMatchObject({ events: 40 });
    expect(r.events[0]!.data).toHaveProperty("do_ack_ms");
    expect(r.events[0]!.data).toHaveProperty("do_pre_ms");
    expect(r.events[1]!.data).toMatchObject({ kind: "gap_4010", epoch: 1 });
    expect(r.events[2]).toMatchObject({ outcome: "failed", error_code: "gap" });
  });

  it("a ticket is one ticket.minted", async () => {
    const r = recorded();
    const f = fixture({ telemetry: r.telemetry, ticketKey: true });
    await created(f);
    await f.api.handle(caller(), { op: "ticket", body: {} });
    await tick();
    expect(r.events.filter((e) => e.event_name === "ticket.minted").map((e) => e.data.result)).toEqual(["api_key_required"]);
  });
});
