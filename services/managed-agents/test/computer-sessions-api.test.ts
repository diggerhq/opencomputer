import { describe, expect, it, vi } from "vitest";

import type { ApiEvent, LogSummary } from "../src/computer/api-types.js";
import { matchApiRoute, writeParams } from "../src/computer/api-http.js";
import { computerApiEnabled, GATED_PROTOCOL } from "../src/computer/api-gate.js";
import { ComputerKeys } from "../src/computer/keys.js";
import type { CalvinGatewayToHost, CalvinPerson } from "../src/computer/protocol.js";
import type { AppendResult, EpochTail, RecoverInput, RecoverResult } from "../src/computer/session-log-contract.js";
import {
  type ApiCaller,
  ComputerSessionsApi,
  EPOCH_TAIL_RETRY_MS,
  GAP_CLOSE_INTERVAL_MS,
  HOST_CALL_HELD_TIMEOUT_MS,
  HOST_CALL_TIMEOUT_MS,
  RECOVER_AFTER_MS,
  STALE_EPOCH_RESEND_MS,
  validateCreate,
  validatePatch,
} from "../src/computer/sessions-api.js";
import { ApiTelemetry } from "../src/computer/telemetry/api.js";
import { createTelemetry } from "../src/computer/telemetry/emitter.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

/**
 * Work 084: the session API in the Computer DO against a fake v4 host and a fake SessionLog.
 * Epoch fencing, minSeq and the journal's order first; then create, writes, visibility, recovery
 * and the Slack path.
 */

const ORG = "org_sessions";
const OWNER = "usr_01jabcdefghjkmnpqrstvwxyz0";
const MO = "usr_01jzyxwvtsrqpnmkjhgfedcba0";
const SID = "cs_7f3a9k2m4q8r1t6v";

