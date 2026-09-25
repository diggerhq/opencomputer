import assert from "node:assert/strict";
import test from "node:test";

import { OpenComputerClient } from "./api.js";
import { runAgent } from "./commands.js";
import { CLIError } from "./errors.js";
import {
  sessionCreateIdempotencyKeys,
  type SessionCreateOutcome,
} from "./session-create.js";

// OCFR-17 reproduction: `--idempotency-key <key> session create "<prompt>"`
// created the session and then lost the first turn to `400 invalid_turn`,
// because one caller key reached both mutations and the turn's body carried
// the raw key while its header carried the derived one. These tests run the
// compound command against a Management API double that applies the API's
// idempotency rules: one key per domain, header and body must agree, a reused
// key with other input is a 409 idempotency_conflict.

type Committed = { id: string; body: string };

interface FakeApi {
  requests: Array<{ method: string; path: string; header: string | null; bodyKey?: string }>;
  sessions: Committed[];
  turns: Array<Committed & { sessionId: string }>;
  /** Commit, then fail the response (the caller never learns the outcome). */
  loseNextSessionResponse: boolean;
  loseNextTurnResponse: boolean;
  /** Refuse the next turn before anything is committed. */
  refuseNextTurn?: { status: number; code: string; message: string };
}

function fakeManagementApi(context: test.TestContext): FakeApi {
  const state: FakeApi = {
    requests: [],
    sessions: [],
    turns: [],
    loseNextSessionResponse: false,
    loseNextTurnResponse: false,
  };
  const events = new Map<
    string,
    Array<{ seq: number; turnId?: string; type: string; data: Record<string, unknown> }>
  >();
  const problem = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status });
  const sessionByKey = new Map<string, Committed>();
  const turnByKey = new Map<string, Committed & { sessionId: string }>();
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const header = request.headers.get("idempotency-key");
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    state.requests.push({
      method: request.method,
      path: url.pathname,
      header,
      ...(typeof body.idempotencyKey === "string" ? { bodyKey: body.idempotencyKey } : {}),
    });
    const sessionMatch = url.pathname.match(/^\/api\/managed-agents\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (url.pathname === "/api/managed-agents/sessions" && request.method === "POST") {
      const fingerprint = JSON.stringify(body);
      const existing = header ? sessionByKey.get(header) : undefined;
      if (existing) {
        if (existing.body !== fingerprint) {
          return problem(409, "idempotency_conflict", "Idempotency-Key was already used with different input");
        }
        return Response.json({ session: { id: existing.id, status: "idle" } }, { status: 200 });
      }
      const created = { id: `ses_${String(state.sessions.length + 1).padStart(2, "0")}`, body: fingerprint };
      state.sessions.push(created);
      if (header) sessionByKey.set(header, created);
      events.set(created.id, [{ seq: 1, type: "runtime.connected", data: {} }]);
      if (state.loseNextSessionResponse) {
        state.loseNextSessionResponse = false;
        throw new TypeError("fetch failed: connection reset");
      }
      return Response.json({ session: { id: created.id, status: "connecting" } }, { status: 201 });
    }
    if (!sessionMatch) return problem(404, "not_found", url.pathname);
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const suffix = sessionMatch[2] ?? "";
    if (!state.sessions.some((session) => session.id === sessionId)) {
      return problem(404, "session_not_found", sessionId);
    }
    if (suffix === "turns" && request.method === "POST") {
      const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
      if (bodyKey && header && bodyKey !== header) {
        return problem(
          400,
          "invalid_turn",
          "Idempotency-Key header and idempotencyKey body field must be equal when both are present",
        );
      }
      const key = bodyKey ?? header ?? crypto.randomUUID();
      if (key.length > 256) return problem(400, "invalid_turn", "Idempotency-Key must be 1 to 256 characters");
      const fingerprint = JSON.stringify({ input: body.input, sessionId });
      const existing = turnByKey.get(key);
      if (existing) {
        if (existing.body !== fingerprint) {
          return problem(409, "idempotency_conflict", "idempotencyKey was already used with different input, payload, or mode");
        }
        return Response.json({ turnId: existing.id, duplicate: true }, { status: 200 });
      }
      if (state.refuseNextTurn) {
        const refusal = state.refuseNextTurn;
        state.refuseNextTurn = undefined;
        return problem(refusal.status, refusal.code, refusal.message);
      }
      const turn = { id: `turn_${String(state.turns.length + 1).padStart(2, "0")}`, body: fingerprint, sessionId };
      state.turns.push(turn);
      turnByKey.set(key, turn);
      const log = events.get(sessionId)!;
      log.push(
        {
          seq: log.length + 1,
          turnId: turn.id,
          type: "message.completed",
          data: { text: `echo: ${String(body.input)}` },
        },
        { seq: log.length + 2, turnId: turn.id, type: "turn.completed", data: { turnId: turn.id } },
      );
      if (state.loseNextTurnResponse) {
        state.loseNextTurnResponse = false;
        throw new TypeError("fetch failed: connection reset");
      }
      return Response.json({ turnId: turn.id, duplicate: false }, { status: 202 });
    }
    if (suffix.startsWith("events")) {
      const after = Number(url.searchParams.get("after") ?? "0");
      return Response.json({ events: (events.get(sessionId) ?? []).filter((event) => event.seq > after) });
    }
    if (suffix === "" && request.method === "GET") {
      const turns = state.turns.filter((turn) => turn.sessionId === sessionId);
      return Response.json({ id: sessionId, status: turns.length ? "running" : "idle" });
    }
    if (suffix === "suspend") return Response.json({ id: sessionId, status: "suspended" });
    return problem(404, "not_found", url.pathname);
  });
  return state;
}

