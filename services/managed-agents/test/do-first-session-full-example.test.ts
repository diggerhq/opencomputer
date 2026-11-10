import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  AgentEvent,
  ProjectDeploymentReference,
  InitializeSessionResult,
  SessionToClientFrame,
} from "../src/protocol.js";

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

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  return response.json<T>();
}

async function events(sessionId: string): Promise<AgentEvent[]> {
  return json<{ events: AgentEvent[] }>(
    await SELF.fetch(
      `https://do-first.test/v1/sessions/${encodeURIComponent(sessionId)}/events`,
    ),
  ).then((result) => result.events);
}

async function waitForEvent(
  sessionId: string,
  predicate: (event: AgentEvent) => boolean,
): Promise<AgentEvent[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = await events(sessionId);
    if (current.some(predicate)) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for a session event");
}

async function connectClient(sessionId: string): Promise<{
  socket: WebSocket;
  frames: SessionToClientFrame[];
}> {
  const response = await SELF.fetch(
    `https://do-first.test/v1/sessions/${encodeURIComponent(sessionId)}/connect?role=client&cursor=0`,
    { headers: { upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  const frames: SessionToClientFrame[] = [];
  socket.addEventListener("message", (message) => {
    frames.push(JSON.parse(String(message.data)) as SessionToClientFrame);
  });
  socket.accept();
  return { socket, frames };
}

async function waitForFrame(
  frames: SessionToClientFrame[],
  predicate: (frame: SessionToClientFrame) => boolean,
): Promise<SessionToClientFrame> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for a streamed session frame");
}

describe("DO-first full session example", () => {
  it("pulls pinned configuration, streams progress, and claims runtime lazily", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const digest = "a".repeat(64);
    const deployment = await account.registerDeployment({
      agentId: "do-first-real-agent",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "managed-agent-artifacts",
        key: "do-first-real-agent/artifact.json",
        digest,
        size: 512,
      },
      imageArn: "managed-agent-runtime",
      imageVersion: "1",
    });

    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://do-first.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "do-first-real-agent@development" }),
      }),
    );
    expect(created).toMatchObject({
      session: {
        status: "new",
        deploymentId: deployment.id,
      },
      deployment: {
        id: deployment.id,
        artifact: { digest },
      },
    });
    expect(created.session.microvmId).toBeUndefined();
    const client = await connectClient(created.session.id);

    // The runtime is started at session create (attempt 1) so a client that
    // waits for `runtime.connected` before its first turn is not left waiting;
    // here no runtime service is configured, so that attempt fails and the
    // turn below claims attempt 2.
    await waitForEvent(
      created.session.id,
      (event) =>
        event.type === "runtime.log" &&
        event.data.phase === "runtime_start_failed" &&
        event.data.attempt === 1,
    );

    const turn = await SELF.fetch(
      `https://do-first.test/v1/sessions/${created.session.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "Inspect the repository configuration and summarize it.",
          idempotencyKey: "do-first-full-example",
        }),
      },
    );
    expect(turn.status).toBe(202);

    await expect(
      waitForFrame(
        client.frames,
        (frame) =>
          frame.type === "event" &&
          frame.event.type === "runtime.log" &&
          frame.event.data.phase === "configuration_loaded",
      ),
    ).resolves.toMatchObject({
      type: "event",
      event: {
        type: "runtime.log",
        data: { phase: "configuration_loaded", deploymentId: deployment.id },
      },
    });

    const streamed = await waitForEvent(
      created.session.id,
      (event) =>
        event.type === "runtime.log" &&
        event.data.phase === "runtime_start_failed" &&
        event.data.attempt === 2,
    );
    expect(
      streamed.map((event) => ({ type: event.type, phase: event.data.phase })),
    ).toEqual(
      expect.arrayContaining([
        { type: "message.received", phase: undefined },
        { type: "turn.queued", phase: undefined },
        { type: "runtime.log", phase: "runtime_starting" },
        { type: "runtime.log", phase: "configuration_loaded" },
        { type: "runtime.log", phase: "runtime_start_failed" },
      ]),
    );
    expect(
      streamed
        .filter(
          (event) =>
            event.type === "runtime.log" &&
            event.data.phase === "configuration_loaded",
        )
        .map((event) => event.data),
    ).toEqual([
      expect.objectContaining({ deploymentId: deployment.id, attempt: 1 }),
      expect.objectContaining({ deploymentId: deployment.id, attempt: 2 }),
    ]);

    const retry = await env.SESSIONS.getByName(
      created.session.id,
    ).claimRuntimeStart();
    expect(retry).toMatchObject({ claimed: true, attempt: 3 });
    await env.SESSIONS.getByName(created.session.id).releaseRuntimeStart(
      retry.attempt,
      "test cleanup",
    );
    client.socket.close();
  });

  it("wakes a sandbox the idle timer suspended when a turn arrives", async () => {
    // blue #315 suspends idle API sessions; a later turn queued behind the
    // suspended sandbox and waited forever unless the client called resume.
    const deployment = await env.ACCOUNTS.getByName("local").registerDeployment({
      agentId: "do-first-wake-agent",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "managed-agent-artifacts",
        key: "do-first-wake-agent/artifact.json",
        digest: "c".repeat(64),
        size: 512,
      },
      imageArn: "managed-agent-runtime",
      imageVersion: "1",
    });
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://do-first.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "do-first-wake-agent@development" }),
      }),
    );
    const sessionId = created.session.id;
    await waitForEvent(
      sessionId,
      (event) =>
        event.type === "runtime.log" &&
        event.data.phase === "runtime_start_failed" &&
        event.data.attempt === 1,
    );
    const session = env.SESSIONS.getByName(sessionId);
    await session.bindMicrovm({ microvmId: "sb-idle", state: "running" });
    await session.updateMicrovmState({ microvmId: "sb-idle", state: "suspended" });

    const turn = await SELF.fetch(
      `https://do-first.test/v1/sessions/${sessionId}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Still there?", idempotencyKey: "wake-1" }),
      },
    );
    expect(turn.status).toBe(202);

    // No client resume: the session lets go of the suspended sandbox and
    // boots one from its snapshot (the test platform has no runtime
    // service, so the start itself fails after loading the configuration).
    await waitForEvent(
      sessionId,
      (event) =>
        event.type === "runtime.log" &&
        event.data.phase === "configuration_loaded" &&
        event.data.attempt === 2 &&
        event.data.deploymentId === deployment.id,
    );
    expect((await session.snapshot()).microvmId).toBeUndefined();
    await expect(
      runInDurableObject(session, (_instance, state) =>
        state.storage.get<number>("runtimeWakeAttempts"),
      ),
    ).resolves.toBe(1);
  });

  it("starts the sandbox runtime of a scheduled session", async () => {
    // A schedule firing launches its session inside the account object, not
    // through the HTTP routes. Without a start of its own, a sandbox session
    // waited for a runtime forever and its schedule skipped every later run.
    const accountId = "local";
    const account = env.ACCOUNTS.getByName(accountId);
    const project = await account.createProject({
      environmentMode: "legacy",
      id: "prj_do_first_schedules",
      name: "Scheduled sandbox project",
      slug: "scheduled-sandbox-project",
    });
    const graph: ProjectDeploymentReference = {
      id: "project:prj_do_first_schedules:graph-one",
      digest: "f".repeat(64),
      localAgentId: "nightly",
      agents: [
        { localId: "nightly", agentId: project.agentId, artifactDigest: "b".repeat(64) },
      ],
      resources: {
        version: 1,
        channels: [],
        channelRegistrations: [],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [
          {
            id: "nightly",
            agentId: "nightly",
            cron: "0 3 * * *",
            timezone: "UTC",
            enabled: ["development"],
            overlap: "skip",
            dispatch: { text: "Run the nightly job" },
          },
        ],
      },
    };
    const deployment = await account.registerDeployment({
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      projectDeployment: graph,
      artifact: { bucket: "artifacts", key: "nightly.json", digest: "b".repeat(64), size: 10 },
      imageArn: "image",
      imageVersion: "1",
    });
    await account.reconcileProjectSchedules({
      accountId,
      userId: "scheduler",
      projectId: project.id,
      environment: "development",
      edgeOrigin: "https://do-first.test",
      projectDeployment: graph,
    });

    const run = await account.runProjectScheduleNow({
      projectId: project.id,
      environment: "development",
      agentId: project.agentId,
      scheduleId: "nightly",
    });
    expect(run).toMatchObject({ outcome: "enacted" });
    const session = env.SESSIONS.getByName(run.sessionId!);
    await expect(session.snapshot()).resolves.toMatchObject({
      executionMode: "microvm",
      turns: [expect.objectContaining({ input: "Run the nightly job" })],
    });
    // The launch claimed the start (attempt 1). No runtime service is
    // configured here, so the attempt fails and releases its claim.
    const launched = await waitForEvent(
      run.sessionId!,
      (event) =>
        event.type === "runtime.log" &&
        event.data.phase === "runtime_start_failed" &&
        event.data.attempt === 1,
    );
    expect(launched).toContainEqual(
      expect.objectContaining({
        type: "runtime.log",
        data: expect.objectContaining({
          phase: "configuration_loaded",
          deploymentId: deployment.id,
          attempt: 1,
        }),
      }),
    );

    // The next firing finds the session still waiting for its runtime: it
    // skips, and starts that session again rather than leaving it stranded.
    const next = await account.runProjectScheduleNow({
      projectId: project.id,
      environment: "development",
      agentId: project.agentId,
      scheduleId: "nightly",
    });
    expect(next).toMatchObject({ outcome: "skipped" });
    await waitForEvent(
      run.sessionId!,
      (event) =>
        event.type === "runtime.log" &&
        event.data.phase === "runtime_start_failed" &&
        event.data.attempt === 2,
    );
    await session.end();
  });
});