const caller = (member = OWNER, extra: Partial<ApiCaller> = {}): ApiCaller => ({
  member,
  userId: `user_${member.slice(4).toUpperCase()}`,
  name: member === OWNER ? "Owner" : "Mo",
  email: null,
  via: "opc",
  client: "opc/0.1.0",
  scopes: ["sessions:read", "sessions:write", "asks:answer"],
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
}

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

function fixture(options: { protocol?: number | null; enabled?: boolean; status?: "ready" | "asleep" | "not_set_up"; admitted?: boolean | "throws"; ticketKey?: boolean; telemetry?: ApiTelemetry } = {}) {
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
  const state = { protocol: options.protocol === undefined ? 4 : options.protocol, wakes: 0, links: new Map<string, string>() };
  const settings = new Map<string, string>();
  const env = {
    SESSION_LOG: { getByName: (id: string) => logOf(id) },
    ...(options.ticketKey ? { WIRE_TICKET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" } : {}),
  } as never;
  const keys = new ComputerKeys({ sql, kv: undefined, organizationId: () => ORG, tunnelId: () => "tun", revoked: () => {}, waitUntil: () => {} });
  /** The host answers each `api` frame with this (by method). */
  const answers = new Map<string, (frame: Extract<CalvinGatewayToHost, { t: "api" }>) => { result?: unknown; error?: unknown } | null>();
  const api: ComputerSessionsApi = new ComputerSessionsApi({
    sql,
    env,
    organizationId: () => ORG,
    host: () => (state.protocol === null ? undefined : { protocol: state.protocol }),
    enabled: () => options.enabled ?? true,
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

/** A session created over the API with no first message (a `start`). */
async function created(f: ReturnType<typeof fixture>, id = SID, member = OWNER) {
  const reply = await f.api.handle(caller(member), { op: "create", body: { id } });
  expect(reply.status).toBe(201);
  return reply;
}

describe("journal: single writer, no gaps, no duplicates", () => {
  it("stores, mirrors and acks a batch; fences an older epoch", async () => {
    const f = fixture();
    await created(f);
    await f.api.journal(SID, 1, [event(1), event(2)]);
    expect(f.frames("journal-ack")).toEqual([{ t: "journal-ack", sessionId: SID, epoch: 1, seq: 2 }]);
    expect(f.api.row(SID)).toMatchObject({ lastSeq: 2, logEpoch: 1, title: "From the log" });
    // A recovery moved the row to epoch 2: a stale writer's batch never reaches the log.
    f.sql.exec("UPDATE sessions SET log_epoch = 2 WHERE session_id = ?", SID);
    await f.api.journal(SID, 1, [event(3)]);
    expect(f.logOf(SID).appends).toHaveLength(1);
    expect(f.frames("journal-ack")).toHaveLength(1);
  });

  it("a batch whose summary changed only lastSeq writes only the per-batch columns", async () => {
    const f = fixture();
    await created(f);
    await f.api.journal(SID, 1, [event(1)]);
    // A column the summary owns, changed behind the cache's back: the narrow update leaves it.
    f.sql.exec("UPDATE sessions SET title = 'poked' WHERE session_id = ?", SID);
    await f.api.journal(SID, 1, [event(2)]);
    expect(f.api.row(SID)).toMatchObject({ lastSeq: 2, title: "poked" });
    // A new epoch is a changed summary: the full update runs again.
    f.sql.exec("UPDATE sessions SET log_epoch = 2 WHERE session_id = ?", SID);
    await f.api.journal(SID, 2, [event(3)]);
    expect(f.api.row(SID)).toMatchObject({ lastSeq: 3, logEpoch: 2, title: "From the log" });
  });

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

  it("a stale epoch from the log raises the row's epoch, so later frames carry it", async () => {
    const f = fixture();
    await created(f);
    f.logOf(SID).epoch = 3;
    await f.api.journal(SID, 1, [event(1)]);
    expect(f.api.row(SID)!.logEpoch).toBe(3);
    expect(f.frames("journal-ack")).toHaveLength(0);
  });

  it("the row never goes backwards in (epoch, seq)", async () => {
    const f = fixture();
    await created(f);
    f.api.applySummary(SID, summary(SID, 10, 2));
    f.api.applySummary(SID, summary(SID, 12, 1));
    f.api.applySummary(SID, summary(SID, 9, 2));
    expect(f.api.row(SID)).toMatchObject({ lastSeq: 10, logEpoch: 2 });
    f.api.applySummary(SID, summary(SID, 3, 3, { epochStartSeq: 3 }));
    expect(f.api.row(SID)).toMatchObject({ lastSeq: 3, logEpoch: 3, epochStartSeq: 3 });
  });

  it("drops a batch for a session it does not know", async () => {
    const f = fixture();
    await f.api.journal("cs_0000000000000000", 1, [event(1, "cs_0000000000000000")]);
    expect(f.logs.size).toBe(0);
  });
});

describe("minSeq", () => {
  it("waits for the journal to reach it, then answers", async () => {
    const f = fixture();
    await created(f);
    const pending = f.api.handle(caller(), { op: "get", sessionId: SID, minSeq: 2 });
    await f.api.journal(SID, 1, [event(1), event(2)]);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect((reply.body as { session: { lastSeq: number } }).session.lastSeq).toBe(2);
  });

  it("answers 503 unavailable with retryAfterMs when it is not reached in 2 s", async () => {
    const f = fixture();
    await created(f);
    const started = Date.now();
    const reply = await f.api.handle(caller(), { op: "get", sessionId: SID, minSeq: 5 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(reply).toMatchObject({ status: 503, error: { code: "unavailable", retryAfterMs: 500 } });
  }, 5_000);
});

describe("POST /sessions", () => {
  it("with input: one api turns.send carrying the session spec, the row's epoch and lastSeq, and a create key", async () => {
    const f = fixture();
    f.answers.set("turns.send", () => ({ result: { turn: { id: "tn_4m8q2x7c1v9b" }, delivery: "started", duplicate: false, seq: 3 } }));
    const reply = await f.api.handle(caller(), { op: "create", body: { id: SID, input: "fix the flaky test\nplease", metadata: { ticket: "ENG-1" } } });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ session: { id: SID, title: "fix the flaky test", owner: { id: OWNER }, origin: { type: "opc", client: "opc/0.1.0" }, metadata: { ticket: "ENG-1" } }, delivery: "started", duplicate: false, seq: 3 });
    const [access] = f.frames("access");
    expect(access).toEqual({ t: "access", access: { sessionId: SID, owner: OWNER, members: null } });
    const [frame] = f.frames("api");
    expect(frame).toMatchObject({ method: "turns.send", sessionId: SID, member: OWNER, idempotencyKey: `create:${SID}`, epoch: 1, lastSeq: 0, session: { kind: "api", sessionId: SID, origin: { type: "opc" } } });
    expect(frame!.session!.owner.userId).toBe(OWNER);
  });

  it("is idempotent by key: the same body replays 200 duplicate, another body is 409", async () => {
    const f = fixture();
    f.answers.set("turns.send", () => ({ result: { turn: { id: "tn_4m8q2x7c1v9b" }, delivery: "started", duplicate: false, seq: 3 } }));
    const body = { id: SID, input: "hi" };
    expect((await f.api.handle(caller(), { op: "create", body, idempotencyKey: "k1" })).status).toBe(201);
    const again = await f.api.handle(caller(), { op: "create", body, idempotencyKey: "k1" });
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, seq: 3, turn: { id: "tn_4m8q2x7c1v9b" } } });
    expect(f.frames("api")).toHaveLength(1);
    // Once the log has the turn, a replay answers it as it is now.
    f.logOf(SID).turns.set("tn_4m8q2x7c1v9b", { id: "tn_4m8q2x7c1v9b", status: "completed" });
    expect(await f.api.handle(caller(), { op: "create", body, idempotencyKey: "k1" })).toMatchObject({ body: { turn: { status: "completed" } } });
    expect(await f.api.handle(caller(), { op: "create", body: { id: SID, input: "other" }, idempotencyKey: "k1" })).toMatchObject({ status: 409, error: { code: "idempotency_conflict" } });
  });

  it("the same id: the same body and member finish the create; anyone else gets 409 id_conflict", async () => {
    const f = fixture();
    f.answers.set("turns.send", () => ({ result: { turn: { id: "tn_4m8q2x7c1v9b" }, delivery: "started", duplicate: f.frames("api").length > 1, seq: 3 } }));
    await f.api.handle(caller(), { op: "create", body: { id: SID, input: "hi" } });
    const repeat = await f.api.handle(caller(), { op: "create", body: { id: SID, input: "hi" } });
    expect(repeat).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(f.frames("api").map((a) => a.idempotencyKey)).toEqual([`create:${SID}`, `create:${SID}`]);
    expect(await f.api.handle(caller(MO), { op: "create", body: { id: SID, input: "hi" } })).toMatchObject({ status: 409, error: { code: "id_conflict" } });
    expect(await f.api.handle(caller(), { op: "create", body: { id: SID, input: "else" } })).toMatchObject({ status: 409, error: { code: "id_conflict" } });
  });

  it("without input: a start frame, 201 at seq 0", async () => {
    const f = fixture();
    const reply = await created(f);
    expect(reply.body).toMatchObject({ turn: null, delivery: null, seq: 0, session: { title: "Untitled", status: "starting" } });
    expect(f.frames("start")[0]).toMatchObject({ epoch: 1, lastSeq: 0, session: { kind: "api", sessionId: SID } });
  });

  it("a host's wake is answered with a start frame; an unknown session's with nothing", async () => {
    const f = fixture();
    await created(f);
    expect(await f.api.onHostFrame({ t: "wake", sessionId: SID })).toBe(true);
    await Promise.all(f.pending());
    expect(f.frames("start")).toHaveLength(2);
    expect(f.frames("start")[1]).toMatchObject({ epoch: 1, session: { kind: "api", sessionId: SID } });
    await f.api.onHostFrame({ t: "wake", sessionId: "cs_0000000000000000" });
    await Promise.all(f.pending());
    expect(f.frames("start")).toHaveLength(2);
  });

  it("a wake waits for an in-flight epoch send: epoch goes first, and start carries the new epoch", async () => {
    const f = fixture();
    await created(f);
    f.logOf(SID).epoch = 2;
    f.logOf(SID).delay = 5;
    f.api.onHello([{ sessionId: SID, epoch: 0, lastSeq: 0 }]);
    f.sql.exec("UPDATE sessions SET log_epoch = 2 WHERE session_id = ?", SID);
    f.sent.length = 0;
    await f.api.onHostFrame({ t: "wake", sessionId: SID });
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all(f.pending());
    expect(f.sent.map((x) => x.t).filter((t) => t === "epoch" || t === "start")).toEqual(["epoch", "start"]);
    expect(f.frames("start")[0]).toMatchObject({ epoch: 2 });
  });

  it("refusals: no computer 409, no credits 402, billing down 503, no v4 host 503 with a wake", async () => {
    expect(await fixture({ status: "not_set_up" }).api.handle(caller(), { op: "create", body: { input: "hi" } })).toMatchObject({ status: 409, error: { code: "computer_not_set_up" } });
    expect(await fixture({ admitted: false }).api.handle(caller(), { op: "create", body: { input: "hi" } })).toMatchObject({ status: 402, error: { code: "insufficient_credits" } });
    expect(await fixture({ admitted: "throws" }).api.handle(caller(), { op: "create", body: { input: "hi" } })).toMatchObject({ status: 503, error: { code: "unavailable" } });
    const old = fixture({ protocol: 3 });
    expect(await old.api.handle(caller(), { op: "create", body: { input: "hi" } })).toMatchObject({ status: 503, error: { code: "computer_unavailable", retryAfterMs: 5_000 } });
    expect(old.state.wakes).toBe(1);
    expect(old.api.row(SID)).toBeUndefined();
  });

  it("validates the body", () => {
    expect(validateCreate({ id: "nope" })).toMatchObject({ error: { status: 400, error: { field: "id" } } });
    expect(validateCreate({ colour: 1 })).toMatchObject({ error: { error: { code: "invalid_request", field: "colour" } } });
    expect(validateCreate({ model: "gpt-0" })).toMatchObject({ error: { error: { code: "unsupported_model", field: "model" } } });
    expect(validateCreate({ mode: "yolo" })).toMatchObject({ error: { error: { code: "unsupported_mode" } } });
    expect(validateCreate({ metadata: { k: "x".repeat(501) } })).toMatchObject({ error: { error: { field: "metadata.k" } } });
    expect(validateCreate({ input: "hi", title: "t" })).toEqual({ value: { input: "hi", title: "t" } });
    expect(validateCreate({ speed: "standard" })).toEqual({ value: { speed: "standard" } });
    expect(validateCreate({ speed: "slow" })).toMatchObject({ error: { status: 400, error: { code: "invalid_request", field: "speed" } } });
    expect(validatePatch({ speed: "fast" })).toEqual({ value: { speed: "fast" } });
    expect(validatePatch({ speed: null })).toMatchObject({ error: { status: 400, error: { code: "invalid_request", field: "speed" } } });
  });

  it("speed: created with the session, in its settings and the spec; absent is null and not sent", async () => {
    const f = fixture();
    const plain = await created(f);
    expect(plain.body).toMatchObject({ session: { settings: { speed: null } } });
    expect(f.frames("start")[0]!.session).not.toHaveProperty("speed");
    const id = "cs_0000000000000011";
    const reply = await f.api.handle(caller(), { op: "create", body: { id, speed: "standard" } });
    expect(reply).toMatchObject({ status: 201, body: { session: { settings: { speed: "standard" } } } });
    expect(f.api.row(id)!.speed).toBe("standard");
    expect(f.frames("start").at(-1)).toMatchObject({ session: { sessionId: id, speed: "standard" } });
  });
});

describe("writes", () => {
  it("send: 202, the session overlaid with the row; the writer's error keeps its status", async () => {
    const f = fixture();
    await created(f);
    f.answers.set("turns.send", () => ({ result: { turn: { id: "tn_4m8q2x7c1v9b" }, delivery: "queued", duplicate: false, seq: 4 } }));
    expect(await f.api.handle(caller(MO), { op: "call", sessionId: SID, method: "turns.send", params: { input: "x" } })).toMatchObject({ status: 202, body: { delivery: "queued" } });
    expect(f.frames("api").at(-1)).toMatchObject({ member: MO, actor: { id: MO, via: "opc" }, params: { sessionId: SID, input: "x" } });
    f.answers.set("turns.send", () => ({ error: { code: "queue_full", message: "full", status: 409, retryable: true, retryAfterMs: 1000 } }));
    expect(await f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "x" } })).toEqual({
      status: 409,
      error: { code: "queue_full", message: "full", retryable: true, retryAfterMs: 1000 },
    });
  });

  it("stop and interrupt: 202 when they acted, 200 when there was nothing to do", async () => {
    const f = fixture();
    await created(f);
    await f.api.journal(SID, 1, [event(1), event(2)]);
    f.answers.set("subagents.stop", () => ({ result: { subagent: { id: "sa_000000000001" }, seq: 3 } }));
    expect((await f.api.handle(caller(), { op: "call", sessionId: SID, method: "subagents.stop", params: { subagentId: "sa_000000000001" } })).status).toBe(202);
    f.answers.set("subagents.stop", () => ({ result: { subagent: { id: "sa_000000000001" }, seq: 2 } }));
    expect((await f.api.handle(caller(), { op: "call", sessionId: SID, method: "subagents.stop", params: { subagentId: "sa_000000000001" } })).status).toBe(200);
  });

  it("a host that disconnects fails the waiting call with 503 at once; a lost row is 404", async () => {
    const f = fixture();
    await created(f);
    const pending = f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "x" } });
    await Promise.resolve();
    await Promise.resolve();
    f.api.onHostClosed();
    expect(await pending).toMatchObject({ status: 503, error: { code: "computer_unavailable" } });
    expect(await f.api.handle(caller(), { op: "call", sessionId: "cs_0000000000000000", method: "turns.send", params: { input: "x" } })).toMatchObject({ status: 404, error: { code: "session_not_found" } });
  });

  it("PATCH: archive and metadata are the row's (no host needed); settings need the host", async () => {
    const f = fixture();
    await created(f);
    f.state.protocol = null;
    expect(await f.api.handle(caller(), { op: "patch", sessionId: SID, body: { archived: true, metadata: { a: "1" } } })).toMatchObject({ status: 200, body: { session: { archived: true, metadata: { a: "1" } }, seq: 0 } });
    expect(await f.api.handle(caller(), { op: "patch", sessionId: SID, body: { metadata: { a: null, b: "2" } } })).toMatchObject({ body: { session: { metadata: { b: "2" } } } });
    expect(await f.api.handle(caller(), { op: "patch", sessionId: SID, body: { title: "New" } })).toMatchObject({ status: 503, error: { code: "computer_unavailable" } });
    expect(await f.api.handle(caller(), { op: "patch", sessionId: SID, body: {} })).toMatchObject({ status: 400 });
    f.state.protocol = 4;
    f.answers.set("sessions.update", () => ({ result: { session: { title: "New" }, seq: 1 } }));
    expect(await f.api.handle(caller(), { op: "patch", sessionId: SID, body: { title: "New" } })).toMatchObject({ status: 200, body: { session: { title: "New", archived: true }, seq: 1 } });
    expect(f.api.row(SID)!.title).toBe("New");
  });

  it("PATCH speed: forwarded to the writer and kept on the row", async () => {
    const f = fixture();
    await created(f);
    f.answers.set("sessions.update", () => ({ result: { seq: 1 } }));
    const reply = await f.api.handle(caller(), { op: "patch", sessionId: SID, body: { speed: "standard" } });
    expect(reply).toMatchObject({ status: 200, body: { session: { settings: { speed: "standard" } } } });
    expect(f.frames("api").at(-1)).toMatchObject({ method: "sessions.update", params: { sessionId: SID, speed: "standard" } });
    expect(f.api.row(SID)!.speed).toBe("standard");
    await f.api.handle(caller(), { op: "patch", sessionId: SID, body: { title: "Other" } });
    expect(f.frames("api").at(-1)).toMatchObject({ params: { title: "Other" }, session: { speed: "standard" } });
    expect(f.frames("api").at(-1)!.params).not.toHaveProperty("speed");
  });
});