const config = { apiUrl: "https://app.opencomputer.dev", apiKey: "test" };

function quiet(context: test.TestContext): void {
  context.mock.method(process.stderr, "write", () => true);
  context.mock.method(process.stdout, "write", () => true);
}

function createAndRun(
  api: FakeApi,
  options: {
    idempotencyKey?: string;
    sessionIdempotencyKey?: string;
    turnIdempotencyKey?: string;
    prompt?: string;
    memory?: Parameters<typeof runAgent>[7];
  } = {},
) {
  void api;
  const client = new OpenComputerClient(config, options.idempotencyKey);
  return runAgent(
    client,
    "support@development",
    options.prompt ?? "Summarize the queue",
    true,
    true,
    false,
    sessionCreateIdempotencyKeys(options),
    options.memory,
  );
}

async function partialFailure(promise: Promise<unknown>): Promise<CLIError & { details: SessionCreateOutcome }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CLIError, `expected a CLIError, got ${String(error)}`);
    assert.equal(error.code, "session_created_turn_failed");
    return error as CLIError & { details: SessionCreateOutcome };
  }
  assert.fail("the compound command should have failed");
}

test("OCFR-17 regression: one global key no longer loses the first turn to 400 invalid_turn", async (context) => {
  const api = fakeManagementApi(context);
  const client = new OpenComputerClient(config, "cypen-cmd-42");
  const created = await client.createSession("support@development");
  // The pre-fix CLI put the raw caller key in the turn body next to the
  // derived header, and the API refused the disagreement once the session
  // already existed.
  const turn = await client.createTurn(created.session.id, "hello", "cypen-cmd-42");
  assert.equal(turn.turnId, "turn_01");
  const request = api.requests.at(-1)!;
  assert.equal(request.bodyKey, request.header);
  assert.notEqual(request.bodyKey, "cypen-cmd-42");
});

