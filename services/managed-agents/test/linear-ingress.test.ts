import { env, runDurableObjectAlarm, SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { bytesToHex, hmac } from "../src/channels/adapter.js";
import { derivedSessionId } from "../src/edge/account-do.js";
import {
  LINEAR_ACK_ATTEMPTS,
  LINEAR_ACK_TEXT,
  LINEAR_FAILURE_TEXT,
  LINEAR_STEP_BACKOFF_MS,
  LINEAR_STOPPED_TEXT,
  LinearIngress,
  linearSessionKey,
  type LinearDeliveryRow,
  type LinearLaunchInput,
  type LinearSessionPort,
  type LinearSessionRow,
} from "../src/edge/linear-ingress.js";
import {
  linearConnectionPrincipal,
  parseLinearConnectionPrincipal,
  type LinearConnectionStore,
  type LinearGraphqlRequest,
  type LinearGraphqlResult,
  type SessionControlInput,
  type SessionControlResult,
} from "../src/edge/linear-contract.js";
import type {
  EnqueueTurnInput,
  LinearConnection,
  LinearInputPayload,
  SessionStatus,
  StructuredAgentInput,
} from "../src/protocol.js";

/**
 * The Linear delivery ledger and session map against the Account object's
 * real SQLite storage, with a fake connection store (S1) and fake Session
 * objects (the Session RPCs, including S4's `applyControl`). Payloads are
 * authored in the shape of work 037's compact Linear contract.
 */

const SECRET = "lin_wh_test_signing_secret";
const ACCOUNT = "acct-linear";
const CONNECTION = `lc_${"a".repeat(32)}`;
const APP_USER = "app-user-1";
const T0 = Date.parse("2026-10-02T10:00:00.000Z");

// ── Fakes ────────────────────────────────────────────────────────────────────

type Graphql = (request: LinearGraphqlRequest) => LinearGraphqlResult | Promise<LinearGraphqlResult>;

function operation(request: LinearGraphqlRequest): string {
  return /(?:mutation|query)\s+(\w+)/.exec(request.query)?.[1] ?? "?";
}

class FakeConnections implements LinearConnectionStore {
  calls: Array<{ op: string; variables: Record<string, unknown> | undefined }> = [];
  events: string[] = [];
  revoked: string[] = [];
  teams: Array<{ allPublic: boolean; teamIds: string[] }> = [];
  connection: LinearConnection = {
    id: CONNECTION,
    projectId: "project-1",
    environment: "production",
    agentId: "agent-1",
    name: "Acme Agent",
    status: "connected",
    clientId: "client-1",
    appUserId: APP_USER,
    organizationId: "org-1",
    webhookUrl: "https://edge.example/v1/webhooks/linear/lc_test/token",
    createAppUrl: "https://linear.app/settings/api/applications/new",
    teams: { allPublic: false, teamIds: ["team-1", "team-3"] },
    revision: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  issueCreator = "user-1";
  parent: { id: string; identifier: string } | null = { id: "issue-0", identifier: "ACME-0" };
  activity: Graphql = () => ({
    outcome: "ok",
    data: { agentActivityCreate: { success: true, agentActivity: { id: "x" } } },
  });

  get(connectionId: string) {
    return connectionId === CONNECTION ? this.connection : null;
  }
  forAgent() {
    return this.connection;
  }
  async signingSecret(connectionId: string) {
    return connectionId === CONNECTION ? SECRET : null;
  }
  async graphql(_connectionId: string, request: LinearGraphqlRequest): Promise<LinearGraphqlResult> {
    const op = operation(request);
    this.calls.push({ op, variables: request.variables });
    if (op === "LinearAgentActivityCreate") return this.activity(request);
    const issue = {
      id: "issue-1",
      identifier: "ACME-1",
      title: "Add a health endpoint",
      description: "Authored fixture issue.",
      url: "https://linear.app/acme/issue/ACME-1",
      team: { id: "team-1", key: "ACME", name: "Acme" },
      parent: this.parent,
      creator: { id: this.issueCreator },
    };
    if (op === "LinearIssueContext") return { outcome: "ok", data: { issue } };
    if (op === "LinearSessionContext") {
      return { outcome: "ok", data: { agentSession: { id: request.variables?.id, issue } } };
    }
    return { outcome: "permanent", status: 400, message: `unexpected ${op}` };
  }
  async accessToken() {
    return { outcome: "unavailable" as const, reason: "not_found" as const };
  }
  recordEvent(_connectionId: string, at: string) {
    this.events.push(at);
  }
  markRevoked(connectionId: string) {
    this.revoked.push(connectionId);
  }
  updateTeams(_connectionId: string, teams: { allPublic: boolean; teamIds: string[] }) {
    this.teams.push(teams);
  }
  activityPosts() {
    return this.calls
      .filter((call) => call.op === "LinearAgentActivityCreate")
      .map((call) => (call.variables as { input: { id: string; agentSessionId: string; content: { type: string; body: string } } }).input);
  }
}

interface FakeTurn {
  turnId: string;
  key: string;
  input: string;
  agentInput?: StructuredAgentInput;
  providerTime?: string;
}

class FakeSession {
  status: SessionStatus = "idle";
  ready = true;
  turns: FakeTurn[] = [];
  controls: SessionControlInput[] = [];
  /** The Linear activity queue reports drained (D3). */
  drained = true;
  /** An open question: inputs are held behind it (S4's `HeldTurnReceipt`). */
  openQuestion: { id: string; status: "held" | "discarded" } | null = null;
  held: string[] = [];
  /** Terminal activities enqueued through the Session object's queue (R3), by key. */
  terminals: Array<{ key: string; body: string }> = [];
  constructor(
    readonly id: string,
    readonly userId: string,
  ) {}
}

class FakeSessions {
  sessions = new Map<string, FakeSession>();
  launches: LinearLaunchInput[] = [];
  log: string[] = [];
  launchFailure: Error | null = null;
  /** The enqueue commits and then its reply is lost, once. */
  loseNextEnqueueReply = false;
  /** Every enqueue fails while set. */
  enqueueFailure: Error | null = null;
  controlFailures = 0;

  private addTurn(session: FakeSession, input: EnqueueTurnInput) {
    const existing = session.turns.find((turn) => turn.key === input.idempotencyKey);
    if (existing) return { turnId: existing.turnId, status: "queued" as const, duplicate: true };
    const turn: FakeTurn = {
      turnId: `turn-${session.id.slice(0, 8)}-${String(session.turns.length + 1)}`,
      key: input.idempotencyKey,
      input: input.input,
      ...(input.agentInput ? { agentInput: input.agentInput } : {}),
      ...(input.providerTime ? { providerTime: input.providerTime } : {}),
    };
    session.turns.push(turn);
    this.log.push(`enqueue ${input.idempotencyKey}`);
    return { turnId: turn.turnId, status: "queued" as const, duplicate: false };
  }

  async launch(input: LinearLaunchInput) {
    this.launches.push(input);
    if (this.launchFailure) throw this.launchFailure;
    const session = new FakeSession(input.sessionId, linearConnectionPrincipal(input.connection.id));
    this.sessions.set(input.sessionId, session);
    this.addTurn(session, {
      input: input.text,
      idempotencyKey: input.idempotencyKey,
      agentInput: input.agentInput,
      providerTime: input.providerTime,
    });
  }

  port(sessionId: string): LinearSessionPort {
    return {
      findTurn: async (key) => {
        const turn = this.sessions.get(sessionId)?.turns.find((candidate) => candidate.key === key);
        return turn ? { turnId: turn.turnId, status: "queued" } : null;
      },
      state: async () => {
        const session = this.sessions.get(sessionId);
        return session
          ? { status: session.status, ready: session.ready, admitted: session.turns.length > 0 }
          : null;
      },
      enqueueTurn: async (input) => {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error("session not initialized");
        if (this.enqueueFailure) throw this.enqueueFailure;
        if (session.openQuestion) {
          const duplicate = session.held.includes(input.idempotencyKey);
          if (!duplicate) session.held.push(input.idempotencyKey);
          this.log.push(`hold ${input.idempotencyKey}`);
          return {
            status: session.openQuestion.status,
            questionId: session.openQuestion.id,
            heldId: `held_${input.idempotencyKey}`,
            duplicate,
          };
        }
        const receipt = this.addTurn(session, input);
        if (this.loseNextEnqueueReply) {
          this.loseNextEnqueueReply = false;
          throw new Error("RPC reply lost");
        }
        return receipt;
      },
      end: async () => {
        const session = this.sessions.get(sessionId);
        if (session) session.status = "ended";
        this.log.push(`end ${sessionId.slice(0, 8)}`);
      },
      linearQueueDrained: async () => this.sessions.get(sessionId)?.drained ?? true,
      enqueueLinearTerminal: async (input) => {
        const session = this.sessions.get(sessionId);
        // Bound to the Linear session once a Linear turn reached it.
        if (!session || session.turns.length === 0) return false;
        if (!session.terminals.some((terminal) => terminal.key === input.key)) {
          session.terminals.push(input);
        }
        this.log.push(`terminal ${input.body}`);
        return true;
      },
      applyControl: async (input): Promise<SessionControlResult> => {
        if (this.controlFailures > 0) {
          this.controlFailures -= 1;
          throw new Error("Session object unreachable");
        }
        const session = this.sessions.get(sessionId)!;
        const duplicate = session.controls.some((control) => control.deliveryId === input.deliveryId);
        if (!duplicate) session.controls.push(input);
        this.log.push(`applyControl ${input.deliveryId}`);
        return {
          deliveryId: input.deliveryId,
          duplicate,
          appliedAt: new Date(T0).toISOString(),
          discardedTurnKeys: [],
        };
      },
    };
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface Harness {
  ingress: LinearIngress;
  connections: FakeConnections;
  sessions: FakeSessions;
  clock: { now: number };
  rows(): LinearDeliveryRow[];
  row(id: string): LinearDeliveryRow;
  entry(agentSessionId: string): LinearSessionRow | null;
  deliver(id: string | null, body: unknown, options?: { secret?: string }): ReturnType<LinearIngress["accept"]>;
  /** Run the alarm's pass, advancing the clock until nothing is due or `limit` passes. */
  drain(limit?: number): Promise<void>;
  restart(): LinearIngress;
  /** SQL statements matching a fault throw, once each, as a crash mid-transaction would. */
  faults: Array<RegExp>;
  /** The Account object's real storage, bypassing the faults. */
  sql: SqlStorage;
}

let uuidCounter = 0;

async function withIngress(name: string, run: (harness: Harness) => Promise<void>): Promise<void> {
  const stub = env.ACCOUNTS.getByName(`linear-ingress-${name}`);
  await runInDurableObject(stub, async (_instance, state) => {
    const connections = new FakeConnections();
    const sessions = new FakeSessions();
    const clock = { now: T0 };
    const faults: RegExp[] = [];
    const sql = new Proxy(state.storage.sql, {
      get(target, property) {
        if (property === "exec") {
          return (query: string, ...bindings: SqlStorageValue[]) => {
            const fault = faults.findIndex((pattern) => pattern.test(query));
            if (fault >= 0) {
              faults.splice(fault, 1);
              throw new Error("injected storage fault");
            }
            return target.exec(query, ...bindings);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const storage = new Proxy(state.storage, {
      get(target, property) {
        if (property === "sql") return sql;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const build = () =>
      new LinearIngress({
        storage,
        connections: () => connections,
        session: (id) => sessions.port(id),
        launch: (input) => sessions.launch(input),
        deriveSessionId: derivedSessionId,
        resetAlarm: async () => undefined,
        now: () => clock.now,
        uuid: () => {
          uuidCounter += 1;
          return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
        },
      });
    const harness: Harness = {
      faults,
      sql: state.storage.sql,
      ingress: build(),
      connections,
      sessions,
      clock,
      rows: () =>
        state.storage.sql
          .exec<LinearDeliveryRow>("SELECT * FROM linear_deliveries ORDER BY received_at, id")
          .toArray(),
      row: (id) =>
        state.storage.sql
          .exec<LinearDeliveryRow>("SELECT * FROM linear_deliveries WHERE id = ?", id)
          .toArray()[0]!,
      entry: (agentSessionId) =>
        state.storage.sql
          .exec<LinearSessionRow>(
            "SELECT * FROM linear_sessions WHERE connection_id = ? AND agent_session_id = ?",
            CONNECTION,
            agentSessionId,
          )
          .toArray()[0] ?? null,
      deliver: async (id, body, options = {}) => {
        const payload = JSON.stringify(body);
        const signature = bytesToHex(await hmac("SHA-256", options.secret ?? SECRET, payload));
        return harness.ingress.accept({
          connectionId: CONNECTION,
          accountId: ACCOUNT,
          edgeOrigin: "https://edge.example",
          deliveryId: id,
          signature,
          payload,
        });
      },
      drain: async (limit = 10) => {
        for (let pass = 0; pass < limit; pass += 1) {
          await harness.ingress.enactDue(new Date(clock.now).toISOString());
          const next = state.storage.sql
            .exec<{ next_attempt_at: string }>(
              `SELECT next_attempt_at FROM linear_deliveries
               WHERE next_attempt_at IS NOT NULL ORDER BY next_attempt_at LIMIT 1`,
            )
            .toArray()[0]?.next_attempt_at;
          if (!next) return;
          clock.now = Math.max(clock.now, Date.parse(next));
        }
      },
      restart: () => {
        harness.ingress = build();
        return harness.ingress;
      },
    };
    await run(harness);
  });
}

// ── Fixtures (authored) ──────────────────────────────────────────────────────

const ISSUE = {
  id: "issue-1",
  identifier: "ACME-1",
  title: "Add a health endpoint",
  description: "Authored fixture issue.",
  url: "https://linear.app/acme/issue/ACME-1",
  teamId: "team-1",
  team: { id: "team-1", key: "ACME", name: "Acme" },
};

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function createdEvent(agentSessionId: string, options: { webhookTimestamp?: number; promptContext?: string } = {}) {
  return {
    type: "AgentSessionEvent",
    action: "created",
    createdAt: iso(-1_000),
    organizationId: "org-1",
    oauthClientId: "client-1",
    appUserId: APP_USER,
    webhookId: "webhook-1",
    webhookTimestamp: options.webhookTimestamp ?? T0,
    agentSession: {
      id: agentSessionId,
      status: "pending",
      issueId: ISSUE.id,
      issue: ISSUE,
      commentId: "comment-root",
      creatorId: "user-1",
      creator: { id: "user-1", name: "Pat Example" },
      createdAt: iso(-2_000),
    },
    agentActivity: null,
    promptContext:
      options.promptContext ??
      '<issue identifier="ACME-1"><title>Add a health endpoint</title><team name="Acme"/></issue>',
    previousComments: null,
    guidance: null,
  };
}

function promptedEvent(
  agentSessionId: string,
  body: string,
  createdAtOffsetMs: number,
  options: { signal?: string; activityId?: string } = {},
) {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    createdAt: iso(createdAtOffsetMs),
    organizationId: "org-1",
    oauthClientId: "client-1",
    appUserId: APP_USER,
    webhookId: "webhook-1",
    webhookTimestamp: T0,
    agentSession: {
      id: agentSessionId,
      status: "active",
      issueId: ISSUE.id,
      issue: ISSUE,
      commentId: "comment-root",
      creatorId: "user-1",
      creator: { id: "user-1", name: "Pat Example" },
    },
    agentActivity: {
      id: options.activityId ?? `act-${body.slice(0, 8)}-${String(createdAtOffsetMs)}`,
      createdAt: iso(createdAtOffsetMs),
      updatedAt: iso(createdAtOffsetMs),
      sourceCommentId: "comment-reply",
      userId: "user-2",
      user: { id: "user-2", name: "Sam Example", email: "sam@example.test", url: "https://linear.app/acme/profiles/sam" },
      signal: options.signal ?? null,
      signalMetadata: null,
      ephemeral: false,
      queued: false,
      sentAt: iso(createdAtOffsetMs),
      executionSkippedReason: null,
      pushSummary: null,
      content: { type: "prompt", body },
    },
    guidance: null,
  };
}

function sessionIdFor(agentSessionId: string, supersession: number): Promise<string> {
  return derivedSessionId(ACCOUNT, linearSessionKey(CONNECTION, agentSessionId, supersession));
}

function payloadOf(turn: { agentInput?: StructuredAgentInput }): LinearInputPayload {
  return turn.agentInput!.payload as unknown as LinearInputPayload;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("linear ingress: acceptance", () => {
  it("stores nothing for a bad signature or a stale timestamp", async () => {
    await withIngress("reject", async (h) => {
      const bad = await h.deliver("d-bad", createdEvent("as-1"), { secret: "wrong" });
      expect(bad.status).toBe(401);
      const stale = await h.deliver("d-stale", createdEvent("as-1", { webhookTimestamp: T0 - 61_000 }));
      expect(stale.status).toBe(401);
      expect(stale.body.error).toBe("stale");
      expect(h.rows()).toHaveLength(0);
      expect(h.connections.events).toHaveLength(0);
    });
  });

  it("answers a replayed delivery with the original result and changes nothing", async () => {
    await withIngress("replay", async (h) => {
      const first = await h.deliver("d-1", createdEvent("as-1"));
      expect(first).toEqual({ status: 200, body: { ok: true, deliveryId: "d-1", kind: "conversational" } });
      await h.drain();
      const settled = h.row("d-1");
      const replay = await h.deliver("d-1", createdEvent("as-1"));
      expect(replay).toEqual({
        status: 200,
        body: { ok: true, deliveryId: "d-1", kind: "conversational", duplicate: true },
      });
      await h.drain();
      expect(h.rows()).toHaveLength(1);
      expect(h.row("d-1")).toEqual(settled);
      expect(h.sessions.launches).toHaveLength(1);
      expect(h.connections.activityPosts()).toHaveLength(1);
      // Every verified agent session event is a health fact, the replay included.
      expect(h.connections.events).toHaveLength(2);
    });
  });
});

describe("linear ingress: conversational deliveries", () => {
  it("created: acknowledges with a persisted id, then one session and one turn", async () => {
    await withIngress("created", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      const ackId = h.row("d-1").ack_activity_id;
      expect(ackId).toMatch(/^[0-9a-f-]{36}$/);
      await h.drain();

      expect(h.connections.activityPosts()).toEqual([
        { id: ackId, agentSessionId: "as-1", content: { type: "thought", body: LINEAR_ACK_TEXT } },
      ]);
      const sessionId = await sessionIdFor("as-1", 0);
      expect(h.sessions.launches).toHaveLength(1);
      expect(h.sessions.launches[0]).toMatchObject({ sessionId, accountId: ACCOUNT, idempotencyKey: "linear:d-1" });
      const session = h.sessions.sessions.get(sessionId)!;
      expect(session.userId).toBe(`channel:linear:${CONNECTION}`);
      expect(session.turns).toHaveLength(1);
      const turn = session.turns[0]!;
      expect(turn.providerTime).toBe(iso(-2_000));
      expect(turn.agentInput).toMatchObject({
        source: "channel",
        text: expect.stringContaining("ACME-1"),
        channel: {
          provider: "linear",
          connectionId: CONNECTION,
          workspaceId: "org-1",
          conversationId: "as-1",
          userId: "user-1",
        },
      });
      expect(payloadOf(turn)).toMatchObject({
        action: "created",
        issue: { id: "issue-1", identifier: "ACME-1", team: { key: "ACME" } },
        origin: { parent: { id: "issue-0", identifier: "ACME-0" }, createdByAgent: false },
        session: { id: "as-1", creator: { id: "user-1", name: "Pat Example" } },
        promptContext: expect.stringContaining("ACME-1"),
      });
      expect(payloadOf(turn)).not.toHaveProperty("status");

      const row = h.row("d-1");
      expect(row.state).toBe("admitted");
      expect(row.ack_state).toBe("posted");
      expect(JSON.parse(row.receipt_json!)).toEqual({
        sessionId,
        turnId: turn.turnId,
        duplicate: false,
        supersession: 0,
      });
      expect(h.entry("as-1")).toMatchObject({
        session_id: sessionId,
        supersession: 0,
        parent_issue_id: "issue-0",
        parent_identifier: "ACME-0",
        created_by_agent: 0,
      });
      // The provider facts were read with the app token, once.
      expect(h.connections.calls.filter((call) => call.op === "LinearIssueContext")).toHaveLength(1);
    });
  });

  it("freezes createdByAgent from the issue creator and passes it on every input", async () => {
    await withIngress("by-agent", async (h) => {
      h.connections.issueCreator = APP_USER;
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      // Linear later says something else; the frozen fact does not move.
      h.connections.issueCreator = "user-9";
      h.connections.parent = null;
      await h.deliver("d-2", promptedEvent("as-1", "Carry on", 5_000));
      await h.drain();
      const turns = h.sessions.sessions.get(await sessionIdFor("as-1", 0))!.turns;
      expect(turns.map((turn) => payloadOf(turn).origin)).toEqual([
        { parent: { id: "issue-0", identifier: "ACME-0" }, createdByAgent: true },
        { parent: { id: "issue-0", identifier: "ACME-0" }, createdByAgent: true },
      ]);
      expect(turns[1]!.providerTime).toBe(iso(5_000));
      expect(turns[1]!.input).toBe("Carry on");
    });
  });

  it("retries the acknowledgement under the same id and treats a conflict as posted", async () => {
    await withIngress("ack-retry", async (h) => {
      let calls = 0;
      h.connections.activity = () => {
        calls += 1;
        return calls === 1
          ? { outcome: "transient", message: "503" }
          : { outcome: "ok", data: null, errors: [{ message: "conflict on insert of AgentActivity" }] };
      };
      await h.deliver("d-1", createdEvent("as-1"));
      await h.ingress.enactDue(new Date(h.clock.now).toISOString());
      expect(h.row("d-1")).toMatchObject({ state: "accepted", attempts: 1 });
      expect(h.sessions.launches).toHaveLength(0);
      await h.drain();
      const posts = h.connections.activityPosts();
      expect(posts).toHaveLength(2);
      expect(posts[0]!.id).toBe(posts[1]!.id);
      expect(h.row("d-1")).toMatchObject({ state: "admitted", ack_state: "posted" });
    });
  });

  it("admits without the acknowledgement once its short retry budget is spent", async () => {
    await withIngress("ack-abandon", async (h) => {
      h.connections.activity = () => ({ outcome: "transient", message: "503" });
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      expect(h.connections.activityPosts()).toHaveLength(LINEAR_ACK_ATTEMPTS);
      expect(h.row("d-1")).toMatchObject({ state: "admitted", ack_state: "abandoned" });
      expect(h.sessions.launches).toHaveLength(1);
    });
  });

  it("prompted before created: one session from the prompt; the late created is recorded, not admitted", async () => {
    await withIngress("reordered", async (h) => {
      await h.deliver("d-p", promptedEvent("as-1", "Please start", 1_000));
      await h.drain();
      const sessionId = await sessionIdFor("as-1", 0);
      expect(h.connections.calls.map((call) => call.op)).toEqual(["LinearSessionContext"]);
      expect(h.sessions.sessions.get(sessionId)!.turns.map((turn) => turn.input)).toEqual(["Please start"]);

      await h.deliver("d-c", createdEvent("as-1", { promptContext: "<issue>late context</issue>" }));
      await h.drain();
      const late = h.row("d-c");
      expect(late.state).toBe("invalidated");
      expect(JSON.parse(late.receipt_json!)).toMatchObject({ superseded: true, sessionId, by: "d-p" });
      // No acknowledgement after work began, and no second session or turn.
      expect(h.connections.activityPosts()).toHaveLength(0);
      expect(h.sessions.launches).toHaveLength(1);
      expect(h.sessions.sessions.get(sessionId)!.turns).toHaveLength(1);
      expect(h.entry("as-1")!.prompt_context).toBe("<issue>late context</issue>");

      await h.deliver("d-p2", promptedEvent("as-1", "Next", 9_000));
      await h.drain();
      const next = h.sessions.sessions.get(sessionId)!.turns[1]!;
      expect(payloadOf(next).promptContext).toBe("<issue>late context</issue>");
    });
  });

  it("recovers a crash between acceptance and acknowledgement", async () => {
    await withIngress("crash-accept", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      const ackId = h.row("d-1").ack_activity_id;
      // The object restarts before any step ran; the next alarm finds the row.
      h.restart();
      h.clock.now += 30_000;
      await h.drain();
      expect(h.connections.activityPosts().map((post) => post.id)).toEqual([ackId]);
      expect(h.row("d-1").state).toBe("admitted");
      expect(h.sessions.launches).toHaveLength(1);
    });
  });

  it("a turn replayed with the same key returns its original receipt", async () => {
    await withIngress("turn-replay", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      h.sessions.loseNextEnqueueReply = true;
      await h.deliver("d-2", promptedEvent("as-1", "More detail", 5_000));
      await h.drain(1);
      // The turn committed but the reply was lost: the row is still pending.
      expect(h.row("d-2")).toMatchObject({ state: "acknowledged", attempts: 1 });
      await h.drain();
      const sessionId = await sessionIdFor("as-1", 0);
      const turns = h.sessions.sessions.get(sessionId)!.turns;
      expect(turns.filter((turn) => turn.key === "linear:d-2")).toHaveLength(1);
      expect(JSON.parse(h.row("d-2").receipt_json!)).toEqual({
        sessionId,
        turnId: turns[1]!.turnId,
        duplicate: true,
        supersession: 0,
      });
    });
  });

  it("an ended session is superseded, never reused", async () => {
    await withIngress("supersede", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      const first = await sessionIdFor("as-1", 0);
      h.sessions.sessions.get(first)!.status = "ended";
      await h.deliver("d-2", promptedEvent("as-1", "Pick this up again", 60_000));
      await h.drain();
      const second = await sessionIdFor("as-1", 1);
      expect(second).not.toBe(first);
      expect(h.sessions.sessions.get(first)!.turns).toHaveLength(1);
      expect(h.sessions.sessions.get(second)!.turns.map((turn) => turn.key)).toEqual(["linear:d-2"]);
      const entry = h.entry("as-1")!;
      expect(entry).toMatchObject({ session_id: second, supersession: 1 });
      expect(JSON.parse(entry.superseded_json)).toEqual([
        expect.objectContaining({ sessionId: first, supersession: 0, by: "d-2" }),
      ]);
      expect(JSON.parse(h.row("d-2").receipt_json!)).toMatchObject({ sessionId: second, supersession: 1 });
    });
  });

  it("records failure after the retries and posts one error activity with a persisted id", async () => {
    await withIngress("failure", async (h) => {
      h.sessions.launchFailure = new Error("The Linear connection's agent is not deployed in production");
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain(20);
      expect(h.sessions.launches).toHaveLength(LINEAR_STEP_BACKOFF_MS.length + 1);
      const row = h.row("d-1");
      expect(row).toMatchObject({ state: "failed", error_activity_state: "posted" });
      expect(row.error).toContain("not deployed");
      const posts = h.connections.activityPosts();
      expect(posts.at(-1)).toEqual({
        id: row.error_activity_id,
        agentSessionId: "as-1",
        content: { type: "error", body: LINEAR_FAILURE_TEXT },
      });
      expect(posts.filter((post) => post.content.type === "error")).toHaveLength(1);
    });
  });

  it("fails without retries or notice when the connection is revoked", async () => {
    await withIngress("revoked-conn", async (h) => {
      await h.deliver("d-1", promptedEvent("as-1", "Hello", 1_000));
      h.connections.connection = { ...h.connections.connection, status: "revoked" };
      await h.drain();
      expect(h.row("d-1")).toMatchObject({ state: "failed", error_activity_state: "skipped" });
      expect(h.sessions.launches).toHaveLength(0);
      expect(h.connections.activityPosts()).toHaveLength(0);
    });
  });
});

describe("linear ingress: control deliveries", () => {
  it("stop is applied before anything else; an older pending prompt is invalidated, a newer one admitted", async () => {
    await withIngress("stop", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      const sessionId = await sessionIdFor("as-1", 0);
      h.sessions.log = [];

      // Delivered out of order: the stop arrives between two prompts, the
      // older of which Linear wrote before the stop.
      await h.deliver("d-old", promptedEvent("as-1", "Older prompt", 10_000));
      await h.deliver("d-stop", promptedEvent("as-1", "stop", 20_000, { signal: "stop" }));
      await h.deliver("d-new", promptedEvent("as-1", "Newer prompt", 30_000));
      expect(h.row("d-stop")).toMatchObject({ kind: "control", event: "stop", provider_time: iso(20_000) });
      await h.drain();

      expect(h.sessions.log).toEqual(["applyControl d-stop", "enqueue linear:d-new"]);
      expect(h.sessions.sessions.get(sessionId)!.controls).toEqual([
        { deliveryId: "d-stop", kind: "stop", providerTime: iso(20_000) },
      ]);
      expect(h.row("d-old")).toMatchObject({ state: "invalidated", error: "stopped by d-stop" });
      expect(h.row("d-new").state).toBe("admitted");
      const stop = h.row("d-stop");
      expect(stop.state).toBe("confirmed");
      expect(JSON.parse(stop.receipt_json!)).toMatchObject({ sessionId, invalidated: ["d-old"] });
      // "Stopped." for a live session is the Session object's activity queue's.
      expect(h.connections.activityPosts().filter((post) => post.content.type === "error")).toHaveLength(0);
    });
  });

  it("holds every later prompt of the session while its stop is not yet applied", async () => {
    await withIngress("stop-retry", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      h.sessions.log = [];
      h.sessions.controlFailures = 2;
      await h.deliver("d-stop", promptedEvent("as-1", "stop", 20_000, { signal: "stop" }));
      await h.deliver("d-new", promptedEvent("as-1", "Newer prompt", 30_000));
      await h.ingress.enactDue(new Date(h.clock.now).toISOString());
      expect(h.row("d-stop")).toMatchObject({ state: "accepted", attempts: 1 });
      expect(h.row("d-new").state).toBe("acknowledged");
      expect(h.sessions.log).toEqual([]);
      await h.drain();
      expect(h.sessions.log).toEqual(["applyControl d-stop", "enqueue linear:d-new"]);
    });
  });

  it("a stop that reaches no session invalidates pending work and confirms with Stopped.", async () => {
    await withIngress("stop-nosession", async (h) => {
      h.connections.activity = () => ({ outcome: "transient", message: "503" });
      await h.deliver("d-1", createdEvent("as-1"));
      await h.ingress.enactDue(new Date(h.clock.now).toISOString());
      h.connections.activity = () => ({ outcome: "ok", data: { agentActivityCreate: { success: true } } });
      await h.deliver("d-stop", promptedEvent("as-1", "stop", 20_000, { signal: "stop" }));
      await h.drain();
      expect(h.row("d-1").state).toBe("invalidated");
      expect(h.sessions.launches).toHaveLength(0);
      const stop = h.row("d-stop");
      expect(stop).toMatchObject({ state: "confirmed", error_activity_state: "posted" });
      expect(h.connections.activityPosts().at(-1)).toEqual({
        id: stop.error_activity_id,
        agentSessionId: "as-1",
        content: { type: "error", body: LINEAR_STOPPED_TEXT },
      });
    });
  });

  it("revocation and permission changes are applied to the connection", async () => {
    await withIngress("connection-controls", async (h) => {
      await h.deliver("d-perm", {
        type: "PermissionChange",
        action: "teamAccessChanged",
        createdAt: iso(0),
        organizationId: "org-1",
        webhookTimestamp: T0,
        canAccessAllPublicTeams: false,
        addedTeamIds: ["team-2"],
        removedTeamIds: ["team-3"],
      });
      await h.deliver("d-rev", {
        type: "OAuthApp",
        action: "revoked",
        createdAt: iso(1_000),
        organizationId: "org-1",
        oauthClientId: "client-1",
        webhookTimestamp: T0,
      });
      await h.deliver("d-auth", {
        type: "OAuthAuthorization",
        action: "created",
        organizationId: "org-1",
        webhookTimestamp: T0,
      });
      await h.drain();
      expect(h.connections.teams).toEqual([{ allPublic: false, teamIds: ["team-1", "team-2"] }]);
      expect(h.connections.revoked).toEqual([CONNECTION]);
      expect(h.row("d-perm").state).toBe("confirmed");
      expect(h.row("d-rev").state).toBe("confirmed");
      // Verified but not acted on: no ledger row. None of the three is an
      // agent session event, so health records no received event (D5).
      expect(h.rows().map((row) => row.id).sort()).toEqual(["d-perm", "d-rev"]);
      expect(h.connections.events).toHaveLength(0);
    });
  });
});

describe("linear ingress: review fixes", () => {
  it("B4: an input held behind an open question is recorded as held or discarded, never as a turn", async () => {
    await withIngress("b4-held", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      const sessionId = await sessionIdFor("as-1", 0);
      const session = h.sessions.sessions.get(sessionId)!;
      session.openQuestion = { id: "q-1", status: "held" };
      await h.deliver("d-2", promptedEvent("as-1", "Also check the logs", 5_000));
      await h.drain();
      const held = h.row("d-2");
      expect(held.state).toBe("admitted");
      expect(JSON.parse(held.receipt_json!)).toEqual({
        sessionId,
        held: true,
        questionId: "q-1",
        duplicate: false,
        supersession: 0,
      });
      session.openQuestion = { id: "q-1", status: "discarded" };
      await h.deliver("d-3", promptedEvent("as-1", "Never mind", 6_000));
      await h.drain();
      const discarded = JSON.parse(h.row("d-3").receipt_json!) as Record<string, unknown>;
      expect(discarded).toEqual({ sessionId, discarded: true, questionId: "q-1", duplicate: false, supersession: 0 });
      expect(discarded).not.toHaveProperty("turnId");
      expect(session.turns).toHaveLength(1);
    });
  });

  it("D1: a prompt released after Stopped. with an earlier createdAt is invalidated at acceptance", async () => {
    await withIngress("d1-accept", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      const sessionId = await sessionIdFor("as-1", 0);
      await h.deliver("d-stop", promptedEvent("as-1", "stop", 20_000, { signal: "stop" }));
      await h.drain();
      expect(h.entry("as-1")!.stopped_at).toBe(iso(20_000));
      h.sessions.log = [];
      // Linear held this message during the run and releases it now.
      const released = await h.deliver("d-held", promptedEvent("as-1", "Written during the run", 15_000));
      expect(released).toEqual({ status: 200, body: { ok: true, deliveryId: "d-held", kind: "conversational" } });
      expect(h.row("d-held")).toMatchObject({ state: "invalidated", next_attempt_at: null });
      expect(JSON.parse(h.row("d-held").receipt_json!)).toEqual({ stopped: true, stoppedAt: iso(20_000) });
      await h.deliver("d-new", promptedEvent("as-1", "Written after the stop", 25_000));
      await h.drain();
      expect(h.sessions.log).toEqual(["enqueue linear:d-new"]);
      expect(h.sessions.sessions.get(sessionId)!.turns.map((turn) => turn.key)).toEqual([
        "linear:d-1",
        "linear:d-new",
      ]);
    });
  });

  it("D1: admission re-checks the stop time on the map entry", async () => {
    await withIngress("d1-admit", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      h.sessions.log = [];
      await h.deliver("d-old", promptedEvent("as-1", "Older prompt", 10_000));
      // A stop applied after this row was accepted, whose sweep it missed.
      h.sql.exec(
        "UPDATE linear_sessions SET stopped_at = ? WHERE agent_session_id = 'as-1'",
        iso(20_000),
      );
      await h.drain();
      expect(h.row("d-old").state).toBe("invalidated");
      expect(h.sessions.log).toEqual([]);
    });
  });

  it("D1: a stop that reached no session still holds when the session is created later", async () => {
    await withIngress("d1-nosession", async (h) => {
      await h.deliver("d-stop", promptedEvent("as-1", "stop", 20_000, { signal: "stop" }));
      await h.drain();
      expect(h.row("d-stop").state).toBe("confirmed");
      await h.deliver("d-held", promptedEvent("as-1", "Written before the stop", 15_000));
      expect(h.row("d-held").state).toBe("invalidated");
      await h.deliver("d-new", promptedEvent("as-1", "Written after the stop", 25_000));
      await h.drain();
      expect(h.row("d-new").state).toBe("admitted");
      expect(h.entry("as-1")!.stopped_at).toBe(iso(20_000));
      expect(h.sessions.launches.map((launch) => launch.idempotencyKey)).toEqual(["linear:d-new"]);
    });
  });

  it("D2: a stop invalidates older prompts before the Session call, even while that call fails", async () => {
    await withIngress("d2-order", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      h.sessions.log = [];
      h.sessions.controlFailures = 100;
      await h.deliver("d-old", promptedEvent("as-1", "Older prompt", 10_000));
      await h.deliver("d-stop", promptedEvent("as-1", "stop", 20_000, { signal: "stop" }));
      await h.ingress.enactDue(new Date(h.clock.now).toISOString());
      expect(h.row("d-stop")).toMatchObject({ state: "accepted", attempts: 1 });
      expect(h.row("d-old")).toMatchObject({ state: "invalidated", error: "stopped by d-stop" });
      expect(h.entry("as-1")!.stopped_at).toBe(iso(20_000));
      await h.drain(20);
      expect(h.row("d-stop").state).toBe("failed");
      expect(h.row("d-old").state).toBe("invalidated");
      expect(h.sessions.log.filter((line) => line.startsWith("enqueue"))).toEqual([]);
    });
  });

  it("D3: an ended session is superseded only once its Linear activities drained", async () => {
    await withIngress("d3-drain", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      const first = await sessionIdFor("as-1", 0);
      const old = h.sessions.sessions.get(first)!;
      old.status = "ended";
      old.drained = false;
      await h.deliver("d-2", promptedEvent("as-1", "Pick this up again", 60_000));
      await h.drain(4);
      expect(h.row("d-2")).toMatchObject({ state: "acknowledged", attempts: 0 });
      expect(h.row("d-2").error).toContain("drain");
      expect(h.entry("as-1")!.supersession).toBe(0);
      expect(h.sessions.launches).toHaveLength(1);
      old.drained = true;
      await h.drain();
      const second = await sessionIdFor("as-1", 1);
      expect(h.entry("as-1")).toMatchObject({ session_id: second, supersession: 1 });
      expect(h.row("d-2").state).toBe("admitted");
    });
  });

  it("D5: only an agent session event is recorded as received", async () => {
    await withIngress("d5-health", async (h) => {
      await h.deliver("d-auth", {
        type: "OAuthAuthorization",
        action: "created",
        organizationId: "org-1",
        webhookTimestamp: T0,
      });
      await h.deliver("d-rev", {
        type: "OAuthApp",
        action: "revoked",
        createdAt: iso(1_000),
        organizationId: "org-1",
        oauthClientId: "client-1",
        webhookTimestamp: T0,
      });
      expect(h.connections.events).toEqual([]);
      await h.deliver("d-1", createdEvent("as-1"));
      expect(h.connections.events).toHaveLength(1);
    });
  });

  it("D7: the map entry and the ledger row's admission target commit together", async () => {
    await withIngress("d7-atomic", async (h) => {
      h.faults.push(/UPDATE linear_deliveries SET session_id = \?, input_json = \?/);
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain(1);
      // The reservation failed half way: neither half is visible.
      expect(h.entry("as-1")).toBeNull();
      expect(h.row("d-1")).toMatchObject({ state: "acknowledged", session_id: null, input_json: null, attempts: 1 });
      await h.drain();
      const sessionId = await sessionIdFor("as-1", 0);
      expect(h.entry("as-1")!.session_id).toBe(sessionId);
      expect(h.row("d-1")).toMatchObject({ state: "admitted", session_id: sessionId });
    });
  });

  it("R2: a session that is not ready but holds turns is retried, never ended", async () => {
    await withIngress("r2-retry", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      const sessionId = await sessionIdFor("as-1", 0);
      const session = h.sessions.sessions.get(sessionId)!;
      session.ready = false;
      h.sessions.log = [];
      await h.deliver("d-2", promptedEvent("as-1", "Next", 5_000));
      await h.drain(1);
      expect(h.row("d-2")).toMatchObject({ state: "acknowledged", attempts: 1 });
      expect(session.status).toBe("idle");
      expect(h.entry("as-1")!.supersession).toBe(0);
      session.ready = true;
      await h.drain();
      expect(h.sessions.log).toEqual(["enqueue linear:d-2"]);
      expect(JSON.parse(h.row("d-2").receipt_json!)).toMatchObject({ sessionId, supersession: 0 });
    });
  });

  it("R2: a session that is not ready and holds nothing is ended and superseded", async () => {
    await withIngress("r2-empty", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      const first = await sessionIdFor("as-1", 0);
      const session = h.sessions.sessions.get(first)!;
      session.ready = false;
      session.turns = [];
      await h.deliver("d-2", promptedEvent("as-1", "Next", 5_000));
      await h.drain();
      expect(session.status).toBe("ended");
      const second = await sessionIdFor("as-1", 1);
      expect(h.entry("as-1")).toMatchObject({ session_id: second, supersession: 1 });
      expect(h.row("d-2").state).toBe("admitted");
    });
  });

  it("R3: a failure on a session that answers the Linear session goes through its activity queue", async () => {
    await withIngress("r3-queue", async (h) => {
      await h.deliver("d-1", createdEvent("as-1"));
      await h.drain();
      const sessionId = await sessionIdFor("as-1", 0);
      h.sessions.enqueueFailure = new Error("Session object unreachable");
      await h.deliver("d-2", promptedEvent("as-1", "Next", 5_000));
      await h.drain(20);
      const row = h.row("d-2");
      expect(row).toMatchObject({ state: "failed", error_activity_state: "queued", next_attempt_at: null });
      expect(h.sessions.sessions.get(sessionId)!.terminals).toEqual([
        { key: row.error_activity_id, body: LINEAR_FAILURE_TEXT },
      ]);
      // The acknowledgement was direct; the failure notice was not.
      expect(h.connections.activityPosts().map((post) => post.content.type)).toEqual(["thought"]);
    });
  });
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

describe("linear ingress: route", () => {
  // The session list index the Session object publishes to, as the other
  // worker suites create it.
  beforeEach(async () => {
    await env.SERVERLESS_AGENTS_DB.prepare(
      `CREATE TABLE IF NOT EXISTS session_creations (
        session_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        countable INTEGER NOT NULL DEFAULT 1,
        exclusion_reason TEXT,
        outcome_at TEXT
      )`,
    ).run();
  });

  it("accepts a signed delivery durably and the Account alarm starts a connection-owned session", async () => {
    const created = await SELF.fetch("https://managedagents.test/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: "linear-e2e", slug: "linear-e2e" }),
    });
    expect(created.ok).toBe(true);
    const project = (await created.json()) as { id: string; agents: Array<{ id: string }> };
    const agentId = project.agents[0]!.id;
    const account = env.ACCOUNTS.getByName("local");
    await account.registerDeployment({
      agentId,
      alias: "production",
      channels: [],
      connections: [],
      artifact: { bucket: "artifacts", key: `${agentId}.json`, digest: "e".repeat(64), size: 10 },
      imageArn: "image",
      imageVersion: "1",
    });
    const token = "b".repeat(64);
    await env.ACCOUNTS.getByName(`linear:${CONNECTION}`).setChannelRoute({
      accountId: "local",
      connectionId: CONNECTION,
      webhookTokenHash: await sha256Hex(token),
      provider: "linear",
    });
    const connections = new FakeConnections();
    connections.connection = { ...connections.connection, projectId: project.id, agentId };
    await runInDurableObject(account, (instance) => {
      // S1 replaces this field with the real store; the test injects a fake.
      Object.defineProperty(instance, "linearConnections", { value: connections });
    });

    const payload = JSON.stringify(createdEvent("as-e2e", { webhookTimestamp: Date.now() }));
    const send = async (signature: string) =>
      SELF.fetch(`https://managedagents.test/v1/webhooks/linear/${CONNECTION}/${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "linear-delivery": "d-e2e",
          "linear-event": "AgentSessionEvent",
          "linear-signature": signature,
        },
        body: payload,
      });
    expect((await send("0".repeat(64))).status).toBe(401);
    const signature = bytesToHex(await hmac("SHA-256", SECRET, payload));
    const accepted = await send(signature);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, deliveryId: "d-e2e", kind: "conversational" });

    // The Account alarm enacts acknowledge, then admit. Workerd may fire it
    // on its own before the test forces it; wait for the row to settle.
    await runDurableObjectAlarm(account);
    let row: LinearDeliveryRow | undefined;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      row = await runInDurableObject(account, (_instance, state) =>
        state.storage.sql
          .exec<LinearDeliveryRow>("SELECT * FROM linear_deliveries WHERE id = 'd-e2e'")
          .toArray()[0]!,
      );
      if (row.state === "admitted" || row.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    row = row!;
    expect(row.state, JSON.stringify(row)).toBe("admitted");
    const receipt = JSON.parse(row.receipt_json!) as { sessionId: string; turnId: string };
    expect(receipt.sessionId).toBe(
      await derivedSessionId("local", linearSessionKey(CONNECTION, "as-e2e", 0)),
    );
    const snapshot = await env.SESSIONS.getByName(receipt.sessionId).snapshot();
    expect(snapshot.userId).toBe(`channel:linear:${CONNECTION}`);
    expect(parseLinearConnectionPrincipal(snapshot.userId)).toEqual({ connectionId: CONNECTION });
    expect(snapshot.source).toBe("channel");
    expect(await env.SESSIONS.getByName(receipt.sessionId).findTurn("linear:d-e2e")).toMatchObject({
      turnId: receipt.turnId,
    });
    expect(connections.activityPosts().map((post) => post.content)).toEqual([
      { type: "thought", body: LINEAR_ACK_TEXT },
    ]);

    // Linear's redelivery is answered with the original result.
    const again = await send(signature);
    expect(await again.json()).toEqual({
      ok: true,
      deliveryId: "d-e2e",
      kind: "conversational",
      duplicate: true,
    });
  });

  it("refuses a webhook URL without a live route", async () => {
    const response = await SELF.fetch("https://edge.example/v1/webhooks/linear/lc_missing/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});