describe("visibility and lists", () => {
  it("API sessions are visible to every member; a Slack session only to its linked owner", async () => {
    const f = fixture();
    await created(f);
    f.slackRow("T1:C1:1.2");
    f.state.links.set("U1", "user_01JABCDEFGHJKMNPQRSTVWXYZ0");
    const delivery = await f.api.slackDelivery("T1:C1:1.2", "U1");
    expect(delivery).toMatchObject({ epoch: 1, lastSeq: 0, userId: OWNER });
    const slackId = delivery!.sessionId;
    expect(f.frames("access").at(-1)).toEqual({ t: "access", access: { sessionId: slackId, owner: OWNER, members: [OWNER] } });
    expect((await f.api.handle(caller(MO), { op: "get", sessionId: SID })).status).toBe(200);
    expect((await f.api.handle(caller(MO), { op: "get", sessionId: slackId })).status).toBe(404);
    const viaSlack = await f.api.handle(caller(), { op: "get", sessionId: slackId });
    expect(viaSlack.body).toMatchObject({ session: { origin: { type: "slack", slack: { channelId: "C1" } }, title: "Slack thread", status: "idle" } });
    // The next delivery reuses the id and sends no new access frame.
    const accesses = f.frames("access").length;
    expect((await f.api.slackDelivery("T1:C1:1.2", "U1"))!.sessionId).toBe(slackId);
    expect(f.frames("access")).toHaveLength(accesses);
    const mine = await f.api.handle(caller(), { op: "list", query: [] });
    expect((mine.body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id).sort()).toEqual([SID, slackId].sort());
    const mo = await f.api.handle(caller(MO), { op: "list", query: [["owner", "anyone"]] });
    expect((mo.body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual([SID]);
    // The status filter matches the status shown: the Slack row's runner says idle.
    const idle = await f.api.handle(caller(), { op: "list", query: [["status", "idle"]] });
    expect((idle.body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual([slackId]);
  });

  it("a v3 host's Slack deliveries are unchanged (no id, no frames)", async () => {
    const f = fixture({ protocol: 3 });
    f.slackRow("T1:C1:1.2");
    expect(await f.api.slackDelivery("T1:C1:1.2", "U1")).toBeNull();
    expect(f.sent).toHaveLength(0);
  });

  it("pages with a keyset cursor and filters by metadata and text", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) {
      f.advance(1000);
      await f.api.handle(caller(), { op: "create", body: { id: `cs_00000000000000${i}${i}`, title: `task ${i} 100%`, metadata: { n: String(i % 2) } } });
    }
    const first = await f.api.handle(caller(), { op: "list", query: [["limit", "2"], ["order", "created"]] });
    const page = first.body as { sessions: Array<{ id: string }>; nextCursor: string };
    expect(page.sessions.map((s) => s.id)).toEqual(["cs_0000000000000044", "cs_0000000000000033"]);
    const second = await f.api.handle(caller(), { op: "list", query: [["limit", "2"], ["order", "created"], ["cursor", page.nextCursor]] });
    expect((second.body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual(["cs_0000000000000022", "cs_0000000000000011"]);
    const odd = await f.api.handle(caller(), { op: "list", query: [["metadata[n]", "1"]] });
    expect((odd.body as { sessions: unknown[] }).sessions).toHaveLength(2);
    const q = await f.api.handle(caller(), { op: "list", query: [["q", "3 100%"]] });
    expect((q.body as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual(["cs_0000000000000033"]);
    expect(await f.api.handle(caller(), { op: "list", query: [["cursor", page.nextCursor]] })).toMatchObject({ status: 400, error: { code: "invalid_cursor" } });
    // A cursor is bound to its filters: the same order with another filter set is refused.
    const other = [["limit", "2"], ["order", "created"], ["metadata[n]", "1"], ["cursor", page.nextCursor]] as Array<[string, string]>;
    expect(await f.api.handle(caller(), { op: "list", query: other })).toMatchObject({ status: 400, error: { code: "invalid_cursor" } });
    expect(await f.api.handle(caller(), { op: "list", query: [["bogus", "1"]] })).toMatchObject({ status: 400, error: { field: "bogus" } });
  });
});

describe("recovery: a lost writer", () => {
  it("host gone 60 s with a turn open: the log is recovered under epoch + 1; the next host hears the new epoch", async () => {
    const f = fixture();
    await created(f);
    await f.api.journal(SID, 1, [event(1), event(2)]);
    f.sql.exec("UPDATE sessions SET active_turn_id = 'tn_4m8q2x7c1v9b', api_status = 'running' WHERE session_id = ?", SID);
    f.state.protocol = null;
    f.api.onHostClosed();
    expect(f.recovers).toEqual([f.now() + RECOVER_AFTER_MS]);
    await f.api.recoverTick();
    expect(f.logOf(SID).recovered).toHaveLength(0);
    f.advance(RECOVER_AFTER_MS);
    await f.api.recoverTick();
    expect(f.logOf(SID).recovered).toMatchObject([{ sessionId: SID, organizationId: ORG, epoch: 2 }]);
    expect(f.api.row(SID)).toMatchObject({ logEpoch: 2, lastSeq: 4, apiStatus: "suspended" });
    // The old writer's late batch is fenced; the new one continues at lastSeq + 1.
    f.state.protocol = 4;
    await f.api.journal(SID, 1, [event(3)]);
    expect(f.frames("journal-ack")).toHaveLength(1);
    f.answers.set("turns.send", () => ({ result: { turn: {}, delivery: "started", duplicate: false, seq: 6 } }));
    await f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "go on" } });
    expect(f.frames("api").at(-1)).toMatchObject({ epoch: 2, lastSeq: 4 });
  });

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
      f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "go on" } }),
    ]);
    const firstAtTwo = f.sent.findIndex((x) => "epoch" in x && (x as { epoch: number }).epoch === 2);
    expect(f.sent[firstAtTwo]!.t).toBe("epoch");
  });

  it("a hello during the recover RPC still gets epoch, and a Slack delivery waits for it (review r2 P1-1)", async () => {
    const f = fixture();
    f.slackRow("T1:C1:1.2");
    const slackId = (await f.api.slackDelivery("T1:C1:1.2", "U1"))!.sessionId;
    await f.api.journal(slackId, 1, [event(1, slackId), event(2, slackId)]);
    f.sql.exec("UPDATE sessions SET active_turn_id = 'tn_4m8q2x7c1v9b', api_status = 'running' WHERE session_id = ?", slackId);
    f.state.protocol = null;
    f.api.onHostClosed();
    f.advance(RECOVER_AFTER_MS);
    let release!: () => void;
    f.logOf(slackId).gate = new Promise<void>((r) => (release = r));
    const tick = f.api.recoverTick();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.logOf(slackId).recovered).toHaveLength(1);
    // The host comes back while the recover RPC is in flight; its journal is at the old epoch, as is the row.
    f.state.protocol = 4;
    f.sent.length = 0;
    f.api.onHello([{ sessionId: slackId, epoch: 1, lastSeq: 2 }]);
    const delivery = f.api.slackDelivery("T1:C1:1.2", "U1");
    await new Promise((r) => setTimeout(r, 0));
    expect(f.frames("epoch")).toHaveLength(0);
    release();
    await tick;
    const d = await delivery;
    await Promise.all(f.pending());
    expect(f.frames("epoch")).toMatchObject([{ sessionId: slackId, epoch: 2, startSeq: 3, lastSeq: 4 }]);
    // The delivery was held until the frame went, and carries the committed epoch.
    expect(d).toMatchObject({ sessionId: slackId, epoch: 2, lastSeq: 4 });
    expect(f.logOf(slackId).tailReads).toBe(0);
  });

  it("a recover answered stale_epoch with the log ahead of the row sends epoch (review r3 P1-1)", async () => {
    const f = fixture();
    await created(f);
    await f.api.journal(SID, 1, [event(1), event(2)]);
    // An earlier recover committed epoch 2 in the log; its result never reached the row (an instance reset mid-RPC).
    Object.assign(f.logOf(SID), { epoch: 2, ack: 4, epochStartSeq: 3 });
    f.sql.exec("UPDATE sessions SET active_turn_id = 'tn_4m8q2x7c1v9b', status = 'stopped' WHERE session_id = ?", SID);
    f.advance(RECOVER_AFTER_MS + 1);
    f.sent.length = 0;
    await f.api.recoverTick();
    await Promise.all(f.pending());
    expect(f.logOf(SID).recovered).toHaveLength(1);
    expect(f.api.row(SID)).toMatchObject({ logEpoch: 2 });
    expect(f.frames("epoch")).toMatchObject([{ sessionId: SID, epoch: 2, startSeq: 3, lastSeq: 4 }]);
  });

  it("a failed epochTail read is retried; when every read fails the stale resend is open again (review r3 P1-1)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fixture();
      await created(f);
      Object.assign(f.logOf(SID), { epoch: 2, ack: 2, epochStartSeq: 1 });
      const log = f.logOf(SID);
      const real = log.epochTail.bind(log);
      let failures = 1;
      log.epochTail = async () => {
        if (failures-- > 0) throw new Error("rpc reset");
        return real();
      };
      f.sent.length = 0;
      await f.api.journal(SID, 0, []);
      await vi.advanceTimersByTimeAsync(EPOCH_TAIL_RETRY_MS[0]!);
      await Promise.all(f.pending());
      expect(f.frames("epoch")).toMatchObject([{ sessionId: SID, epoch: 2 }]);
      // Every read fails: no frame, and the next stale batch (inside the 5 s limit) asks again.
      f.sent.length = 0;
      f.advance(STALE_EPOCH_RESEND_MS);
      failures = 99;
      await f.api.journal(SID, 1, [event(1)]);
      await vi.advanceTimersByTimeAsync(EPOCH_TAIL_RETRY_MS.reduce((a, b) => a + b, 0));
      await Promise.all(f.pending());
      expect(f.frames("epoch")).toHaveLength(0);
      failures = 0;
      await f.api.journal(SID, 1, [event(1)]);
      await Promise.all(f.pending());
      expect(f.frames("epoch")).toMatchObject([{ sessionId: SID, epoch: 2 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty journal batch under an older epoch asks for epoch (rate-limited); at the row's epoch it is nothing (calvin 424bd40)", async () => {
    const f = fixture();
    await created(f);
    f.sql.exec("UPDATE sessions SET log_epoch = 2 WHERE session_id = ?", SID);
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

  it("a write held through an adoption is awaited past 15 s; a keyed retry takes the original's answer (review r3 P2-2)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fixture();
      await created(f);
      await f.api.journal(SID, 1, [event(1)]);
      // Steady state: 15 s, then 503.
      const plain = f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "hi" } });
      await vi.advanceTimersByTimeAsync(HOST_CALL_TIMEOUT_MS);
      expect((await plain).status).toBe(503);
      // The epoch just moved: the host holds the write until it adopts (~20 s); the answer is still awaited.
      Object.assign(f.logOf(SID), { epoch: 2, ack: 1, epochStartSeq: 2 });
      f.sql.exec("UPDATE sessions SET log_epoch = 2 WHERE session_id = ?", SID);
      await f.api.journal(SID, 1, []);
      await Promise.all(f.pending());
      expect(f.frames("epoch")).toHaveLength(1);
      const held = f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "held" } });
      await vi.advanceTimersByTimeAsync(20_000);
      const heldFrame = f.frames("api").at(-1)!;
      await f.api.onHostFrame({ t: "api-result", id: heldFrame.id, result: { turnId: "tn_4m8q2x7c1v9b", duplicate: false } } as never);
      expect((await held).status).toBe(202);
      // Keyed: the client gives up at 40 s and retries with the same key; nothing new is sent, and the host's
      // late answer to the original resolves the retry.
      const first = f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "keyed" }, idempotencyKey: "idem-1" });
      await vi.advanceTimersByTimeAsync(HOST_CALL_HELD_TIMEOUT_MS);
      expect((await first).status).toBe(503);
      const sentBefore = f.frames("api").length;
      const retry = f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "keyed" }, idempotencyKey: "idem-1" });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.frames("api")).toHaveLength(sentBefore);
      const original = f.frames("api").at(-1)!;
      expect(original.idempotencyKey).toBe("idem-1");
      await f.api.onHostFrame({ t: "api-result", id: original.id, result: { turnId: "tn_9z8y7x6w5v4u", duplicate: false } } as never);
      expect(await retry).toMatchObject({ status: 202, body: { turnId: "tn_9z8y7x6w5v4u" } });
      // Answered: a later repeat goes to the host again (whose writer dedupes by the key).
      void f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "keyed" }, idempotencyKey: "idem-1" });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.frames("api")).toHaveLength(sentBefore + 1);
      f.api.onHostClosed();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hello: a journal behind the log hears epoch first; one in step hears nothing", async () => {
    const f = fixture();
    await created(f);
    await created(f, "cs_2222222222222222");
    f.sql.exec("UPDATE sessions SET log_epoch = 3 WHERE session_id = ?", SID);
    f.logOf(SID).epoch = 3;
    f.logOf(SID).ack = 5;
    f.logOf(SID).epochStartSeq = 5;
    f.sent.length = 0;
    f.api.onHello([
      { sessionId: SID, epoch: 1, lastSeq: 7 },
      { sessionId: "cs_2222222222222222", epoch: 1, lastSeq: 0 },
    ]);
    await Promise.all(f.pending());
    expect(f.frames("epoch")).toMatchObject([{ sessionId: SID, epoch: 3, startSeq: 5, lastSeq: 5 }]);
    expect(f.logOf("cs_2222222222222222").tailReads).toBe(0);
  });

  it("hello: a journal at the log's epoch but short of its stored events (or torn, epoch 0) hears epoch (calvin r2 P1-2)", async () => {
    const f = fixture();
    await created(f);
    await created(f, "cs_2222222222222222");
    await created(f, "cs_3333333333333333");
    for (const sid of [SID, "cs_2222222222222222", "cs_3333333333333333"]) {
      f.sql.exec("UPDATE sessions SET log_epoch = 2, last_seq = 6 WHERE session_id = ?", sid);
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

  it("a batch under a fenced epoch: epoch again, at most once per session per 5 s", async () => {
    const f = fixture();
    await created(f);
    f.sql.exec("UPDATE sessions SET log_epoch = 2 WHERE session_id = ?", SID);
    f.logOf(SID).epoch = 2;
    await f.api.journal(SID, 1, [event(1)]);
    await Promise.all(f.pending());
    await f.api.journal(SID, 1, [event(1)]);
    await Promise.all(f.pending());
    expect(f.frames("epoch")).toHaveLength(1);
    expect(f.logOf(SID).appends).toHaveLength(0);
    f.advance(STALE_EPOCH_RESEND_MS);
    await f.api.journal(SID, 1, [event(1)]);
    await Promise.all(f.pending());
    expect(f.frames("epoch")).toHaveLength(2);
    // The log fencing a batch the row let through (the row was behind): the row follows, epoch goes.
    const g = fixture();
    await created(g);
    g.logOf(SID).epoch = 4;
    await g.api.journal(SID, 1, [event(1)]);
    await Promise.all(g.pending());
    expect(g.api.row(SID)!.logEpoch).toBe(4);
    expect(g.frames("epoch")).toMatchObject([{ epoch: 4 }]);
  });

  it("an api call waits for an in-flight epoch send and carries the new epoch after it", async () => {
    const f = fixture();
    await created(f);
    f.logOf(SID).epoch = 2;
    f.logOf(SID).delay = 5;
    f.answers.set("turns.send", () => ({ result: { turn: {}, delivery: "started", duplicate: false, seq: 1 } }));
    f.api.onHello([{ sessionId: SID, epoch: 0, lastSeq: 0 }]);
    f.sql.exec("UPDATE sessions SET log_epoch = 2 WHERE session_id = ?", SID);
    f.sent.length = 0;
    await f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "hi" } });
    expect(f.sent.map((x) => x.t).filter((t) => t === "epoch" || t === "api")).toEqual(["epoch", "api"]);
    expect(f.frames("api")[0]).toMatchObject({ epoch: 2 });
  });
});