test("acceptance 1: create-and-run completes with separate session and turn keys", async (context) => {
  quiet(context);
  const api = fakeManagementApi(context);
  const result = await createAndRun(api, {
    sessionIdempotencyKey: "cypen/session/1",
    turnIdempotencyKey: "cypen/turn/1",
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.session, { id: "ses_01", created: true, duplicate: false, status: "connecting" });
  assert.deepEqual(result.turn, { id: "turn_01", admitted: true, duplicate: false, status: "completed" });
  assert.equal(result.sessionId, "ses_01");
  assert.equal(result.turnId, "turn_01");
  assert.equal(result.output, "echo: Summarize the queue");
  const [session, turn] = api.requests.filter((request) => request.method === "POST");
  assert.ok(session?.header && turn?.header, "both mutations are keyed");
  assert.notEqual(session.header, turn.header);
  assert.equal(turn.bodyKey, turn.header, "the turn's header and body agree");
  assert.equal(session.header.includes("cypen/session/1"), false, "raw keys never leave the CLI");
});

test("acceptance 2: a lost session-create response converges on one session when retried", async (context) => {
  quiet(context);
  const api = fakeManagementApi(context);
  api.loseNextSessionResponse = true;
  await assert.rejects(createAndRun(api, { idempotencyKey: "cypen-cmd-7" }), /connection reset/);
  assert.equal(api.sessions.length, 1, "the session was committed before the response was lost");

  const retried = await createAndRun(api, { idempotencyKey: "cypen-cmd-7" });
  assert.equal(api.sessions.length, 1, "the retry did not create a second session");
  assert.equal(api.turns.length, 1);
  assert.deepEqual(retried.session, { id: "ses_01", created: false, duplicate: true, status: "idle" });
  assert.equal(retried.turn.admitted, true);
  assert.equal(retried.complete, true);
});

test("a replayed session with a fresh turn key waits for the new turn, not an earlier one", async (context) => {
  quiet(context);
  const api = fakeManagementApi(context);
  const first = await createAndRun(api, { sessionIdempotencyKey: "s", turnIdempotencyKey: "t1", prompt: "one" });
  assert.equal(first.turn.id, "turn_01");

  const second = await createAndRun(api, { sessionIdempotencyKey: "s", turnIdempotencyKey: "t2", prompt: "two" });
  assert.equal(second.session.id, "ses_01");
  assert.equal(second.session.duplicate, true);
  assert.deepEqual(second.turn, { id: "turn_02", admitted: true, duplicate: false, status: "completed" });
  assert.equal(second.output, "echo: two", "the earlier turn's output is not reported for the new turn");
});

test("acceptance 3: a lost turn-admission response converges on one turn when retried", async (context) => {
  quiet(context);
  const api = fakeManagementApi(context);
  api.loseNextTurnResponse = true;
  const failure = await partialFailure(createAndRun(api, { idempotencyKey: "cypen-cmd-8" }));
  assert.equal(failure.details.session.id, "ses_01");
  assert.equal(failure.details.session.created, true);
  assert.equal(failure.details.turn.admitted, false, "the CLI cannot know whether the turn committed");
  assert.equal(api.turns.length, 1, "the turn was committed before the response was lost");

  const retried = await createAndRun(api, { idempotencyKey: "cypen-cmd-8" });
  assert.equal(api.sessions.length, 1);
  assert.equal(api.turns.length, 1, "the retry replayed the committed turn");
  assert.deepEqual(retried.turn, { id: "turn_01", admitted: true, duplicate: true, status: "completed" });
  assert.equal(retried.session.duplicate, true);
});

test("acceptance 4: a turn refused before commit reports the existing idle session", async (context) => {
  quiet(context);
  const api = fakeManagementApi(context);
  api.refuseNextTurn = { status: 400, code: "invalid_turn", message: "Expected input" };
  const failure = await partialFailure(createAndRun(api, { idempotencyKey: "cypen-cmd-9" }));
  assert.deepEqual(failure.details, {
    session: { id: "ses_01", created: true, duplicate: false, status: "idle" },
    turn: { id: null, admitted: false, error: { code: "invalid_turn", message: "Expected input" } },
    complete: false,
  });
  assert.match(failure.message, /ses_01/);
  assert.match(failure.hint, /session end ses_01/);
  assert.equal(api.turns.length, 0);
});

test("acceptance 5: a changed prompt under the same turn key is a turn-key conflict", async (context) => {
  quiet(context);
  const api = fakeManagementApi(context);
  await createAndRun(api, { idempotencyKey: "cypen-cmd-10", prompt: "first wording" });
  const failure = await partialFailure(createAndRun(api, { idempotencyKey: "cypen-cmd-10", prompt: "second wording" }));
  assert.equal(failure.details.session.id, "ses_01");
  assert.equal(failure.details.session.duplicate, true);
  assert.equal(failure.details.turn.admitted, false);
  assert.equal(failure.details.turn.error?.code, "turn_idempotency_conflict");
  assert.match(failure.hint, /--turn-idempotency-key/);
  assert.equal(api.turns.length, 1, "no second turn was admitted");
});

test("acceptance 6: changed session bindings under the same session key are a session-key conflict", async (context) => {
  quiet(context);
  const api = fakeManagementApi(context);
  await createAndRun(api, {
    idempotencyKey: "cypen-cmd-11",
    memory: { requirements: { scope: "document", id: "workshop" } },
  });
  await assert.rejects(
    createAndRun(api, {
      idempotencyKey: "cypen-cmd-11",
      memory: { requirements: { scope: "document", id: "other" } },
    }),
    (error: unknown) => error instanceof CLIError && error.code === "session_idempotency_conflict",
  );
  assert.equal(api.sessions.length, 1, "no second session was created");
});

test("acceptance 7: the convenience global key derives non-colliding session and turn identities", async (context) => {
  quiet(context);
  const derived = sessionCreateIdempotencyKeys({ idempotencyKey: "root" });
  assert.notEqual(derived.session, derived.turn);
  assert.equal(derived.session?.includes("root"), true);
  assert.deepEqual(sessionCreateIdempotencyKeys({}), {});
  assert.deepEqual(
    sessionCreateIdempotencyKeys({ idempotencyKey: "root", sessionIdempotencyKey: "s", turnIdempotencyKey: "t" }),
    { session: "s", turn: "t" },
    "explicit keys win over the derived ones",
  );
  // A session created under root key A and a turn under root key B must not
  // share provider identities even when the raw strings are related.
  const api = fakeManagementApi(context);
  await createAndRun(api, { idempotencyKey: "cypen" });
  await createAndRun(api, { idempotencyKey: "session:cypen" });
  const headers = api.requests.filter((request) => request.method === "POST").map((request) => request.header);
  assert.equal(new Set(headers).size, headers.length, "every mutation carried a distinct provider key");
  assert.equal(api.sessions.length, 2);
  assert.equal(api.turns.length, 2);
});

test("acceptance 8: JSON output is sufficient for automated recovery and cleanup", async (context) => {
  quiet(context);
  const api = fakeManagementApi(context);
  api.refuseNextTurn = { status: 503, code: "runtime_unavailable", message: "try again" };
  const failure = await partialFailure(createAndRun(api, { idempotencyKey: "cypen-cmd-12" }));
  // What `--json` prints on stderr, round-tripped: the session to clean up
  // or retry against is addressable without parsing prose.
  const printed = JSON.parse(
    JSON.stringify({ error: { code: failure.code, message: failure.message, hint: failure.hint, details: failure.details } }),
  ) as { error: { code: string; details: SessionCreateOutcome } };
  assert.equal(printed.error.code, "session_created_turn_failed");
  assert.equal(printed.error.details.complete, false);
  assert.equal(typeof printed.error.details.session.id, "string");
  assert.equal(printed.error.details.turn.id, null);
  assert.equal(printed.error.details.turn.admitted, false);
  assert.equal(typeof printed.error.details.turn.error?.code, "string");

  const completed = await createAndRun(api, { idempotencyKey: "cypen-cmd-12" });
  const success = JSON.parse(JSON.stringify(completed)) as SessionCreateOutcome;
  assert.equal(success.complete, true);
  assert.equal(success.session.id, printed.error.details.session.id, "the retry converged on the reported session");
  assert.equal(api.sessions.length, 1);
});

test("session send with a global key sends one agreeing turn identity", async (context) => {
  const api = fakeManagementApi(context);
  const client = new OpenComputerClient(config, "cypen-send-1");
  const created = await client.createSession("support@development");
  const turn = await client.createTurn(created.session.id, "hello", "cypen-send-1");
  assert.equal(turn.duplicate, false);
  const request = api.requests.at(-1)!;
  assert.equal(request.bodyKey, request.header);
  assert.equal(request.header?.includes("cypen-send-1"), false);
  const replay = await client.createTurn(created.session.id, "hello", "cypen-send-1");
  assert.equal(replay.duplicate, true);
  assert.equal(api.turns.length, 1);
});

test("an unkeyed turn still carries a fresh random idempotency key", async (context) => {
  const api = fakeManagementApi(context);
  const client = new OpenComputerClient(config);
  const created = await client.createSession("support@development");
  await client.createTurn(created.session.id, "hello");
  await client.createTurn(created.session.id, "hello");
  const keys = api.requests.filter((request) => request.path.endsWith("/turns")).map((request) => request.bodyKey);
  assert.equal(keys.length, 2);
  assert.ok(keys[0] && keys[1] && keys[0] !== keys[1]);
  assert.equal(api.turns.length, 2);
});
