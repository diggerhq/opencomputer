// Work 037 stream S3: the Session object's Linear activity queue and the
// Account-side post. The queue runs against a real SQLite (node:sqlite)
// standing in for Durable Object storage, with the Session tables it reads
// (session, turns, events) reduced to the columns it uses. Linear is a fake
// that keeps activities by client id, the way the provider spike recorded it
// (work 037, spike part 1). All payloads are authored fixtures.

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LINEAR_FAILURE_TEXT,
  LINEAR_KEEPALIVE_TEXT,
  LINEAR_STOPPED_TEXT,
  LINEAR_SUPERSEDED_DRAIN_MS,
  LinearActivityQueue,
  enqueueLinearActivity,
  postLinearActivityWith,
  pullRequestUrl,
  setLinearSessionExternalLinkWith,
  summarizeToolParameter,
  type LinearActivityAccount,
  type LinearSessionLink,
  type LinearSessionUpdateResult,
} from "../src/edge/linear-activities.js";
import type {
  LinearActivityPost,
  LinearActivityPostResult,
  LinearConnectionStore,
  LinearGraphqlRequest,
  LinearGraphqlResult,
} from "../src/edge/linear-contract.js";
import type { AgentEvent } from "../src/protocol.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONNECTION = "lc_test";
const AGENT_SESSION = "as_fixture_1";

// ── A Durable Object storage stand-in over node:sqlite ──────────────────────