describe("hello and tickets", () => {
  it("hello sends access for API sessions and linked Slack ones only", async () => {
    const f = fixture();
    await created(f);
    f.slackRow("T1:C1:9.9", "U2");
    f.sql.exec("UPDATE sessions SET session_id = 'cs_1111111111111111' WHERE runner_key = 'T1:C1:9.9'");
    // Many unlinked Slack threads: none is read for a frame it would not make.
    for (let i = 0; i < 50; i++) {
      f.slackRow(`T1:C1:${i}.1`, "U2");
      f.sql.exec("UPDATE sessions SET session_id = ? WHERE runner_key = ?", `cs_8888888888888${100 + i}`, `T1:C1:${i}.1`);
    }
    f.sent.length = 0;
    f.api.onHello();
    expect(f.frames("access").map((a) => a.access.sessionId)).toEqual([SID]);
  });

  it("admins: a caller's admin role reaches every access list, and a demotion takes it back", async () => {
    const f = fixture();
    await created(f);
    f.slackRow("T1:C1:1.2");
    f.state.links.set("U1", "user_01JABCDEFGHJKMNPQRSTVWXYZ0");
    const slackId = (await f.api.slackDelivery("T1:C1:1.2", "U1"))!.sessionId;
    f.sent.length = 0;
    // A member's call says nothing new: no frames.
    await f.api.handle(caller(MO, { admin: false }), { op: "me" });
    expect(f.frames("access")).toHaveLength(0);
    // An admin's first call: every session's access list again, with admins.
    await f.api.handle(caller(MO, { admin: true }), { op: "me" });
    expect(f.frames("access").map((a) => a.access).sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual(
      [
        { sessionId: SID, owner: OWNER, members: null, admins: [MO] },
        { sessionId: slackId, owner: OWNER, members: [OWNER], admins: [MO] },
      ].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    );
    f.sent.length = 0;
    await f.api.handle(caller(MO, { admin: true }), { op: "me" });
    expect(f.frames("access")).toHaveLength(0);
    // New sessions and the next hello carry them too, from storage.
    await created(f, "cs_2222222222222222");
    expect(f.frames("access").at(-1)!.access).toEqual({ sessionId: "cs_2222222222222222", owner: OWNER, members: null, admins: [MO] });
    expect(f.settings.get("apiAdmins")).toBe(JSON.stringify([MO]));
    // Demoted: the lists go out without them.
    f.sent.length = 0;
    await f.api.handle(caller(MO, { admin: false }), { op: "me" });
    expect(f.frames("access")).toHaveLength(3);
    expect(f.frames("access").every((a) => a.access.admins === undefined)).toBe(true);
  });

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
      slackQueue: () => ({ rows: 1, oldestMs: 250 }),
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
    expect(r.events[0]!.data).toMatchObject({ events: 40, slack_queue_rows: 1, slack_queue_oldest_ms: 250 });
    expect(r.events[0]!.data).toHaveProperty("do_ack_ms");
    expect(r.events[0]!.data).toHaveProperty("do_pre_ms");
    expect(r.events[1]!.data).toMatchObject({ kind: "gap_4010", epoch: 1 });
    expect(r.events[2]).toMatchObject({ outcome: "failed", error_code: "gap" });
  });

  it("an API write is one computer.write; a ticket one ticket.minted", async () => {
    const r = recorded();
    const f = fixture({ telemetry: r.telemetry, ticketKey: true });
    await created(f);
    f.answers.set("turns.send", () => ({ result: { turn: { id: "tn_4m8q2x7c1v9b" }, delivery: "queued", duplicate: false, seq: 4 } }));
    await f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "hello there" } });
    await f.api.handle(caller(), { op: "ticket", body: {} });
    await tick();
    const writes = r.events.filter((e) => e.event_name === "computer.write");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ session_key: SID, outcome: "completed", data: { method: "turns.send", held: false, replayed: false } });
    expect(writes[0]!.data).toHaveProperty("do_ms");
    expect(r.events.filter((e) => e.event_name === "ticket.minted").map((e) => e.data.result)).toEqual(["api_key_required"]);
    expect(JSON.stringify(r.events)).not.toContain("hello there");
  });
});

