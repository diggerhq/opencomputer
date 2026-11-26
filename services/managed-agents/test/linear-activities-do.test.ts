// Work 037 stream S3: the activity queue's SQL on real Durable Object
// storage (workerd's SQLite, beside the Session object's own tables), so the
// node:sqlite unit suite cannot pass on a dialect difference. Authored
// fixtures; Linear is a fake that keeps activities by client id.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  LINEAR_SUPERSEDED_DRAIN_MS,
  LinearActivityQueue,
  enqueueLinearActivity,
  linearQueueDrained,
  postLinearActivityWith,
  setLinearSessionExternalLinkWith,
} from "../src/edge/linear-activities.js";
import type { LinearGraphqlRequest, LinearGraphqlResult } from "../src/edge/linear-contract.js";
import type { AgentEvent } from "../src/protocol.js";
import type { SessionDurableObject } from "../src/edge/session-do.js";

function fakeLinear() {
  const activities: Array<{ id: string; content: { type: string }; createdAt: string }> = [];
  let n = 0;
  return {
    activities,
    async graphql(_connectionId: string, request: LinearGraphqlRequest): Promise<LinearGraphqlResult> {
      const variables = request.variables ?? {};
      if (request.query.includes("agentActivityCreate")) {
        const input = variables.input as { id: string; content: { type: string } };
        if (activities.some((activity) => activity.id === input.id)) {
          return { outcome: "ok", data: null, errors: [{ message: "conflict on insert of AgentActivity" }] };
        }
        const createdAt = new Date(Date.UTC(2026, 9, 2, 12, 0, n++)).toISOString();
        activities.push({ id: input.id, content: input.content, createdAt });
        return {
          outcome: "ok",
          data: { agentActivityCreate: { success: true, agentActivity: { id: input.id, createdAt } } },
        };
      }
      if (request.query.includes("agentSessionUpdate")) {
        return { outcome: "ok", data: { agentSessionUpdate: { success: true } } };
      }
      return { outcome: "ok", data: { agentActivity: null } };
    },
  };
}

