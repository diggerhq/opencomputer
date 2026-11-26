import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import { ComputerKeys } from "../src/computer/keys.js";
import { SLACK_QUEUE_OLDEST_SQL, SLACK_QUEUE_STATE_INDEX, SLACK_QUEUE_WAITING_SQL, slackQueueNow } from "../src/computer/slack-queue-gauge.js";
import type { LogSummary } from "../src/computer/api-types.js";
import type { AppendResult } from "../src/computer/session-log-contract.js";
import { ApiTelemetry, type EmitTelemetry, surfaceOfOrigin } from "../src/computer/telemetry/api.js";
import { BATCH_MS, TelemetryBatch } from "../src/computer/telemetry/batch.js";
import { gatewayTelemetry } from "../src/computer/telemetry/gateway.js";
import { createTelemetry } from "../src/computer/telemetry/emitter.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

/**
 * Work 084 instrumentation, blue side: one telemetry event per real unit of work (a journal batch,
 * an API write, a key write, an HTTP request), never one per journal event; ids only; nothing
 * leaves without the Tinybird settings.
 */

const SID = "cs_7f3a9k2m4q8r1t6v";
const SECRET_TEXT = "the user's secret prompt text";

type Line = Record<string, any>;

/** Collects what the emitters would send, and how many records the validator refused. */
function sink() {
  const events: Line[] = [];
  const flushes: Promise<void>[] = [];
  let invalid = 0;
  const emit: EmitTelemetry = (write) => {
    const t = createTelemetry({ service: "gateway", version: "test", region: "test", send: (b) => void events.push(...b.events) });
    write(t);
    invalid += t.dropped.invalid ?? 0;
    flushes.push(t.flush());
  };
  return {
    emit,
    events,
    invalid: () => invalid,
    settle: async () => {
      await Promise.all(flushes.splice(0));
      return events.filter((e) => e.event_name !== "telemetry.dropped");
    },
  };
}

function summary(lastSeq: number): LogSummary {
  return {
    lastSeq, logEpoch: 1, epochStartSeq: 1, status: "idle", title: null, settings: null, activeTurnId: null, queued: [], asks: [],
    subagents: [], lastTurn: null, lastText: null, context: { usedTokens: null, windowTokens: null }, lastActiveAt: null, syncedAt: null,
  } as LogSummary;
}

const stats = {
  storeMs: 3.4, rows: 5, dupes: 0, mismatches: 0, bytes: 900, syncSpills: 0, syncSpillBytes: 0, syncSpillMs: 0,
  refolded: true, refoldMs: 0.6, spillsDue: 1, storageBytes: 65536,
};

const journalEvent = (seq: number, type = "message.delta", turnId: string | null = "tn_000000000001") => ({
  turnId,
  type,
  createdAt: new Date(1_800_000_000_000 + seq).toISOString(),
  // What a real event carries beside these; the telemetry never reads it.
  data: { text: SECRET_TEXT },
});