describe("rollout gate (COMPUTER_API_ORGS)", () => {
  it("parses: unset or empty is nobody, * is everybody, otherwise the listed organizations", () => {
    expect(computerApiEnabled(undefined, ORG)).toBe(false);
    expect(computerApiEnabled("", ORG)).toBe(false);
    expect(computerApiEnabled(" , ", ORG)).toBe(false);
    expect(computerApiEnabled("*", ORG)).toBe(true);
    expect(computerApiEnabled("*", undefined)).toBe(true);
    expect(computerApiEnabled(`org_other, ${ORG} `, ORG)).toBe(true);
    expect(computerApiEnabled("org_other", ORG)).toBe(false);
    expect(computerApiEnabled("org_other", undefined)).toBe(false);
    expect(GATED_PROTOCOL).toBe(3);
  });

  it("gated off: every operation but /me answers 409 feature_unavailable; nothing is stored or sent", async () => {
    const f = fixture({ enabled: false, ticketKey: true });
    const ops = [
      { op: "create", body: { id: SID, input: "hi" } },
      { op: "list", query: [] },
      { op: "get", sessionId: SID },
      { op: "ticket", body: { sessionIds: [SID] } },
    ] as const;
    for (const op of ops) {
      const reply = await f.api.handle(caller(MO, { admin: true }), op as never);
      expect(reply).toEqual({ status: 409, error: { code: "feature_unavailable", message: expect.any(String), feature: "sessions" } });
    }
    expect((await f.api.handle(caller(), { op: "me" })).status).toBe(200);
    expect(f.sent).toHaveLength(0);
    expect(f.settings.has("apiAdmins")).toBe(false);
    expect([...f.sql.exec("SELECT COUNT(*) AS n FROM sessions WHERE session_id IS NOT NULL")][0]).toEqual({ n: 0 });
  });

  it("gated on: the same calls go through", async () => {
    const f = fixture({ enabled: true });
    await created(f);
    expect((await f.api.handle(caller(), { op: "list", query: [] })).status).toBe(200);
  });
});