function sqliteStorage(): DurableObjectStorage {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  const exec = (query: string, ...bindings: unknown[]) => {
    const statement = db.prepare(query);
    const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
    const write = /^\s*(INSERT|UPDATE|DELETE)/i.test(query);
    const changes = write
      ? Number((db.prepare("SELECT changes() AS c").get() as { c: number }).c)
      : 0;
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`expected one row, got ${String(rows.length)}`);
        return rows[0];
      },
      rowsWritten: changes,
    };
  };
  const storage = {
    sql: { exec },
    transactionSync<T>(fn: () => T): T {
      const name = `sp${String(depth++)}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };
  return storage as unknown as DurableObjectStorage;
}

// ── A fake Linear that keeps activities by client id ────────────────────────

interface LinearActivity {
  id: string;
  agentSessionId: string;
  content: Record<string, unknown>;
  ephemeral?: boolean;
  signal?: string;
  signalMetadata?: unknown;
  createdAt: string;
}

class FakeLinear implements Pick<LinearConnectionStore, "graphql"> {
  readonly activities: LinearActivity[] = [];
  readonly sessionUpdates: Array<{ id: string; input: unknown }> = [];
  readonly requests: LinearGraphqlRequest[] = [];
  /** Outcomes to return instead of acting, consumed in order. */
  readonly scripted: LinearGraphqlResult[] = [];
  private clock = 0;

  async graphql(_connectionId: string, request: LinearGraphqlRequest): Promise<LinearGraphqlResult> {
    this.requests.push(request);
    const scripted = this.scripted.shift();
    if (scripted) return scripted;
    const variables = request.variables ?? {};
    if (request.query.includes("agentActivityCreate")) {
      const input = variables.input as LinearActivity;
      if (this.activities.some((activity) => activity.id === input.id)) {
        return { outcome: "ok", data: null, errors: [{ message: "conflict on insert of AgentActivity" }] };
      }
      const createdAt = new Date(Date.UTC(2026, 9, 2, 12, 0, this.clock++)).toISOString();
      this.activities.push({ ...input, createdAt });
      return {
        outcome: "ok",
        data: {
          agentActivityCreate: {
            success: true,
            agentActivity: { id: input.id, createdAt, content: { __typename: "AgentActivityThoughtContent" } },
          },
        },
      };
    }
    if (request.query.includes("agentActivity(")) {
      const found = this.activities.find((activity) => activity.id === variables.id);
      return {
        outcome: "ok",
        data: { agentActivity: found ? { id: found.id, createdAt: found.createdAt, content: { __typename: "X" } } : null },
      };
    }
    if (request.query.includes("agentSessionUpdate")) {
      this.sessionUpdates.push({ id: String(variables.id), input: variables.input });
      return { outcome: "ok", data: { agentSessionUpdate: { success: true } } };
    }
    throw new Error(`unexpected query ${request.query}`);
  }
}

/** The Account object as the queue sees it: the real post functions over the fake Linear. */
class FakeAccount implements LinearActivityAccount {
  readonly calls: Array<{ kind: "activity"; post: LinearActivityPost } | { kind: "link"; link: LinearSessionLink }> = [];
  /** Per-call overrides, consumed in order; "lose" posts and then throws as a lost response would. */
  readonly script: Array<LinearActivityPostResult | "lose" | "throw"> = [];

  constructor(readonly linear: FakeLinear) {}

  async postLinearActivity(connectionId: string, post: LinearActivityPost): Promise<LinearActivityPostResult> {
    this.calls.push({ kind: "activity", post });
    const next = this.script.shift();
    if (next === "throw") throw new Error("account unreachable");
    if (next === "lose") {
      await postLinearActivityWith(this.linear, connectionId, post);
      throw new Error("Network connection lost.");
    }
    if (next) return next;
    return postLinearActivityWith(this.linear, connectionId, post);
  }

  async setLinearSessionExternalLink(
    connectionId: string,
    agentSessionId: string,
    link: LinearSessionLink,
  ): Promise<LinearSessionUpdateResult> {
    this.calls.push({ kind: "link", link });
    return setLinearSessionExternalLinkWith(this.linear, connectionId, agentSessionId, link);
  }
}

// ── The Session object's tables, reduced ────────────────────────────────────

class Session {
  readonly storage = sqliteStorage();
  readonly linear = new FakeLinear();
  readonly account = new FakeAccount(this.linear);
  readonly broadcasts: AgentEvent[] = [];
  /** The Session object's question hook, as the queue calls it. */
  readonly elicitations: Array<{ questionId: string; outcome: Record<string, unknown> }> = [];
  dispatches = 0;
  readonly pending: Promise<unknown>[] = [];
  private settledSeq = 0;
  private eventSeq = 0;
  readonly queue: LinearActivityQueue;

  constructor(readonly linearSession = true) {
    const sql = this.storage.sql;
    sql.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE turns (
      id TEXT PRIMARY KEY, input TEXT NOT NULL, input_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL, settled_seq INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL,
      turn_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL)`);
    sql.exec("INSERT INTO session VALUES ('ses_1', 'idle', ?)", new Date().toISOString());
    this.queue = new LinearActivityQueue({
      storage: this.storage,
      account: () => this.account,
      appendEvent: (type, turnId, data) => this.event(type, turnId, data),
      questionElicitation: (questionId, outcome) => {
        this.elicitations.push({ questionId, outcome });
        return [];
      },
      dispatch: () => {
        this.dispatches++;
      },
      broadcast: (events) => this.broadcasts.push(...events),
      scheduleAlarm: async () => undefined,
      waitUntil: (promise) => this.pending.push(promise),
    });
  }

  event(type: AgentEvent["type"], turnId: string | undefined, data: Record<string, unknown>): AgentEvent {
    const id = `evt_${String(++this.eventSeq)}`;
    const timestamp = new Date().toISOString();
    const row = this.storage.sql
      .exec<{ seq: number }>(
        "INSERT INTO events (id, timestamp, turn_id, type, data) VALUES (?, ?, ?, ?, ?) RETURNING seq",
        id,
        timestamp,
        turnId ?? null,
        type,
        JSON.stringify(data),
      )
      .one();
    return {
      id,
      seq: row.seq,
      timestamp,
      protocolVersion: 2 as AgentEvent["protocolVersion"],
      accountId: "acct",
      agentId: "agent",
      deploymentId: "dep",
      sessionId: "ses_1",
      turnId,
      type,
      data,
    };
  }

  admit(turnId: string, text = "Please look at ACME-1"): void {
    const input = this.linearSession
      ? {
          source: "channel",
          text,
          channel: {
            provider: "linear",
            connectionId: CONNECTION,
            workspaceId: "org_fixture",
            conversationId: AGENT_SESSION,
            userId: "user_fixture",
          },
          payload: { action: "created" },
        }
      : { source: "user", text };
    const at = new Date().toISOString();
    this.storage.sql.exec(
      "INSERT INTO turns (id, input, input_json, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
      turnId,
      text,
      JSON.stringify(input),
      at,
      at,
    );
  }

  /** A tool call that started and returned, through the progress hook. */
  tool(turnId: string, callId: string, tool = "read", input: Record<string, unknown> = { filePath: "src/app.ts" }): void {
    this.event("tool.started", turnId, { tool, callId, input });
    const completed = this.event("tool.completed", turnId, { tool, callId, output: "line one\nline two" });
    this.queue.onTurnEvents(turnId, [completed]);
  }

  private settleRow(turnId: string, status: string): void {
    this.storage.sql.exec(
      "UPDATE turns SET status = ?, settled_seq = ?, updated_at = ? WHERE id = ?",
      status,
      ++this.settledSeq,
      new Date().toISOString(),
      turnId,
    );
  }

  complete(turnId: string, finalText: string): Promise<void> {
    this.storage.transactionSync(() => {
      this.settleRow(turnId, "completed");
      this.event("message.completed", turnId, { text: finalText, finalText });
      this.event("turn.completed", turnId, {});
    });
    return this.queue.afterSettlement();
  }

  fail(turnId: string): Promise<void> {
    this.storage.transactionSync(() => {
      this.settleRow(turnId, "failed");
      this.event("turn.failed", turnId, { message: "boom" });
    });
    return this.queue.afterSettlement();
  }

  cancel(turnId: string, data: Record<string, unknown> = { reason: "interrupted" }): Promise<void> {
    this.storage.transactionSync(() => {
      this.settleRow(turnId, "cancelled");
      this.event("turn.cancelled", turnId, data);
    });
    return this.queue.afterSettlement();
  }

  /** What stream S4 does in one transaction when a turn ends by asking. */
  ask(turnId: string, questionId: string, text: string, options: Array<{ label: string; value: string }>): Promise<void> {
    this.storage.transactionSync(() => {
      this.settleRow(turnId, "completed");
      this.event("message.completed", turnId, { text: "", finalText: "" });
      this.event("turn.completed", turnId, { outcome: "question", questionId });
      this.event("question.asked", turnId, { questionId, text, options });
      enqueueLinearActivity(this.storage, {
        kind: "terminal",
        content: { type: "elicitation", body: text },
        questionId,
        signal: "select",
        signalMetadata: { options },
      });
    });
    return this.queue.afterSettlement();
  }

  rows(): Array<Record<string, unknown>> {
    return this.storage.sql
      .exec("SELECT * FROM linear_activities ORDER BY seq")
      .toArray() as Array<Record<string, unknown>>;
  }

  posted(): string[] {
    return this.linear.activities.map((activity) => String(activity.content.type));
  }

  failures(): Array<Record<string, unknown>> {
    return this.broadcasts.filter((event) => event.type === "delivery.failed").map((event) => event.data);
  }

  async flush(): Promise<void> {
    while (this.pending.length > 0) await this.pending.shift();
  }
}

