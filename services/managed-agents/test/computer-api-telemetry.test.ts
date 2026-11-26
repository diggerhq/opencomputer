import { afterEach, describe, expect, it, vi } from "vitest";

import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import { ComputerKeys } from "../src/computer/keys.js";
import type { LogSummary } from "../src/api-objects/objects.js";
import type { AppendResult } from "../src/actors/session-log/contract.js";
import { ApiTelemetry, type EmitTelemetry, surfaceOfOrigin } from "../src/computer/telemetry/api.js";
import { BATCH_MS, TelemetryBatch } from "../src/computer/telemetry/batch.js";
import { gatewayTelemetry } from "../src/telemetry/gateway.js";
import { createTelemetry } from "../src/telemetry/emitter.js";
import { keyIdentity } from "./fixtures/identity.js";
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
  it("one sessionlog.append per batch, whatever its size, with the DO time", async () => {
    const s = sink();
    const t = new ApiTelemetry({ emit: s.emit, surfaceOf: () => "cli", now: () => 1_800_000_000_500 });
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
      do_chain_wait_ms: 1, do_pre_ms: 2, do_post_ms: 0, do_ack_ms: 10,
    });
    expect(JSON.stringify(out)).not.toContain(SECRET_TEXT);
  });

  it("a refused batch: failed with the reason, no ack time", async () => {
    const s = sink();
    const t = new ApiTelemetry({ emit: s.emit, surfaceOf: () => "api" });
    t.journaled({ sessionId: SID, epoch: 2, events: [journalEvent(9, "message.delta", null)], appendMs: 4, preMs: 1, postMs: 0, result: { ok: false, reason: "gap", logEpoch: 2, ack: 3 } });
    const [e] = await s.settle();
    expect(e).toMatchObject({ outcome: "failed", error_code: "gap", data: { refused: "gap", turns: 0 } });
    expect(e).not.toHaveProperty("turn_id");
    expect(e!.data).not.toHaveProperty("do_ack_ms");
  });

  it("ticket.minted, keys.*, recovery and an outage are one event each", async () => {
    const s = sink();
    let now = 1_000;
    const t = new ApiTelemetry({ emit: s.emit, surfaceOf: () => "api", now: () => now });
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
      "ticket.minted", "ticket.minted", "keys.synced", "keys.revoked", "sessionlog.recovery", "computer.unavailable",
    ]);
    expect(out[1]).toMatchObject({ outcome: "failed", error_code: "api_key_required", data: { result: "api_key_required" } });
    expect(out[5]).toMatchObject({ duration_ms: 1000, data: { wait_ms: 1000 } });
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
    h.api.ticket({ surface: "cli", ms: 4, result: "minted", sessions: 1, keyWritten: false });
    expect(h.posts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await h.settle();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.map((e) => e.event_name)).toEqual(["sessionlog.append", "sessionlog.append", "ticket.minted"]);
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
  // An opc key, as the edge resolves it from the key and the user agent.
  const key = keyIdentity("org_1", "user_01JABCDEFGHJKMNPQRSTVWXYZ0", ["sandbox:*"]);
  const identity = { ...key, ocPrincipal: { ...key.ocPrincipal!, via: "opc" as const } };

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
    const stub: ComputerApiStub = { computerApi: vi.fn() };
    // The turn goes through the session's inbox: a repeat already delivered answers its stored result.
    const log = { accept: vi.fn(async () => ({ ok: true, id: "tn_000000000000", duplicate: true, outcome: { state: "delivered", result: { delivery: "queued" } } })) };
    const env = { ...ON, SESSION_LOG: { getByName: () => log } };
    const res = await routeComputerApi(
      new Request(`https://blue.test/v1/computer/sessions/${SID}/turns?secret=1`, {
        method: "POST",
        headers: { "user-agent": "opc/1.0.0", "content-type": "application/json" },
        body: JSON.stringify({ input: SECRET_TEXT }),
      }),
      env as never, identity, "org_1", stub, `/sessions/${SID}/turns`, c.waitUntil,
    );
    expect(res.status).toBe(200);
    await c.settle();
    expect(c.lines).toHaveLength(1);
    const e = c.lines[0]!;
    expect(e).toMatchObject({ event_name: "httpapi.request", surface: "cli", session_key: SID, org_id: "org_1", outcome: "completed" });
    expect(JSON.parse(e.data)).toMatchObject({ route: "turns", op: "turns.send", method: "POST", status: 200, replayed: true });
    expect(typeof JSON.parse(e.data).log_ms).toBe("number");
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