describe("ApiTelemetry: one event per unit, ids only", () => {
  it("one sessionlog.append per batch, whatever its size, with the DO time and the Slack queue", async () => {
    const s = sink();
    const t = new ApiTelemetry({ emit: s.emit, surfaceOf: () => "cli", slackQueue: () => ({ rows: 2, oldestMs: 1500.4 }), now: () => 1_800_000_000_500 });
    for (const size of [1, 50, 500]) {
      const events = Array.from({ length: size }, (_, i) => journalEvent(i + 1, i === size - 1 ? "turn.completed" : "message.delta"));
      const result: AppendResult = { ok: true, ack: size, summary: summary(size), stats };
      t.journaled({ sessionId: SID, epoch: 1, events, appendMs: 7.2, chainWaitMs: 1.1, preMs: 2.2, postMs: 0, ackMs: 9.6, result });
    }
    const out = await s.settle();
    expect(out).toHaveLength(3);
    expect(s.invalid()).toBe(0);
    expect(out[2]).toMatchObject({
      event_name: "sessionlog.append",
      surface: "cli",
      session_key: SID,
      turn_id: "tn_000000000001",
      duration_ms: 7,
      outcome: "completed",
    });
    expect(out[2]!.data).toMatchObject({
      epoch: 1, events: 500, turns: 1, ended: true, append_ms: 7, commit_lag_ms_max: 499, commit_lag_ms_min: 0,
      store_ms: 3, rows: 5, spills_due: 1, storage_bytes: 65536,
      do_chain_wait_ms: 1, do_pre_ms: 2, do_post_ms: 0, do_ack_ms: 10, slack_queue_rows: 2, slack_queue_oldest_ms: 1500,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET_TEXT);
  });

  it("a refused batch: failed with the reason, no ack time; a broken queue read leaves the queue out", async () => {
    const s = sink();
    const t = new ApiTelemetry({ emit: s.emit, surfaceOf: () => "api", slackQueue: () => { throw new Error("sql"); } });
    t.journaled({ sessionId: SID, epoch: 2, events: [journalEvent(9, "message.delta", null)], appendMs: 4, preMs: 1, postMs: 0, result: { ok: false, reason: "gap", logEpoch: 2, ack: 3 } });
    const [e] = await s.settle();
    expect(e).toMatchObject({ outcome: "failed", error_code: "gap", data: { refused: "gap", turns: 0 } });
    expect(e).not.toHaveProperty("turn_id");
    expect(e!.data).not.toHaveProperty("do_ack_ms");
    expect(e!.data).not.toHaveProperty("slack_queue_rows");
  });

  it("computer.write, ticket.minted, keys.*, recovery and an outage are one event each", async () => {
    const s = sink();
    let now = 1_000;
    const t = new ApiTelemetry({ emit: s.emit, surfaceOf: () => "api", slackQueue: () => ({ rows: 0, oldestMs: null }), now: () => now });
    t.write({ sessionId: SID, surface: "cli", method: "turns.send", hostMs: 40, doMs: 0.4, held: true, heldMs: 12, replayed: false, timedOut: false });
    t.write({ sessionId: SID, surface: "api", method: "turns.send", hostMs: 15000, held: false, heldMs: 0, replayed: false, timedOut: true, errorCode: "computer_unavailable" });
    t.ticket({ surface: "api", ms: 3, result: "minted", sessions: 1, keyWritten: true });
    t.ticket({ surface: "api", ms: 1, result: "api_key_required" });
    t.keySynced({ keyId: "key_1", trigger: "ensure", ms: 2, ok: true, kvWrites: 2 });
    t.keyRevoked({ keyId: "key_1", ms: 1, known: true, hostTold: false, ok: true });
    t.recovery("epoch_sent", { sessionId: SID, reason: "stale", ms: 5, ok: true, data: { epoch: 3, events: 4, attempt: 1 } });
    t.unavailable();
    now += 400;
    t.unavailable();
    now += 600;
    t.hostBack();
    t.hostBack();
    const out = await s.settle();
    expect(s.invalid()).toBe(0);
    expect(out.map((e) => e.event_name)).toEqual([
      "computer.write", "computer.write", "ticket.minted", "ticket.minted", "keys.synced", "keys.revoked", "sessionlog.recovery", "computer.unavailable",
    ]);
    expect(out[0]!.data).toEqual({ method: "turns.send", held: true, held_ms: 12, replayed: false, timed_out: false, do_ms: 0, slack_queue_rows: 0 });
    expect(out[1]).toMatchObject({ outcome: "failed", error_type: "timeout", error_code: "computer_unavailable" });
    expect(out[3]).toMatchObject({ outcome: "failed", error_code: "api_key_required", data: { result: "api_key_required" } });
    expect(out[7]).toMatchObject({ duration_ms: 1000, data: { wait_ms: 1000 } });
  });

  it("the validator refuses forbidden shapes; nothing reaches the DO", async () => {
    const s = sink();
    const t = new ApiTelemetry({ emit: s.emit, surfaceOf: () => "api" });
    // A path and a key-shaped string, where only closed values belong.
    t.recovery("tail_retry", { sessionId: SID, reason: "/home/user/project" });
    t.keySynced({ keyId: `osb_${"a".repeat(40)}`, trigger: "sync", ms: 1, ok: true, kvWrites: 2 });
    expect(await s.settle()).toHaveLength(0);
    expect(s.invalid()).toBe(2);
    const throwing = new ApiTelemetry({ emit: () => { throw new Error("emitter down"); }, surfaceOf: () => { throw new Error("sql"); } });
    expect(() => throwing.journaled({ sessionId: SID, epoch: 1, events: [], appendMs: 1, result: { ok: true, ack: 0, summary: summary(0) } })).not.toThrow();
    expect(() => throwing.write({ sessionId: SID, surface: "api", method: "turns.send", hostMs: 1, held: false, heldMs: 0, replayed: false, timedOut: false })).not.toThrow();
  });

  it("surfaces: slack, opc is the CLI, the rest the API", () => {
    expect([surfaceOfOrigin("slack"), surfaceOfOrigin("opc"), surfaceOfOrigin("api"), surfaceOfOrigin(null)]).toEqual(["slack", "cli", "api", "api"]);
  });
});

describe("TelemetryBatch: the DO's events share one POST per window", () => {
  const TB = { TINYBIRD_API_URL: "https://tb.test", TINYBIRD_APPEND_TOKEN: "p.append" };

  function harness(env: Record<string, string> = TB, max?: number) {
    const posts: Line[][] = [];
    const post = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(String(init?.body).split("\n").map((l) => JSON.parse(l) as Line));
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const waited: Promise<unknown>[] = [];
    let opened = 0;
    const batch = new TelemetryBatch({
      open: () => (opened++, gatewayTelemetry(env, { fetch: post })),
      waitUntil: (p) => void waited.push(p),
      ...(max ? { max } : {}),
    });
    const api = new ApiTelemetry({ emit: (w) => batch.emit(w), surfaceOf: () => "cli" });
    const append = (seq: number) =>
      api.journaled({ sessionId: SID, epoch: 1, events: [journalEvent(seq)], appendMs: 1, result: { ok: true, ack: seq, summary: summary(seq), stats } });
    return { posts, waited, opened: () => opened, append, api, settle: () => Promise.all(waited.splice(0)) };
  }

  afterEach(() => vi.useRealTimers());

  it("events from separate invocations within the window are one POST, each its own record", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.append(1);
    await vi.advanceTimersByTimeAsync(300);
    h.append(2);
    h.api.write({ sessionId: SID, surface: "cli", method: "turns.send", hostMs: 4, held: false, heldMs: 0, replayed: false, timedOut: false });
    expect(h.posts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await h.settle();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.map((e) => e.event_name)).toEqual(["sessionlog.append", "sessionlog.append", "computer.write"]);
    // The window closed: the next event opens a new batch.
    h.append(3);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await h.settle();
    expect(h.posts.map((p) => p.length)).toEqual([3, 1]);
    expect(h.opened()).toBe(2);
  });

  it("a full batch closes early; the next event opens another", async () => {
    vi.useFakeTimers();
    const h = harness(TB, 2);
    for (let seq = 1; seq <= 5; seq++) h.append(seq);
    expect(h.opened()).toBe(3);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await h.settle();
    expect(h.posts.map((p) => p.length)).toEqual([2, 2, 1]);
  });

  it("off: no timer, nothing posted, still validated", async () => {
    vi.useFakeTimers();
    const h = harness({});
    h.append(1);
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve();
    await h.settle();
    expect(h.posts).toHaveLength(0);
  });
});