const transient: LinearActivityPostResult = { outcome: "transient", message: "HTTP 503" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

// ── The queue ───────────────────────────────────────────────────────────────

describe("Linear activity queue", () => {
  it("is a no-op for a session no Linear input reached", async () => {
    const session = new Session(false);
    session.admit("t1");
    session.storage.transactionSync(() =>
      enqueueLinearActivity(session.storage, { kind: "terminal", content: { type: "response", body: "hi" } }),
    );
    session.tool("t1", "c1");
    await session.complete("t1", "All done.");
    await session.flush();
    expect(session.rows()).toEqual([]);
    expect(session.account.calls).toEqual([]);
  });

  it("posts in seq order with a persisted UUIDv4 per activity, the terminal after the progress", async () => {
    const session = new Session();
    session.admit("t1");
    session.tool("t1", "c1", "read", { filePath: "src/a.ts" });
    advance(3_000);
    session.tool("t1", "c2", "grep", { pattern: "TODO" });
    await session.flush();
    await session.complete("t1", "Looked at both files.");

    const rows = session.rows();
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows.every((row) => UUID_V4.test(String(row.id)))).toBe(true);
    expect(rows.every((row) => row.state === "posted")).toBe(true);
    expect(session.linear.activities.map((activity) => activity.id)).toEqual(rows.map((row) => row.id));
    expect(session.linear.activities.map((activity) => activity.content)).toEqual([
      { type: "action", action: "read", parameter: "src/a.ts", result: "Completed (2 lines of output)" },
      { type: "action", action: "grep", parameter: "TODO", result: "Completed (2 lines of output)" },
      { type: "response", body: "Looked at both files." },
    ]);
    expect(session.linear.activities.every((activity) => activity.agentSessionId === AGENT_SESSION)).toBe(true);
  });

  it("retries a lost response with the same id and Linear keeps one activity (conflict means posted)", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push("lose");
    await session.complete("t1", "Answer.");
    expect(session.rows()[0]).toMatchObject({ state: "failed_transient", attempts: 1 });
    expect(session.linear.activities).toHaveLength(1);

    advance(2_000);
    await session.queue.onAlarm();
    const calls = session.account.calls.map((call) => (call.kind === "activity" ? call.post.id : "link"));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(calls[1]);
    expect(session.linear.activities).toHaveLength(1);
    expect(session.rows()[0]).toMatchObject({ state: "posted", attempts: 2 });
    expect(session.rows()[0]?.provider_created_at).toBe(session.linear.activities[0]?.createdAt);
  });

  it("posts at most one action per tool call and one per 3 s per session, never raw arguments", async () => {
    const session = new Session();
    session.admit("t1");
    session.tool("t1", "c1", "bash", { command: "curl -H 'Authorization: Bearer sk_fixture' https://example.test" });
    session.queue.onTurnEvents("t1", [session.event("tool.completed", "t1", { tool: "bash", callId: "c1", output: "x" })]);
    advance(1_000);
    session.tool("t1", "c2");
    advance(2_100);
    session.tool("t1", "c3", "webfetch", { url: "https://example.test/doc?token=secret" });
    await session.flush();

    const actions = session.linear.activities.map((activity) => activity.content);
    expect(actions).toEqual([
      { type: "action", action: "bash", parameter: "Ran a shell command", result: "Completed (2 lines of output)" },
      { type: "action", action: "webfetch", parameter: "https://example.test/doc", result: "Completed (2 lines of output)" },
    ]);
    expect(JSON.stringify(actions)).not.toContain("sk_fixture");
    expect(JSON.stringify(actions)).not.toContain("token=secret");
  });

  it("does not report the ask tool as an action", async () => {
    const session = new Session();
    session.admit("t1");
    session.tool("t1", "c1", "ask", { text: "Which one?" });
    await session.flush();
    expect(session.rows()).toEqual([]);
  });

  it("bridges a silent running turn with an ephemeral thought every 10 minutes", async () => {
    const session = new Session();
    session.admit("t1");
    await session.queue.onAlarm();
    expect(session.linear.activities).toHaveLength(0);
    expect(session.queue.nextDueAtMs()).toBe(Date.now() + 10 * 60_000);

    advance(10 * 60_000);
    await session.queue.onAlarm();
    expect(session.linear.activities).toEqual([
      expect.objectContaining({ content: { type: "thought", body: LINEAR_KEEPALIVE_TEXT }, ephemeral: true }),
    ]);
    advance(5 * 60_000);
    await session.queue.onAlarm();
    expect(session.linear.activities).toHaveLength(1);
    advance(5 * 60_000);
    await session.queue.onAlarm();
    expect(session.linear.activities).toHaveLength(2);
  });

  it("drops progress that arrives after its turn's terminal activity", async () => {
    const session = new Session();
    session.admit("t1");
    await session.complete("t1", "Done here.");
    advance(5_000);
    session.tool("t1", "late");
    session.storage.transactionSync(() =>
      enqueueLinearActivity(session.storage, {
        kind: "progress",
        turnId: "t1",
        content: { type: "thought", body: "late thought" },
      }),
    );
    await session.flush();
    expect(session.posted()).toEqual(["response"]);
    expect(session.rows()).toHaveLength(1);
  });

  it("drops a progress row after four failed attempts and the queue continues", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push(transient, transient, transient, transient);
    session.tool("t1", "c1");
    await session.flush();
    await session.complete("t1", "Final answer.");
    for (const wait of [2_000, 10_000, 30_000]) {
      advance(wait);
      await session.queue.onAlarm();
    }
    expect(session.rows().map((row) => row.state)).toEqual(["dropped", "posted"]);
    expect(session.posted()).toEqual(["response"]);
    expect(session.failures()).toEqual([
      expect.objectContaining({ kind: "progress", contentType: "action", state: "dropped", attempts: 4 }),
    ]);
  });

  it("retries a terminal row until it posts and raises delivery.failed after four attempts", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push(transient, transient, transient, transient, transient);
    await session.complete("t1", "Final answer.");
    for (const wait of [2_000, 10_000, 30_000]) {
      advance(wait);
      await session.queue.onAlarm();
    }
    expect(session.rows()[0]).toMatchObject({ state: "failed_transient", attempts: 4 });
    expect(session.failures()).toEqual([
      expect.objectContaining({ kind: "terminal", contentType: "response", retrying: true, attempts: 4 }),
    ]);
    advance(120_000);
    await session.queue.onAlarm();
    expect(session.rows()[0]).toMatchObject({ state: "failed_transient", attempts: 5 });
    advance(300_000);
    await session.queue.onAlarm();
    expect(session.rows()[0]).toMatchObject({ state: "posted", attempts: 6 });
    expect(session.posted()).toEqual(["response"]);
    expect(session.failures()).toHaveLength(1);
  });

  it("ends a permanently failed row at once, names it in delivery.failed, and proceeds", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push({ outcome: "permanent", message: "invalid input" });
    await session.complete("t1", "First.");
    session.admit("t2");
    await session.complete("t2", "Second.");
    expect(session.rows().map((row) => row.state)).toEqual(["failed_permanent", "posted"]);
    expect(session.linear.activities.map((activity) => activity.content)).toEqual([
      { type: "response", body: "Second." },
    ]);
    expect(session.failures()).toEqual([
      expect.objectContaining({ state: "failed_permanent", contentType: "response", error: "provider_rejected" }),
    ]);
  });

  it("invalidates the queue of an unavailable connection", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push({ outcome: "unavailable", reason: "revoked" });
    await session.complete("t1", "Answer.");
    expect(session.rows()[0]).toMatchObject({ state: "invalidated" });
    expect(session.failures()).toEqual([expect.objectContaining({ state: "invalidated", error: "connection_revoked" })]);
  });

  it("maps a failed turn to the failure error and a stopped turn to Stopped.", async () => {
    const session = new Session();
    session.admit("t1");
    await session.fail("t1");
    session.admit("t2");
    await session.cancel("t2", { reason: "interrupted" });
    session.admit("t3");
    await session.cancel("t3", { reason: "interrupted", replacementTurnId: "t4" });
    expect(session.linear.activities.map((activity) => activity.content)).toEqual([
      { type: "error", body: LINEAR_FAILURE_TEXT },
      { type: "error", body: LINEAR_STOPPED_TEXT },
    ]);
  });

  it("posts Stopped. once, for the turn that ran, never for held or discarded turns", async () => {
    const session = new Session();
    session.admit("t1");
    await session.cancel("t1", { reason: "held", questionId: "q1" });
    session.admit("t2");
    await session.cancel("t2", { reason: "stopped" });
    session.admit("t3");
    await session.cancel("t3", { reason: "stopped", discarded: true });
    expect(session.linear.activities.map((activity) => activity.content)).toEqual([
      { type: "error", body: LINEAR_STOPPED_TEXT },
    ]);
  });

  it("asks for the alarm at once when a stop drive settles a turn without the settlement hook", async () => {
    const session = new Session();
    session.admit("t1");
    session.storage.transactionSync(() => {
      session.storage.sql.exec("UPDATE turns SET status = 'cancelled', settled_seq = 1 WHERE id = 't1'");
      session.event("turn.cancelled", "t1", { reason: "interrupted" });
    });
    expect(session.queue.nextDueAtMs()).toBe(Date.now());
    await session.queue.onAlarm();
    expect(session.linear.activities.map((activity) => activity.content)).toEqual([
      { type: "error", body: LINEAR_STOPPED_TEXT },
    ]);
    expect(session.queue.nextDueAtMs()).toBeNull();
  });

  it("posts a question turn's elicitation with its options and no response, then records Linear's time", async () => {
    const session = new Session();
    session.admit("t1");
    session.tool("t1", "c1");
    await session.flush();
    const options = [
      { label: "Go", value: "go" },
      { label: "Revise", value: "revise" },
    ];
    await session.ask("t1", "q_t1_call9", "Proceed with the plan?", options);
    // A replayed settlement adds nothing.
    await session.queue.afterSettlement();

    expect(session.linear.activities.map((activity) => activity.content.type)).toEqual(["action", "elicitation"]);
    const elicitation = session.linear.activities[1]!;
    expect(elicitation).toMatchObject({
      content: { type: "elicitation", body: "Proceed with the plan?" },
      signal: "select",
      signalMetadata: { options },
    });
    expect(session.rows()[1]).toMatchObject({ turn_id: "t1", question_id: "q_t1_call9", kind: "terminal" });
    expect(session.elicitations).toEqual([
      { questionId: "q_t1_call9", outcome: { kind: "posted", providerTime: elicitation.createdAt } },
    ]);
  });

  it("reports an elicitation that fails permanently or is invalidated as undeliverable", async () => {
    const failed = new Session();
    failed.admit("t1");
    failed.account.script.push({ outcome: "permanent", message: "invalid input" });
    await failed.ask("t1", "q_failed", "Which?", [{ label: "A", value: "a" }]);
    expect(failed.rows()[0]).toMatchObject({ state: "failed_permanent", question_id: "q_failed" });
    expect(failed.elicitations).toEqual([{ questionId: "q_failed", outcome: { kind: "undeliverable" } }]);

    const invalidated = new Session();
    invalidated.admit("t1");
    invalidated.account.script.push({ outcome: "unavailable", reason: "revoked" });
    await invalidated.ask("t1", "q_invalid", "Which?", []);
    expect(invalidated.rows()[0]).toMatchObject({ state: "invalidated", question_id: "q_invalid" });
    expect(invalidated.elicitations).toEqual([{ questionId: "q_invalid", outcome: { kind: "undeliverable" } }]);

    // A failed row that is not an elicitation reports nothing.
    const plain = new Session();
    plain.admit("t1");
    plain.account.script.push({ outcome: "permanent", message: "invalid input" });
    await plain.complete("t1", "Answer.");
    expect(plain.elicitations).toEqual([]);
  });

  it("keeps the provider's message out of delivery.failed: error is a fixed code (item 8)", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push({ outcome: "permanent", message: "Argument Validation Error: issue ACME-12 'Secret plan'" });
    await session.complete("t1", "Answer.");
    const [failure] = session.failures();
    expect(failure).toEqual({
      channel: "linear",
      activityId: session.rows()[0]!.id,
      agentSessionId: expect.any(String),
      kind: "terminal",
      contentType: "response",
      state: "failed_permanent",
      attempts: 1,
      error: "provider_rejected",
      turnId: "t1",
    });
    expect(JSON.stringify(session.failures())).not.toContain("Secret plan");
    // The row keeps it for operators.
    expect(session.rows()[0]!.error).toContain("Secret plan");
  });

  it("does not record the question's time before the elicitation posts", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push(transient);
    await session.ask("t1", "q1", "Which?", [{ label: "A", value: "a" }]);
    expect(session.elicitations).toEqual([]);
    advance(2_000);
    await session.queue.onAlarm();
    expect(session.elicitations).toEqual([
      { questionId: "q1", outcome: { kind: "posted", providerTime: session.linear.activities[0]?.createdAt } },
    ]);
  });

  it("sets a pull request URL in the final message as the session's external link, before the response", async () => {
    const session = new Session();
    session.admit("t1");
    await session.complete(
      "t1",
      "Opened https://github.com/acme/service/pull/41 and then https://github.com/acme/service/pull/42.",
    );
    expect(session.account.calls.map((call) => call.kind)).toEqual(["link", "activity"]);
    expect(session.linear.sessionUpdates).toEqual([
      {
        id: AGENT_SESSION,
        input: { externalUrls: [{ label: "Pull request", url: "https://github.com/acme/service/pull/42" }] },
      },
    ]);
    expect(session.posted()).toEqual(["response"]);
  });

  it("lets a superseded session drain within the window, then invalidates what remains", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push(transient, transient);
    await session.complete("t1", "Last words.");
    session.storage.sql.exec("UPDATE session SET status = 'ended'");
    advance(2_000);
    await session.queue.onAlarm();
    expect(session.rows()[0]).toMatchObject({ state: "failed_transient", attempts: 2 });

    advance(LINEAR_SUPERSEDED_DRAIN_MS);
    await session.queue.onAlarm();
    expect(session.rows()[0]).toMatchObject({ state: "invalidated", attempts: 2 });
    expect(session.linear.activities).toHaveLength(0);
    expect(session.failures()).toEqual([
      expect.objectContaining({ state: "invalidated", error: "session_superseded" }),
    ]);
  });

  it("posts a superseded session's queue when it drains inside the window", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push(transient);
    await session.complete("t1", "Last words.");
    session.storage.sql.exec("UPDATE session SET status = 'ended'");
    advance(2_000);
    await session.queue.onAlarm();
    expect(session.posted()).toEqual(["response"]);
  });

  it("treats a failed Account call as transient and keeps the id", async () => {
    const session = new Session();
    session.admit("t1");
    session.account.script.push("throw");
    await session.complete("t1", "Answer.");
    advance(2_000);
    await session.queue.onAlarm();
    expect(session.rows()[0]).toMatchObject({ state: "posted", attempts: 2 });
  });
});

