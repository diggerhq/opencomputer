import { describe, expect, it, vi } from "vitest";

import type { ApiEvent, LogSummary } from "../src/computer/api-types.js";
import { matchApiRoute, writeParams } from "../src/computer/api-http.js";
import { ComputerKeys } from "../src/computer/keys.js";
import type { CalvinGatewayToHost, CalvinPerson } from "../src/computer/protocol.js";
import type { AppendResult, EpochTail, RecoverInput, RecoverResult } from "../src/computer/session-log-contract.js";
import {
  type ApiRequest,
  ComputerSessionsApi,
  GAP_CLOSE_INTERVAL_MS,
  HOST_CALL_TIMEOUT_MS,
  RECOVER_AFTER_MS,
} from "../src/computer/sessions-api.js";
import { ApiTelemetry } from "../src/computer/telemetry/api.js";
import { createTelemetry } from "../src/computer/telemetry/emitter.js";
import type { SessionsApiDeps } from "../src/computer/sessions-api.js";
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
  async inbox() {
    return { entries: [], epoch: this.epoch, lastSeq: this.ack };
  }
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
  const api: ComputerSessionsApi = new ComputerSessionsApi({
    sql,
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.api.onHostClosed();
    expect(await pending).toMatchObject({ status: 503, error: { code: "computer_unavailable" } });
    expect(await f.api.handle(caller(), { op: "call", sessionId: "cs_0000000000000000", method: "turns.send", params: { input: "x" } })).toMatchObject({ status: 404, error: { code: "session_not_found" } });
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
      f.api.handle(caller(), { op: "call", sessionId: SID, method: "turns.send", params: { input: "go on" } }),
    ]);
    const firstAtTwo = f.sent.findIndex((x) => "epoch" in x && (x as { epoch: number }).epoch === 2);
    expect(f.sent[firstAtTwo]!.t).toBe("epoch");
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

  it("a write held through an adoption is awaited past 15 s (review r3 P2-2)", async () => {
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
      f.api.onHostClosed();
    } finally {
      vi.useRealTimers();
    }
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