describe("ComputerKeys telemetry", () => {
  it("one keys.synced per KV write path and one keys.revoked per revoke", async () => {
    const s = sink();
    const telemetry = new ApiTelemetry({ emit: s.emit, surfaceOf: () => "api" });
    const kv = { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
    const keys = new ComputerKeys({
      sql: sqlStorage(), kv, organizationId: () => "org_1", tunnelId: () => "tun_1", revoked: () => true, waitUntil: () => {}, telemetry,
    });
    const key = { id: "key_1", hash: "a".repeat(64), name: "laptop", kind: "user" as const, scopes: ["sessions:read"], expiresAt: null, createdAt: null };
    expect(await keys.ensure(key, "usr_x")).toBe(true);
    expect(await keys.ensure(key, "usr_x")).toBe(false);
    await keys.revoke("key_1");
    await keys.revoke("key_2");
    const out = await s.settle();
    expect(out.map((e) => [e.event_name, e.data])).toEqual([
      ["keys.synced", { key_id: "key_1", trigger: "ensure", ok: true, kv_writes: 2 }],
      ["keys.revoked", { key_id: "key_1", known: true, host_told: true }],
      ["keys.revoked", { key_id: "key_2", known: false, host_told: true }],
    ]);
    expect(JSON.stringify(out)).not.toContain("a".repeat(64));
  });
});

describe("httpapi.request: one per blue computer-API request", () => {
  const ON = { TINYBIRD_API_URL: "https://tb.test", TINYBIRD_APPEND_TOKEN: "p.append" };
  const identity = { kind: "user", userId: "user_01JABCDEFGHJKMNPQRSTVWXYZ0", accountId: "org_1", role: "member" } as unknown as RequestIdentity;

  function capture() {
    const lines: Line[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      for (const l of String(init.body).split("\n")) lines.push(JSON.parse(l));
      return new Response(null, { status: 202 });
    }));
    const pending: Promise<unknown>[] = [];
    return { lines, waitUntil: (p: Promise<unknown>) => void pending.push(p), settle: () => Promise.all(pending.splice(0)) };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("names the route and op, the status and the DO time; never the URL or the body", async () => {
    const c = capture();
    const stub: ComputerApiStub = { computerApi: vi.fn(async () => ({ status: 202, body: { delivery: "queued", duplicate: true } })) };
    const res = await routeComputerApi(
      new Request(`https://blue.test/v1/computer/sessions/${SID}/turns?secret=1`, {
        method: "POST",
        headers: { "user-agent": "opc/1.0.0", "content-type": "application/json" },
        body: JSON.stringify({ input: SECRET_TEXT }),
      }),
      ON as never, identity, "org_1", stub, `/sessions/${SID}/turns`, c.waitUntil,
    );
    expect(res.status).toBe(202);
    await c.settle();
    expect(c.lines).toHaveLength(1);
    const e = c.lines[0]!;
    expect(e).toMatchObject({ event_name: "httpapi.request", surface: "cli", session_key: SID, org_id: "org_1", outcome: "completed" });
    expect(JSON.parse(e.data)).toMatchObject({ route: "turns", op: "turns.send", method: "POST", status: 202, replayed: true });
    expect(typeof JSON.parse(e.data).do_ms).toBe("number");
    const text = JSON.stringify(e);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain("secret=1");
  });

  it("a refusal carries its code; unconfigured, nothing is sent", async () => {
    const c = capture();
    const stub: ComputerApiStub = { computerApi: vi.fn() };
    await routeComputerApi(new Request("https://blue.test/v1/computer/nope"), ON as never, identity, "org_1", stub, "/nope", c.waitUntil);
    await c.settle();
    expect(c.lines[0]).toMatchObject({ outcome: "failed", error_code: "not_found" });
    expect(JSON.parse(c.lines[0]!.data)).toMatchObject({ route: "other", op: "other", status: 404 });
    c.lines.length = 0;
    await routeComputerApi(new Request("https://blue.test/v1/computer/nope"), {} as never, identity, "org_1", stub, "/nope", c.waitUntil);
    await c.settle();
    expect(c.lines).toHaveLength(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the Slack queue gauge is index-only", () => {
  const schema = (db: DatabaseSync) => {
    db.exec(`CREATE TABLE slack_queue (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, last_error TEXT, thread_key TEXT, started_at INTEGER)`);
    db.exec(SLACK_QUEUE_STATE_INDEX);
  };
  const plan = (db: DatabaseSync, query: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");

  it("both reads use the covering index on (state, available_at), never a table scan", () => {
    const db = new DatabaseSync(":memory:");
    schema(db);
    for (const q of [SLACK_QUEUE_WAITING_SQL, SLACK_QUEUE_OLDEST_SQL]) {
      const p = plan(db, q);
      expect(p).toMatch(/USING COVERING INDEX slack_queue_state/);
      expect(p).not.toMatch(/SCAN slack_queue(?! USING)/);
    }
  });

  it("counts waiting rows, skips failed ones, and reads the oldest pending wait", () => {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE slack_queue (sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', available_at INTEGER NOT NULL);`);
    sql.exec(SLACK_QUEUE_STATE_INDEX);
    expect(slackQueueNow(sql, 10_000)).toEqual({ rows: 0, oldestMs: null });
    for (const [state, at] of [["pending", 7_000], ["pending", 9_000], ["running", 1_000], ["failed", 0]] as const) {
      sql.exec("INSERT INTO slack_queue (payload, state, available_at) VALUES ('{}', ?, ?)", state, at);
    }
    expect(slackQueueNow(sql, 10_000)).toEqual({ rows: 3, oldestMs: 3_000 });
  });
});