// ── Mapping helpers ─────────────────────────────────────────────────────────

describe("Linear activity mapping", () => {
  it("summarizes parameters within 120 characters", () => {
    expect(summarizeToolParameter("read", { filePath: `src/${"x".repeat(200)}.ts` })).toHaveLength(120);
    expect(summarizeToolParameter("custom", { other: 1 })).toBe("Called custom");
  });

  it("never copies a query argument, which is the call's raw input", () => {
    expect(
      summarizeToolParameter("linear_graphql", { query: "query { issue(id: \"ACME-1\") { title } }" }),
    ).toBe("Called linear_graphql");
    expect(summarizeToolParameter("sql", { query: "SELECT * FROM users", name: "users" })).toBe("users");
    expect(summarizeToolParameter("grep", { pattern: "TODO", path: "src" })).toBe("src");
  });

  it("finds the last GitHub pull request URL", () => {
    expect(pullRequestUrl("see https://github.com/a/b/pull/1 and https://github.com/a/b/pull/2")).toBe(
      "https://github.com/a/b/pull/2",
    );
    expect(pullRequestUrl("https://github.com/a/b/issues/3")).toBeNull();
  });
});

// ── The Account side ────────────────────────────────────────────────────────

describe("postLinearActivity", () => {
  const post: LinearActivityPost = {
    id: "8a6b7c1e-0f1d-4a5b-9c2d-3e4f5a6b7c8d",
    agentSessionId: AGENT_SESSION,
    content: { type: "elicitation", body: "Pick one" },
    signal: "select",
    signalMetadata: { options: [{ label: "A", value: "a" }] },
  };

  it("sends the client id, selects content subfields and passes signalMetadata as the options object", async () => {
    const linear = new FakeLinear();
    const result = await postLinearActivityWith(linear, CONNECTION, post);
    expect(result).toMatchObject({ outcome: "posted", duplicate: false });
    const request = linear.requests[0]!;
    expect(request.query).toContain("content { __typename }");
    expect(request.variables).toEqual({
      input: {
        id: post.id,
        agentSessionId: AGENT_SESSION,
        content: { type: "elicitation", body: "Pick one" },
        signal: "select",
        signalMetadata: { options: [{ label: "A", value: "a" }] },
      },
    });
  });

  it("reports a conflict on the id as posted, duplicate, with the original createdAt", async () => {
    const linear = new FakeLinear();
    const first = await postLinearActivityWith(linear, CONNECTION, post);
    const second = await postLinearActivityWith(linear, CONNECTION, post);
    expect(second).toEqual({
      outcome: "posted",
      duplicate: true,
      createdAt: first.outcome === "posted" ? first.createdAt : "",
    });
    expect(linear.activities).toHaveLength(1);
  });

  it("classifies rate limits as transient and invalid input as permanent", async () => {
    const linear = new FakeLinear();
    linear.scripted.push(
      { outcome: "ok", data: null, errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
      { outcome: "ok", data: null, errors: [{ message: "Argument Validation Error", extensions: { type: "invalid input" } }] },
      { outcome: "unavailable", reason: "revoked" },
      { outcome: "transient", message: "HTTP 502" },
      { outcome: "permanent", status: 400, message: "bad request" },
    );
    expect((await postLinearActivityWith(linear, CONNECTION, post)).outcome).toBe("transient");
    expect((await postLinearActivityWith(linear, CONNECTION, post)).outcome).toBe("permanent");
    expect(await postLinearActivityWith(linear, CONNECTION, post)).toEqual({ outcome: "unavailable", reason: "revoked" });
    expect((await postLinearActivityWith(linear, CONNECTION, post)).outcome).toBe("transient");
    expect((await postLinearActivityWith(linear, CONNECTION, post)).outcome).toBe("permanent");
  });

  it("sets the external link with agentSessionUpdate", async () => {
    const linear = new FakeLinear();
    const result = await setLinearSessionExternalLinkWith(linear, CONNECTION, AGENT_SESSION, {
      label: "Pull request",
      url: "https://github.com/acme/service/pull/7",
    });
    expect(result).toEqual({ outcome: "updated" });
    expect(linear.requests[0]?.query).toContain("agentSessionUpdate(id: $id, input: $input)");
  });
});
