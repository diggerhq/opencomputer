import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { OPENROUTER_MODEL_CATALOG_CACHE_KEY } from "../src/edge/model-catalog.js";
import type { AgentEvent, InitializeSessionResult, Project, SessionSnapshot } from "../src/protocol.js";
import { artifactBundle, artifactDigest } from "./fixtures/command-integrated-fixture.mjs";

/**
 * Command duration on the real path: a managed session at the edge, the
 * real Workerd host running the real OpenCode loop against a scripted
 * model, and a fake computer behind the SANDBOX binding that interprets
 * `sleep N` in fake seconds. What is real here: the tool schemas the model
 * sees, the validation before dispatch, the lifetime ceiling and computer
 * replacement, the polling deadline, and how a timeout reaches the model
 * as a tool error while the turn continues. What is not: the process unit
 * (see command-unit.test.ts) and the platform's AWS calls.
 */

const base = "https://managedagents.test";

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

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function waitForEvents(sessionId: string, predicate: (events: AgentEvent[]) => boolean): Promise<AgentEvent[]> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await SELF.fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}/events`);
    expect(response.status).toBe(200);
    const { events } = await response.json<{ events: AgentEvent[] }>();
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for session events");
}

interface SandboxLog {
  ensures: Array<{ sessionID: string; generation: number; sandboxId: string }>;
  executes: Array<{
    sessionID: string;
    sandboxId: string;
    generation: number;
    toolCallID: string;
    capability: string;
    request: Record<string, unknown>;
  }>;
  statuses: Array<{ sessionID: string; sandboxId: string; generation: number; toolCallID: string; after?: number; waitMs?: number }>;
  cancels: Array<{ sessionID: string; sandboxId: string; generation: number; toolCallID: string; reason: string }>;
  terminates: Array<{ sessionID: string; sandboxId: string | null; generation: number; preserve: boolean }>;
  probes: Array<{ sessionID: string; sandboxId: string; generation: number }>;
  sandboxes: Array<{ sandboxId: string; sessionID: string; generation: number; state: string }>;
  /** Keyed `<sessionID>:<generation>:<toolCallID>`. */
  operations: Array<{ key: string; status: string }>;
}

/** The ids the Session object holds for its host: the host object's name and the OpenCode session inside it. */
async function hostSessionIds(sessionId: string): Promise<{ runtimeSessionId: string; opencodeSessionId: string }> {
  return runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) => {
    const row = state.storage.sql
      .exec<{ runtime_session_id: string; opencode_session_id: string }>(
        "SELECT runtime_session_id, opencode_session_id FROM workerd_session WHERE slot = 1",
      )
      .one();
    return { runtimeSessionId: row.runtime_session_id, opencodeSessionId: row.opencode_session_id };
  });
}

/** The host object (OpenCodeSessionDurableObject) behind a managed session. */
async function hostOf(sessionId: string): Promise<DurableObjectStub> {
  const runtimeSessionId = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
    state.storage.sql
      .exec<{ runtime_session_id: string }>("SELECT runtime_session_id FROM workerd_session WHERE slot = 1")
      .one().runtime_session_id,
  );
  const hosts = (env as unknown as { OPENCODE_SESSIONS: DurableObjectNamespace }).OPENCODE_SESSIONS;
  return hosts.get(hosts.idFromName(runtimeSessionId));
}

const sandbox = () => (env as unknown as { SANDBOX: Fetcher }).SANDBOX;

/**
 * The fake computer's log, scoped to one managed session. The fake keeps a
 * single log for the whole file, and a session of an earlier test keeps
 * working after that test returned: its host's idle alarm terminates the
 * computer it left behind, which lands in the log while a later test is
 * running. A window over the unscoped log (a length taken at the start of
 * the test) sees that late work; the session's own entries do not.
 */
async function sandboxLog(sessionId: string): Promise<SandboxLog> {
  const log = await (await sandbox().fetch("https://sandbox.invalid/v1/sandboxes/inspect")).json<SandboxLog>();
  const own = <T extends { sessionID: string }>(entries: T[]): T[] => entries.filter((entry) => entry.sessionID === sessionId);
  return {
    ensures: own(log.ensures),
    executes: own(log.executes),
    statuses: own(log.statuses),
    cancels: own(log.cancels),
    terminates: own(log.terminates),
    probes: own(log.probes),
    sandboxes: own(log.sandboxes),
    operations: log.operations.filter((operation) => operation.key.startsWith(`${sessionId}:`)),
  };
}

async function controlSandbox(patch: Record<string, unknown>): Promise<void> {
  const response = await sandbox().fetch(
    "https://sandbox.invalid/v1/sandboxes/test-control",
    jsonRequest("POST", patch),
  );
  expect(response.status).toBe(200);
}

/** The host's operation ledger and lease for a managed session's runtime session. */
async function hostState(sessionId: string): Promise<{
  operations: Array<{
    tool_call_id: string;
    outcome: string | null;
    generation: number | null;
    turn_id: string | null;
    abandoned_at: number | null;
  }>;
  lease:
    | { state: string; generation: number; sandbox_id: string | null; expires_at: number | null; probe_due: number; retire_reason: string | null }
    | undefined;
}> {
  const runtimeSessionId = await runInDurableObject(env.SESSIONS.getByName(sessionId), (_instance, state) =>
    state.storage.sql
      .exec<{ runtime_session_id: string }>("SELECT runtime_session_id FROM workerd_session WHERE slot = 1")
      .one().runtime_session_id,
  );
  const hosts = (env as unknown as { OPENCODE_SESSIONS: DurableObjectNamespace }).OPENCODE_SESSIONS;
  return runInDurableObject(hosts.get(hosts.idFromName(runtimeSessionId)), (_instance, state) => ({
    operations: state.storage.sql
      .exec<{
        tool_call_id: string;
        outcome: string | null;
        generation: number | null;
        turn_id: string | null;
        abandoned_at: number | null;
      }>(
        "SELECT tool_call_id, outcome, generation, turn_id, abandoned_at FROM workerd_capability_faults ORDER BY created_at",
      )
      .toArray(),
    lease: state.storage.sql
      .exec<{ state: string; generation: number; sandbox_id: string | null; expires_at: number | null; probe_due: number; retire_reason: string | null }>(
        "SELECT state, generation, sandbox_id, expires_at, probe_due, retire_reason FROM workerd_sandbox_lease WHERE slot = 1",
      )
      .toArray()[0],
  }));
}

interface Fixture {
  project: Project;
  createSession(): Promise<string>;
  /** Runs one turn to its terminal event and returns the turn's events. */
  turn(sessionId: string, input: string, key: string): Promise<{ turnId: string; events: AgentEvent[] }>;
}

async function fixture(): Promise<Fixture> {
  await caches.default.put(
    OPENROUTER_MODEL_CATALOG_CACHE_KEY,
    Response.json(
      { fetchedAt: Date.now(), ids: ["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-5"] },
      { headers: { "cache-control": "public, max-age=3600" } },
    ),
  );
  const created = await SELF.fetch(
    `${base}/v1/projects`,
    jsonRequest("POST", { environmentMode: "legacy", name: `Integrated commands ${crypto.randomUUID().slice(0, 8)}` }),
  );
  expect(created.status).toBe(201);
  const body = await created.json<{ project?: Project } & Project>();
  const project = body.project ?? body;
  const digest = await artifactDigest();
  const deployed = await SELF.fetch(
    `${base}/v1/deployments`,
    jsonRequest("POST", {
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      imageArn: "test-image",
      imageVersion: "1",
      artifact: { bucket: "test-artifacts", key: digest, digest, size: artifactBundle.byteLength },
      models: [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
    }),
  );
  expect(deployed.status).toBe(201);
  return {
    project,
    createSession: async () => {
      const response = await SELF.fetch(
        `${base}/v1/sessions`,
        jsonRequest("POST", { agentId: `${project.agentId}@development` }),
      );
      expect(response.status).toBe(201);
      const { session } = await response.json<InitializeSessionResult>();
      expect(session).toMatchObject({ executionMode: "workerd", status: "idle" });
      return session.id;
    },
    turn: async (sessionId, input, key) => {
      const response = await SELF.fetch(
        `${base}/v1/sessions/${sessionId}/turns`,
        jsonRequest("POST", { input, idempotencyKey: key }),
      );
      expect(response.status).toBe(202);
      const { turnId } = await response.json<{ turnId: string }>();
      const events = await waitForEvents(sessionId, (current) =>
        current.some(
          (event) =>
            event.turnId === turnId &&
            (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled"),
        ),
      );
      return { turnId, events: events.filter((event) => event.turnId === turnId) };
    },
  };
}

function run(input: Record<string, unknown>): string {
  return `run:${JSON.stringify(input)}`;
}

function finalText(events: AgentEvent[]): string {
  return String(events.find((event) => event.type === "message.completed")?.data.text ?? "");
}

function terminal(events: AgentEvent[]): string[] {
  return events.filter((event) => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)).map((event) => event.type);
}

describe("command duration through the edge, the real host and a fake computer", () => {
  it("runs the same provider call label independently in two canonical turns (VB-01)", async () => {
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(
      sessionId,
      run({ _providerCallId: "call_0", command: "echo discovery", timeoutSeconds: 5 }),
      "vb-01-discovery",
    );
    const second = await f.turn(
      sessionId,
      run({ _providerCallId: "call_0", command: "echo testing", timeoutSeconds: 5 }),
      "vb-01-testing",
    );

    expect(terminal(first.events)).toEqual(["turn.completed"]);
    expect(terminal(second.events)).toEqual(["turn.completed"]);
    expect(finalText(first.events)).toContain("discovery");
    expect(finalText(second.events)).toContain("testing");

    const executes = (await sandboxLog(sessionId)).executes;
    expect(executes.map((execute) => execute.request.command)).toEqual([
      "echo discovery",
      "echo testing",
    ]);
    expect(new Set(executes.map((execute) => execute.toolCallID)).size).toBe(2);

    const started = [...first.events, ...second.events].filter(
      (event) => event.type === "tool.started",
    );
    const identities = started.map(
      (event) => event.data.identity as { providerCallId?: unknown; toolCallId?: unknown },
    );
    expect(started.map((event) => event.data.callId)).toEqual(["call_0", "call_0"]);
    expect(identities.map((identity) => identity.providerCallId)).toEqual([
      "call_0",
      "call_0",
    ]);
    expect(new Set(identities.map((identity) => identity.toolCallId)).size).toBe(2);
    expect(new Set(started.map((event) => event.turnId)).size).toBe(2);
  });

  it("runs a long command to completion under a long enough timeout, with the timeout on the wire", async () => {
    const f = await fixture();
    const sessionId = await f.createSession();
    const { turnId, events } = await f.turn(sessionId, run({ command: "sleep 300", timeoutSeconds: 600 }), "long-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    expect(finalText(events)).toContain('"exitCode":0');
    const log = await sandboxLog(sessionId);
    expect(log.executes).toEqual([
      expect.objectContaining({
        capability: "exec",
        generation: 1,
        request: expect.objectContaining({ command: "sleep 300", timeoutSeconds: 600 }),
      }),
    ]);
    const host = await hostState(sessionId);
    expect(host.operations).toEqual([expect.objectContaining({ outcome: "completed", generation: 1, turn_id: turnId })]);
    expect(host.lease).toMatchObject({ state: "ready", generation: 1, sandbox_id: expect.stringMatching(/^sb-/) });
    expect(host.lease!.expires_at).toBeGreaterThan(Date.now());
  });

  it("fails the call to the model when the timeout elapses; the turn continues and the outcome is recorded", async () => {
    const f = await fixture();
    const sessionId = await f.createSession();
    const { events } = await f.turn(sessionId, run({ command: "sleep 300", timeoutSeconds: 60 }), "short-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    expect(events.some((event) => event.type === "tool.failed")).toBe(true);
    const text = finalText(events);
    // The error reaches the model as the tool's result, JSON-encoded.
    expect(text).toContain("timed out after 60 seconds and was terminated");
    expect(text).toContain("process unit: cgroup");
    expect(text).toContain("partial output before the cutoff");
    expect(text).toContain("Writes it completed before that remain");
    expect((await hostState(sessionId)).operations).toEqual([expect.objectContaining({ outcome: "timed_out" })]);
  });

  it("routes the harness's built-in shell to the computer", async () => {
    const f = await fixture();
    const sessionId = await f.createSession();
    const { events } = await f.turn(sessionId, run({ tool: "shell", command: "echo hello from shell", timeoutSeconds: 5 }), "shell-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    expect(finalText(events)).toContain("hello from shell");
    expect((await sandboxLog(sessionId)).executes).toEqual([
      expect.objectContaining({
        capability: "exec",
        request: expect.objectContaining({ command: "echo hello from shell", timeoutSeconds: 5 }),
      }),
    ]);
    expect(events.filter((event) => event.type === "tool.started").map((event) => JSON.stringify(event.data))).toEqual([
      expect.stringContaining("shell"),
    ]);
  });

  it("defaults the timeout and refuses an out-of-range one before anything is dispatched", async () => {
    const f = await fixture();
    const sessionId = await f.createSession();
    const defaulted = await f.turn(sessionId, run({ command: "echo default" }), "default-1");
    expect(terminal(defaulted.events)).toEqual(["turn.completed"]);
    expect((await sandboxLog(sessionId)).executes).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ command: "echo default", timeoutSeconds: 120 }),
      }),
    ]);
    const refused = await f.turn(sessionId, run({ command: "echo never", timeoutSeconds: 1801 }), "range-1");
    expect(terminal(refused.events)).toEqual(["turn.completed"]);
    expect(refused.events.some((event) => event.type === "tool.failed")).toBe(true);
    // The harness enforces the schema's bounds before the tool runs.
    expect(finalText(refused.events)).toContain("timeoutSeconds");
    expect(finalText(refused.events)).toContain("1800");
    expect((await sandboxLog(sessionId)).executes).toHaveLength(1);
    expect((await hostState(sessionId)).operations.map((operation) => operation.outcome)).toEqual(["completed"]);
  });

  it("acquires a new computer, after confirmed termination of the old one, when the current one cannot host the command", async () => {
    await controlSandbox({ lifetimeMs: 400_000 });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(sessionId, run({ command: "echo first", timeoutSeconds: 5 }), "life-1");
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    const oldLease = (await hostState(sessionId)).lease!;
    expect(oldLease).toMatchObject({ state: "ready", generation: 1 });

    // A fresh computer lives an hour again; the running one has under seven
    // minutes, which minus the termination reserve cannot host ten.
    await controlSandbox({ lifetimeMs: 3_600_000 });
    const second = await f.turn(sessionId, run({ command: "sleep 1", timeoutSeconds: 600 }), "life-2");
    expect(terminal(second.events)).toEqual(["turn.completed"]);
    expect(finalText(second.events)).toContain('"exitCode":0');
    const log = await sandboxLog(sessionId);
    // Retired for lifetime, healthy: its filesystem is asked to be preserved.
    expect(log.terminates).toEqual([
      expect.objectContaining({ sandboxId: oldLease.sandbox_id, generation: 1, preserve: true }),
    ]);
    expect(log.ensures.map((ensure) => ensure.generation)).toEqual([1, 2]);
    const executes = log.executes;
    expect(executes.map((execute) => [execute.generation, execute.request.command])).toEqual([
      [1, "echo first"],
      [2, "sleep 1"],
    ]);
    expect(executes[1]!.sandboxId).not.toBe(oldLease.sandbox_id);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
  });

  it("retries an unconfirmed termination before another computer mounts the workspace", async () => {
    await controlSandbox({ lifetimeMs: 400_000 });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(sessionId, run({ command: "echo first", timeoutSeconds: 5 }), "confirm-1");
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    await controlSandbox({ lifetimeMs: 3_600_000, failTerminate: 1 });

    // The platform fails to confirm: the call fails, the lease stays
    // `terminating`, and no computer was launched.
    const failed = await f.turn(sessionId, run({ command: "sleep 1", timeoutSeconds: 600 }), "confirm-2");
    expect(terminal(failed.events)).toEqual(["turn.completed"]);
    expect(finalText(failed.events)).toContain("could not be confirmed terminated");
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "terminating", generation: 1 });
    expect((await sandboxLog(sessionId)).ensures.map((ensure) => ensure.generation)).toEqual([1]);

    // The next command confirms first, then acquires generation 2.
    const recovered = await f.turn(sessionId, run({ command: "echo again", timeoutSeconds: 5 }), "confirm-3");
    expect(terminal(recovered.events)).toEqual(["turn.completed"]);
    expect(finalText(recovered.events)).toContain("echo again");
    const log = await sandboxLog(sessionId);
    expect(log.terminates.map((terminate) => terminate.generation)).toEqual([1, 1]);
    expect(log.ensures.map((ensure) => ensure.generation)).toEqual([1, 2]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
  });

  it("cancels at the derived deadline and, with the cancellation confirmed, records the operation cancelled", async () => {
    await controlSandbox({ lifetimeMs: 3_600_000, cancelUnreachable: false, isolation: "cgroup" });
    const f = await fixture();
    const sessionId = await f.createSession();
    const { events } = await f.turn(sessionId, run({ command: "hang", timeoutSeconds: 1 }), "hang-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    expect(events.some((event) => event.type === "tool.failed")).toBe(true);
    expect(finalText(events)).toContain("did not report an outcome within 1 seconds");
    expect(finalText(events)).toContain("cancelled on the computer (confirmed)");
    const log = await sandboxLog(sessionId);
    expect(log.cancels).toEqual([expect.objectContaining({ reason: "report_deadline" })]);
    expect((await hostState(sessionId)).operations).toEqual([expect.objectContaining({ outcome: "cancelled", abandoned_at: null })]);
  });

  it("keeps an operation pending when its cancellation cannot be confirmed: the model is not told it was cancelled, and the next command does not run on that computer", async () => {
    // Review finding 1: a command hung, the cancel answered 503, the host
    // wrote resolved_at anyway, the turn completed, and the next command
    // ran on the same computer beside the still-running one.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: true, isolation: "cgroup", forgetOperations: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const { turnId, events } = await f.turn(sessionId, run({ command: "hang unconfirmed", timeoutSeconds: 1 }), "unknown-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    const text = finalText(events);
    expect(text).toContain("did not report an outcome within 1 seconds");
    expect(text).toContain("could not be confirmed");
    expect(text).toContain("outcome is unknown");
    expect(text).not.toContain("was cancelled on the computer");
    // Unresolved and abandoned: the row fences the computer.
    const host = await hostState(sessionId);
    expect(host.operations).toEqual([expect.objectContaining({ outcome: null, turn_id: turnId, generation: 1 })]);
    expect(host.operations[0]!.abandoned_at).not.toBeNull();
    // The command is in fact still running on the computer.
    expect((await sandboxLog(sessionId)).operations.find((operation) => operation.key.endsWith(`:${host.operations[0]!.tool_call_id}`))?.status).toBe("running");

    // The next turn, the supervisor still unreachable: the computer is
    // terminated and confirmed, and the command runs on a new one.
    const next = await f.turn(sessionId, run({ command: "echo elsewhere", timeoutSeconds: 5 }), "unknown-2");
    expect(terminal(next.events)).toEqual(["turn.completed"]);
    expect(finalText(next.events)).toContain("echo elsewhere");
    const log = await sandboxLog(sessionId);
    expect(log.cancels.map((cancel) => cancel.reason)).toEqual(["report_deadline", "unsettled_before_reuse"]);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
    expect(log.executes.map((execute) => execute.generation)).toEqual([1, 2]);
    expect((await hostState(sessionId)).operations.map((operation) => operation.outcome)).toEqual(["lost", "completed"]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
    await controlSandbox({ cancelUnreachable: false });
  });

  it("long-polls the computer's status instead of ticking once a second", async () => {
    const f = await fixture();
    const sessionId = await f.createSession();
    const { events } = await f.turn(sessionId, run({ command: "echo held", timeoutSeconds: 5 }), "longpoll-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    expect(finalText(events)).toContain("echo held");
    // Every status request carries the wait; the fake held the running
    // ones until the command settled, so the turn needed no quiet tick.
    const statuses = (await sandboxLog(sessionId)).statuses;
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => Number.isInteger(status.waitMs) && (status.waitMs ?? 0) > 0)).toBe(true);
    // The start reply already carried the operation's first entry, so the
    // first held request opens past it rather than fetching it again.
    expect(statuses[0]!.after).toBe(1);
  });

  it("still follows correctly when the computer ignores the wait: a supervisor image from before the long poll", async () => {
    // Instant quiet answers must not spin the follow into a busy loop nor
    // starve settlement: the host keeps its former cadence for those.
    await controlSandbox({ honorStatusWait: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const { events } = await f.turn(sessionId, run({ command: "echo old image", timeoutSeconds: 5 }), "oldimg-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    expect(finalText(events)).toContain("echo old image");
    await controlSandbox({ honorStatusWait: true });
  });

  it("reuses the computer once a later cancellation of an abandoned operation is confirmed", async () => {
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: true, isolation: "cgroup", forgetOperations: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(sessionId, run({ command: "hang then-confirmed", timeoutSeconds: 1 }), "confirmed-later-1");
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    expect((await hostState(sessionId)).operations[0]!.abandoned_at).not.toBeNull();
    // The supervisor answers again before the next command: the cancel is
    // confirmed at reuse, the operation settles, the same computer serves.
    await controlSandbox({ cancelUnreachable: false });
    const next = await f.turn(sessionId, run({ command: "echo same computer", timeoutSeconds: 5 }), "confirmed-later-2");
    expect(terminal(next.events)).toEqual(["turn.completed"]);
    expect(finalText(next.events)).toContain("echo same computer");
    const log = await sandboxLog(sessionId);
    expect(log.cancels.map((cancel) => cancel.reason)).toEqual(["report_deadline", "unsettled_before_reuse"]);
    expect(log.terminates).toEqual([]);
    expect(log.executes.map((execute) => execute.generation)).toEqual([1, 1]);
    expect((await hostState(sessionId)).operations.map((operation) => operation.outcome)).toEqual(["cancelled", "completed"]);
  });

  it("recovers a first shell call from transient ensure failures without poisoning the session", async () => {
    // A fresh deployment's first ensure can hit the platform mid-launch —
    // throttling, a run hook still settling. The acquisition must retry the
    // ensure, and the failed attempts must not poison the session: one
    // generation, one computer, subsequent calls reused.
    await controlSandbox({ failEnsures: 2 });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(
      sessionId,
      run({ tool: "shell", command: "echo shell-alive", timeoutSeconds: 30 }),
      "ensure-retry-1",
    );
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    expect(finalText(first.events)).toContain("shell-alive");
    const log = await sandboxLog(sessionId);
    expect(log.ensures.map((ensure) => ensure.generation)).toEqual([1, 1, 1]);
    expect((await hostState(sessionId)).lease).toMatchObject({
      state: "ready",
      generation: 1,
      sandbox_id: expect.stringMatching(/^sb-/),
    });

    const second = await f.turn(
      sessionId,
      run({ command: "echo still-alive", timeoutSeconds: 30 }),
      "ensure-retry-2",
    );
    expect(terminal(second.events)).toEqual(["turn.completed"]);
    expect(finalText(second.events)).toContain("still-alive");
    // No further launches: the same computer hosts the follow-up.
    expect((await sandboxLog(sessionId)).ensures).toHaveLength(3);
    expect(
      (await sandboxLog(sessionId)).sandboxes.filter(
        (sandbox) => sandbox.state === "running" && sandbox.generation === 1,
      ),
    ).toHaveLength(1);
    await controlSandbox({ failEnsures: 0 });
  });

  it("fails the call, not the session, when ensure keeps failing; the next call launches a fresh computer", async () => {
    // Transient failures beyond the bound still resolve on the next call:
    // the generation keeps its deterministic launch so a failed provision
    // cannot pin the session to a dead computer forever.
    await controlSandbox({ failEnsures: 3 });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(
      sessionId,
      run({ command: "echo never", timeoutSeconds: 30 }),
      "ensure-fail-1",
    );
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    expect(finalText(first.events)).toContain("Sandbox acquisition returned 500");

    await controlSandbox({ failEnsures: 0 });
    const second = await f.turn(
      sessionId,
      run({ command: "echo recovered", timeoutSeconds: 30 }),
      "ensure-fail-2",
    );
    expect(terminal(second.events)).toEqual(["turn.completed"]);
    expect(finalText(second.events)).toContain("recovered");
    const host = await hostState(sessionId);
    expect(host.lease).toMatchObject({ state: "ready", generation: 1 });
  });

  it("probes a kept computer before a turn reuses it and replaces one that does not answer, after confirmed termination", async () => {
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(sessionId, run({ command: "echo one", timeoutSeconds: 5 }), "probe-1");
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    // A fresh computer is not probed on the turn that launched it.
    expect((await sandboxLog(sessionId)).probes).toEqual([]);

    // Killed between turns: the probe fails, generation 1 is terminated and
    // confirmed, and the follow-up continues on generation 2.
    await controlSandbox({ probeAlive: false });
    const second = await f.turn(sessionId, run({ command: "echo two", timeoutSeconds: 5 }), "probe-2");
    expect(terminal(second.events)).toEqual(["turn.completed"]);
    expect(finalText(second.events)).toContain("echo two");
    const log = await sandboxLog(sessionId);
    expect(log.probes).toEqual([expect.objectContaining({ generation: 1 })]);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1, preserve: false })]);
    expect(log.ensures.map((ensure) => ensure.generation)).toEqual([1, 2]);
    expect(log.executes.map((execute) => execute.generation)).toEqual([1, 2]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });

    // Alive again: the next turn probes and reuses.
    await controlSandbox({ probeAlive: true });
    const third = await f.turn(sessionId, run({ command: "echo three", timeoutSeconds: 5 }), "probe-3");
    expect(terminal(third.events)).toEqual(["turn.completed"]);
    const after = await sandboxLog(sessionId);
    expect(after.probes.map((probe) => probe.generation)).toEqual([1, 2]);
    expect(after.terminates).toHaveLength(1);
    expect(after.executes.map((execute) => execute.generation)).toEqual([1, 2, 2]);
  });

  it("serializes concurrent liveness decisions: two callers failing the probe of generation 1 make one replacement and one termination", async () => {
    // Review finding 2: the probe ran before the acquisition lock, so the
    // second stale probe created generation 3 on top of generation 2 and
    // terminated generation 1 twice, leaving two live computers.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(sessionId, run({ command: "echo one", timeoutSeconds: 5 }), "race-1");
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    await controlSandbox({ probeAlive: false });
    const host = await hostOf(sessionId);
    const leases = await runInDurableObject(host, async (raw, state) => {
      // The next turn would mark the kept computer for a probe; two
      // commands of that turn then ask for the computer at once.
      state.storage.sql.exec("UPDATE workerd_sandbox_lease SET probe_due = 1 WHERE slot = 1");
      const instance = raw as unknown as {
        ensureSandbox(sessionID: string): Promise<{ generation: number; state: string; sandbox_id: string | null }>;
      };
      return Promise.all([instance.ensureSandbox(sessionId), instance.ensureSandbox(sessionId)]);
    });
    expect(leases.map((lease) => [lease.generation, lease.state])).toEqual([
      [2, "ready"],
      [2, "ready"],
    ]);
    expect(leases[0]!.sandbox_id).toBe(leases[1]!.sandbox_id);
    const log = await sandboxLog(sessionId);
    expect(log.probes.every((probe) => probe.generation === 1)).toBe(true);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
    expect(log.ensures.map((ensure) => ensure.generation)).toEqual([1, 2]);
    expect(log.sandboxes.filter((sandbox) => sandbox.state === "running")).toHaveLength(1);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
    await controlSandbox({ probeAlive: true });
  });

  async function untilExecuted(sessionId: string, command: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if ((await sandboxLog(sessionId)).executes.some((execute) => execute.request.command === command)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`The computer never received ${command}`);
  }

  it("a Stop during a running command terminates it on the computer and cancels the turn after settlement", async () => {
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const admitted = await SELF.fetch(
      `${base}/v1/sessions/${sessionId}/turns`,
      jsonRequest("POST", { input: run({ command: "hang stop-me", timeoutSeconds: 600 }), idempotencyKey: "stop-1" }),
    );
    expect(admitted.status).toBe(202);
    const { turnId } = await admitted.json<{ turnId: string }>();
    await untilExecuted(sessionId, "hang stop-me");

    const interrupted = await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" });
    expect(interrupted.status).toBe(200);
    expect((await interrupted.json<SessionSnapshot>()).status).toBe("stopping");
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.cancelled" && event.turnId === turnId),
    );
    expect(events.find((event) => event.type === "turn.cancelled")?.data).toMatchObject({
      reason: "interrupted",
      operationsSettled: 1,
      computerTerminated: false,
    });
    expect(events.filter((event) => event.turnId === turnId && ["turn.completed", "turn.failed"].includes(event.type))).toEqual([]);
    const log = await sandboxLog(sessionId);
    expect(log.cancels).toEqual([expect.objectContaining({ reason: "interrupted" })]);
    expect(log.terminates).toEqual([]);
    expect((await hostState(sessionId)).operations).toEqual([expect.objectContaining({ outcome: "cancelled", turn_id: turnId })]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 1 });

    // The session is usable straight away, on the same computer.
    const next = await f.turn(sessionId, run({ command: "echo after stop", timeoutSeconds: 5 }), "stop-2");
    expect(terminal(next.events)).toEqual(["turn.completed"]);
    expect(finalText(next.events)).toContain("echo after stop");
    expect((await sandboxLog(sessionId)).executes.map((execute) => execute.generation)).toEqual([1, 1]);
  });

  it("a Stop whose command was terminated without verified containment is not settled: the computer is terminated and the next turn runs on a new one", async () => {
    // Review finding 3: the supervisor reported terminal cancellation
    // after signalling a process group whose setsid() descendant
    // survived. A terminated unit settles only with verified containment;
    // otherwise the operation stays pending and the Session object's
    // terminate fallback resolves it.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "process_session" });
    const f = await fixture();
    const sessionId = await f.createSession();
    const admitted = await SELF.fetch(
      `${base}/v1/sessions/${sessionId}/turns`,
      jsonRequest("POST", { input: run({ command: "hang weak-containment", timeoutSeconds: 600 }), idempotencyKey: "weak-1" }),
    );
    expect(admitted.status).toBe(202);
    const { turnId } = await admitted.json<{ turnId: string }>();
    await untilExecuted(sessionId, "hang weak-containment");
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" })).status).toBe(200);
    const unsettled = await waitForEvents(sessionId, (current) =>
      current.some(
        (event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === false,
      ),
    );
    expect(unsettled.find((event) => event.data.acknowledged === false)?.data).toMatchObject({
      pendingOperations: [expect.any(String)],
      error: expect.stringContaining("without verified containment"),
    });
    // The retry does not wait out the settlement budget: the computer is
    // terminated through the platform and confirmed, and only then is the
    // turn cancelled.
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE workerd_pending_stop SET next_attempt_at_ms = ? WHERE slot = 1", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.cancelled" && event.turnId === turnId),
    );
    expect(events.find((event) => event.type === "turn.cancelled")?.data).toMatchObject({
      reason: "interrupted",
      computerTerminated: true,
    });
    const log = await sandboxLog(sessionId);
    expect(log.cancels).toEqual([expect.objectContaining({ reason: "interrupted" })]);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1, preserve: false })]);
    expect((await hostState(sessionId)).operations).toEqual([expect.objectContaining({ outcome: "lost", turn_id: turnId })]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "terminated", generation: 1 });

    await controlSandbox({ isolation: "cgroup" });
    const next = await f.turn(sessionId, run({ command: "echo after weak", timeoutSeconds: 5 }), "weak-2");
    expect(terminal(next.events)).toEqual(["turn.completed"]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
  });

  it("does not accept a tombstone for an operation with no recorded supervisor boot: the stop stays pending until the computer is terminated", async () => {
    // Review finding 3, second part: a lost start reply (no boot id
    // recorded) followed by a supervisor restart answered "not found" and
    // the host took that as a match. Positive evidence or computer
    // termination, never an assumed match.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const admitted = await SELF.fetch(
      `${base}/v1/sessions/${sessionId}/turns`,
      jsonRequest("POST", { input: run({ command: "hang lost-start", timeoutSeconds: 600 }), idempotencyKey: "null-boot-1" }),
    );
    expect(admitted.status).toBe(202);
    const { turnId } = await admitted.json<{ turnId: string }>();
    await untilExecuted(sessionId, "hang lost-start");
    // The start reply's boot id was lost; the supervisor has since restarted.
    await runInDurableObject(await hostOf(sessionId), (_instance, state) => {
      state.storage.sql.exec("UPDATE workerd_capability_faults SET supervisor_boot_id = NULL");
    });
    await controlSandbox({ forgetOperations: true });
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" })).status).toBe(200);
    const unsettled = await waitForEvents(sessionId, (current) =>
      current.some(
        (event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === false,
      ),
    );
    expect(unsettled.find((event) => event.data.acknowledged === false)?.data).toMatchObject({ pendingOperations: [expect.any(String)] });
    expect((await hostState(sessionId)).operations).toEqual([expect.objectContaining({ outcome: null, turn_id: turnId })]);
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}`).then((r) => r.json<SessionSnapshot>())).status).toBe("stopping");

    // Only computer termination resolves it, after the settlement budget.
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE workerd_pending_stop SET requested_at_ms = ?, next_attempt_at_ms = ? WHERE slot = 1",
        Date.now() - 61_000,
        Date.now() - 1,
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.cancelled" && event.turnId === turnId),
    );
    expect(events.find((event) => event.type === "turn.cancelled")?.data).toMatchObject({ computerTerminated: true });
    expect((await sandboxLog(sessionId)).terminates).toEqual([expect.objectContaining({ generation: 1 })]);
    expect((await hostState(sessionId)).operations).toEqual([expect.objectContaining({ outcome: "lost", turn_id: turnId })]);
    await controlSandbox({ forgetOperations: false });
  });

  it("scopes a stop to the turn it names: an older turn's stop sweeps and releases nothing of the newer turn's", async () => {
    // Review finding 4, at the host: /stop accepted turnId but swept every
    // operation of the session and released whatever lease was current.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 0 });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(sessionId, run({ command: "echo warm", timeoutSeconds: 5 }), "scope-1");
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    const marker = await sandboxLog(sessionId);
    const { opencodeSessionId } = await hostSessionIds(sessionId);
    const host = await hostOf(sessionId);
    // Two dispatched operations in the ledger, one of an old turn and one
    // of the turn now holding the lease; the supervisor never heard of
    // either (tombstones from the boot that admitted them settle them).
    await runInDurableObject(host, (raw, state) => {
      for (const [id, turn] of [
        ["op-old", "turn-old"],
        ["op-new", "turn-new"],
      ]) {
        state.storage.sql.exec(
          `INSERT INTO workerd_capability_faults (
             tool_call_id, session_id, capability, request_json, created_at, requested_at,
             turn_id, generation, supervisor_boot_id
           ) VALUES (?, ?, 'exec', '{}', ?, ?, ?, 1, 'supervisor-boot-fake')`,
          id,
          opencodeSessionId,
          Date.now(),
          Date.now(),
          turn,
        );
      }
      (raw as unknown as { claimTurnLease(sessionID: string, turnId: string): void }).claimTurnLease(opencodeSessionId, "turn-new");
    });
    const stopOld = await runInDurableObject(host, (raw) =>
      (raw as unknown as { fetch(request: Request): Promise<Response> }).fetch(
        new Request("https://host.invalid/stop", jsonRequest("POST", { sessionID: opencodeSessionId, turnId: "turn-old", reason: "interrupted" })),
      ),
    );
    expect(stopOld.status).toBe(200);
    expect(await stopOld.json()).toMatchObject({ settled: true, turnId: "turn-old", staleTurn: true, operations: { total: 1, settled: 1 } });
    const afterOld = await hostState(sessionId);
    expect(afterOld.operations.map((operation) => [operation.tool_call_id, operation.outcome])).toEqual([
      [expect.any(String), "completed"],
      ["op-old", "cancelled"],
      ["op-new", null],
    ]);
    expect((await sandboxLog(sessionId)).cancels.slice(marker.cancels.length).map((cancel) => cancel.toolCallID)).toEqual(["op-old"]);
    const leaseAfterOld = await runInDurableObject(host, (_raw, state) =>
      state.storage.sql.exec<{ turn_id: string }>("SELECT turn_id FROM workerd_turn_lease WHERE opencode_session_id = ?", opencodeSessionId).toArray(),
    );
    expect(leaseAfterOld).toEqual([{ turn_id: "turn-new" }]);

    // The newer turn's own stop settles its operation and releases its lease.
    const stopNew = await runInDurableObject(host, (raw) =>
      (raw as unknown as { fetch(request: Request): Promise<Response> }).fetch(
        new Request("https://host.invalid/stop", jsonRequest("POST", { sessionID: opencodeSessionId, turnId: "turn-new", reason: "interrupted" })),
      ),
    );
    expect(stopNew.status).toBe(200);
    expect(await stopNew.json()).toMatchObject({ settled: true, turnId: "turn-new", staleTurn: false });
    expect((await hostState(sessionId)).operations.find((operation) => operation.tool_call_id === "op-new")?.outcome).toBe("cancelled");
    expect(
      await runInDurableObject(host, (_raw, state) =>
        state.storage.sql.exec("SELECT turn_id FROM workerd_turn_lease WHERE opencode_session_id = ?", opencodeSessionId).toArray(),
      ),
    ).toEqual([]);
  });

  it("a Stop handler that finishes late, after its caller timed out and the retry settled the turn, touches nothing of the next turn", async () => {
    // Review finding 4's delayed-handler case: the first Stop is paused
    // after interrupting the old loop (its cancel held at the supervisor),
    // the caller times out, the alarm retry settles the old turn, a new
    // turn starts a command, and then the first handler is released.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 1, cancelsReleased: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const admittedA = await SELF.fetch(
      `${base}/v1/sessions/${sessionId}/turns`,
      jsonRequest("POST", { input: run({ command: "hang late-a", timeoutSeconds: 600 }), idempotencyKey: "late-a" }),
    );
    const { turnId: turnA } = await admittedA.json<{ turnId: string }>();
    await untilExecuted(sessionId, "hang late-a");
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" })).status).toBe(200);
    // The first host handler is now inside its held cancel; the caller's
    // bounded call times out and the attempt is recorded unsettled.
    await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === false),
    );
    expect((await sandboxLog(sessionId)).cancels).toHaveLength(1);
    // The alarm retries: the second handler's cancel is not held, the old
    // turn settles, and the session is idle again.
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE workerd_pending_stop SET next_attempt_at_ms = ? WHERE slot = 1", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitForEvents(sessionId, (current) => current.some((event) => event.type === "turn.cancelled" && event.turnId === turnA));
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}`).then((r) => r.json<SessionSnapshot>())).status).toBe("idle");

    // A new turn starts a command on the same computer.
    const admittedB = await SELF.fetch(
      `${base}/v1/sessions/${sessionId}/turns`,
      jsonRequest("POST", { input: run({ command: "hang late-b", timeoutSeconds: 600 }), idempotencyKey: "late-b" }),
    );
    const { turnId: turnB } = await admittedB.json<{ turnId: string }>();
    await untilExecuted(sessionId, "hang late-b");
    const { opencodeSessionId } = await hostSessionIds(sessionId);
    const host = await hostOf(sessionId);
    const leaseOf = () =>
      runInDurableObject(host, (_raw, state) =>
        state.storage.sql
          .exec<{ turn_id: string; stop_requested_at: number | null }>(
            "SELECT turn_id, stop_requested_at FROM workerd_turn_lease WHERE opencode_session_id = ?",
            opencodeSessionId,
          )
          .toArray(),
      );
    expect(await leaseOf()).toEqual([{ turn_id: turnB, stop_requested_at: null }]);

    // Release the first handler: it finishes its old stop and must leave
    // the new turn's lease, fence and command exactly as they are.
    await controlSandbox({ cancelsReleased: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await leaseOf()).toEqual([{ turn_id: turnB, stop_requested_at: null }]);
    const opB = (await hostState(sessionId)).operations.find((operation) => operation.turn_id === turnB)!;
    expect(opB.outcome).toBeNull();
    const cancels = (await sandboxLog(sessionId)).cancels;
    expect(cancels.map((cancel) => cancel.toolCallID)).not.toContain(opB.tool_call_id);
    expect((await sandboxLog(sessionId)).operations.find((operation) => operation.key.endsWith(`:${opB.tool_call_id}`))?.status).toBe("running");

    // The new turn's own stop is unaffected and settles it normally.
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" })).status).toBe(200);
    const events = await waitForEvents(sessionId, (current) => current.some((event) => event.type === "turn.cancelled" && event.turnId === turnB));
    expect(events.find((event) => event.type === "turn.cancelled" && event.turnId === turnB)?.data).toMatchObject({ operationsSettled: 1, computerTerminated: false });
    expect((await sandboxLog(sessionId)).cancels.filter((cancel) => cancel.toolCallID === opB.tool_call_id)).toHaveLength(1);
    expect((await sandboxLog(sessionId)).terminates).toEqual([]);
    await controlSandbox({ holdCancels: 0, cancelsReleased: false });
  });

  it("terminates only the computer generation the stop named; a generation already replaced answers as terminated without touching the current one", async () => {
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 0 });
    const f = await fixture();
    const sessionId = await f.createSession();
    expect(terminal((await f.turn(sessionId, run({ command: "echo one", timeoutSeconds: 5 }), "gen-1")).events)).toEqual(["turn.completed"]);
    await controlSandbox({ probeAlive: false });
    expect(terminal((await f.turn(sessionId, run({ command: "echo two", timeoutSeconds: 5 }), "gen-2")).events)).toEqual(["turn.completed"]);
    await controlSandbox({ probeAlive: true });
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
    const terminatesBefore = (await sandboxLog(sessionId)).terminates.length;
    const { opencodeSessionId } = await hostSessionIds(sessionId);
    const host = await hostOf(sessionId);
    const terminate = (body: Record<string, unknown>) =>
      runInDurableObject(host, (raw) =>
        (raw as unknown as { fetch(request: Request): Promise<Response> }).fetch(
          new Request("https://host.invalid/terminate-computer", jsonRequest("POST", { sessionID: opencodeSessionId, reason: "late_stop", ...body })),
        ),
      );
    const stale = await terminate({ generation: 1, turnId: "turn-old" });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ terminated: true, alreadyTerminated: true, generation: 1 });
    expect((await sandboxLog(sessionId)).terminates).toHaveLength(terminatesBefore);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
    const current = await terminate({ generation: 2 });
    expect(await current.json()).toMatchObject({ terminated: true, alreadyTerminated: false, generation: 2 });
    expect((await sandboxLog(sessionId)).terminates.map((entry) => entry.generation)).toEqual([1, 2]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "terminated", generation: 2 });
  });

  it("a Stop the supervisor cannot confirm terminates the computer after the budget; the next turn runs on a new one", async () => {
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: true });
    const f = await fixture();
    const sessionId = await f.createSession();
    const admitted = await SELF.fetch(
      `${base}/v1/sessions/${sessionId}/turns`,
      jsonRequest("POST", { input: run({ command: "hang lost-supervisor", timeoutSeconds: 600 }), idempotencyKey: "lost-1" }),
    );
    expect(admitted.status).toBe(202);
    const { turnId } = await admitted.json<{ turnId: string }>();
    await untilExecuted(sessionId, "hang lost-supervisor");
    await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" });
    const unsettled = await waitForEvents(sessionId, (current) =>
      current.some(
        (event) => event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === false,
      ),
    );
    expect(unsettled.find((event) => event.data.acknowledged === false)?.data).toMatchObject({ pendingOperations: [expect.any(String)] });
    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}`).then((r) => r.json<SessionSnapshot>())).status).toBe("stopping");

    // The settlement budget passes: the Session object terminates the
    // computer through the host and the platform and settles on that.
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE workerd_pending_stop SET requested_at_ms = ?, next_attempt_at_ms = ? WHERE slot = 1",
        Date.now() - 61_000,
        Date.now() - 1,
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.cancelled" && event.turnId === turnId),
    );
    expect(events.find((event) => event.type === "turn.cancelled")?.data).toMatchObject({
      reason: "interrupted",
      computerTerminated: true,
    });
    const log = await sandboxLog(sessionId);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
    expect((await hostState(sessionId)).operations).toEqual([expect.objectContaining({ outcome: "lost", turn_id: turnId })]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "terminated", generation: 1 });

    // The follow-up continues on a new computer with the workspace.
    await controlSandbox({ cancelUnreachable: false });
    const next = await f.turn(sessionId, run({ command: "echo after loss", timeoutSeconds: 5 }), "lost-2");
    expect(terminal(next.events)).toEqual(["turn.completed"]);
    expect(finalText(next.events)).toContain("echo after loss");
    expect((await sandboxLog(sessionId)).ensures.map((ensure) => ensure.generation)).toEqual([1, 2]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
  });

  it("fences the computer when following a command ends in an exception: a malformed status reply leaves the outcome unknown, and the next turn does not run on that computer until termination is confirmed", async () => {
    // Re-review finding 1: the status reply's JSON.parse threw outside the
    // abandon path, the row stayed unresolved and not abandoned, and the
    // next turn's command ran on the same computer beside the one still
    // running. Every exit after dispatch goes through one settlement-aware
    // cleanup; an exception is uncertainty, and uncertainty fences reuse.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: true, isolation: "cgroup", forgetOperations: false, malformedStatuses: 1 });
    const f = await fixture();
    const sessionId = await f.createSession();
    const { turnId, events } = await f.turn(sessionId, run({ command: "hang malformed-status", timeoutSeconds: 600 }), "malformed-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    expect(events.some((event) => event.type === "tool.failed")).toBe(true);
    const text = finalText(events);
    expect(text).toContain("could not be followed");
    expect(text).toContain("outcome is unknown");
    expect(text).not.toContain("was cancelled");
    // Unresolved and abandoned: the row fences the computer.
    const host = await hostState(sessionId);
    expect(host.operations).toEqual([expect.objectContaining({ outcome: null, turn_id: turnId, generation: 1 })]);
    expect(host.operations[0]!.abandoned_at).not.toBeNull();
    expect((await sandboxLog(sessionId)).cancels.map((cancel) => cancel.reason)).toEqual(["follow_failed"]);
    // The command is in fact still running on the computer.
    const operationKey = `:${host.operations[0]!.tool_call_id}`;
    expect((await sandboxLog(sessionId)).operations.find((operation) => operation.key.endsWith(operationKey))?.status).toBe("running");

    // The next turn, the supervisor still not confirming: the computer is
    // terminated and confirmed, and the command runs on a new one.
    const next = await f.turn(sessionId, run({ command: "echo elsewhere", timeoutSeconds: 5 }), "malformed-2");
    expect(terminal(next.events)).toEqual(["turn.completed"]);
    expect(finalText(next.events)).toContain("echo elsewhere");
    const log = await sandboxLog(sessionId);
    expect(log.cancels.map((cancel) => cancel.reason)).toEqual(["follow_failed", "unsettled_before_reuse"]);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
    expect(log.executes.map((execute) => execute.generation)).toEqual([1, 2]);
    expect(log.operations.find((operation) => operation.key.endsWith(operationKey))?.status).toBe("cancelled");
    expect((await hostState(sessionId)).operations.map((operation) => operation.outcome)).toEqual(["lost", "completed"]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
    await controlSandbox({ cancelUnreachable: false, malformedStatuses: 0 });
  });

  it("does not settle a timeout the supervisor terminated without verified containment: the operation stays fenced and the next command runs on a new computer", async () => {
    // Re-review finding 2: the poll loop's failed and cancelled branches
    // wrote the outcome without settlementOf. A timeout reported with
    // terminated:true, contained:false, isolation:"process_session" was
    // recorded timed_out and the next command reused generation 1, with
    // whatever the killed leader left behind still running. Polling
    // applies the same evidence rule as cancellation: verified
    // containment, or confirmed computer termination.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "process_session", forgetOperations: false });
    const f = await fixture();
    const sessionId = await f.createSession();
    const { turnId, events } = await f.turn(sessionId, run({ command: "sleep 300", timeoutSeconds: 60 }), "weak-timeout-1");
    expect(terminal(events)).toEqual(["turn.completed"]);
    expect(events.some((event) => event.type === "tool.failed")).toBe(true);
    const text = finalText(events);
    expect(text).toContain("timed out after 60 seconds and was terminated");
    expect(text).toContain("process unit: process_session");
    expect(text).toContain("without verified containment");
    expect(text).toContain("will be terminated and replaced");
    // Not settled: unresolved and fencing the computer.
    const host = await hostState(sessionId);
    expect(host.operations).toEqual([expect.objectContaining({ outcome: null, turn_id: turnId, generation: 1 })]);
    expect(host.operations[0]!.abandoned_at).not.toBeNull();
    expect((await sandboxLog(sessionId)).terminates).toEqual([]);

    // The next command: the supervisor answers the cancel with the same
    // unverified termination, so the computer is terminated, confirmed
    // and replaced before anything runs.
    const next = await f.turn(sessionId, run({ command: "echo clean", timeoutSeconds: 5 }), "weak-timeout-2");
    expect(terminal(next.events)).toEqual(["turn.completed"]);
    expect(finalText(next.events)).toContain("echo clean");
    const log = await sandboxLog(sessionId);
    expect(log.cancels.map((cancel) => cancel.reason)).toEqual(["unsettled_before_reuse"]);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
    expect(log.executes.map((execute) => execute.generation)).toEqual([1, 2]);
    expect((await hostState(sessionId)).operations.map((operation) => operation.outcome)).toEqual(["lost", "completed"]);
    expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2 });
    await controlSandbox({ isolation: "cgroup" });
  });

  /**
   * A dispatched, unresolved operation row as the host wrote it before the
   * ownership columns existed (f19dcad: tool_call_id, session_id,
   * capability, request_json, created_at, requested_at, resolved_at), with
   * its command started on the computer the session had at the time.
   */
  async function seedLegacyOperation(sessionId: string, toolCallID: string, command: string): Promise<void> {
    const { opencodeSessionId } = await hostSessionIds(sessionId);
    const lease = (await hostState(sessionId)).lease!;
    await runInDurableObject(await hostOf(sessionId), (_raw, state) => {
      state.storage.sql.exec(
        `INSERT INTO workerd_capability_faults (
           tool_call_id, session_id, capability, request_json, created_at, requested_at
         ) VALUES (?, ?, 'exec', ?, ?, ?)`,
        toolCallID,
        opencodeSessionId,
        JSON.stringify({ command }),
        Date.now() - 60_000,
        Date.now() - 60_000,
      );
    });
    const started = await sandbox().fetch(
      "https://sandbox.invalid/v1/sandboxes/execute",
      jsonRequest("POST", {
        sessionID: sessionId,
        sandboxId: lease.sandbox_id,
        generation: lease.generation,
        toolCallID,
        capability: "exec",
        request: { command, timeoutSeconds: 600 },
      }),
    );
    expect(started.status).toBe(200);
    expect((await sandboxLog(sessionId)).operations.find((operation) => operation.key.endsWith(`:${toolCallID}`))?.status).toBe("running");
  }

  it("a Stop with an unresolved operation from before the ownership columns does not settle on the row's silence: the computer is terminated and confirmed, and the row is resolved by that retirement", async () => {
    // Re-review finding 3: the named stop's sweep excluded NULL turn ids
    // and the generation check treated NULL as another generation, so the
    // stop reported settled without touching the computer while the
    // pre-upgrade command kept running. A legacy row is unverified: no
    // supervisor identity, no generation, no owner; nothing is guessed.
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 0 });
    const f = await fixture();
    const sessionId = await f.createSession();
    const admitted = await SELF.fetch(
      `${base}/v1/sessions/${sessionId}/turns`,
      jsonRequest("POST", { input: run({ command: "hang beside-legacy", timeoutSeconds: 600 }), idempotencyKey: "legacy-stop-1" }),
    );
    expect(admitted.status).toBe(202);
    const { turnId } = await admitted.json<{ turnId: string }>();
    await untilExecuted(sessionId, "hang beside-legacy");
    await seedLegacyOperation(sessionId, "op-legacy-stop", "hang legacy-stop");

    expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" })).status).toBe(200);
    // Not settled by the first attempt: the live command's cancel is
    // confirmed, the legacy row cannot be.
    const unsettled = await waitForEvents(sessionId, (current) =>
      current.some(
        (event) =>
          event.turnId === turnId &&
          ((event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === false) ||
            event.type === "turn.cancelled"),
      ),
    );
    expect(unsettled.find((event) => event.turnId === turnId && event.type === "turn.cancelled")).toBeUndefined();
    expect(unsettled.find((event) => event.data.acknowledged === false)?.data).toMatchObject({
      pendingOperations: ["op-legacy-stop"],
      error: expect.stringContaining("without verified containment"),
    });
    expect((await sandboxLog(sessionId)).operations.find((operation) => operation.key.endsWith(":op-legacy-stop"))?.status).toBe("running");
    // The retry escalates without waiting out the settlement budget:
    // the computer is terminated through the platform and confirmed.
    const stub = env.SESSIONS.getByName(sessionId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE workerd_pending_stop SET next_attempt_at_ms = ? WHERE slot = 1", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const events = await waitForEvents(sessionId, (current) =>
      current.some((event) => event.type === "turn.cancelled" && event.turnId === turnId),
    );
    expect(events.find((event) => event.type === "turn.cancelled")?.data).toMatchObject({ reason: "interrupted", computerTerminated: true });
    const log = await sandboxLog(sessionId);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
    // No cancel was addressed to a generation the row never named.
    expect(log.cancels.map((cancel) => cancel.toolCallID)).not.toContain("op-legacy-stop");
    expect(log.operations.find((operation) => operation.key.endsWith(":op-legacy-stop"))?.status).toBe("cancelled");
    const host = await hostState(sessionId);
    expect(host.operations.map((operation) => [operation.tool_call_id, operation.outcome, operation.generation])).toEqual([
      ["op-legacy-stop", "lost", null],
      [expect.any(String), expect.stringMatching(/^(cancelled|lost)$/), 1],
    ]);
    expect(host.lease).toMatchObject({ state: "terminated", generation: 1 });
  });

  it("reuse with an unresolved operation from before the ownership columns retires the computer first: the next command runs on a new generation and the row is resolved by that retirement", async () => {
    await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 0 });
    const f = await fixture();
    const sessionId = await f.createSession();
    const first = await f.turn(sessionId, run({ command: "echo before upgrade", timeoutSeconds: 5 }), "legacy-reuse-1");
    expect(terminal(first.events)).toEqual(["turn.completed"]);
    await seedLegacyOperation(sessionId, "op-legacy-reuse", "hang legacy-reuse");

    const next = await f.turn(sessionId, run({ command: "echo after upgrade", timeoutSeconds: 5 }), "legacy-reuse-2");
    expect(terminal(next.events)).toEqual(["turn.completed"]);
    expect(finalText(next.events)).toContain("echo after upgrade");
    const log = await sandboxLog(sessionId);
    expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
    expect(log.ensures.map((ensure) => ensure.generation)).toEqual([1, 2]);
    expect(log.executes.map((execute) => [execute.generation, execute.request.command])).toEqual([
      [1, "echo before upgrade"],
      [1, "hang legacy-reuse"],
      [2, "echo after upgrade"],
    ]);
    expect(log.cancels.map((cancel) => cancel.toolCallID)).not.toContain("op-legacy-reuse");
    expect(log.operations.find((operation) => operation.key.endsWith(":op-legacy-reuse"))?.status).toBe("cancelled");
    const host = await hostState(sessionId);
    expect(host.operations.find((operation) => operation.tool_call_id === "op-legacy-reuse")).toMatchObject({ outcome: "lost", generation: null, turn_id: null });
    expect(host.lease).toMatchObject({ state: "ready", generation: 2 });
  });

  describe("a computer still running the supervisor from before the contract (rollout compatibility)", () => {
    // The Workers deploy before the image, and promoting the image does
    // not upgrade computers already running. The fake reproduces that
    // supervisor's recorded replies (f19dcad): no boot id, no cancel
    // route, a timeout answered as a completion with timedOut and no
    // containment, a health reply with no generation. Such a supervisor
    // is unverifiable: its computer is retired with confirmed termination
    // at the next acquisition, not probed each turn and not reused, and a
    // stop against it escalates to termination without the full budget.

    it("retires it at the next acquisition, without a probe, once a reply revealed it", async () => {
      await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 0, supervisor: "f19dcad" });
      const f = await fixture();
      const sessionId = await f.createSession();
      // The image is promoted right after this computer launched.
      await untilLaunched(sessionId, f, run({ command: "echo on the old image", timeoutSeconds: 5 }), "old-acq-1");
      const first = await hostState(sessionId);
      expect(first.lease).toMatchObject({ state: "ready", generation: 1, retire_reason: expect.stringContaining("supervisor") });
      expect(first.operations).toEqual([expect.objectContaining({ outcome: "completed", generation: 1 })]);

      const next = await f.turn(sessionId, run({ command: "echo on the new image", timeoutSeconds: 5 }), "old-acq-2");
      expect(terminal(next.events)).toEqual(["turn.completed"]);
      expect(finalText(next.events)).toContain("echo on the new image");
      const log = await sandboxLog(sessionId);
      expect(log.probes).toEqual([]);
      expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
      expect(log.ensures.map((ensure) => ensure.generation)).toEqual([1, 2]);
      expect(log.executes.map((execute) => execute.generation)).toEqual([1, 2]);
      expect((await hostState(sessionId)).lease).toMatchObject({ state: "ready", generation: 2, retire_reason: null });
    });

    it("retires it on the liveness probe when nothing else revealed it: the health reply has no generation", async () => {
      await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 0, supervisor: "f19dcad" });
      const f = await fixture();
      const sessionId = await f.createSession();
      await untilLaunched(sessionId, f, run({ command: "echo launched", timeoutSeconds: 5 }), "old-probe-1");
      // The lease as the pre-deploy host left it: no reply recorded
      // against it, a probe due before the next reuse.
      await runInDurableObject(await hostOf(sessionId), (_raw, state) => {
        state.storage.sql.exec("UPDATE workerd_sandbox_lease SET retire_reason = NULL, probe_due = 1 WHERE slot = 1");
      });
      const next = await f.turn(sessionId, run({ command: "echo probed", timeoutSeconds: 5 }), "old-probe-2");
      expect(terminal(next.events)).toEqual(["turn.completed"]);
      const log = await sandboxLog(sessionId);
      expect(log.probes).toEqual([expect.objectContaining({ generation: 1 })]);
      expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
      expect(log.executes.map((execute) => execute.generation)).toEqual([1, 2]);
    });

    it("does not settle a command it killed at its cutoff: the completion carries timedOut and no containment, and the computer is replaced before the next command", async () => {
      await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 0, supervisor: "f19dcad" });
      const f = await fixture();
      const sessionId = await f.createSession();
      const { turnId, events } = await untilLaunched(sessionId, f, run({ command: "sleep 300", timeoutSeconds: 60 }), "old-run-1");
      expect(terminal(events)).toEqual(["turn.completed"]);
      expect(events.some((event) => event.type === "tool.failed")).toBe(true);
      const text = finalText(events);
      expect(text).toContain("without verified containment");
      expect(text).toContain("will be terminated and replaced");
      const host = await hostState(sessionId);
      expect(host.operations).toEqual([expect.objectContaining({ outcome: null, turn_id: turnId, generation: 1 })]);
      expect(host.operations[0]!.abandoned_at).not.toBeNull();

      const next = await f.turn(sessionId, run({ command: "echo replaced", timeoutSeconds: 5 }), "old-run-2");
      expect(terminal(next.events)).toEqual(["turn.completed"]);
      expect(finalText(next.events)).toContain("echo replaced");
      const log = await sandboxLog(sessionId);
      expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
      expect(log.executes.map((execute) => execute.generation)).toEqual([1, 2]);
      expect((await hostState(sessionId)).operations.map((operation) => operation.outcome)).toEqual(["lost", "completed"]);
    });

    it("a Stop against it escalates to confirmed termination on the next attempt, not after the settlement budget", async () => {
      await controlSandbox({ lifetimeMs: 3_600_000, probeAlive: true, cancelUnreachable: false, isolation: "cgroup", forgetOperations: false, holdCancels: 0, supervisor: "f19dcad" });
      const f = await fixture();
      const sessionId = await f.createSession();
      const admitted = await SELF.fetch(
        `${base}/v1/sessions/${sessionId}/turns`,
        jsonRequest("POST", { input: run({ command: "hang on-old-supervisor", timeoutSeconds: 600 }), idempotencyKey: "old-stop-1" }),
      );
      expect(admitted.status).toBe(202);
      const { turnId } = await admitted.json<{ turnId: string }>();
      await untilExecuted(sessionId, "hang on-old-supervisor");
      await controlSandbox({ supervisor: "current" });
      expect((await SELF.fetch(`${base}/v1/sessions/${sessionId}/interrupt`, { method: "POST" })).status).toBe(200);
      const unsettled = await waitForEvents(sessionId, (current) =>
        current.some(
          (event) =>
            event.turnId === turnId &&
            ((event.type === "runtime.log" && event.data.phase === "workerd_interrupt" && event.data.acknowledged === false) ||
              event.type === "turn.cancelled"),
        ),
      );
      expect(unsettled.find((event) => event.turnId === turnId && event.type === "turn.cancelled")).toBeUndefined();
      expect(unsettled.find((event) => event.data.acknowledged === false)?.data).toMatchObject({
        pendingOperations: [expect.any(String)],
        error: expect.stringContaining("the computer will be terminated"),
      });
      expect((await sandboxLog(sessionId)).cancels).toEqual([expect.objectContaining({ reason: "interrupted" })]);
      // The retry escalates: requested_at is left alone, so this is not
      // the settlement budget.
      const stub = env.SESSIONS.getByName(sessionId);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE workerd_pending_stop SET next_attempt_at_ms = ? WHERE slot = 1", Date.now() - 1);
      });
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const events = await waitForEvents(sessionId, (current) =>
        current.some((event) => event.type === "turn.cancelled" && event.turnId === turnId),
      );
      const cancelled = events.find((event) => event.type === "turn.cancelled")!;
      expect(cancelled.data).toMatchObject({ reason: "interrupted", computerTerminated: true });
      expect(Number(events.find((event) => event.data.acknowledged === true)?.data.settledAfterMs)).toBeLessThan(60_000);
      const log = await sandboxLog(sessionId);
      expect(log.terminates).toEqual([expect.objectContaining({ generation: 1 })]);
      expect((await hostState(sessionId)).operations).toEqual([expect.objectContaining({ outcome: "lost", turn_id: turnId })]);
      expect((await hostState(sessionId)).lease).toMatchObject({ state: "terminated", generation: 1 });
      const next = await f.turn(sessionId, run({ command: "echo after old stop", timeoutSeconds: 5 }), "old-stop-2");
      expect(terminal(next.events)).toEqual(["turn.completed"]);
      expect((await sandboxLog(sessionId)).executes.map((execute) => execute.generation)).toEqual([1, 2]);
    });
  });

  /** Runs a turn whose first command launches the computer, then promotes the image for later launches. */
  async function untilLaunched(sessionId: string, f: Fixture, input: string, key: string): Promise<{ turnId: string; events: AgentEvent[] }> {
    const outcome = await f.turn(sessionId, input, key);
    await controlSandbox({ supervisor: "current" });
    return outcome;
  }
});