describe("Linear activity queue on Durable Object storage", () => {
  it("binds from the first Linear turn, posts in order, and answers a question turn with its elicitation only", async () => {
    await runInDurableObject(env.SESSIONS.getByName("linear-activities-do"), async (_instance, state) => {
      const storage = state.storage;
      const sql = storage.sql;
      const at = new Date().toISOString();
      sql.exec(
        `INSERT INTO session (id, account_id, user_id, agent_id, deployment_id, status,
           runtime_token_hash, created_at, updated_at)
         VALUES ('ses_linear', 'acct', 'user', 'agent', 'dep', 'running', 'hash', ?, ?)`,
        at,
        at,
      );
      const input = (turnId: string) =>
        JSON.stringify({
          source: "channel",
          text: "Investigate",
          channel: { provider: "linear", connectionId: "lc_1", conversationId: "as_1" },
          payload: { action: "created" },
          turnId,
        });
      for (const turnId of ["t1", "t2"]) {
        sql.exec(
          `INSERT INTO turns (id, input, input_json, mode, status, idempotency_key, created_at, updated_at)
           VALUES (?, 'Investigate', ?, 'queue', 'running', ?, ?, ?)`,
          turnId,
          input(turnId),
          `linear:${turnId}`,
          at,
          at,
        );
      }
      const linear = fakeLinear();
      const broadcasts: AgentEvent[] = [];
      const pending: Promise<unknown>[] = [];
      let eventCount = 0;
      const append = (type: string, turnId: string | undefined, data: Record<string, unknown>) => {
        const id = `e${String(++eventCount)}`;
        const seq = sql
          .exec<{ seq: number }>(
            "INSERT INTO events (id, timestamp, turn_id, type, data) VALUES (?, ?, ?, ?, ?) RETURNING seq",
            id,
            at,
            turnId ?? null,
            type,
            JSON.stringify(data),
          )
          .one().seq;
        return { id, seq, turnId, type, data } as unknown as AgentEvent;
      };
      const queue = new LinearActivityQueue({
        storage,
        account: () => ({
          postLinearActivity: (connectionId, post) => postLinearActivityWith(linear, connectionId, post),
          setLinearSessionExternalLink: (connectionId, agentSessionId, link) =>
            setLinearSessionExternalLinkWith(linear, connectionId, agentSessionId, link),
        }),
        appendEvent: (type, turnId, data) => append(type, turnId, data),
        questionElicitation: () => [],
        dispatch: () => undefined,
        broadcast: (events) => broadcasts.push(...events),
        scheduleAlarm: async () => undefined,
        waitUntil: (promise) => pending.push(promise),
      });

      // A tool call that returned, then the turn completes with a PR link.
      append("tool.started", "t1", { tool: "read", callId: "c1", input: { filePath: "README.md" } });
      queue.onTurnEvents("t1", [append("tool.completed", "t1", { tool: "read", callId: "c1", output: "ok" })]);
      await Promise.all(pending);
      storage.transactionSync(() => {
        sql.exec("UPDATE turns SET status = 'completed', settled_seq = 1 WHERE id = 't1'");
        append("message.completed", "t1", { finalText: "PR: https://github.com/acme/svc/pull/9" });
        append("turn.completed", "t1", {});
      });
      await queue.afterSettlement();

      // The next turn asks.
      storage.transactionSync(() => {
        sql.exec("UPDATE turns SET status = 'completed', settled_seq = 2 WHERE id = 't2'");
        append("message.completed", "t2", { finalText: "" });
        append("turn.completed", "t2", { outcome: "question", questionId: "q2" });
        append("question.asked", "t2", { questionId: "q2", text: "Go?", options: [] });
        enqueueLinearActivity(storage, {
          kind: "terminal",
          content: { type: "elicitation", body: "Go?" },
          questionId: "q2",
          signal: "select",
          signalMetadata: { options: [{ label: "Go", value: "go" }] },
        });
      });
      await queue.afterSettlement();
      expect(queue.nextDueAtMs()).toBeNull();

      const rows = sql
        .exec<{ seq: number; kind: string; state: string; turn_id: string | null; question_id: string | null }>(
          "SELECT seq, kind, state, turn_id, question_id FROM linear_activities ORDER BY seq",
        )
        .toArray();
      expect(rows).toEqual([
        { seq: 1, kind: "progress", state: "posted", turn_id: "t1", question_id: null },
        { seq: 2, kind: "progress", state: "posted", turn_id: "t1", question_id: null },
        { seq: 3, kind: "terminal", state: "posted", turn_id: "t1", question_id: null },
        { seq: 4, kind: "terminal", state: "posted", turn_id: "t2", question_id: "q2" },
      ]);
      expect(linear.activities.map((activity) => activity.content.type)).toEqual([
        "action",
        "response",
        "elicitation",
      ]);
      expect(broadcasts).toEqual([]);
    });
  });

  it("D3: reports drained only when nothing waits to post, or once an ended session's window passed", async () => {
    await runInDurableObject(env.SESSIONS.getByName("linear-activities-drained"), async (instance: SessionDurableObject, state) => {
      const storage = state.storage;
      const sql = storage.sql;
      const endedAt = new Date(Date.UTC(2026, 9, 2, 12, 0, 0)).toISOString();
      const endedMs = Date.parse(endedAt);
      expect(linearQueueDrained(storage)).toBe(true);
      sql.exec(
        `INSERT INTO session (id, account_id, user_id, agent_id, deployment_id, status,
           runtime_token_hash, created_at, updated_at)
         VALUES ('ses_drained', 'acct', 'user', 'agent', 'dep', 'running', 'hash', ?, ?)`,
        endedAt,
        endedAt,
      );
      sql.exec(
        `INSERT INTO turns (id, input, input_json, mode, status, idempotency_key, created_at, updated_at)
         VALUES ('t1', 'Investigate', ?, 'queue', 'completed', 'linear:d-1', ?, ?)`,
        JSON.stringify({
          source: "channel",
          text: "Investigate",
          channel: { provider: "linear", connectionId: "lc_1", conversationId: "as_1" },
        }),
        endedAt,
        endedAt,
      );
      storage.transactionSync(() =>
        enqueueLinearActivity(storage, { kind: "terminal", content: { type: "error", body: "Failed." } }),
      );
      // A live session with a row waiting: never drained.
      expect(linearQueueDrained(storage, endedMs + 10 * LINEAR_SUPERSEDED_DRAIN_MS)).toBe(false);
      sql.exec("UPDATE session SET status = 'ended'");
      expect(linearQueueDrained(storage, endedMs + LINEAR_SUPERSEDED_DRAIN_MS - 1)).toBe(false);
      expect(linearQueueDrained(storage, endedMs + LINEAR_SUPERSEDED_DRAIN_MS)).toBe(true);
      // The worker's own record of when it saw the end wins over the row's update time.
      sql.exec("UPDATE linear_binding SET ended_at_ms = ?", endedMs + 60_000);
      expect(linearQueueDrained(storage, endedMs + LINEAR_SUPERSEDED_DRAIN_MS)).toBe(false);
      sql.exec("UPDATE linear_activities SET state = 'posted'");
      expect(linearQueueDrained(storage, endedMs)).toBe(true);
      expect(instance.linearQueueDrained()).toBe(true);
    });
  });

  it("R3: the Session object enqueues the ingress's failure notice once per key, behind its queue", async () => {
    await runInDurableObject(env.SESSIONS.getByName("linear-activities-terminal"), async (instance: SessionDurableObject, state) => {
      const sql = state.storage.sql;
      expect(instance.enqueueLinearTerminal({ key: "k-1", body: "Failed." })).toBe(false);
      const at = new Date().toISOString();
      sql.exec(
        `INSERT INTO session (id, account_id, user_id, agent_id, deployment_id, status,
           runtime_token_hash, created_at, updated_at)
         VALUES ('ses_terminal', 'acct', 'user', 'agent', 'dep', 'ended', 'hash', ?, ?)`,
        at,
        at,
      );
      // Initialized, but no Linear input reached it: the caller posts itself.
      expect(instance.enqueueLinearTerminal({ key: "k-1", body: "Failed." })).toBe(false);
      sql.exec(
        `INSERT INTO turns (id, input, input_json, mode, status, idempotency_key, created_at, updated_at)
         VALUES ('t1', 'Investigate', ?, 'queue', 'running', 'linear:d-1', ?, ?)`,
        JSON.stringify({
          source: "channel",
          text: "Investigate",
          channel: { provider: "linear", connectionId: "lc_1", conversationId: "as_1" },
        }),
        at,
        at,
      );
      state.storage.transactionSync(() =>
        enqueueLinearActivity(state.storage, { kind: "progress", content: { type: "thought", body: "Working." } }),
      );
      expect(instance.enqueueLinearTerminal({ key: "k-1", body: "Failed." })).toBe(true);
      expect(instance.enqueueLinearTerminal({ key: "k-1", body: "Failed." })).toBe(true);
      // Let the background drain the RPC started finish inside the test.
      await (instance as unknown as { linearActivities: { drain(): Promise<void> } }).linearActivities.drain();
      const rows = sql
        .exec<{ seq: number; kind: string; content_json: string }>(
          "SELECT seq, kind, content_json FROM linear_activities ORDER BY seq",
        )
        .toArray()
        .map((row) => ({ seq: row.seq, kind: row.kind, content: JSON.parse(row.content_json) as unknown }));
      expect(rows).toEqual([
        { seq: 1, kind: "progress", content: { type: "thought", body: "Working." } },
        { seq: 2, kind: "terminal", content: { type: "error", body: "Failed." } },
      ]);
    });
  });
});
