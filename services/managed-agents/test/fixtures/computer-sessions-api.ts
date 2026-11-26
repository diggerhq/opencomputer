// The Computer DO's session API against a fake v4 host and a fake SessionLog, shared by
// computer-sessions-api.test.ts and computer-session-access.test.ts.

import { expect } from "vitest";

import type { ApiEvent, LogSummary } from "../../src/computer/api-types.js";
import { ComputerKeys } from "../../src/computer/keys.js";
import type { CalvinGatewayToHost, CalvinPerson } from "../../src/computer/protocol.js";
import type { AppendResult, EpochTail, RecoverInput, RecoverResult } from "../../src/computer/session-log-contract.js";
import { type ApiCaller, ComputerSessionsApi, type SessionsApiDeps } from "../../src/computer/sessions-api.js";
import type { ApiTelemetry } from "../../src/computer/telemetry/api.js";
import { sqlStorage } from "./computer-sql.js";

export const ORG = "org_sessions";
export const OWNER = "usr_01jabcdefghjkmnpqrstvwxyz0";
export const MO = "usr_01jzyxwvtsrqpnmkjhgfedcba0";
export const SID = "cs_7f3a9k2m4q8r1t6v";

export const caller = (member = OWNER, extra: Partial<ApiCaller> = {}): ApiCaller => ({
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

export function summary(_sessionId: string, lastSeq: number, logEpoch: number, extra: Partial<LogSummary> = {}): LogSummary {
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
export class FakeLog {
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

export const event = (seq: number, sessionId = SID): ApiEvent => ({
  id: `ev_${String(seq).padStart(16, "0")}`,
  seq,
  createdAt: new Date(1_800_000_000_000 + seq).toISOString(),
  sessionId,
  turnId: null,
  type: "message.received",
  actor: null,
  data: {},
});

export function fixture(options: { protocol?: number | null; enabled?: boolean; status?: "ready" | "asleep" | "not_set_up"; admitted?: boolean | "throws"; ticketKey?: boolean; telemetry?: ApiTelemetry; routeSession?: SessionsApiDeps["routeSession"]; secretsFor?: SessionsApiDeps["secretsFor"] } = {}) {
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
    routeSession: options.routeSession,
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

/** A session created over the API with no first message (a `start`). */
export async function created(f: ReturnType<typeof fixture>, id = SID, member = OWNER, access?: { mode: string; people?: string[] }) {
  const reply = await f.api.handle(caller(member), { op: "create", body: { id, ...(access ? { access } : {}) } });
  expect(reply.status).toBe(201);
  return reply;
}
