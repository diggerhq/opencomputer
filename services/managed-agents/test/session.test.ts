import { env, SELF, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentDeployment,
  AgentSummary,
  AgentEvent,
  InitializeSessionResult,
  ProjectDeploymentReference,
  SessionSnapshot,
  SessionSummary,
  SessionToRuntimeFrame,
  ModelAccessBinding,
  ModelAccessConnection,
  ModelRoute,
} from "../src/protocol.js";
import { channelPrincipalId } from "../src/channels/principal.js";
import { SessionDurableObject } from "../src/edge/session-do.js";
import { selectApplySession } from "../src/edge/index.js";
import { OPENROUTER_MODEL_CATALOG_CACHE_KEY } from "../src/edge/model-catalog.js";
import { workerdModelConfiguration } from "../src/edge/deployment-pool-do.js";
import { hostToolCallId } from "../src/tool-identity.js";

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

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
  await env.SERVERLESS_AGENTS_DB.prepare("DELETE FROM session_creations").run();
});

const inboxes = new WeakMap<WebSocket, unknown[]>();

/**
 * Deferred webhook admission runs from the Account DO alarm, which workerd may
 * fire on its own before the test forces it. Force it, then wait for the
 * ledger to leave `pending`.
 */
async function settleWebhookRequest(
  projectId: string,
  webhookId: string,
  requestId: string,
): Promise<Record<string, unknown>> {
  await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
  for (let attempt = 0; attempt < 250; attempt++) {
    const listed = await json<{ requests: Array<Record<string, unknown>> }>(
      await SELF.fetch(
        `https://managedagents.test/v1/projects/${projectId}/webhooks/${webhookId}/requests?environment=development`,
      ),
    );
    const request = listed.requests.find((candidate) => candidate.id === requestId);
    if (request && request.outcome !== "pending") return request;
    if (request && Number(request.attempt) > 0 && request.error) return request;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Webhook request ${requestId} did not settle`);
}

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function managedCredentialRequest(
  method: "POST" | "GET" | "DELETE",
  path: string,
  body = "",
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-managed-credential-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${method}.${path}.${body}`),
  );
  const signatureHex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return SELF.fetch(`https://managedagents.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-oc-managed-ts": timestamp,
      "x-oc-managed-sig": signatureHex,
    },
    body: method === "POST" ? body : undefined,
  });
}

async function connect(path: string): Promise<WebSocket> {
  const response = await SELF.fetch(`https://managedagents.test${path}`, {
    headers: { upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  const socket = response.webSocket as WebSocket;
  const inbox: unknown[] = [];
  inboxes.set(socket, inbox);
  socket.addEventListener("message", (message) => {
    inbox.push(JSON.parse(String(message.data)) as unknown);
  });
  socket.accept();
  return socket;
}

function nextFrame<T>(
  socket: WebSocket,
  predicate: (frame: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const inbox = inboxes.get(socket);
    if (!inbox) {
      reject(new Error("WebSocket does not have an inbox"));
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      const index = inbox.findIndex((frame) => predicate(frame as T));
      if (index >= 0) {
        const [frame] = inbox.splice(index, 1);
        resolve(frame as T);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for WebSocket frame"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("managed-agent session control plane", () => {
  it.each(["github", "linear"])(
    "routes the provider-specific %s connection link endpoint",
    async (provider) => {
      const response = await SELF.fetch(
        `https://managedagents.test/v1/connections/${provider}/link`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ service: provider, label: provider }),
        },
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "managed_connections_unavailable" },
      });
    },
  );

  it("pins the first model route revision for the life of the session", async () => {
    const session = env.SESSIONS.getByName("session-route-pin");
    const initial: ModelRoute = {
      id: "mr_initial",
      organizationId: "local",
      projectId: "prj_test",
      environment: "development",
      connectionId: "mac_scx",
      model: "GLM-5.3",
      fallback: "fail",
      revision: 1,
      updatedByUserId: "admin",
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    };
    await expect(session.pinModelRoute(initial)).resolves.toEqual(initial);
    await expect(
      session.pinModelRoute({
        ...initial,
        id: "mr_changed",
        model: "deepseek-v4-flash",
        revision: 2,
      }),
    ).resolves.toEqual(initial);
  });

  it("pins the absence of a route so a later project change cannot affect it", async () => {
    const session = env.SESSIONS.getByName("session-no-route-pin");
    await expect(session.pinModelRoute(null)).resolves.toBeNull();
    await expect(
      session.pinModelRoute({
        id: "mr_late",
        organizationId: "local",
        projectId: "prj_test",
        environment: "development",
        connectionId: "mac_scx",
        model: "GLM-5.3",
        fallback: "fail",
        revision: 1,
        updatedByUserId: "admin",
        createdAt: "2026-09-15T00:00:00.000Z",
        updatedAt: "2026-09-15T00:00:00.000Z",
      }),
    ).resolves.toBeNull();
  });

  it("pins the applicable project route during session admission", async () => {
    const account = env.ACCOUNTS.getByName("route-admission-org");
    const project = await account.createProject({
      environmentMode: "legacy",
      id: "prj_route_admission",
      name: "Route admission",
      slug: "route-admission",
    });
    const deployment = await account.registerDeployment({
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "artifacts",
        key: "route-admission.json",
        digest: "a".repeat(64),
        size: 1,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    const connection = await account.connectModelAccessApiKey({
      organizationId: "route-admission-org",
      connectedByUserId: "admin",
      provider: "openai_compatible",
      apiKey: "secret",
      baseUrl: "https://api.scx.ai/v1",
    });
    const initial = await account.putModelRoute({
      organizationId: "route-admission-org",
      projectId: project.id,
      service: "linear",
      environment: "development",
      connectionId: connection.id,
      model: "GLM-5.3",
      fallback: "fail",
      updatedByUserId: "admin",
    });
    const session = env.SESSIONS.getByName("session-admission-pin");
    await session.initialize({
      id: "session-admission-pin",
      accountId: "route-admission-org",
      userId: "user",
      agentId: project.agentId,
      deploymentId: deployment.id,
      deployment,
      environment: "development",
    });
    const revised = await account.putModelRoute({
      organizationId: "route-admission-org",
      projectId: project.id,
      environment: "development",
      connectionId: connection.id,
      model: "deepseek-v4-flash",
      fallback: "fail",
      updatedByUserId: "admin",
    });
    expect(revised.revision).toBe(2);
    await expect(session.pinModelRoute(revised)).resolves.toEqual(initial);
  });

  it("reuses session creation receipts by idempotency key", async () => {
    const request = (agentId: string) =>
      SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "cli-session-retry",
        },
        body: JSON.stringify({ agentId }),
      });
    const first = await json<InitializeSessionResult>(await request("local/echo"));
    const retry = await json<InitializeSessionResult>(await request("local/echo"));
    expect(retry.session.id).toBe(first.session.id);

    const conflict = await request("local/other");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });
  });

  it("stores and resolves an organization OpenRouter key through the signed hand-off", async () => {
    const accountId = "org-model-billing";
    const ownerId = `oc-org:${accountId}`;
    const body = JSON.stringify({
      owner_id: ownerId,
      provider: "openrouter",
      key: "sk-or-test-org-key",
      or_key_hash: "or-hash-1",
      operation_id: "op-1",
    });
    const bound = await managedCredentialRequest(
      "POST",
      "/internal/managed-credential",
      body,
    );
    expect(bound.status).toBe(200);
    const binding = await bound.json<{ managed_credential_id: string }>();
    expect(binding.managed_credential_id).toMatch(/^mmc_/);

    const account = env.ACCOUNTS.getByName(accountId);
    await expect(
      account.resolveManagedModelCredential("openrouter"),
    ).resolves.toEqual({
      id: binding.managed_credential_id,
      key: "sk-or-test-org-key",
    });

    const query = `?owner_id=${encodeURIComponent(ownerId)}&or_key_hash=or-hash-1`;
    const found = await managedCredentialRequest(
      "GET",
      `/internal/managed-credential${query}`,
    );
    await expect(found.json()).resolves.toEqual({
      managed_credential_id: binding.managed_credential_id,
    });

    const removed = await managedCredentialRequest(
      "DELETE",
      `/internal/managed-credential?owner_id=${encodeURIComponent(ownerId)}`,
    );
    await expect(removed.json()).resolves.toEqual({ deleted: 1 });
    await expect(
      account.resolveManagedModelCredential("openrouter"),
    ).resolves.toBeNull();
  });

  it("reconciles environment schedules and starts a structured manual run", async () => {
    const account = env.ACCOUNTS.getByName("project-schedules");
    const project = await account.createProject({
      environmentMode: "legacy",
      id: "prj_schedules",
      name: "Scheduled project",
      slug: "scheduled-project",
    });
    const graph: ProjectDeploymentReference = {
      id: "project:prj_schedules:graph-one",
      digest: "f".repeat(64),
      localAgentId: "hygiene",
      agents: [
        {
          localId: "hygiene",
          agentId: project.agentId,
          artifactDigest: "a".repeat(64),
        },
      ],
      resources: {
        version: 1,
        channels: [],
        channelRegistrations: [],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [
          {
            id: "weekday-hygiene",
            agentId: "hygiene",
            cron: "0 9 * * 1-5",
            timezone: "America/Los_Angeles",
            enabled: ["production"],
            overlap: "skip",
            dispatch: {
              text: "Review stale flags",
              payload: { mode: "async", dryRun: true },
            },
          },
        ],
      },
    };
    await account.registerDeployment({
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      projectDeployment: graph,
      artifact: {
        bucket: "artifacts",
        key: "hygiene.json",
        digest: "a".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    await expect(
      account.reconcileProjectSchedules({
        accountId: "project-schedules",
        userId: "scheduler",
        projectId: project.id,
        environment: "development",
        edgeOrigin: "https://managedagents.test",
        projectDeployment: graph,
      }),
    ).resolves.toEqual({ active: 1, ready: true });

    const [schedule] = await account.listProjectSchedules({
      projectId: project.id,
      environment: "development",
      agentId: project.agentId,
    });
    expect(schedule).toMatchObject({
      id: "weekday-hygiene",
      cron: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
      overlap: "skip",
      status: "manual",
      dispatch: { payload: { mode: "async", dryRun: true } },
    });
    await expect(
      account.reconcileProjectSchedules({
        accountId: "project-schedules",
        userId: "scheduler",
        projectId: project.id,
        environment: "production",
        edgeOrigin: "https://managedagents.test",
        projectDeployment: graph,
      }),
    ).resolves.toEqual({ active: 1, ready: true });
    await expect(
      account.listProjectSchedules({
        projectId: project.id,
        environment: "production",
        agentId: project.agentId,
      }),
    ).resolves.toContainEqual(expect.objectContaining({ status: "active" }));

    const developmentRecurring = {
      ...graph,
      resources: {
        ...graph.resources,
        schedules: graph.resources.schedules.map((definition) => ({
          ...definition,
          enabled: ["development", "production"] as const,
        })),
      },
    };
    await account.reconcileProjectSchedules({
      accountId: "project-schedules",
      userId: "scheduler",
      projectId: project.id,
      environment: "development",
      edgeOrigin: "https://managedagents.test",
      projectDeployment: developmentRecurring,
    });
    await expect(
      account.listProjectSchedules({
        projectId: project.id,
        environment: "development",
        agentId: project.agentId,
      }),
    ).resolves.toContainEqual(expect.objectContaining({ status: "active" }));

    const run = await account.runProjectScheduleNow({
      projectId: project.id,
      environment: "development",
      agentId: project.agentId,
      scheduleId: "weekday-hygiene",
    });
    expect(run).toMatchObject({
      scheduleId: "weekday-hygiene",
      manual: true,
      outcome: "enacted",
    });
    expect(run.sessionId).toBeTruthy();
    // A schedule admission records the schedule's environment on the
    // session: the list's environment filter never hides it.
    await expect(account.getSession(run.sessionId!)).resolves.toMatchObject({
      id: run.sessionId,
      source: "schedule",
      projectId: project.id,
      environment: "development",
    });
    const session = env.SESSIONS.getByName(run.sessionId!);
    await expect(session.snapshot()).resolves.toMatchObject({
      deploymentId: `${project.agentId}:${"a".repeat(64)}`,
      environment: "development",
      turns: [
        expect.objectContaining({ input: "Review stale flags", status: "queued" }),
      ],
    });
    expect(
      (await account.listSessionSummaries({ environment: "development", labels: [], limit: 50 })).sessions.map(
        (candidate: { id: string }) => candidate.id,
      ),
    ).toContain(run.sessionId);

    await session.end();
    const rerun = await account.runProjectScheduleNow({
      projectId: project.id,
      environment: "development",
      agentId: project.agentId,
      scheduleId: "weekday-hygiene",
    });
    expect(rerun).toMatchObject({ outcome: "enacted" });
    expect(rerun.sessionId).not.toBe(run.sessionId);

    await expect(
      account.runProjectScheduleNow({
        projectId: project.id,
        environment: "development",
        agentId: project.agentId,
        scheduleId: "weekday-hygiene",
      }),
    ).resolves.toMatchObject({
      outcome: "skipped",
      error: "A prior run is still active",
    });
  });

  it("commits the question a MicroVM turn ended with, holds the turns behind it, and admits the answer", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "local/examples/hello-agent", deploymentId: "development" }),
      }),
    );
    const sessionId = created.session.id;
    const runtime = await connect(`/v1/sessions/${sessionId}/connect?role=runtime&token=${created.runtimeToken}`);
    const welcome = await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "runtime.welcome");
    if (welcome.type !== "runtime.welcome") return;
    runtime.send(JSON.stringify({ type: "model.configuration.request", epoch: welcome.epoch }));
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "model.configuration");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));
    const send = (input: string, key: string, extra: Record<string, unknown> = {}) =>
      SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, idempotencyKey: key, ...extra }),
      }).then((response) => json<{ turnId: string }>(response));
    const asking = await send("write hello world", "microvm-ask-1");
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "turn.start" && frame.turnId === asking.turnId);
    const behind = await send("also add a README", "microvm-ask-2");
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "frame-ask-1",
        turnId: asking.turnId,
        events: [
          { type: "tool.started", data: { callId: "call-ask", tool: "ask", title: "ask", input: { text: "Which language?" } } },
          { type: "tool.completed", data: { callId: "call-ask", tool: "ask", title: "ask", output: "recorded" } },
          { type: "message.completed", data: { text: "I need one decision first." } },
        ],
      }),
    );
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "frame-ask-2",
        turnId: asking.turnId,
        events: [
          {
            type: "turn.completed",
            data: {
              question: {
                callId: "call-ask",
                text: "Which language?",
                options: [
                  { label: "Python", value: "python" },
                  { label: "Go", value: "go" },
                ],
                context: "Both work here.",
              },
            },
          },
        ],
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(runtime, () => false, 20).catch(() => undefined);

    const { events } = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/events`),
    );
    const asked = events.find((event) => event.type === "question.asked")!;
    expect(asked).toMatchObject({
      turnId: asking.turnId,
      data: {
        text: "Which language?",
        options: [
          { label: "Python", value: "python" },
          { label: "Go", value: "go" },
        ],
        context: "Both work here.",
      },
    });
    const questionId = (asked.data as { questionId: string }).questionId;
    const completed = events.find((event) => event.type === "turn.completed" && event.turnId === asking.turnId)!;
    // The question travels to the session on the completion, not out of it.
    expect(completed.data).toEqual({ outcome: "question", questionId });
    expect(events.indexOf(asked)).toBeLessThan(events.indexOf(completed));
    const snapshot = await env.SESSIONS.getByName(sessionId).snapshot();
    expect(snapshot).toMatchObject({ status: "idle", question: { id: questionId, text: "Which language?" } });
    // The turn queued behind the question waits as steering for the answer.
    expect(snapshot.turns.find((turn: { id: string }) => turn.id === behind.turnId)).toMatchObject({ status: "cancelled" });

    const answer = await send("Go", "microvm-ask-3", { answers: questionId });
    const start = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start" && frame.turnId === answer.turnId,
    );
    if (start.type !== "turn.start") return;
    expect(start.input).toContain("Go");
    expect(start.agentInput).toMatchObject({
      answer: { questionId, value: "go" },
      steering: [{ text: "also add a README" }],
    });
    runtime.close();
  });

  it("settles a tool call the runtime never completed when the turn ends, ahead of the terminal event", async () => {
    // Review finding 7: a terminal turn event settles every tool call of
    // that turn without a completion of its own, on the MicroVM path too.
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "local/examples/hello-agent", deploymentId: "development" }),
      }),
    );
    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "runtime.welcome");
    if (welcome.type !== "runtime.welcome") return;
    runtime.send(JSON.stringify({ type: "model.configuration.request", epoch: welcome.epoch }));
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "model.configuration");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));
    const turn = await json<{ turnId: string }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "run something", idempotencyKey: "settle-turn-1" }),
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "turn.start" && frame.turnId === turn.turnId);
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "frame-settle-1",
        turnId: turn.turnId,
        events: [
          { type: "tool.started", data: { callId: "call-open", tool: "shell", title: "shell", input: { command: "sleep 100" }, messageId: "msg-open" } },
          { type: "tool.started", data: { callId: "call-done", tool: "lookup", title: "lookup", input: {} } },
          { type: "tool.completed", data: { callId: "call-done", tool: "lookup", title: "lookup", output: "found" } },
        ],
      }),
    );
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "frame-settle-2",
        turnId: turn.turnId,
        events: [{ type: "turn.failed", data: { message: "the runtime gave up" } }],
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(runtime, () => false, 20).catch(() => undefined);
    const { events } = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/events`),
    );
    const failed = events.find((event) => event.type === "turn.failed" && event.turnId === turn.turnId)!;
    const settled = events.filter((event) => event.type === "tool.failed" && event.turnId === turn.turnId);
    expect(settled.map((event) => event.data)).toEqual([
      {
        callId: "call-open",
        tool: "shell",
        title: "shell",
        message: "The turn ended (turn.failed) before this tool call completed",
        settledBy: "turn.failed",
        // The synthetic failure carries the same host identity as the call
        // it settles, the message recovered from the call's own start.
        identity: {
          projectId: "project:local/examples/hello-agent",
          environment: "development",
          agentId: "local/examples/hello-agent",
          deploymentId: "development",
          sessionId: created.session.id,
          turnId: turn.turnId,
          messageId: "msg-open",
          providerCallId: "call-open",
          toolCallId: hostToolCallId({
            sessionId: created.session.id,
            turnId: turn.turnId,
            messageId: "msg-open",
            providerCallId: "call-open",
          }),
        },
      },
    ]);
    expect(settled[0]!.seq).toBeLessThan(failed.seq);
    runtime.close(1000, "test complete");
  });

  it("preserves an indexed session source on the detail route", async () => {
    const sessionId = crypto.randomUUID();
    const session = env.SESSIONS.getByName(sessionId);
    const initialized = await session.initialize({
      id: sessionId,
      accountId: "local",
      userId: "test-user",
      agentId: "scheduled-agent",
      deploymentId: "scheduled-deployment",
      source: "schedule",
    });
    await session.publishSummary();

    await expect(
      env.SERVERLESS_AGENTS_DB.prepare(
        "SELECT account_id, source, created_at FROM session_creations WHERE session_id = ?",
      )
        .bind(sessionId)
        .first(),
    ).resolves.toEqual({
      account_id: "local",
      source: "schedule",
      created_at: initialized.session.createdAt,
    });

    await expect(
      json<SessionSnapshot & { source: string }>(
        await SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}`),
      ),
    ).resolves.toMatchObject({ id: sessionId, source: "schedule" });

    await env.SERVERLESS_AGENTS_DB.prepare(
      "DELETE FROM session_creations WHERE session_id = ?",
    )
      .bind(sessionId)
      .run();
    const backfilled = await SELF.fetch(
      "https://managedagents.test/internal/session-index/backfill?account_id=local",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-session-index-admin-secret",
        },
      },
    );
    await expect(backfilled.json()).resolves.toEqual({
      account_id: "local",
      indexed: 1,
    });
    await expect(
      env.SERVERLESS_AGENTS_DB.prepare(
        "SELECT COUNT(*) AS count FROM session_creations WHERE session_id = ?",
      )
        .bind(sessionId)
        .first("count"),
    ).resolves.toBe(1);
  });

  it("assigns a managed runtime profile through the operator route and exposes only its safe label", async () => {
    const assigned = await SELF.fetch(
      "https://managedagents.test/internal/account/runtime-profile?account_id=local",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-session-index-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileId: "acme-scanner" }),
      },
    );
    expect(assigned.status).toBe(200);
    await expect(assigned.json()).resolves.toMatchObject({
      accountId: "local",
      profileId: "acme-scanner",
      customized: true,
      displayName: "Acme scanning",
    });

    const visible = await SELF.fetch(
      "https://managedagents.test/v1/account/runtime-profile",
    );
    expect(visible.status).toBe(200);
    await expect(visible.json()).resolves.toEqual({
      customized: true,
      displayName: "Acme scanning",
    });
    expect(await env.ACCOUNTS.getByName("local").getManagedRuntimeProfile()).toMatchObject({
      profileId: "acme-scanner",
    });

    const cleared = await SELF.fetch(
      "https://managedagents.test/internal/account/runtime-profile?account_id=local",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-session-index-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileId: null }),
      },
    );
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      profileId: null,
      customized: false,
      displayName: "OpenComputer default",
    });
    await expect(
      env.ACCOUNTS.getByName("local").getManagedRuntimeProfile(),
    ).resolves.toMatchObject({ profileId: null });
    const visibleAfterClear = await SELF.fetch(
      "https://managedagents.test/v1/account/runtime-profile",
    );
    await expect(visibleAfterClear.json()).resolves.toEqual({
      customized: false,
      displayName: "OpenComputer default",
    });

    const wrongMethod = await SELF.fetch(
      "https://managedagents.test/internal/account/runtime-profile?account_id=local",
    );
    expect(wrongMethod.status).toBe(404);
  });

  it("rejects unknown managed runtime profiles without changing the account", async () => {
    const response = await SELF.fetch(
      "https://managedagents.test/internal/account/runtime-profile?account_id=local",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-session-index-admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ profileId: "unknown-profile" }),
      },
    );
    expect(response.status).toBe(400);
    expect(await env.ACCOUNTS.getByName("local").getManagedRuntimeProfile()).toBeNull();
  });

  it("activates a project deployment only after every member is registered", async () => {
    const account = env.ACCOUNTS.getByName("project-activation");
    const graph: ProjectDeploymentReference = {
      id: "project:prj_test:graph-one",
      digest: "c".repeat(64),
      localAgentId: "reviewer",
      agents: [
        {
          localId: "reviewer",
          agentId: "reviewer-agent",
          artifactDigest: "a".repeat(64),
        },
        {
          localId: "notifier",
          agentId: "notifier-agent",
          artifactDigest: "b".repeat(64),
        },
      ],
      resources: {
        version: 1,
        channels: [],
        channelRegistrations: [],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [],
      },
    };
    await account.registerDeployment({
      agentId: "reviewer-agent",
      alias: "production",
      channels: [],
      connections: [],
      projectDeployment: graph,
      artifact: {
        bucket: "artifacts",
        key: "reviewer.json",
        digest: "a".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    await expect(
      account.resolveDeployment("reviewer-agent@production"),
    ).resolves.toBeNull();

    await account.registerDeployment({
      agentId: "notifier-agent",
      alias: "production",
      channels: [],
      connections: [],
      projectDeployment: { ...graph, localAgentId: "notifier" },
      artifact: {
        bucket: "artifacts",
        key: "notifier.json",
        digest: "b".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    await expect(
      account.resolveDeployment("reviewer-agent@production"),
    ).resolves.toMatchObject({
      id: `reviewer-agent:${"a".repeat(64)}`,
      projectDeployment: { id: graph.id, localAgentId: "reviewer" },
    });
    await expect(
      account.resolveDeployment("notifier-agent@production"),
    ).resolves.toMatchObject({
      id: `notifier-agent:${"b".repeat(64)}`,
      projectDeployment: { id: graph.id, localAgentId: "notifier" },
    });
  });

  it("activates a corrected project roster when a failed attempt left stale members", async () => {
    const account = env.ACCOUNTS.getByName("project-roster-retry");
    const resources: ProjectDeploymentReference["resources"] = {
      version: 1,
      channels: [],
      channelRegistrations: [],
      outboxes: [],
      outboxRegistrations: [],
      schedules: [],
    };
    const id = "project:prj_retry:same-client-digest";
    const stale: ProjectDeploymentReference = {
      id,
      digest: "c".repeat(64),
      localAgentId: "coder",
      agents: [
        {
          localId: "coder",
          agentId: "summarizer-agent",
          artifactDigest: "a".repeat(64),
        },
        {
          localId: "summarizer",
          agentId: "summarizer-agent--summarizer",
          artifactDigest: "b".repeat(64),
        },
      ],
      resources,
    };
    const corrected: ProjectDeploymentReference = {
      ...stale,
      agents: [
        {
          localId: "coder",
          agentId: "coder-agent",
          artifactDigest: "a".repeat(64),
        },
        {
          localId: "summarizer",
          agentId: "coder-agent--summarizer",
          artifactDigest: "b".repeat(64),
        },
      ],
    };
    const register = (
      graph: ProjectDeploymentReference,
      member: ProjectDeploymentReference["agents"][number],
    ) =>
      account.registerDeployment({
        agentId: member.agentId,
        alias: "production",
        channels: [],
        connections: [],
        projectDeployment: { ...graph, localAgentId: member.localId },
        artifact: {
          bucket: "artifacts",
          key: `${member.localId}.json`,
          digest: member.artifactDigest,
          size: 10,
        },
        imageArn: "image",
        imageVersion: "1",
      });

    for (const member of stale.agents) await register(stale, member);
    for (const member of corrected.agents) await register(corrected, member);

    await expect(
      account.resolveDeployment("coder-agent@production"),
    ).resolves.toMatchObject({
      id: `coder-agent:${"a".repeat(64)}`,
      projectDeployment: { id, localAgentId: "coder" },
    });
    await expect(
      account.resolveDeployment("coder-agent--summarizer@production"),
    ).resolves.toMatchObject({
      id: `coder-agent--summarizer:${"b".repeat(64)}`,
      projectDeployment: { id, localAgentId: "summarizer" },
    });
  });

  it("rejects a child agent declared as a project's primary member", async () => {
    const project = await json<{ id: string; agentId: string }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environmentMode: "single",
          name: "Primary guard",
          slug: "primary-guard",
        }),
      }),
    );
    const childAgentId = `${project.agentId}--summarizer`;
    const graph: ProjectDeploymentReference = {
      id: "project:prj_primary_guard:bad-graph",
      digest: "c".repeat(64),
      localAgentId: "summarizer",
      agents: [
        {
          localId: "summarizer",
          agentId: childAgentId,
          artifactDigest: "a".repeat(64),
        },
      ],
      resources: {
        version: 1,
        channels: [],
        channelRegistrations: [],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [],
      },
    };

    const rejected = await SELF.fetch(
      "https://managedagents.test/v1/deployments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: childAgentId,
          alias: "default",
          channels: [],
          connections: [],
          projectDeployment: graph,
          artifact: {
            bucket: "artifacts",
            key: "summarizer.json",
            digest: "a".repeat(64),
            size: 10,
          },
          imageArn: "image",
          imageVersion: "1",
        }),
      },
    );
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "invalid_project_deployment" },
    });
    await expect(
      env.ACCOUNTS.getByName("local").listAgents(),
    ).resolves.not.toContainEqual(
      expect.objectContaining({ id: childAgentId }),
    );
  });

  it("lists outbox readiness and history for exactly one environment", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const graph: ProjectDeploymentReference = {
      id: "project:prj_outboxes:graph-one",
      digest: "d".repeat(64),
      localAgentId: "reviewer",
      agents: [
        {
          localId: "reviewer",
          agentId: "reviewer-agent",
          artifactDigest: "e".repeat(64),
        },
      ],
      resources: {
        version: 1,
        channels: [
          {
            id: "team-slack",
            type: "slack",
            displayName: "Team Slack",
            scopes: { bot: ["chat:write"] },
            events: [],
            destinations: {
              "pull-request-reviews": {
                type: "conversation",
                visibility: "private",
              },
            },
            routing: { whenAmbiguous: "ask" },
          },
        ],
        channelRegistrations: [],
        outboxes: [
          {
            id: "review-requests",
            channelId: "team-slack",
            destination: "pull-request-reviews",
          },
        ],
        outboxRegistrations: [
          { agentId: "reviewer", outboxId: "review-requests" },
        ],
        schedules: [],
      },
    };
    for (const alias of ["development", "production"] as const) {
      await account.registerDeployment({
        agentId: "reviewer-agent",
        alias,
        channels: [],
        connections: [],
        projectDeployment: graph,
        artifact: {
          bucket: "artifacts",
          key: "reviewer.json",
          digest: "e".repeat(64),
          size: 10,
        },
        imageArn: "image",
        imageVersion: "1",
      });
      await account.createOutboxItem({
        agentId: "reviewer-agent",
        alias,
        deploymentId: `reviewer-agent:${alias}`,
        sessionId: `session-${alias}`,
        outboxId: "review-requests",
        eventType: `pull-request.ready.${alias}`,
        idempotencyKey: "same-key",
        content: { title: alias },
      });
    }

    const response = await json<{
      environment: string;
      outboxes: Array<{
        id: string;
        readiness: string;
        items: Array<{
          eventType: string;
          sessionId?: string;
          contentPreview: { title?: string };
        }>;
      }>;
    }>(
      await SELF.fetch(
        "https://managedagents.test/v1/outboxes?agentId=reviewer-agent&environment=development",
      ),
    );
    expect(response.environment).toBe("development");
    expect(response.outboxes).toEqual([
      expect.objectContaining({
        id: "review-requests",
        readiness: "channel_not_connected",
        items: [
          expect.objectContaining({
            eventType: "pull-request.ready.development",
            sessionId: "session-development",
            contentPreview: { title: "development" },
          }),
        ],
      }),
    ]);
  });

  it("isolates Slack connections by code-defined channel and deduplicates outbox items", async () => {
    const account = env.ACCOUNTS.getByName("channel-resources");
    await account.createSlackConnection({
      id: "engineering-slack",
      channelId: "engineering",
      agentId: "reviewer-agent",
      alias: "production",
      appName: "Engineering",
    });
    await account.createSlackConnection({
      id: "support-slack",
      channelId: "support",
      agentId: "reviewer-agent",
      alias: "production",
      appName: "Support",
    });
    await expect(
      account.findSlackConnectionForAlias(
        "reviewer-agent",
        "production",
        "engineering",
      ),
    ).resolves.toMatchObject({ id: "engineering-slack" });

    const input = {
      agentId: "reviewer-agent",
      alias: "production",
      deploymentId: "reviewer-agent:digest",
      sessionId: "session-production",
      outboxId: "pull-request-reviews",
      eventType: "pull-request.ready",
      idempotencyKey: "repo:42:ready",
      content: { title: "Review pull request #42" },
    };
    const first = await account.createOutboxItem(input);
    const duplicate = await account.createOutboxItem(input);
    const development = await account.createOutboxItem({
      ...input,
      alias: "development",
      deploymentId: "reviewer-agent:development-digest",
    });
    expect(first).toMatchObject({ status: "pending", duplicate: false });
    expect(duplicate).toEqual({
      id: first.id,
      status: "pending",
      duplicate: true,
    });
    await expect(
      account.listOutboxItems("reviewer-agent", "production"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: first.id,
        outboxId: "pull-request-reviews",
        sessionId: "session-production",
        contentPreview: { title: "Review pull request #42" },
      }),
    ]);
    await expect(
      account.listOutboxItems("reviewer-agent", "development"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: development.id,
        outboxId: "pull-request-reviews",
      }),
    ]);
  });

  it("persists redacted Slack channel health summaries", async () => {
    const account = env.ACCOUNTS.getByName("channel-health");
    await account.createSlackConnection({
      id: "health-slack",
      channelId: "engineering",
      agentId: "reviewer-agent",
      alias: "development",
      appName: "Engineering",
    });

    await account.recordSlackEvent("health-slack");
    await account.recordSlackError("health-slack", "ingress_session_create_failed");
    await account.recordSlackDelivery(
      "health-slack",
      "failed",
      "turn_delivery_failed",
    );
    const failed = await account.getSlackConnection("health-slack");
    expect(failed?.lastEventAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(failed?.lastDelivery).toMatchObject({ status: "failed" });
    expect(failed?.lastError).toMatchObject({
      category: "turn_delivery_failed",
    });

    await account.recordSlackDelivery("health-slack", "delivered");
    const recovered = await account.getSlackConnection("health-slack");
    expect(recovered?.lastDelivery).toMatchObject({ status: "delivered" });
    expect(recovered?.lastError).toEqual(failed?.lastError);
  });

  it("isolates one Slack user across agent apps", async () => {
    const first = await channelPrincipalId(
      "slack",
      "org-one",
      "agent-one-app",
      "U123",
    );
    const repeated = await channelPrincipalId(
      "slack",
      "org-one",
      "agent-one-app",
      "U123",
    );
    const second = await channelPrincipalId(
      "slack",
      "org-one",
      "agent-two-app",
      "U123",
    );

    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^channel:slack:[a-f0-9]{64}$/);
  });

  it("keeps same-provider aliases isolated by user identity", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await account.upsertManagedToolConnection({
      id: "personal-gmail",
      provider: "google",
      label: "personal",
      ownerUserId: "user-one",
      externalAccountId: "ca_personal",
      scopes: ["gmail.readonly"],
    });
    await account.upsertManagedToolConnection({
      id: "work-gmail",
      provider: "google",
      label: "personal",
      ownerUserId: "user-two",
      externalAccountId: "ca_work",
      scopes: ["gmail.readonly"],
    });

    expect(await account.listConnections("user-one")).toMatchObject([
      { id: "personal-gmail", label: "personal", ownerUserId: "user-one" },
    ]);
    expect(
      await account.findUserConnection("user-two", "google", "personal"),
    ).toMatchObject({ id: "work-gmail", ownerUserId: "user-two" });
    expect(
      await account.getConnectionForUser("personal-gmail", "user-two"),
    ).toBeNull();
  });

  it("attaches an account connection to a project independently of the session principal", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const project = await account.createProject({
      id: "project-service-test",
      name: "Project services",
      slug: "project-services",
    });
    await account.upsertManagedToolConnection({
      id: "owner-linear",
      provider: "linear",
      label: "default",
      ownerUserId: "account-owner",
      externalAccountId: "ca_linear_owner",
      scopes: ["read", "issues:create"],
    });

    await expect(
      account.attachProjectServiceConnection({
        projectId: project.id,
        connectionId: "owner-linear",
      }),
    ).resolves.toMatchObject({
      projectId: project.id,
      provider: "linear",
      label: "default",
      connectionId: "owner-linear",
      connection: {
        ownerUserId: "account-owner",
        externalAccountId: "ca_linear_owner",
      },
    });

    const slackPrincipal = await channelPrincipalId(
      "slack",
      "local",
      "linear-agent-app",
      "U123",
    );
    expect(slackPrincipal).not.toBe("account-owner");
    await expect(
      account.listProjectServiceAttachments(project.id, "linear"),
    ).resolves.toMatchObject([
      {
        connectionId: "owner-linear",
        connection: { externalAccountId: "ca_linear_owner" },
      },
    ]);

    // Reauthorization keeps the logical row and attachment even while the
    // replacement consent is pending or its browser link expires.
    await account.upsertManagedToolConnection({
      id: "owner-linear",
      provider: "linear",
      label: "default",
      ownerUserId: "account-owner",
      scopes: ["read", "issues:create"],
      status: "pending",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await account.deleteExpiredManagedConnections(
      "2026-10-07T00:00:00.000Z",
    );
    await expect(account.getConnection("owner-linear")).resolves.toMatchObject({
      status: "pending",
    });
    await expect(
      account.listProjectServiceAttachments(project.id, "linear"),
    ).resolves.toHaveLength(1);

    account.removeConnection("owner-linear");
    await expect(
      account.listProjectServiceAttachments(project.id, "linear"),
    ).resolves.toEqual([]);
  });

  it("manages project service attachments through the owner API", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const project = await account.createProject({
      id: "project-service-route-test",
      name: "Project service route",
      slug: "project-service-route",
    });
    await account.upsertManagedToolConnection({
      id: "route-linear",
      provider: "linear",
      label: "default",
      ownerUserId: "local",
      externalAccountId: "ca_route_linear",
      scopes: ["read", "issues:create"],
    });

    const path = `https://managedagents.test/v1/projects/${project.id}/service-connections`;
    const attached = await json<{
      connectionId: string;
      service: string;
      connection: Record<string, unknown>;
    }>(
      await SELF.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId: "route-linear" }),
      }),
    );
    expect(attached.connectionId).toBe("route-linear");
    expect(attached.service).toBe("linear");
    expect(attached.connection).not.toHaveProperty("ownerUserId");
    expect(attached.connection).not.toHaveProperty("externalAccountId");

    const listed = await json<{
      attachments: Array<{ connectionId: string; connection: object }>;
    }>(await SELF.fetch(path));
    expect(listed.attachments).toMatchObject([
      {
        connectionId: "route-linear",
        connection: { provider: "linear", status: "connected" },
      },
    ]);
    expect(listed.attachments[0]?.connection).not.toHaveProperty("ownerUserId");
    expect(listed.attachments[0]?.connection).not.toHaveProperty(
      "externalAccountId",
    );

    const detached = await SELF.fetch(path, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "route-linear" }),
    });
    expect(detached.status).toBe(204);

  });

  it("keeps Google service attachments with the same label distinct", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const project = await account.createProject({
      id: "project-google-services-test",
      name: "Google project services",
      slug: "google-project-services",
    });
    await account.upsertManagedToolConnection({
      id: "default-gmail",
      provider: "google",
      label: "default",
      ownerUserId: "local",
      externalAccountId: "ca_gmail",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    });
    await account.upsertManagedToolConnection({
      id: "default-calendar",
      provider: "google",
      label: "default",
      ownerUserId: "local",
      externalAccountId: "ca_calendar",
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });

    await account.attachProjectServiceConnection({
      projectId: project.id,
      connectionId: "default-gmail",
    });
    await account.attachProjectServiceConnection({
      projectId: project.id,
      connectionId: "default-calendar",
    });

    await expect(
      account.listProjectServiceAttachments(project.id),
    ).resolves.toMatchObject([
      { service: "calendar", label: "default", connectionId: "default-calendar" },
      { service: "gmail", label: "default", connectionId: "default-gmail" },
    ]);
  });

  it("rate limits pending managed connection checks and deletes expired attempts", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await account.upsertManagedToolConnection({
      id: "pending-gmail",
      provider: "google",
      label: "pending",
      ownerUserId: "user-one",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "pending",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await account.upsertManagedToolConnection({
      id: "expired-gmail",
      provider: "google",
      label: "expired",
      ownerUserId: "user-one",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "pending",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      account.claimPendingManagedConnections({
        ownerUserId: "user-one",
        checkedAt: "2026-08-02T00:00:00.000Z",
        retryBefore: "2026-08-01T23:59:55.000Z",
      }),
    ).resolves.toMatchObject([{ id: "pending-gmail", status: "pending" }]);
    await expect(
      account.claimPendingManagedConnections({
        ownerUserId: "user-one",
        checkedAt: "2026-08-02T00:00:01.000Z",
        retryBefore: "2026-08-01T23:59:56.000Z",
      }),
    ).resolves.toEqual([]);
    await expect(
      account.claimPendingManagedConnections({
        ownerUserId: "user-one",
        checkedAt: "2026-08-02T00:00:06.000Z",
        retryBefore: "2026-08-02T00:00:01.000Z",
      }),
    ).resolves.toMatchObject([{ id: "pending-gmail" }]);
    await expect(account.getConnection("expired-gmail")).resolves.toBeNull();
    await account.upsertManagedToolConnection({
      id: "legacy-pending-gmail",
      provider: "google",
      label: "legacy-pending",
      ownerUserId: "user-one",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "pending",
    });
    await account.deleteExpiredManagedConnections(
      "2098-01-01T00:00:00.000Z",
    );
    await expect(
      account.getConnection("legacy-pending-gmail"),
    ).resolves.toBeNull();
  });

  it("clears pending lifecycle metadata when a managed connection succeeds", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await account.upsertManagedToolConnection({
      id: "eventual-gmail",
      provider: "google",
      label: "default",
      ownerUserId: "user-one",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "pending",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await account.upsertManagedToolConnection({
      id: "eventual-gmail",
      provider: "google",
      label: "default",
      ownerUserId: "user-one",
      externalAccountId: "ca_active",
      displayName: "owner@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      status: "connected",
    });

    await expect(
      account.claimPendingManagedConnections({
        ownerUserId: "user-one",
        checkedAt: "2098-01-01T00:00:00.000Z",
        retryBefore: "2097-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual([]);
    await expect(account.getConnection("eventual-gmail")).resolves.toMatchObject(
      {
        status: "connected",
        externalAccountId: "ca_active",
        displayName: "owner@example.com",
      },
    );
  });

  it("reuses a linked Slack identity within one workspace only", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await account.createSlackConnection({
      id: "slack-one",
      agentId: "agent-one",
      alias: "production",
      appName: "Agent One",
    });
    await account.createSlackConnection({
      id: "slack-two",
      agentId: "agent-two",
      alias: "production",
      appName: "Agent Two",
    });
    await account.createSlackConnection({
      id: "slack-other-workspace",
      agentId: "agent-three",
      alias: "production",
      appName: "Agent Three",
    });
    const installations = [
      { team_id: "T123", team: "Acme", user_id: "B1", bot_id: "BOT1" },
      { team_id: "T123", team: "Acme", user_id: "B2", bot_id: "BOT2" },
      { team_id: "T999", team: "Other", user_id: "B3", bot_id: "BOT3" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, ...installations.shift() })),
    );
    await account.completeSlackConnection("slack-one", "xoxb-one", "APP1");
    await account.completeSlackConnection("slack-two", "xoxb-two", "APP2");
    await account.completeSlackConnection(
      "slack-other-workspace",
      "xoxb-three",
      "APP3",
    );
    await account.issueChannelIdentityLink({
      connectionId: "slack-one",
      externalUserId: "U123",
      tokenHash: "link-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(
      await account.claimChannelIdentityLink(
        "link-token",
        "opencomputer-user",
      ),
    ).toBe(true);

    expect(await account.resolveChannelIdentity("slack-two", "U123")).toBe(
      "opencomputer-user",
    );
    expect(
      await account.resolveChannelIdentity("slack-other-workspace", "U123"),
    ).toBeNull();
  });

  it("records Slack credential verification without disabling the channel", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await account.createSlackConnection({
      id: "slack-verification",
      agentId: "agent-verification",
      alias: "production",
      appName: "Verification Agent",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          team_id: "T123",
          team: "Acme",
          user_id: "B1",
          bot_id: "BOT1",
        }),
      ),
    );
    await account.completeSlackConnection(
      "slack-verification",
      "xoxb-verification",
      "APP1",
      "a".repeat(32),
    );
    expect(await account.getSlackConnection("slack-verification")).toMatchObject(
      {
        status: "connected",
        verifiedAt: undefined,
        verificationError: undefined,
      },
    );

    expect(
      await account.recordSlackVerification("slack-verification", false),
    ).toMatchObject({
      status: "connected",
      verifiedAt: undefined,
      verificationError: "signing_secret_mismatch",
    });
    expect(
      await account.recordSlackVerification("slack-verification", true),
    ).toMatchObject({
      status: "connected",
      verifiedAt: expect.any(String),
      verificationError: undefined,
    });
  });

  it("claims a channel connection grant once", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await account.issueChannelConnectionGrant({
      tokenHash: "grant-token",
      connectionId: "slack-agent-one",
      externalUserId: "U123",
      principalUserId: "channel:slack:principal",
      service: "gmail",
      label: "personal",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await expect(
      account.claimChannelConnectionGrant("grant-token"),
    ).resolves.toEqual({
      connectionId: "slack-agent-one",
      externalUserId: "U123",
      principalUserId: "channel:slack:principal",
      service: "gmail",
      label: "personal",
    });
    await expect(
      account.claimChannelConnectionGrant("grant-token"),
    ).resolves.toBeNull();
  });

  it("claims a deployment warm-pool slot only once", async () => {
    const pool = env.POOLS.getByName("account:deployment:image");
    expect(await pool.beginFill(1_000)).toBe(true);
    expect(await pool.beginFill(1_001)).toBe(false);
    expect(
      await pool.completeFill({
        microvmId: "microvm-warm",
        endpoint: "warm.example.test",
        claimToken: "claim-token",
        createdAt: "2026-07-31T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(await pool.beginFill(1_002)).toBe(false);
    await expect(pool.claim()).resolves.toMatchObject({
      microvmId: "microvm-warm",
      claimToken: "claim-token",
    });
    await expect(pool.claim()).resolves.toBeNull();
    expect(await pool.beginFill(1_003)).toBe(true);
  });

  it("atomically claims distinct Workerd prewarm leases", async () => {
    const pool = env.POOLS.getByName("account:deployment:workerd");
    const modelConfiguration = workerdModelConfiguration({
      models: [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
      defaultModel: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      },
    });
    const slots = await pool.beginWorkerdFill(2, modelConfiguration, 1_000);
    const capabilities: Array<{ id: string; token: string }> = [];
    expect(slots).toHaveLength(2);
    for (const [index, slot] of slots.entries()) {
      const capability = await pool.createWorkerdModelGatewayCapability(slot);
      capabilities.push(capability);
      await expect(
        pool.authenticateWorkerdModelGateway(capability.id, capability.token),
      ).resolves.toBeNull();
      expect(
        await pool.completeWorkerdFill(slot, {
          runtimeSessionId: `runtime-${index}`,
          opencodeSessionId: `opencode-${index}`,
          modelGatewayCapabilityId: capability.id,
          runtimeBootId: `boot-${index}`,
          runtimeActivation: 1,
          runtimeInitMs: 10 + index,
          createdAt: new Date(1_000 + index).toISOString(),
        }),
      ).toBe(true);
    }
    expect(await pool.inspectWorkerd()).toEqual({ filling: 0, ready: 2 });

    const [first, second, empty] = await Promise.all([
      pool.claimWorkerd("session-0", modelConfiguration),
      pool.claimWorkerd("session-1", modelConfiguration),
      pool.claimWorkerd("session-2", modelConfiguration),
    ]);
    expect(new Set([first?.runtimeSessionId, second?.runtimeSessionId])).toEqual(
      new Set(["runtime-0", "runtime-1"]),
    );
    expect(empty).toBeNull();
    const claimedBySession = await Promise.all(
      capabilities.map((capability) =>
        pool.authenticateWorkerdModelGateway(capability.id, capability.token),
      ),
    );
    expect(new Set(claimedBySession.map((binding: { sessionId: string } | null) => binding?.sessionId))).toEqual(
      new Set(["session-0", "session-1"]),
    );
    await expect(
      pool.authenticateWorkerdModelGateway(capabilities[0]!.id, "wrong-token"),
    ).resolves.toBeNull();
    expect(await pool.inspectWorkerd()).toEqual({ filling: 0, ready: 0 });
  });

  it("invalidates Workerd prewarms created for a different model configuration", async () => {
    const pool = env.POOLS.getByName("account:deployment:model-change");
    const oldConfiguration = workerdModelConfiguration({
      defaultModel: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      },
    });
    const newConfiguration = workerdModelConfiguration({
      models: [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
      defaultModel: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      },
    });
    const [oldSlot] = await pool.beginWorkerdFill(1, oldConfiguration, 1_000);
    const oldCapability = await pool.createWorkerdModelGatewayCapability(oldSlot!);
    expect(
      await pool.completeWorkerdFill(oldSlot!, {
        runtimeSessionId: "runtime-old",
        opencodeSessionId: "opencode-old",
        modelGatewayCapabilityId: oldCapability.id,
        runtimeBootId: "boot-old",
        runtimeActivation: 1,
        runtimeInitMs: 10,
        createdAt: new Date(1_000).toISOString(),
      }),
    ).toBe(true);

    const [newSlot] = await pool.beginWorkerdFill(1, newConfiguration, 2_000);
    expect(newSlot).toBeDefined();
    expect(newSlot).not.toBe(oldSlot);
    expect(await pool.inspectWorkerd()).toEqual({ filling: 1, ready: 0 });
    await expect(
      pool.claimWorkerd("wrong-model-session", oldConfiguration),
    ).resolves.toBeNull();

    const newCapability = await pool.createWorkerdModelGatewayCapability(newSlot!);
    expect(
      await pool.completeWorkerdFill(newSlot!, {
        runtimeSessionId: "runtime-new",
        opencodeSessionId: "opencode-new",
        modelGatewayCapabilityId: newCapability.id,
        runtimeBootId: "boot-new",
        runtimeActivation: 1,
        runtimeInitMs: 11,
        createdAt: new Date(2_000).toISOString(),
      }),
    ).toBe(true);
    await expect(
      pool.claimWorkerd("new-model-session", newConfiguration),
    ).resolves.toMatchObject({ runtimeSessionId: "runtime-new" });
  });

  it("does not expose the retired product and project landing pages", async () => {
    const responses = await Promise.all([
      SELF.fetch("https://managedagents.test/"),
      SELF.fetch("https://managedagents.test/project.css"),
      SELF.fetch("https://managedagents.test/project.js"),
      SELF.fetch("https://managedagents.test/projects/prj_test"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 404,
    ]);
  });

  it("archives and restores a project without deleting its configuration", async () => {
    const created = await SELF.fetch("https://managedagents.test/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: "Restorable", slug: "restorable" }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { id: string; slug: string; agentId: string };

    const archived = await SELF.fetch(
      `https://managedagents.test/v1/projects/${project.id}/archive`,
      { method: "POST" },
    );
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({
      id: project.id,
      archivedAt: expect.any(String),
    });

    const listed = await json<{ projects: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects"),
    );
    expect(listed.projects.map((p) => p.id)).not.toContain(project.id);
    const archivedList = await json<{ projects: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects?archived=true"),
    );
    expect(archivedList.projects.map((p) => p.id)).toContain(project.id);

    const blockedDeploy = await SELF.fetch(
      "https://managedagents.test/v1/deployments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: project.agentId,
          alias: "development",
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/restorable/artifact.json",
            digest: "a".repeat(64),
            size: 512,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      },
    );
    expect(blockedDeploy.status).toBe(409);
    await expect(blockedDeploy.json()).resolves.toMatchObject({
      error: { code: "project_archived" },
    });

    const restored = await SELF.fetch(
      `https://managedagents.test/v1/projects/${project.id}/restore`,
      { method: "POST" },
    );
    expect(restored.status).toBe(200);
    expect((await restored.json() as { archivedAt?: string }).archivedAt).toBeUndefined();
    const relisted = await json<{ projects: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects"),
    );
    expect(relisted.projects.map((p) => p.id)).toContain(project.id);
  });

  it("replaces the project-name placeholder from the agent manifest on deploy", async () => {
    const created = await SELF.fetch("https://managedagents.test/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environmentMode: "legacy",
        name: "Customer support project",
        slug: "customer-support",
      }),
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { agentId: string };

    const deploy = (name: string | undefined, digest: string) =>
      SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: project.agentId,
          ...(name === undefined ? {} : { name }),
          alias: "production",
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/precedence-agent/artifact.json",
            digest,
            size: 512,
          },
          imageArn:
            "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      });
    const nameOf = async () =>
      (
        await json<{ agents: AgentSummary[] }>(
          await SELF.fetch("https://managedagents.test/v1/agents"),
        )
      ).agents.find((agent) => agent.id === project.agentId)?.name;

    expect(await nameOf()).toBe("Customer support project");

    expect((await deploy("Support specialist", "1".repeat(64))).status).toBe(201);
    expect(await nameOf()).toBe("Support specialist");

    // A later source rename also lands, while omitting the name preserves the
    // last deployed value rather than falling back to the id.
    expect((await deploy("Support triage", "2".repeat(64))).status).toBe(201);
    expect(await nameOf()).toBe("Support triage");
    expect((await deploy(undefined, "3".repeat(64))).status).toBe(201);
    expect(await nameOf()).toBe("Support triage");
  });

  it("returns the internal project view for an authenticated account", async () => {
    const createdResponse = await SELF.fetch(
      "https://managedagents.test/v1/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environmentMode: "legacy",
          name: "Project API test",
          slug: "project-api-test",
        }),
      },
    );
    expect(createdResponse.status).toBe(201);
    const project = (await createdResponse.json()) as {
      id: string;
      environments: Array<{ name: string }>;
      agents: Array<{ id: string; name: string }>;
    };
    expect(project.environments.map((environment) => environment.name)).toEqual([
      "development",
      "production",
    ]);
    expect(project.agents).toEqual([
      { id: "project-api-test", name: "Project API test" },
    ]);

    const digest = "d".repeat(64);
    const account = env.ACCOUNTS.getByName("local");
    for (const alias of ["development", "production"]) {
      await account.registerDeployment({
        agentId: "project-api-test",
        alias,
        channels: [],
        connections: [],
        artifact: {
          bucket: "artifacts",
          key: "project-api-test.json",
          digest,
          size: 10,
        },
        imageArn: "image",
        imageVersion: "1",
      });
    }

    const templateCommit = "a".repeat(40);
    await env.SERVERLESS_AGENTS_DB.prepare(
      `CREATE TABLE IF NOT EXISTS template_versions (
         id TEXT PRIMARY KEY,
         repository_url TEXT NOT NULL,
         commit_sha TEXT NOT NULL
       )`,
    ).run();
    await env.SERVERLESS_AGENTS_DB.prepare(
      `CREATE TABLE IF NOT EXISTS template_installations (
         id TEXT PRIMARY KEY,
         version_id TEXT NOT NULL,
         account_id TEXT NOT NULL,
         project_id TEXT NOT NULL,
         project_repo_id TEXT,
         state TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ).run();
    await env.SERVERLESS_AGENTS_DB.prepare(
      `INSERT INTO template_versions (id, repository_url, commit_sha)
       VALUES (?, ?, ?)`,
    )
      .bind(
        "tplver_project_api_test",
        "https://github.com/diggerhq/example",
        templateCommit,
      )
      .run();
    await env.SERVERLESS_AGENTS_DB.prepare(
      `INSERT INTO template_installations
       (id, version_id, account_id, project_id, state, updated_at)
       VALUES (?, ?, 'local', ?, 'ready', ?)`,
    )
      .bind(
        "tplinst_project_api_test",
        "tplver_project_api_test",
        project.id,
        "2026-09-02T00:00:00.000Z",
      )
      .run();

    const [overviewResponse, projectsResponse] = await Promise.all([
      SELF.fetch(`https://managedagents.test/v1/projects/${project.id}`),
      SELF.fetch("https://managedagents.test/v1/projects"),
    ]);
    expect(overviewResponse.status).toBe(200);
    await expect(overviewResponse.json()).resolves.toMatchObject({
      templateSource: {
        repositoryUrl: "https://github.com/diggerhq/example",
        commitSha: templateCommit,
        cloneReady: false,
      },
      project: {
        id: project.id,
        environments: [
          {
            name: "development",
            agentId: "project-api-test",
            activeDeploymentId: `project-api-test:${digest}`,
          },
          {
            name: "production",
            agentId: "project-api-test",
            activeDeploymentId: `project-api-test:${digest}`,
          },
        ],
      },
      sessions: [],
      channels: [],
      schedules: [],
    });
    await expect(projectsResponse.json()).resolves.toMatchObject({
      projects: [{ id: project.id }],
    });
  });

  it("omits historical child agents that are not in the active project roster", async () => {
    const created = await json<{ id: string; agentId: string }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environmentMode: "single",
          name: "Roster project",
          slug: "roster-project",
        }),
      }),
    );
    const account = env.ACCOUNTS.getByName("local");
    await account.registerDeployment({
      agentId: `${created.agentId}--orphan`,
      name: "Orphan",
      alias: "default",
      channels: [],
      connections: [],
      artifact: {
        bucket: "artifacts",
        key: "orphan.json",
        digest: "9".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });

    const response = await json<{
      projects: Array<{
        id: string;
        agents: Array<{ id: string; name: string }>;
      }>;
    }>(
      await SELF.fetch("https://managedagents.test/v1/projects"),
    );
    expect(
      response.projects.find((project) => project.id === created.id)?.agents,
    ).toEqual([
      { id: created.agentId, name: "Roster project" },
    ]);
  });

  it("keeps Composio OAuth callbacks on first-party branded routes", async () => {
    const oauth = await SELF.fetch(
      "https://managedagents.test/v1/connections/google/oauth/callback?code=secret-code&state=state-123",
      { redirect: "manual" },
    );
    expect(oauth.status).toBe(302);
    const location = new URL(oauth.headers.get("location") ?? "");
    expect(location.origin).toBe("https://backend.composio.dev");
    expect(location.pathname).toBe("/api/v3.1/toolkits/auth/callback");
    expect(location.searchParams.get("code")).toBe("secret-code");
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(oauth.headers.get("cache-control")).toBe("no-store");

    const completed = await SELF.fetch(
      "https://managedagents.test/v1/connections/google/callback?service=gmail&status=success&connected_account_id=ca_123",
    );
    expect(completed.status).toBe(200);
    const html = await completed.text();
    expect(html).toContain("Gmail connected");
    expect(html).toContain("OpenComputer");
    expect(html).not.toContain("Composio");
  });

  it("renders the callback page even when it cannot record the outcome", async () => {
    // The callback names the connection it resolves so the status can be
    // written while we are being told about it. An account or connection that
    // does not exist — a stale link, or a forged call — must not break the
    // page the person authorizing is looking at.
    const completed = await SELF.fetch(
      "https://managedagents.test/v1/connections/google/callback" +
        "?service=gmail&status=success&connected_account_id=ca_123" +
        "&account=no-such-account&connection=no-such-connection",
    );
    expect(completed.status).toBe(200);
    expect(await completed.text()).toContain("Gmail connected");
  });

  it("does not record anything when the provider reports a failure", async () => {
    const failed = await SELF.fetch(
      "https://managedagents.test/v1/connections/google/callback" +
        "?service=gmail&status=error&account=a&connection=b",
    );
    expect(failed.status).toBe(400);
  });

  it("commits the result tool's output once per call, fenced by turn and runtime, and keeps it past the turn", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "local/examples/hello-agent",
          deploymentId: "development",
        }),
      }),
    );
    const before = await json<SessionSnapshot>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}`),
    );
    expect(before.result).toBeNull();

    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    if (welcome.type !== "runtime.welcome") return;
    runtime.send(JSON.stringify({ type: "model.configuration.request", epoch: welcome.epoch }));
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "model.configuration");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));

    const commit = (
      body: Record<string, unknown>,
      token = created.runtimeToken,
    ): Promise<Response> =>
      SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/result`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const generation = { kind: "microvm", epoch: welcome.epoch };
    const snapshot = async () =>
      json<SessionSnapshot>(
        await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}`),
      );
    const resultEvents = async (callId: string) =>
      (
        await json<{ events: AgentEvent[] }>(
          await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/events`),
        )
      ).events.filter((event) => event.type === "tool.completed" && event.data.callId === callId);

    // No turn yet: nothing to attribute the result to.
    const early = await commit({ turnId: "turn-none", callId: "call-0", tool: "report", runtime: generation, data: {} });
    expect(early.status).toBe(409);
    expect((await early.json<{ error: { code: string } }>()).error.code).toBe("stale_turn");

    const first = await json<{ turnId: string }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "report the branch", idempotencyKey: "result-turn-1" }),
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start" && frame.turnId === first.turnId,
    );

    // Guarded: the runtime token, and a well-formed body.
    expect((await commit({ turnId: first.turnId, callId: "call-1", tool: "report", runtime: generation, data: {} }, "wrong")).status).toBe(401);
    expect((await commit({ turnId: first.turnId, callId: "call-1", tool: "report", runtime: generation })).status).toBe(400);
    expect((await commit({ turnId: first.turnId, callId: "call-1", tool: "report", runtime: { kind: "workerd" }, data: {} })).status).toBe(400);

    // The first commit: result, receipt and the call's event in one step.
    const committed = await commit({
      turnId: first.turnId,
      callId: "call-1",
      tool: "report",
      runtime: generation,
      data: { pr: { number: 7 }, branch: "task/1" },
      messageId: "msg-1",
    });
    expect(committed.status).toBe(200);
    const firstOutcome = await committed.json<{ status: string; replayed: boolean; receipt: { eventId: string; reportedAt: string } }>();
    expect(firstOutcome).toMatchObject({ status: "committed", replayed: false });
    const afterFirst = await snapshot();
    // The result carries the host identity of the call that committed it:
    // the session part from the session row, never from the commit body.
    const identity = {
      projectId: "project:local/examples/hello-agent",
      environment: "development",
      agentId: "local/examples/hello-agent",
      deploymentId: "development",
      sessionId: created.session.id,
      turnId: first.turnId,
      messageId: "msg-1",
      providerCallId: "call-1",
      toolCallId: hostToolCallId({
        sessionId: created.session.id,
        turnId: first.turnId,
        messageId: "msg-1",
        providerCallId: "call-1",
      }),
    };
    expect(afterFirst.result).toEqual({
      turnId: first.turnId,
      callId: "call-1",
      reportedAt: firstOutcome.receipt.reportedAt,
      data: { pr: { number: 7 }, branch: "task/1" },
      identity,
    });
    const firstEvents = await resultEvents("call-1");
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]!.id).toBe(firstOutcome.receipt.eventId);
    expect(firstEvents[0]!.turnId).toBe(first.turnId);
    // The public shape: the committed value itself as `output`, the same
    // JSON the snapshot returns as `result.data`, never its text.
    expect(firstEvents[0]!.data).toEqual({
      tool: "report",
      callId: "call-1",
      title: "report",
      output: { pr: { number: 7 }, branch: "task/1" },
      result: true,
      identity,
    });

    // A replay with the same data, keys in another order: the original
    // receipt, no second event.
    const replayed = await commit({
      turnId: first.turnId,
      callId: "call-1",
      tool: "report",
      runtime: generation,
      data: { branch: "task/1", pr: { number: 7 } },
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual({ ...firstOutcome, replayed: true });
    expect(await resultEvents("call-1")).toHaveLength(1);

    // The same call with different data is a conflict; the result stands.
    const conflict = await commit({ turnId: first.turnId, callId: "call-1", tool: "report", runtime: generation, data: { branch: "other" } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json<{ error: { code: string } }>()).error.code).toBe("result_conflict");
    expect((await snapshot()).result?.data).toEqual({ pr: { number: 7 }, branch: "task/1" });

    // A later call replaces the result; a replay of the earlier call then
    // returns its receipt without displacing the newer result.
    const second = await commit({ turnId: first.turnId, callId: "call-2", tool: "report", runtime: generation, data: { branch: "task/1", pr: { number: 8 } } });
    expect(second.status).toBe(200);
    expect((await snapshot()).result).toMatchObject({ callId: "call-2", data: { pr: { number: 8 } } });
    const lateReplay = await commit({ turnId: first.turnId, callId: "call-1", tool: "report", runtime: generation, data: { branch: "task/1", pr: { number: 7 } } });
    expect(await lateReplay.json()).toEqual({ ...firstOutcome, replayed: true });
    expect((await snapshot()).result).toMatchObject({ callId: "call-2" });

    // Fences: a runtime the session does not drive, and the size bound.
    const stale = await commit({ turnId: first.turnId, callId: "call-3", tool: "report", runtime: { kind: "microvm", epoch: welcome.epoch + 1 }, data: { branch: "x" } });
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe("stale_runtime");
    const large = await commit({ turnId: first.turnId, callId: "call-4", tool: "report", runtime: generation, data: { branch: "x".repeat(9_000) } });
    expect(large.status).toBe(409);
    expect((await large.json<{ error: { code: string } }>()).error.code).toBe("result_too_large");
    expect((await snapshot()).result).toMatchObject({ callId: "call-2" });
    expect(await resultEvents("call-3")).toHaveLength(0);

    // The runtime's own completion frames for committed calls are
    // duplicates; other tools' frames are kept.
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "frame-result-1",
        turnId: first.turnId,
        events: [
          { type: "tool.completed", data: { callId: "call-1", tool: "report", output: "{}" } },
          { type: "tool.completed", data: { callId: "call-2", tool: "report", output: "{}" } },
          { type: "tool.completed", data: { callId: "call-9", tool: "lookup", output: "found" } },
          { type: "message.completed", data: { text: "done" } },
          { type: "turn.completed", data: {} },
        ],
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(runtime, () => false, 20).catch(() => undefined);
    const settled = await snapshot();
    expect(settled.turns[0]).toMatchObject({ id: first.turnId, status: "completed" });
    expect(settled.result).toMatchObject({ turnId: first.turnId, callId: "call-2" });
    expect(await resultEvents("call-1")).toHaveLength(1);
    expect(await resultEvents("call-2")).toHaveLength(1);
    expect(await resultEvents("call-9")).toHaveLength(1);

    // A settled turn takes no new result; its replay still answers.
    const afterSettle = await commit({ turnId: first.turnId, callId: "call-5", tool: "report", runtime: generation, data: { branch: "late" } });
    expect((await afterSettle.json<{ error: { code: string } }>()).error.code).toBe("stale_turn");
    expect((await commit({ turnId: first.turnId, callId: "call-1", tool: "report", runtime: generation, data: { branch: "task/1", pr: { number: 7 } } })).status).toBe(200);

    // Cancelled between execution and commit: the interrupt settles the
    // turn first, so the commit that follows is refused and the previous
    // result stands.
    const second_turn = await json<{ turnId: string }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "try again", idempotencyKey: "result-turn-2" }),
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start" && frame.turnId === second_turn.turnId,
    );
    const interrupted = await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/interrupt`, { method: "POST" });
    expect(interrupted.status).toBe(200);
    const cancelled = await commit({ turnId: second_turn.turnId, callId: "call-6", tool: "report", runtime: generation, data: { branch: "cancelled" } });
    expect(cancelled.status).toBe(409);
    expect((await cancelled.json<{ error: { code: string } }>()).error.code).toBe("stale_turn");
    const afterCancel = await snapshot();
    expect(afterCancel.turns[1]).toMatchObject({ id: second_turn.turnId, status: "cancelled" });
    expect(afterCancel.result).toMatchObject({ turnId: first.turnId, callId: "call-2" });

    // The RPC the route fronts answers the same way.
    await expect(
      env.SESSIONS.getByName(created.session.id).commitResult({
        turnId: first.turnId,
        callId: "call-1",
        tool: "report",
        runtime: { kind: "microvm", epoch: welcome.epoch },
        data: { branch: "task/1", pr: { number: 7 } },
      }),
    ).resolves.toMatchObject({ status: "committed", replayed: true });

    // An ended session keeps its result.
    expect((await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/end`, { method: "POST" })).status).toBe(200);
    const ended = await snapshot();
    expect(ended.status).toBe("ended");
    expect(ended.result).toMatchObject({ turnId: first.turnId, callId: "call-2" });
  });

  it("evaluates the result fence on the session as read inside the commit transaction: a runtime accepted while the commit awaited its fingerprint refuses the stale epoch", async () => {
    // Re-review finding 4: commitResult captured the session row before
    // awaiting the SHA-256 of the data and compared that captured epoch
    // inside the transaction. A runtime the object accepted during the
    // await advanced the epoch to 2 (`connecting`); the epoch-1 result
    // still committed. The fence is evaluated on the state read inside
    // the transaction, never on a copy taken before an await (C1).
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "local/examples/hello-agent", deploymentId: "development" }),
      }),
    );
    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "runtime.welcome");
    if (welcome.type !== "runtime.welcome") return;
    runtime.send(JSON.stringify({ type: "model.configuration.request", epoch: welcome.epoch }));
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "model.configuration");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));
    const first = await json<{ turnId: string }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "report the branch", idempotencyKey: "result-race-1" }),
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "turn.start" && frame.turnId === first.turnId);

    const raced = await runInDurableObject(env.SESSIONS.getByName(created.session.id), async (raw) => {
      const instance = raw as unknown as SessionDurableObject;
      // The commit runs synchronously up to its first await (the
      // fingerprint); the object then accepts a replacement runtime, its
      // own transition to the next epoch, before the commit's transaction.
      const pending = instance.commitResult({
        turnId: first.turnId,
        callId: "call-race",
        tool: "report",
        runtime: { kind: "microvm", epoch: welcome.epoch },
        data: { branch: "from the replaced runtime" },
      });
      const pair = new WebSocketPair();
      (instance as unknown as { acceptRuntime(server: WebSocket): void }).acceptRuntime(pair[1]);
      return pending;
    });
    expect(raced).toMatchObject({ status: "rejected", reason: "stale_runtime" });
    const after = await json<SessionSnapshot>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}`),
    );
    expect(after.status).toBe("connecting");
    expect(after.result).toBeNull();
    const events = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/events`),
    );
    expect(events.events.filter((event) => event.type === "tool.completed")).toEqual([]);  });

  it("queues turns, fences a runtime, persists events, and deduplicates input", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "local/examples/hello-agent",
          deploymentId: "development",
        }),
      }),
    );

    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    expect(welcome.type).toBe("runtime.welcome");
    if (welcome.type !== "runtime.welcome") return;
    await env.SESSIONS.getByName(created.session.id).recordModelRouteResolved({
      providerCallId: "codex-byok-call",
      requested: { provider: "openai", model: "gpt-5.6-sol" },
      effective: { provider: "openai", model: "gpt-5.6-sol" },
      runtime: "codex",
      access: {
        type: "external_subscription",
        connectionId: "model-access-codex",
        connectionKind: "codex_subscription",
      },
      source: "project_route",
      routeId: "mr_codex",
      routeRevision: 2,
      fallback: "fail",
      openComputerModelChargeUsd: 0,
    });

    runtime.send(
      JSON.stringify({
        type: "model.configuration.request",
        epoch: welcome.epoch,
      }),
    );
    const modelConfiguration = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "model.configuration",
    );
    expect(modelConfiguration).toEqual({
      type: "model.configuration",
      provider: "openrouter",
      model: "openrouter/anthropic/claude-sonnet-4.6",
    });
    expect(modelConfiguration).not.toHaveProperty("apiKey");
    runtime.send(
      JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }),
    );

    const invalidGateway = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/model-gateway/api/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(invalidGateway.status).toBe(401);
    const unavailableGateway = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/model-gateway/api/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.runtimeToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(unavailableGateway.status).toBe(503);

    const key = crypto.randomUUID();
    const firstResponse = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "first turn", idempotencyKey: key }),
      },
    );
    expect(firstResponse.status).toBe(202);
    const first = await json<{
      turnId: string;
      duplicate: boolean;
    }>(firstResponse);

    const start = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start",
    );
    expect(start).toMatchObject({
      type: "turn.start",
      turnId: first.turnId,
      input: "first turn",
    });

    // The same request again is the same turn; the key identifies the
    // request, so other text under it is a conflict (tested below).
    const duplicateResponse = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "first turn", idempotencyKey: key }),
      },
    );
    expect(duplicateResponse.status).toBe(200);
    expect(await duplicateResponse.json()).toMatchObject({
      turnId: first.turnId,
      duplicate: true,
    });

    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "frame-1",
        turnId: first.turnId,
        events: [
          { type: "message.delta", data: { text: "hello" } },
          { type: "message.completed", data: { text: "hello" } },
          {
            type: "usage.recorded",
            data: {
              provider: "openrouter",
              model: "anthropic/claude-sonnet-4.6",
              costUsd: 0.0123,
            },
          },
          {
            type: "usage.recorded",
            data: {
              provider: "openrouter",
              model: "openai/gpt-5.6-sol",
              costUsd: 0.0456,
            },
          },
          { type: "turn.completed", data: {} },
        ],
      }),
    );

    await nextFrame<SessionToRuntimeFrame>(runtime, () => false, 20).catch(
      () => undefined,
    );

    const snapshot = await json<SessionSnapshot>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}`),
    );
    expect(snapshot.status).toBe("idle");
    expect(snapshot.turns).toEqual([
      expect.objectContaining({
        id: first.turnId,
        input: "first turn",
        status: "completed",
      }),
    ]);

    const eventBody = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/events`,
      ),
    );
    const eventTypes = eventBody.events.map((event) => event.type);
    expect(eventTypes).toContain("runtime.connected");
    expect(eventTypes).toContain("turn.started");
    expect(eventTypes).toContain("message.completed");
    expect(eventTypes).toContain("usage.recorded");
    expect(eventTypes).toContain("turn.completed");
    expect(
      eventBody.events.find((event) => event.type === "model.route_resolved")
        ?.data,
    ).toMatchObject({
      source: "project_route",
      routeId: "mr_codex",
      routeRevision: 2,
      fallback: "fail",
    });
    expect(
      eventBody.events.every(
        (event, index) =>
          index === 0 || event.seq > eventBody.events[index - 1]!.seq,
      ),
    ).toBe(true);
    await expect(
      env.SESSIONS.getByName(created.session.id).usageSummary(),
    ).resolves.toEqual({
      title: "first turn",
      modelCalls: 2,
      modelProviderCostUsd: 0.0123,
      modelUsage: [
        expect.objectContaining({ costUsd: 0.0123 }),
        expect.objectContaining({ costUsd: 0 }),
      ],
      runtimeSecondsByTier: {},
    });
    // The turn's working time is a segment of its own, billed for work
    // minutes; the summary above still counts only VM time.
    await expect(
      env.SESSIONS.getByName(created.session.id).listRuntimeBillingSegments(),
    ).resolves.toEqual([
      expect.objectContaining({
        id: `${first.turnId}:turn`,
        closeReason: "turn_settled",
        quantitySeconds: 1,
      }),
    ]);

    const replay = await connect(
      `/v1/sessions/${created.session.id}/connect?role=client&cursor=0`,
    );
    const completed = await nextFrame<{
      type: string;
      event?: AgentEvent;
    }>(replay, (frame) => frame.event?.type === "turn.completed");
    expect(completed.event?.turnId).toBe(first.turnId);

    runtime.close(1000, "test complete");
    await nextFrame<{
      type: string;
      event?: AgentEvent;
    }>(replay, (frame) => frame.event?.type === "runtime.disconnected");
    const disconnectedSnapshot = await json<SessionSnapshot>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}`,
      ),
    );
    expect(disconnectedSnapshot.status).toBe("idle");

    replay.close(1000, "test complete");
  });

  it("admits a structured payload and refuses a reused key for another request", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "local/examples/hello-agent",
          deploymentId: "development",
        }),
      }),
    );
    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    expect(welcome.type).toBe("runtime.welcome");
    if (welcome.type !== "runtime.welcome") return;
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));

    const turnsUrl = `https://managedagents.test/v1/sessions/${created.session.id}/turns`;
    const post = (body: unknown) =>
      SELF.fetch(turnsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const key = "task-01/start";
    const text = "Fix the flaky test";
    const payload = {
      repo: "acme/widgets",
      ref: "main",
      labels: ["bug", "p1"],
      actor: { login: "octocat", id: 583231 },
      note: "  keep  this  spacing  ",
    };

    const admitted = await post({ input: text, idempotencyKey: key, payload });
    expect(admitted.status).toBe(202);
    const first = await json<{ turnId: string; status: string; duplicate: boolean }>(admitted);
    expect(first.duplicate).toBe(false);

    // The runtime is handed the payload as typed input from the user, next
    // to the text; the MicroVM harness passes exactly this to useInput().
    const start = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start",
    );
    expect(start).toEqual({
      type: "turn.start",
      turnId: first.turnId,
      input: text,
      agentInput: { source: "user", text, payload },
      identity: {
        projectId: "project:local/examples/hello-agent",
        environment: "development",
        agentId: "local/examples/hello-agent",
        deploymentId: "development",
        sessionId: created.session.id,
      },
    });

    // The same request serialized in another key order, with the default
    // mode spelled out, is the same request: the original receipt.
    const reordered = await post(
      JSON.stringify({
        payload: {
          note: payload.note,
          actor: { id: 583231, login: "octocat" },
          labels: ["bug", "p1"],
          ref: "main",
          repo: "acme/widgets",
        },
        mode: "queue",
        idempotencyKey: key,
        input: text,
      }),
    );
    expect(reordered.status).toBe(200);
    expect(await reordered.json()).toEqual({
      turnId: first.turnId,
      status: expect.any(String),
      duplicate: true,
    });

    // Other text (whitespace counts), another payload, no payload, or another
    // mode under the same key is a conflict, and admits nothing.
    for (const body of [
      { input: `${text} `, idempotencyKey: key, payload },
      { input: text, idempotencyKey: key, payload: { ...payload, ref: "develop" } },
      { input: text, idempotencyKey: key },
      { input: text, idempotencyKey: key, payload: null },
      { input: text, idempotencyKey: key, payload, mode: "interrupt" },
    ]) {
      const conflict = await post(body);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        error: {
          code: "idempotency_conflict",
          message: expect.stringContaining("idempotencyKey"),
        },
      });
    }

    // The payload is bounded where the application composes it.
    const oversize = await post({
      input: "too big",
      idempotencyKey: "task-02/start",
      payload: { text: "x".repeat(32 * 1024) },
    });
    expect(oversize.status).toBe(400);
    expect(await oversize.json()).toMatchObject({ error: { code: "invalid_payload" } });
    const atLimit = await post({
      input: "at the limit",
      idempotencyKey: "task-03/start",
      payload: "x".repeat(32 * 1024 - 2),
    });
    expect(atLimit.status).toBe(202);
    const third = await json<{ turnId: string }>(atLimit);

    // Without a payload the request is text and mode only; the queue default
    // is applied before comparison.
    const plain = await post({ input: "Follow up", idempotencyKey: "task-01/2" });
    expect(plain.status).toBe(202);
    const second = await json<{ turnId: string }>(plain);
    const plainAgain = await post({ input: "Follow up", idempotencyKey: "task-01/2", mode: "queue" });
    expect(plainAgain.status).toBe(200);
    expect(await plainAgain.json()).toMatchObject({ turnId: second.turnId, duplicate: true });

    // The key is one rule across create and turns: the `Idempotency-Key`
    // header carries it too. Header only admits and deduplicates like the
    // body field; both present must be equal (the same key either way is
    // the same request), and a disagreement is refused before anything is
    // admitted.
    const postWithHeader = (body: unknown, key: string) =>
      SELF.fetch(turnsUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      });
    const headerOnly = await postWithHeader({ input: "Header keyed" }, "task-01/3");
    expect(headerOnly.status).toBe(202);
    const fourth = await json<{ turnId: string }>(headerOnly);
    expect(await postWithHeader({ input: "Header keyed" }, "task-01/3").then((r) => r.json())).toMatchObject({
      turnId: fourth.turnId,
      duplicate: true,
    });
    expect(
      await postWithHeader({ input: "Header keyed", idempotencyKey: "task-01/3" }, "task-01/3").then((r) => r.json()),
    ).toMatchObject({ turnId: fourth.turnId, duplicate: true });
    // The body field alone still finds the header-admitted turn: one key space.
    expect(await post({ input: "Header keyed", idempotencyKey: "task-01/3" }).then((r) => r.json())).toMatchObject({
      turnId: fourth.turnId,
      duplicate: true,
    });
    const disagree = await postWithHeader({ input: "Header keyed", idempotencyKey: "task-01/4" }, "task-01/3");
    expect(disagree.status).toBe(400);
    expect(await disagree.json()).toMatchObject({ error: { code: "invalid_turn" } });
    // Different text under the header key is the same conflict as under the body key.
    const headerConflict = await postWithHeader({ input: "Other text" }, "task-01/3");
    expect(headerConflict.status).toBe(409);
    expect(await headerConflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });

    // The log records the payload with the admission, and only when there was one.
    const eventBody = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/events`),
    );
    expect(eventBody.events.filter((event) => event.type === "message.received")).toEqual([
      expect.objectContaining({
        turnId: first.turnId,
        data: { input: text, mode: "queue", payload },
      }),
      expect.objectContaining({
        turnId: third.turnId,
        data: { input: "at the limit", mode: "queue", payload: "x".repeat(32 * 1024 - 2) },
      }),
      expect.objectContaining({
        turnId: second.turnId,
        data: { input: "Follow up", mode: "queue" },
      }),
      expect.objectContaining({
        turnId: fourth.turnId,
        data: { input: "Header keyed", mode: "queue" },
      }),
    ]);
    const snapshot = await json<SessionSnapshot>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}`),
    );
    expect(snapshot.turns.map((turn) => turn.id)).toEqual([first.turnId, third.turnId, second.turnId, fourth.turnId]);

    runtime.close(1000, "test complete");
  });

  it("explicitly queues, steers, and interrupts active turns", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "local/examples/input-modes",
          deploymentId: "development",
        }),
      }),
    );
    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    if (welcome.type !== "runtime.welcome") return;
    runtime.send(
      JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }),
    );

    const admit = async (input: string, mode: string) => {
      const response = await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/turns`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input,
            mode,
            idempotencyKey: `${mode}:${input}`,
          }),
        },
      );
      expect(response.status).toBe(202);
      return json<{ turnId: string; status: string }>(response);
    };

    const active = await admit("original work", "queue");
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start" && frame.turnId === active.turnId,
    );

    const steered = await admit("focus on tests", "steer");
    expect(steered.status).toBe("running");
    expect(
      await nextFrame<SessionToRuntimeFrame>(
        runtime,
        (frame) => frame.type === "turn.steer",
      ),
    ).toMatchObject({
      type: "turn.steer",
      turnId: steered.turnId,
      activeTurnId: active.turnId,
      input: "focus on tests",
    });
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "steer-completed",
        turnId: steered.turnId,
        events: [{ type: "turn.completed", data: {} }],
      }),
    );

    const queued = await admit("follow-up", "queue");
    await expect(
      nextFrame<SessionToRuntimeFrame>(
        runtime,
        (frame) => frame.type === "turn.start" && frame.turnId === queued.turnId,
        30,
      ),
    ).rejects.toThrow("Timed out");

    const replacement = await admit("stop and do this", "interrupt");
    expect(
      await nextFrame<SessionToRuntimeFrame>(
        runtime,
        (frame) => frame.type === "turn.cancel",
      ),
    ).toEqual({ type: "turn.cancel", turnId: active.turnId });
    expect(
      await nextFrame<SessionToRuntimeFrame>(
        runtime,
        (frame) =>
          frame.type === "turn.start" && frame.turnId === replacement.turnId,
      ),
    ).toMatchObject({
      type: "turn.start",
      turnId: replacement.turnId,
      input: "stop and do this",
    });
    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "late-cancelled-output",
        turnId: active.turnId,
        events: [{ type: "message.completed", data: { text: "too late" } }],
      }),
    );

    runtime.send(
      JSON.stringify({
        type: "event.batch",
        epoch: welcome.epoch,
        frameId: "replacement-completed",
        turnId: replacement.turnId,
        events: [{ type: "turn.completed", data: {} }],
      }),
    );
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start" && frame.turnId === queued.turnId,
    );

    const snapshot = await json<SessionSnapshot>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}`,
      ),
    );
    expect(snapshot.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: active.turnId,
          mode: "queue",
          status: "cancelled",
        }),
        expect.objectContaining({
          id: steered.turnId,
          mode: "steer",
          status: "completed",
        }),
        expect.objectContaining({
          id: replacement.turnId,
          mode: "interrupt",
          status: "completed",
        }),
      ]),
    );
    const events = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/events`,
      ),
    );
    expect(events.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["turn.steered", "turn.interrupted", "turn.cancelled"]),
    );
    expect(
      events.events.some((event) => event.data.text === "too late"),
    ).toBe(false);

    runtime.close(1000, "test complete");
  });

  it("rejects an invalid runtime bootstrap token", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const response = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/connect?role=runtime&token=wrong`,
      { headers: { upgrade: "websocket" } },
    );
    expect(response.status).toBe(401);
  });

  it("lets the runtime read session state and durably commit reactive renders", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    await json(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/data`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "mode", value: "support" }),
        },
      ),
    );
    const authorization = { authorization: `Bearer ${created.runtimeToken}` };
    const resources = await json<{
      data: Array<{ key: string; value: unknown }>;
    }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/resources`,
        { headers: authorization },
      ),
    );
    expect(resources.data).toEqual([
      expect.objectContaining({ key: "mode", value: "support" }),
    ]);

    const render = {
      renderId: "render-1",
      responseId: "response-1",
      providerTurn: 1,
      stateVersion: 1,
      instructionsHash: "a".repeat(64),
      instructions: "Search the repository without exposing private data.",
      enabledTools: ["search"],
      requiredConnections: ["github"],
      enabledMcpServers: ["github"],
      input: { source: "user", text: "Review this repository" },
      tools: [{ name: "search", description: "Search the repository" }],
      model: { provider: "openrouter", model: "openai/gpt-5.2" },
      renderedAt: "2026-08-09T00:00:00.000Z",
    };
    const committed = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/renders`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(render),
      },
    );
    expect(committed.status).toBe(201);
    await expect(
      env.SESSIONS.getByName(created.session.id).listAgentRenders(),
    ).resolves.toEqual([render]);
    const events = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/events?after=0`,
      ),
    );
    expect(events.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.rendered",
          data: expect.objectContaining({
            instructions: render.instructions,
            enabledTools: ["search"],
          }),
        }),
      ]),
    );
  });

  it("returns not found for an unknown session", async () => {
    const response = await SELF.fetch(
      "https://managedagents.test/v1/sessions/not-a-session",
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "session_not_found" },
    });
  });

  it("persists a session MicroVM binding and lifecycle state", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const path = `https://managedagents.test/v1/sessions/${created.session.id}/microvm`;
    const bound = await json<SessionSnapshot>(
      await SELF.fetch(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          microvmId: "microvm-test",
          state: "running",
        }),
      }),
    );
    expect(bound).toMatchObject({
      microvmId: "microvm-test",
      microvmState: "running",
    });

    const suspended = await json<SessionSnapshot>(
      await SELF.fetch(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          microvmId: "microvm-test",
          state: "suspended",
        }),
      }),
    );
    expect(suspended).toMatchObject({
      status: "suspended",
      microvmId: "microvm-test",
      microvmState: "suspended",
    });

    const events = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/events`,
      ),
    );
    expect(events.events.map((event) => event.type)).toContain(
      "runtime.suspended",
    );
  });

  it("finalizes idempotent runtime billing segments before VM cleanup", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const session = env.SESSIONS.getByName(created.session.id);

    await session.bindMicrovm({
      microvmId: "microvm-billing-test",
      state: "running",
    });
    await session.updateMicrovmState({
      microvmId: "microvm-billing-test",
      state: "suspending",
    });
    await session.updateMicrovmState({
      microvmId: "microvm-billing-test",
      state: "suspended",
    });

    const [segment] = await session.listRuntimeBillingSegments();
    expect(segment).toMatchObject({
      accountId: created.session.accountId,
      sessionId: created.session.id,
      deploymentId: created.session.deploymentId,
      agentId: created.session.agentId,
      microvmId: "microvm-billing-test",
      resourceTier: "2gb_1vcpu",
      quantitySeconds: 1,
      closeReason: "suspended",
    });
    expect(segment?.id).toBeTruthy();

    await session.end();
    await expect(session.listRuntimeBillingSegments()).resolves.toHaveLength(1);
    await session.acknowledgeRuntimeBillingSegments([segment!.id, segment!.id]);
    await expect(session.listRuntimeBillingSegments()).resolves.toEqual([]);
    await expect(session.usageSummary()).resolves.toMatchObject({
      modelCalls: 0,
      modelProviderCostUsd: 0,
      runtimeSecondsByTier: { "2gb_1vcpu": 1 },
    });
  });

  it("opens a fresh billing lease only after a runtime resumes", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const session = env.SESSIONS.getByName(created.session.id);

    await session.bindMicrovm({
      microvmId: "microvm-resume",
      state: "running",
    });
    await session.updateMicrovmState({
      microvmId: "microvm-resume",
      state: "suspending",
    });
    await session.updateMicrovmState({
      microvmId: "microvm-resume",
      state: "suspended",
    });
    await session.updateMicrovmState({
      microvmId: "microvm-resume",
      state: "resuming",
    });
    await session.updateMicrovmState({
      microvmId: "microvm-resume",
      state: "running",
    });
    await session.end();

    await expect(session.listRuntimeBillingSegments()).resolves.toEqual([
      expect.objectContaining({ closeReason: "suspended" }),
      expect.objectContaining({ closeReason: "session_ended" }),
    ]);
  });

  it("keeps a deployment runtime mode immutable for a content digest", async () => {
    const account = env.ACCOUNTS.getByName("deployment-runtime-mode");
    const input = {
      agentId: "pinned-runtime-agent",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "managed-agent-artifacts",
        key: "agents/pinned-runtime-agent/digest.json",
        digest: "f".repeat(64),
        size: 100,
      },
      imageArn: "image",
      imageVersion: "1",
    } as const;

    const created = await account.registerDeployment({
      ...input,
      runtimeMode: "workerd-lazy-sandbox",
    });
    const repeated = await account.registerDeployment({
      ...input,
      runtimeMode: "microvm",
    });

    expect(created.runtimeMode).toBe("workerd-lazy-sandbox");
    expect(repeated.runtimeMode).toBe("workerd-lazy-sandbox");
    const resolved = await account.resolveDeployment(
      "pinned-runtime-agent@development",
    );
    expect(resolved?.runtimeMode).toBe("workerd-lazy-sandbox");
  });

  it("validates and persists managed GitHub connection permissions", async () => {
    const deployment = await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "github-agent",
          alias: "development",
          connections: ["github"],
          githubConnections: [
            {
              id: "github",
              provider: {
                kind: "github-app",
                permissions: {
                  pull_requests: "write",
                  contents: "write",
                  metadata: "read",
                },
              },
            },
          ],
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/github-agent/digest.json",
            digest: "b".repeat(64),
            size: 512,
          },
          imageArn: "image",
          imageVersion: "1",
        }),
      }),
    );

    expect(deployment.githubConnections).toEqual([
      {
        id: "github",
        provider: {
          kind: "github-app",
          permissions: {
            contents: "write",
            metadata: "read",
            pull_requests: "write",
          },
        },
      },
    ]);

    const invalid = await SELF.fetch(
      "https://managedagents.test/v1/deployments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "invalid-github-agent",
          alias: "development",
          connections: ["github"],
          githubConnections: [
            {
              id: "github",
              provider: {
                kind: "github-app",
                permissions: { metadata: "write" },
              },
            },
          ],
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/invalid-github-agent/digest.json",
            digest: "c".repeat(64),
            size: 512,
          },
          imageArn: "image",
          imageVersion: "1",
        }),
      },
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_deployment" },
    });
  });

  it("consumes managed GitHub connect state once and reports attachments", async () => {
    const account = env.ACCOUNTS.getByName("github-install-state");
    await account.createProject({
      environmentMode: "legacy",
      id: "prj_github_install",
      name: "GitHub install",
      slug: "github-install",
    });
    await account.createGitHubConnectState({
      nonceHash: "nonce-hash",
      projectId: "prj_github_install",
      environments: ["development"],
    });
    await expect(
      account.consumeGitHubConnectState("nonce-hash"),
    ).resolves.toEqual({
      projectId: "prj_github_install",
      environments: ["development"],
    });
    await expect(
      account.consumeGitHubConnectState("nonce-hash"),
    ).resolves.toBeNull();
    await account.createGitHubConnectState({ nonceHash: "account-nonce" });
    await expect(account.consumeGitHubConnectState("account-nonce")).resolves.toEqual({
      environments: [],
    });

    await runInDurableObject(account, (_instance, state) => {
      const now = new Date().toISOString();
      state.storage.sql.exec(
        `INSERT INTO github_installations
           (id, github_installation_id, account_login, account_type,
            repository_selection, state, created_at, updated_at)
         VALUES ('ghi_test', 123, 'octo-org', 'Organization', 'selected',
                 'active', ?, ?)`,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO github_attachments
           (project_id, environment, installation_id, created_at, updated_at)
         VALUES ('prj_github_install', 'development', 'ghi_test', ?, ?)`,
        now,
        now,
      );
    });
    expect(await account.getGitHubStatus("prj_github_install")).toMatchObject([
      {
        environment: "development",
        state: "active",
        installation: {
          githubInstallationId: 123,
          accountLogin: "octo-org",
          repositorySelection: "selected",
        },
      },
      { environment: "production", state: "not_connected" },
    ]);
    expect(await account.listGitHubInstallations()).toMatchObject([
      { id: "ghi_test", accountLogin: "octo-org", state: "active" },
    ]);
    expect(await account.attachGitHub({
      projectId: "prj_github_install",
      environment: "production",
      installationId: "ghi_test",
    })).toBe(true);
    expect(await account.getGitHubStatus("prj_github_install")).toMatchObject([
      { environment: "development", state: "active" },
      { environment: "production", state: "active" },
    ]);
  });

  it("exposes GitHub status but refuses install URLs without a configured App", async () => {
    const account = env.ACCOUNTS.getByName("local");
    await account.createProject({
      environmentMode: "legacy",
      id: "prj_github_route",
      name: "GitHub route",
      slug: "github-route",
    });
    const status = await json<{
      environments: Array<{ environment: string; state: string }>;
      connections: unknown[];
      app: null;
    }>(
      await SELF.fetch(
        "https://managedagents.test/v1/projects/prj_github_route/github",
      ),
    );
    expect(status.app).toBeNull();
    expect(status.connections).toEqual([]);
    expect(status.environments).toMatchObject([
      { environment: "development", state: "not_connected" },
      { environment: "production", state: "not_connected" },
    ]);

    const connect = await SELF.fetch(
      "https://managedagents.test/v1/projects/prj_github_route/github/connect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(connect.status).toBe(503);
    await expect(connect.json()).resolves.toMatchObject({
      error: { code: "github_app_not_configured" },
    });

    const accountConnections = await json<{ connections: unknown[]; app: null }>(
      await SELF.fetch("https://managedagents.test/v1/github"),
    );
    expect(accountConnections).toEqual({ connections: [], app: null });
  });

  it("persists exact declared and default models with a deployment", async () => {
    const account = env.ACCOUNTS.getByName("deployment-models");
    const deployment = await account.registerDeployment({
      agentId: "model-agent",
      alias: "development",
      channels: [],
      connections: [],
      models: [
        { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
      ],
      defaultModel: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      },
      artifact: {
        bucket: "managed-agent-artifacts",
        key: "agents/model-agent/digest.json",
        digest: "e".repeat(64),
        size: 100,
      },
      imageArn: "image",
      imageVersion: "1",
    });

    expect(deployment.models).toEqual([
      { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
    ]);
    expect(deployment.defaultModel).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    });
  });

  it("resolves models for legacy deployments without model metadata", async () => {
    await caches.default.put(
      OPENROUTER_MODEL_CATALOG_CACHE_KEY,
      Response.json(
        {
          fetchedAt: Date.now(),
          ids: ["anthropic/claude-sonnet-4.6"],
        },
        { headers: { "cache-control": "public, max-age=3600" } },
      ),
    );
    const account = env.ACCOUNTS.getByName("local");
    const deployment = await account.registerDeployment({
      agentId: "legacy-model-agent",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "managed-agent-artifacts",
        key: "agents/legacy-model-agent/digest.json",
        digest: "c".repeat(64),
        size: 100,
      },
      imageArn: "image",
      imageVersion: "1",
      runtimeMode: "microvm",
    });
    expect(deployment.models).toBeUndefined();
    expect(deployment.defaultModel).toBeUndefined();

    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: deployment.agentId,
          deploymentId: deployment.id,
        }),
      }),
    );
    const response = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/models/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: {
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4.6",
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      model: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      },
    });
  });

  it("rejects an unavailable deployment model before alias activation", async () => {
    await caches.default.put(
      OPENROUTER_MODEL_CATALOG_CACHE_KEY,
      Response.json(
        {
          fetchedAt: Date.now(),
          ids: ["anthropic/claude-sonnet-4.6"],
        },
        { headers: { "cache-control": "public, max-age=3600" } },
      ),
    );
    const response = await SELF.fetch("https://managedagents.test/v1/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: "invalid-model-agent",
        alias: "development",
        models: [
          { provider: "openrouter", model: "anthropic/claude-sonnet-999" },
        ],
        artifact: {
          bucket: "managed-agent-artifacts",
          key: "agents/invalid-model-agent/digest.json",
          digest: "d".repeat(64),
          size: 100,
        },
        imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
        imageVersion: "1.0",
      }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_model_selection" },
    });
    await expect(
      env.ACCOUNTS.getByName("local").resolveDeployment(
        "invalid-model-agent@development",
      ),
    ).resolves.toBeNull();
  });

  it("registers an agent deployment, resolves its alias, and ends a session", async () => {
    const deployment = await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "hello-agent",
          name: "Gentle Falcon",
          alias: "production",
          channels: ["slack"],
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/hello-agent/digest.json",
            digest: "a".repeat(64),
            size: 763,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      }),
    );
    expect(deployment).toMatchObject({
      id: `hello-agent:${"a".repeat(64)}`,
      agentId: "hello-agent",
      alias: "production",
      runtimeMode: "workerd-lazy-sandbox",
      channels: ["slack"],
    });
    const priorDeployment = await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "hello-agent",
          name: "Gentle Falcon",
          alias: "preview",
          channels: [],
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/hello-agent/previous.json",
            digest: "f".repeat(64),
            size: 612,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      }),
    );

    const deployments = await json<{ deployments: AgentDeployment[] }>(
      await SELF.fetch("https://managedagents.test/v1/deployments?agentId=hello-agent"),
    );
    expect(deployments.deployments.map((item) => item.id)).toEqual(
      expect.arrayContaining([deployment.id, priorDeployment.id]),
    );

    const agents = await json<{ agents: AgentSummary[] }>(
      await SELF.fetch("https://managedagents.test/v1/agents"),
    );
    expect(agents.agents).toEqual([
      expect.objectContaining({
        id: "hello-agent",
        name: "Gentle Falcon",
        activeDeploymentId: deployment.id,
        deploymentCount: 2,
      }),
    ]);

    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "hello-agent@production",
          source: "playground",
        }),
      }),
    );
    expect(created.session).toMatchObject({
      agentId: "hello-agent",
      deploymentId: deployment.id,
    });
    expect(created.deployment).toEqual(deployment);

    const sessions = await json<{ sessions: SessionSnapshot[] }>(
      await SELF.fetch("https://managedagents.test/v1/sessions"),
    );
    expect(sessions.sessions).toEqual([
      expect.objectContaining({
        id: created.session.id,
        source: "playground",
        status: "new",
      }),
    ]);

    const ended = await json<SessionSnapshot>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/end`,
        { method: "POST" },
      ),
    );
    expect(ended.status).toBe("ended");
    const events = await json<{ events: AgentEvent[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${created.session.id}/events`,
      ),
    );
    expect(events.events.map((event) => event.type)).toContain("session.ended");
  });

  it("reserves a native Slack connection and protects its callback", async () => {
    await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "slack-agent",
          alias: "production",
          channels: [],
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/slack-agent/digest.json",
            digest: "b".repeat(64),
            size: 512,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      }),
    );

    const reserved = await json<{
      connection: { id: string; appName?: string; status: string };
      manifest: {
        display_information: { name: string };
        settings: { event_subscriptions: { request_url: string } };
      };
      createUrl: string;
    }>(
      await SELF.fetch("https://managedagents.test/v1/channels/slack/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "slack-agent@production",
          name: "Inbox Helper",
        }),
      }),
    );
    expect(reserved.connection.status).toBe("pending");
    expect(reserved.connection.appName).toBe("Inbox Helper");
    expect(reserved.manifest.display_information.name).toBe("Inbox Helper");
    expect(reserved.createUrl).toBe("https://api.slack.com/apps");
    const webhookUrl =
      reserved.manifest.settings.event_subscriptions.request_url;
    expect(webhookUrl).toMatch(
      /^https:\/\/managedagents\.test\/v1\/webhooks\/slack\/[^/]+\/[^/]+$/,
    );

    const challenge = await json<{ challenge: string }>(
      await SELF.fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "url_verification",
          challenge: "slack-challenge",
        }),
      }),
    );
    expect(challenge.challenge).toBe("slack-challenge");

    const forged = await SELF.fetch(webhookUrl.replace(/[^/]+$/, "forged"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "url_verification",
        challenge: "forged",
      }),
    });
    expect(forged.status).toBe(401);
  });

  it("reserves only declared tool connections and validates OAuth state", async () => {
    await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "gmail-agent",
          alias: "production",
          connections: ["google"],
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/gmail-agent/digest.json",
            digest: "c".repeat(64),
            size: 512,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      }),
    );
    const unconnectedSession = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "gmail-agent@production" }),
      }),
    );
    const requested = await json<{
      status: string;
      delivery: string;
      authorizationUrl: string;
    }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${unconnectedSession.session.id}/connections`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${unconnectedSession.runtimeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ service: "gmail", label: "personal" }),
        },
      ),
    );
    expect(requested).toMatchObject({
      status: "requested",
      delivery: "inline",
    });
    const requestedUrl = new URL(requested.authorizationUrl);
    expect(requestedUrl.origin).toBe("https://app.example");
    expect(requestedUrl.pathname).toBe("/managed-agents/connections");
    expect(requestedUrl.searchParams.get("service")).toBe("gmail");
    expect(requestedUrl.searchParams.get("alias")).toBe("personal");
    expect(requestedUrl.searchParams.get("connect")).toBe("1");

    const providerAliasRequest = await json<{
      authorizationUrl: string;
    }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${unconnectedSession.session.id}/connections`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${unconnectedSession.runtimeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            service: "google",
            label: "personal2",
            newAccount: true,
          }),
        },
      ),
    );
    const providerAliasUrl = new URL(providerAliasRequest.authorizationUrl);
    expect(providerAliasUrl.searchParams.get("service")).toBe("gmail");
    expect(providerAliasUrl.searchParams.get("alias")).toBe("personal2");

    const compatibilityRequest = await json<{
      status: string;
      delivery: string;
      authorizationUrl: string;
      label: string;
    }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${unconnectedSession.session.id}/connections/opencomputer/fetch`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${unconnectedSession.runtimeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "request",
            service: "gmail",
            newAccount: true,
          }),
        },
      ),
    );
    expect(compatibilityRequest).toMatchObject({
      status: "requested",
      delivery: "inline",
      label: "gmail-2",
    });
    expect(
      new URL(compatibilityRequest.authorizationUrl).searchParams.get("alias"),
    ).toBe("gmail-2");

    const compatibilityList = await json<{ connections: unknown[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${unconnectedSession.session.id}/connections/opencomputer/fetch`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${unconnectedSession.runtimeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "list" }),
        },
      ),
    );
    expect(compatibilityList.connections).toEqual([]);

    const unavailable = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${unconnectedSession.session.id}/connections`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${unconnectedSession.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ service: "slack" }),
      },
    );
    expect(unavailable.status).toBe(409);

    const invalidRuntime = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${unconnectedSession.session.id}/connections`,
      { headers: { authorization: "Bearer wrong-token" } },
    );
    expect(invalidRuntime.status).toBe(401);
    const unconnected = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${unconnectedSession.session.id}/connections/google/fetch`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${unconnectedSession.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          service: "gmail",
          path: "/gmail/v1/users/me/messages",
        }),
      },
    );
    expect(unconnected.status).toBe(404);
    await expect(unconnected.json()).resolves.toMatchObject({
      error: {
        code: "connection_not_found",
        message: expect.stringContaining(
          "opencomputer connection add gmail",
        ),
      },
    });
    const reserved = await json<{
      connection: { id: string; status: string; provider: string };
      authorizationUrl: string;
      state: string;
    }>(
      await SELF.fetch("https://managedagents.test/v1/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          agentId: "gmail-agent@production",
          scopes: [
            "openid",
            "email",
            "https://www.googleapis.com/auth/gmail.modify",
          ],
          redirectUri: "http://127.0.0.1:3456/oauth/callback",
          codeChallenge: "challenge",
        }),
      }),
    );
    expect(reserved.connection).toMatchObject({
      provider: "google",
      status: "pending",
    });
    expect(new URL(reserved.authorizationUrl).searchParams.get("state")).toBe(
      reserved.state,
    );

    const rejected = await SELF.fetch(
      `https://managedagents.test/v1/connections/${reserved.connection.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "code",
          state: "forged",
          codeVerifier: "verifier",
          redirectUri: "http://127.0.0.1:3456/oauth/callback",
        }),
      },
    );
    expect(rejected.status).toBe(401);

    const upstreamRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        upstreamRequests.push(url);
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid email https://www.googleapis.com/auth/gmail.modify",
          });
        }
        if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
          return Response.json({
            sub: "google-user",
            email: "user@example.com",
          });
        }
        if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages") {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer access-token",
          );
          return Response.json({ messages: [{ id: "message-one" }] });
        }
        throw new Error(`Unexpected upstream request: ${url}`);
      }),
    );
    const connected = await json<{
      status: string;
      displayName: string;
    }>(
      await SELF.fetch(
        `https://managedagents.test/v1/connections/${reserved.connection.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: "code",
            state: reserved.state,
            codeVerifier: "verifier",
            redirectUri: "http://127.0.0.1:3456/oauth/callback",
          }),
        },
      ),
    );
    expect(connected).toMatchObject({
      status: "connected",
      displayName: "user@example.com",
    });

    await env.ACCOUNTS.getByName("local").upsertManagedToolConnection({
      id: "unrelated-notion",
      provider: "notion",
      label: "default",
      ownerUserId: "local",
      externalAccountId: "ca_notion",
      scopes: [],
    });

    const visibleConnections = await json<{
      connections: Array<Record<string, unknown>>;
    }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${unconnectedSession.session.id}/connections`,
        {
          headers: {
            authorization: `Bearer ${unconnectedSession.runtimeToken}`,
          },
        },
      ),
    );
    expect(visibleConnections.connections).toContainEqual(
      expect.objectContaining({
        id: reserved.connection.id,
        provider: "google",
        label: "default",
        status: "connected",
      }),
    );
    expect(visibleConnections.connections[0]).not.toHaveProperty("ownerUserId");
    expect(visibleConnections.connections).not.toContainEqual(
      expect.objectContaining({ id: "unrelated-notion" }),
    );

    const session = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "gmail-agent@production" }),
      }),
    );
    const proxied = await json<{ status: number; body: string }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${session.session.id}/connections/google/fetch`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.runtimeToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            service: "gmail",
            path: "/gmail/v1/users/me/messages",
          }),
        },
      ),
    );
    expect(proxied).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"messages":[{"id":"message-one"}]}',
    });
    expect(upstreamRequests).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://openidconnect.googleapis.com/v1/userinfo",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    ]);

    const listed = await json<{ connections: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/connections"),
    );
    expect(listed.connections.map((connection) => connection.id)).toContain(
      reserved.connection.id,
    );
  });

  it("bridges Kernel-compatible Streamable HTTP through managed egress", async () => {
    const project = await json<{
      id: string;
      agents: Array<{ id: string }>;
    }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Kernel MCP", slug: "kernel-mcp" }),
      }),
    );
    const agentId = project.agents[0]!.id;
    const secret = "kernel-secret-that-must-not-leak";
    await json(
      await SELF.fetch(
        `https://managedagents.test/v1/projects/${project.id}/secrets/KERNEL_API_KEY`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value: secret,
            environment: "development",
            allowedOrigins: ["https://mcp.onkernel.com"],
          }),
        },
      ),
    );
    await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          alias: "development",
          connections: ["kernel-mcp-auth"],
          httpConnections: [
            {
              id: "kernel-mcp-auth",
              origin: "https://mcp.onkernel.com",
              methods: ["GET", "POST", "DELETE"],
              pathPrefix: "/mcp",
              headers: {
                Authorization: {
                  kind: "secret",
                  name: "KERNEL_API_KEY",
                  prefix: "Bearer ",
                },
                Accept: "application/json, text/event-stream",
              },
            },
          ],
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/kernel-mcp/digest.json",
            digest: "k".repeat(64),
            size: 512,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      }),
    );
    const session = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${agentId}@development` }),
      }),
    );

    const upstreamFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("https://mcp.onkernel.com/mcp");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
        expect(headers.get("accept")).toBe("application/json, text/event-stream");
        expect(headers.get("mcp-session-id")).toBe("kernel-session");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(
          '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
        );
        return new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"manage_browsers"}]}}\n\n',
          {
            headers: {
              "content-type": "text/event-stream",
              "mcp-session-id": "next-kernel-session",
            },
          },
        );
      },
    );
    vi.stubGlobal("fetch", upstreamFetch);
    const response = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${session.session.id}/mcp/kernel-mcp-auth?path=%2Fmcp`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.runtimeToken}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "kernel-session",
        },
        body: '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("mcp-session-id")).toBe("next-kernel-session");
    await expect(response.text()).resolves.toContain('"name":"manage_browsers"');
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("injects scoped secrets only at managed egress and exposes redacted logs", async () => {
    const project = await json<{
      id: string;
      agents: Array<{ id: string }>;
    }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Egress test", slug: "egress-test" }),
      }),
    );
    const agentId = project.agents[0]!.id;
    const secret = "github-secret-that-must-not-leak";
    const stored = await json<{ name: string; allowedOrigins: string[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/projects/${project.id}/secrets/GITHUB_TOKEN`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value: secret,
            environment: "development",
            allowedOrigins: [
              "https://api.github.com",
              "https://codeload.github.com",
            ],
          }),
        },
      ),
    );
    expect(stored).toEqual(
      expect.objectContaining({
        name: "GITHUB_TOKEN",
        allowedOrigins: [
          "https://api.github.com",
          "https://codeload.github.com",
        ],
      }),
    );
    expect(JSON.stringify(stored)).not.toContain(secret);

    await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          alias: "development",
          connections: ["github-api"],
          httpConnections: [
            {
              id: "github-api",
              origin: "https://api.github.com",
              methods: ["GET"],
              pathPrefix: "/repos/",
              redirectOrigins: [
                {
                  origin: "https://codeload.github.com",
                  pathPrefix: "/opencomputer/example/",
                },
              ],
              headers: {
                Authorization: {
                  kind: "secret",
                  name: "GITHUB_TOKEN",
                  prefix: "Bearer ",
                },
              },
            },
          ],
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/egress-test/digest.json",
            digest: "e".repeat(64),
            size: 512,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      }),
    );
    const session = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${agentId}@development` }),
      }),
    );

    const upstreamFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://codeload.github.com/opencomputer/example/legacy.tar.gz/HEAD?token=archive-token") {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${secret}`,
          );
          expect(new Headers(init?.headers).has("x-caller-context")).toBe(false);
          expect(init?.redirect).toBe("manual");
          return new Response("archive-bytes", {
            headers: { "content-type": "application/gzip" },
          });
        }
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${secret}`,
        );
        expect(init?.redirect).toBe("manual");
        if (url === "https://api.github.com/repos/opencomputer/example") {
          return Response.json({ full_name: "opencomputer/example" });
        }
        if (url === "https://api.github.com/repos/opencomputer/example/tarball/HEAD") {
          return new Response(null, {
            status: 302,
            headers: {
              location:
                "https://codeload.github.com/opencomputer/example/legacy.tar.gz/HEAD?token=archive-token",
            },
          });
        }
        if (url === "https://api.github.com/repos/opencomputer/example/zipball/HEAD") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://downloads.example.com/private.zip" },
          });
        }
        throw new Error(`Unexpected upstream request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", upstreamFetch);
    const response = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${session.session.id}/egress/github-api/fetch`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "GET",
          path: "/repos/opencomputer/example",
          headers: {},
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      full_name: "opencomputer/example",
    });

    const archive = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${session.session.id}/egress/github-api/fetch`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "GET",
          path: "/repos/opencomputer/example/tarball/HEAD",
          headers: { "x-caller-context": "must-not-cross-origin" },
        }),
      },
    );
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/gzip");
    expect(new TextDecoder().decode(await archive.arrayBuffer())).toBe(
      "archive-bytes",
    );

    await SELF.fetch(
      `https://managedagents.test/v1/projects/${project.id}/secrets/GITHUB_TOKEN`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: secret,
          environment: "development",
          allowedOrigins: ["https://api.github.com"],
        }),
      },
    );
    const secretBlockedRedirect = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${session.session.id}/egress/github-api/fetch`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "GET",
          path: "/repos/opencomputer/example/tarball/HEAD",
          headers: {},
        }),
      },
    );
    expect(secretBlockedRedirect.status).toBe(409);
    await expect(secretBlockedRedirect.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "secret_unavailable" }),
      }),
    );

    const blockedRedirect = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${session.session.id}/egress/github-api/fetch`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          method: "GET",
          path: "/repos/opencomputer/example/zipball/HEAD",
          headers: {},
        }),
      },
    );
    expect(blockedRedirect.status).toBe(502);
    await expect(blockedRedirect.json()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "egress_redirect_blocked" }),
      }),
    );
    expect(upstreamFetch).toHaveBeenCalledTimes(5);

    const ingested = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${session.session.id}/runtime-logs`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entries: [{ level: "info", stream: "stdout", message: "agent ready" }],
        }),
      },
    );
    expect(ingested.status).toBe(202);
    const logs = await json<{ logs: Array<{ event: string; data: unknown }> }>(
      await SELF.fetch(`https://managedagents.test/v1/logs?agentId=${agentId}`),
    );
    expect(logs.logs.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(["egress.request", "egress.response", "runtime.log"]),
    );
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("resolves encrypted runtime variables for the session runtime", async () => {
    const project = await json<{
      id: string;
      agents: Array<{ id: string }>;
    }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Runtime variables", slug: "runtime-variables" }),
      }),
    );
    const agentId = project.agents[0]!.id;
    const projectValue = "postgres://project-value";
    const agentValue = "postgres://agent-override";

    for (const [name, value, scopedAgentId] of [
      ["DATABASE_URL", projectValue, undefined],
      ["FEATURE_MODE", "safe", undefined],
      ["DATABASE_URL", agentValue, agentId],
    ] as const) {
      const response = await SELF.fetch(
        `https://managedagents.test/v1/projects/${project.id}/runtime-variables/${name}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            value,
            environment: "development",
            ...(scopedAgentId ? { agentId: scopedAgentId } : {}),
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain(value);
    }

    const listed = await json<{
      variables: Array<{ name: string; agentId?: string }>;
    }>(
      await SELF.fetch(
        `https://managedagents.test/v1/projects/${project.id}/runtime-variables?environment=development`,
      ),
    );
    expect(listed.variables).toHaveLength(3);
    expect(JSON.stringify(listed)).not.toContain(projectValue);
    expect(JSON.stringify(listed)).not.toContain(agentValue);

    await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          alias: "development",
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/runtime-variables/digest.json",
            digest: "f".repeat(64),
            size: 512,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      }),
    );
    const session = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: `${agentId}@development` }),
      }),
    );
    const resolved = await json<{ variables: Record<string, string> }>(
      await SELF.fetch(
        `https://managedagents.test/v1/sessions/${session.session.id}/runtime-variables`,
        { headers: { authorization: `Bearer ${session.runtimeToken}` } },
      ),
    );
    expect(resolved.variables).toEqual({
      DATABASE_URL: agentValue,
      FEATURE_MODE: "safe",
    });

    const unauthenticated = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${session.session.id}/runtime-variables`,
    );
    expect(unauthenticated.status).toBe(401);

    const reserved = await SELF.fetch(
      `https://managedagents.test/v1/projects/${project.id}/runtime-variables/OPENCOMPUTER_TOKEN`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "blocked", environment: "development" }),
      },
    );
    expect(reserved.status).toBe(400);
  });

  it("creates authenticated agent webhooks and admits idempotent sessions", async () => {
    const project = await json<{
      id: string;
      agents: Array<{ id: string }>;
    }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Webhook project", slug: "webhook-project" }),
      }),
    );
    const agentId = project.agents[0]!.id;
    await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          alias: "development",
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/webhook/digest.json",
            digest: "e".repeat(64),
            size: 512,
          },
          imageArn: "image",
          imageVersion: "1",
        }),
      }),
    );

    const createdResponse = await SELF.fetch(
      `https://managedagents.test/v1/projects/${project.id}/webhooks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Run hygiene",
          environment: "development",
          agentId,
        }),
      },
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      webhook: { id: string; token: string; enabled: boolean };
    };
    expect(created.webhook.token).toMatch(/^ocwh_/);
    expect(created.webhook.enabled).toBe(true);

    const listed = await json<{ webhooks: unknown[] }>(
      await SELF.fetch(
        `https://managedagents.test/v1/projects/${project.id}/webhooks?environment=development&agentId=${agentId}`,
      ),
    );
    expect(listed.webhooks).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.webhook.token);

    const input = {
      text: "Run the configured hygiene review.",
      payload: { mode: "hygiene", repository: "diggerhq/example" },
    };
    const invoke = () =>
      SELF.fetch(
        `https://managedagents.test/v1/agent-webhooks/${created.webhook.id}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${created.webhook.token}`,
            "content-type": "application/json",
            "idempotency-key": "hygiene-2026-08-18",
          },
          body: JSON.stringify(input),
        },
      );
    const acceptedResponse = await invoke();
    expect(acceptedResponse.status).toBe(202);
    const accepted = (await acceptedResponse.json()) as {
      request: { id: string; sessionId: string; deploymentId: string; outcome: string };
      duplicate: boolean;
    };
    expect(accepted.duplicate).toBe(false);
    // Acknowledged before admission: the session id is derived, the runtime
    // work happens from the Account DO alarm.
    expect(accepted.request.outcome).toBe("pending");
    expect(accepted.request.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(accepted.request.deploymentId).toBeTruthy();
    await expect(
      env.SESSIONS.getByName(accepted.request.sessionId).snapshotOrNull(),
    ).resolves.toBeNull();

    const settled = await settleWebhookRequest(project.id, created.webhook.id, accepted.request.id);
    expect(settled).toMatchObject({
      outcome: "accepted",
      attempt: 1,
      sessionId: accepted.request.sessionId,
    });
    const session = await env.SESSIONS.getByName(accepted.request.sessionId).snapshot();
    expect(session.turns[0]?.input).toBe(input.text);
    // A webhook admission records the webhook's environment on the session,
    // so the list's environment filter shows it (design C1, every admission
    // path) and credentials resolve in it (C3).
    expect(session.environment).toBe("development");
    await expect(
      env.ACCOUNTS.getByName("local").getSession(accepted.request.sessionId),
    ).resolves.toMatchObject({ id: accepted.request.sessionId, source: "webhook", environment: "development" });
    const filtered = await json<{ sessions: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/sessions?environment=development"),
    );
    expect(filtered.sessions.map((candidate) => candidate.id)).toContain(accepted.request.sessionId);

    const duplicateResponse = await invoke();
    expect(duplicateResponse.status).toBe(202);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      duplicate: true,
      request: { sessionId: accepted.request.sessionId, outcome: "accepted" },
    });

    const conflict = await SELF.fetch(
      `https://managedagents.test/v1/agent-webhooks/${created.webhook.id}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.webhook.token}`,
          "content-type": "application/json",
          "idempotency-key": "hygiene-2026-08-18",
        },
        body: JSON.stringify({ text: "A different body under the same key." }),
      },
    );
    expect(conflict.status).toBe(409);

    const unauthorized = await SELF.fetch(
      `https://managedagents.test/v1/agent-webhooks/${created.webhook.id}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    expect(unauthorized.status).toBe(401);
  });

  it("admits provider deliveries on the URL credential and re-drives failed admissions", async () => {
    const project = await json<{ id: string; agents: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Provider webhook project", slug: "provider-webhooks" }),
      }),
    );
    const agentId = project.agents[0]!.id;
    await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          alias: "development",
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/provider/digest.json",
            digest: "f".repeat(64),
            size: 512,
          },
          imageArn: "image",
          imageVersion: "1",
        }),
      }),
    );
    const created = await json<{ webhook: { id: string; token: string; name: string; identity?: string } }>(
      await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Sentry alerts", environment: "development", agentId, identity: "header:Request-ID" }),
      }),
    );
    expect(created.webhook.identity).toBe("header:request-id");
    const rejected = await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentMode: "legacy", name: "Bad identity", environment: "development", agentId, identity: "sentry" }),
    });
    expect(rejected.status).toBe(400);
    const url = `https://managedagents.test/v1/agent-webhooks/${created.webhook.id}/${created.webhook.token}`;
    // A Sentry-shaped body: no text, no payload, no bearer header, a provider delivery id.
    const providerBody = {
      action: "triggered",
      data: { event: { event_id: "a".repeat(32), contexts: { oncall: { service: "api" } } } },
      installation: { uuid: "inst" },
    };
    const deliver = (requestId: string) =>
      SELF.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "request-id": requestId },
        body: JSON.stringify(providerBody),
      });

    const wrongToken = await SELF.fetch(
      `https://managedagents.test/v1/agent-webhooks/${created.webhook.id}/${"0".repeat(20)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(wrongToken.status).toBe(401);

    const acceptedResponse = await deliver("req-1");
    expect(acceptedResponse.status).toBe(202);
    const accepted = (await acceptedResponse.json()) as {
      request: { id: string; sessionId: string; outcome: string };
      duplicate: boolean;
    };
    expect(accepted).toMatchObject({ duplicate: false, request: { outcome: "pending" } });

    // Same provider delivery id while pending: echoed, not re-run.
    await expect(deliver("req-1").then((response) => response.json())).resolves.toMatchObject({
      duplicate: true,
      request: { id: accepted.request.id, sessionId: accepted.request.sessionId },
    });

    await expect(
      settleWebhookRequest(project.id, created.webhook.id, accepted.request.id),
    ).resolves.toMatchObject({ outcome: "accepted", attempt: 1 });
    const session = await env.SESSIONS.getByName(accepted.request.sessionId).snapshot();
    expect(session.turns[0]?.input).toBe(`Webhook ${created.webhook.name} invoked`);

    // A delivery whose admission fails is retried, not lost. The claim arms
    // the alarm for "now", so hold the clock a day ahead: the alarm is then
    // scheduled in the future and only runs when the test forces it.
    vi.useFakeTimers({ toFake: ["Date"] });
    let retried: Record<string, unknown>;
    let second: { request: { id: string; sessionId: string } };
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      second = (await deliver("req-2").then((response) => response.json())) as typeof second;
      await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks/${created.webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      await expect(
        settleWebhookRequest(project.id, created.webhook.id, second.request.id),
      ).resolves.toMatchObject({ outcome: "pending", attempt: 1, error: "Webhook unavailable" });
      await expect(
        env.SESSIONS.getByName(second.request.sessionId).snapshotOrNull(),
      ).resolves.toBeNull();

      // Re-enable; the next due attempt starts a fresh session under the same request.
      await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks/${created.webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      vi.setSystemTime(Date.now() + 60_000);
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      retried = await settleWebhookRequest(project.id, created.webhook.id, second.request.id);
    } finally {
      vi.useRealTimers();
    }
    // Nothing was initialized by the failed attempt, so the retry keeps the
    // session id the 202 announced.
    expect(retried).toMatchObject({ outcome: "accepted", attempt: 2, sessionId: second.request.sessionId });
    await expect(
      env.SESSIONS.getByName(retried!.sessionId as string).snapshot(),
    ).resolves.toMatchObject({ turns: [expect.objectContaining({ input: `Webhook ${created.webhook.name} invoked` })] });
  });

  async function providerWebhook(slug: string, identity = "header:Request-ID") {
    const project = await json<{ id: string; agents: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: slug, slug }),
      }),
    );
    const agentId = project.agents[0]!.id;
    await json<AgentDeployment>(
      await SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          alias: "development",
          artifact: { bucket: "managed-agent-artifacts", key: `agents/${slug}/digest.json`, digest: "c".repeat(64), size: 512 },
          imageArn: "image",
          imageVersion: "1",
        }),
      }),
    );
    const created = await json<{ webhook: { id: string; token: string; name: string } }>(
      await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Alerts", environment: "development", agentId, identity }),
      }),
    );
    const url = `https://managedagents.test/v1/agent-webhooks/${created.webhook.id}/${created.webhook.token}`;
    const deliver = (headers: Record<string, string>, body: unknown) =>
      SELF.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }).then(async (response) => ({
        status: response.status,
        body: (await response.json()) as { request: { id: string; sessionId: string; outcome: string; attempt?: number }; duplicate: boolean },
      }));
    return { project, agentId, webhook: created.webhook, url, deliver };
  }

  it("recovers an admission whose acceptance write failed after the turn was stored, on the same session", async () => {
    const { project, webhook, deliver } = await providerWebhook("recover-accept");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      const first = await deliver({ "request-id": "r-accept" }, { action: "triggered", data: { event: { event_id: "b".repeat(32) } } });
      expect(first.status).toBe(202);
      // Make only the ledger's acceptance write fail, after the Session DO has stored the turn.
      await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TRIGGER block_accept BEFORE UPDATE OF outcome ON project_webhook_requests
           WHEN NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'injected acceptance failure'); END`,
        );
      });
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const stalled = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(stalled).toMatchObject({
        outcome: "pending",
        attempt: 1,
        error: expect.stringContaining("injected acceptance failure"),
      });
      const stored = await env.SESSIONS.getByName(first.body.request.sessionId).snapshot();
      expect(stored.turns).toHaveLength(1);
      expect(stored.status).not.toBe("ended");

      await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER block_accept");
      });
      vi.setSystemTime(Date.now() + 60_000);
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const recovered = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(recovered).toMatchObject({ outcome: "accepted", attempt: 2, sessionId: first.body.request.sessionId });
      // One session, one turn: the retry reconciled instead of allocating.
      const after = await env.SESSIONS.getByName(first.body.request.sessionId).snapshot();
      expect(after.turns).toHaveLength(1);
      const { sessions } = await env.ACCOUNTS.getByName("local").listSessionSummaries({
        agent: after.agentId,
        labels: [],
        limit: 100,
      });
      expect(sessions.filter((session: SessionSummary) => session.source === "webhook")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes an attempt that initialized its session but never stored the turn", async () => {
    const { project, agentId, webhook, deliver } = await providerWebhook("recover-init");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      const first = await deliver({ "request-id": "r-init" }, { action: "triggered", data: { event: { event_id: "c".repeat(32) } } });
      // Mimic a crash after Session DO initialization: the announced session exists with no turn.
      const session = env.SESSIONS.getByName(first.body.request.sessionId);
      const deployment = await env.ACCOUNTS.getByName("local").resolveDeployment(`${agentId}@development`);
      await session.initialize({
        id: first.body.request.sessionId,
        accountId: "local",
        userId: "user",
        agentId,
        deploymentId: deployment!.id,
      });
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const settled = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(settled).toMatchObject({ outcome: "accepted", attempt: 1, sessionId: first.body.request.sessionId });
      const after = await session.snapshot();
      expect(after.turns).toHaveLength(1);
      expect(after.turns[0]?.input).toBe(`Webhook ${webhook.name} invoked`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a delivery failed after five attempts and re-drives it on a same-identity retry", async () => {
    const { project, webhook, deliver } = await providerWebhook("redrive-failed");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      const body = { action: "triggered", data: { event: { event_id: "d".repeat(32) } } };
      const first = await deliver({ "request-id": "r-failed" }, body);
      await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks/${webhook.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
      });
      let last: Record<string, unknown> | undefined;
      for (let attempt = 1; attempt <= 5; attempt++) {
        vi.setSystemTime(Date.now() + 3_600_000);
        await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
        last = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
        expect(last).toMatchObject({ attempt, outcome: attempt < 5 ? "pending" : "failed" });
      }
      await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks/${webhook.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
      });
      // A delivery under another identity is simply a new request.
      const other = await deliver({ "request-id": "r-failed-2" }, body);
      expect(other.status).toBe(202);
      expect(other.body.request.id).not.toBe(first.body.request.id);
      // The provider retries the failed delivery under its identity: the terminal row is re-armed, not echoed.
      const rearmed = await deliver({ "request-id": "r-failed" }, body);
      expect(rearmed.body).toMatchObject({ duplicate: true, request: { id: first.body.request.id, outcome: "pending" } });
      vi.setSystemTime(Date.now() + 60_000);
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const driven = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(driven).toMatchObject({ outcome: "accepted", attempt: 6 });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Make the next `enqueueTurn` commit and then lose its reply; with
   * `loseProbe`, the first `findTurn` after that lost reply also loses its
   * reply, so the attempt ends with the outcome unknown.
   */
  function loseEnqueueReplyOnce(options: { loseProbe?: boolean } = {}) {
    const enqueue = SessionDurableObject.prototype.enqueueTurn;
    const find = SessionDurableObject.prototype.findTurn;
    let enqueueArmed = true;
    let probeArmed = false;
    SessionDurableObject.prototype.enqueueTurn = function (this: SessionDurableObject, input) {
      const result = enqueue.call(this, input);
      if (enqueueArmed) {
        enqueueArmed = false;
        probeArmed = Boolean(options.loseProbe);
        // A reply is lost after the callee finished: the admission commits
        // (enqueueTurn awaits the fingerprint and the event subscriptions
        // before its transaction), then the caller never hears of it.
        return result.then(() => {
          throw new Error("injected lost enqueue reply");
        });
      }
      return result;
    };
    SessionDurableObject.prototype.findTurn = function (this: SessionDurableObject, key) {
      if (probeArmed) {
        probeArmed = false;
        throw new Error("injected lost probe reply");
      }
      return find.call(this, key);
    };
    return () => {
      SessionDurableObject.prototype.enqueueTurn = enqueue;
      SessionDurableObject.prototype.findTurn = find;
    };
  }

  it("does not end or replace a session whose enqueue committed but whose reply was lost", async () => {
    const { project, agentId, webhook, deliver } = await providerWebhook("lost-reply");
    vi.useFakeTimers({ toFake: ["Date"] });
    const restore = loseEnqueueReplyOnce();
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      const first = await deliver({ "request-id": "r-lost" }, { action: "triggered", data: { event: { event_id: "e".repeat(32) } } });
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      // The launcher probed the Session DO, found the turn, and accepted in the same attempt.
      const settled = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(settled).toMatchObject({ outcome: "accepted", attempt: 1, sessionId: first.body.request.sessionId });
      const session = await env.SESSIONS.getByName(first.body.request.sessionId).snapshot();
      expect(session.status).not.toBe("ended");
      expect(session.turns).toHaveLength(1);
      const { sessions } = await env.ACCOUNTS.getByName("local").listSessionSummaries({
        agent: agentId,
        labels: [],
        limit: 100,
      });
      expect(sessions).toHaveLength(1);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("reconciles a committed turn on the next attempt when both the enqueue and the probe replies were lost", async () => {
    const { project, agentId, webhook, deliver } = await providerWebhook("lost-reply-probe");
    vi.useFakeTimers({ toFake: ["Date"] });
    const restore = loseEnqueueReplyOnce({ loseProbe: true });
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      const first = await deliver({ "request-id": "r-lost-2" }, { action: "triggered", data: { event: { event_id: "f".repeat(32) } } });
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const stalled = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(stalled).toMatchObject({ outcome: "pending", attempt: 1, error: expect.stringContaining("lost enqueue reply") });
      // Outcome unknown: the session must not have been ended.
      const session = await env.SESSIONS.getByName(first.body.request.sessionId).snapshot();
      expect(session.status).not.toBe("ended");
      expect(session.turns).toHaveLength(1);

      vi.setSystemTime(Date.now() + 60_000);
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const recovered = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(recovered).toMatchObject({ outcome: "accepted", attempt: 2, sessionId: first.body.request.sessionId });
      const { sessions } = await env.ACCOUNTS.getByName("local").listSessionSummaries({
        agent: agentId,
        labels: [],
        limit: 100,
      });
      expect(sessions).toHaveLength(1);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("persists a replacement session id before launching it, so a later crash cannot allocate a third", async () => {
    const { project, agentId, webhook, deliver } = await providerWebhook("replacement");
    vi.useFakeTimers({ toFake: ["Date"] });
    let restore = () => {};
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      const first = await deliver({ "request-id": "r-repl" }, { action: "triggered", data: { event: { event_id: "1".repeat(32) } } });
      const announced = first.body.request.sessionId;
      // Announced session A: initialized by a crashed attempt, then ended with no turn.
      const deployment = await env.ACCOUNTS.getByName("local").resolveDeployment(`${agentId}@development`);
      await env.SESSIONS.getByName(announced).initialize({
        id: announced, accountId: "local", userId: "user", agentId, deploymentId: deployment!.id,
      });
      await env.SESSIONS.getByName(announced).end();
      // Replacement B: its enqueue commits but both replies are lost.
      restore = loseEnqueueReplyOnce({ loseProbe: true });
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const stalled = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(stalled).toMatchObject({ outcome: "pending", attempt: 1 });
      const replacement = stalled.sessionId as string;
      expect(replacement).not.toBe(announced);
      expect((await env.SESSIONS.getByName(replacement).snapshot()).turns).toHaveLength(1);

      vi.setSystemTime(Date.now() + 60_000);
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const recovered = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(recovered).toMatchObject({ outcome: "accepted", attempt: 2, sessionId: replacement });
      // A stays ended with no turn and is listed as such (every initialized
      // session publishes its own row); B is the webhook session; no C.
      const announcedAfter = await env.SESSIONS.getByName(announced).snapshot();
      expect(announcedAfter).toMatchObject({ status: "ended", turns: [] });
      const { sessions: indexed } = await env.ACCOUNTS.getByName("local").listSessionSummaries({
        agent: agentId,
        labels: [],
        limit: 100,
      });
      expect(indexed.map((entry: SessionSummary) => entry.id).sort()).toEqual([announced, replacement].sort());
      expect(indexed.find((entry: SessionSummary) => entry.id === announced)).toMatchObject({ status: "ended" });
      expect(indexed.find((entry: SessionSummary) => entry.id === replacement)).toMatchObject({ source: "webhook" });
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it("treats a configured body identity as authoritative when the provider reserializes the body", async () => {
    const { project, webhook, deliver } = await providerWebhook("derived-identity");
    const updated = await json<{ webhook: { identity?: string } }>(
      await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks/${webhook.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: "body:/data/event/event_id" }),
      }),
    );
    expect(updated.webhook.identity).toBe("body:/data/event/event_id");
    const event = { event_id: "2".repeat(32) };
    const first = await deliver(
      { "request-id": "attempt-1" },
      { action: "triggered", data: { event, triggered_rule: "Rule" } },
    );
    expect(first.status).toBe(202);
    const retry = await deliver(
      { "request-id": "attempt-2" },
      { action: "triggered", data: { event: { ...event, extra: "reserialized" }, triggered_rule: "Rule" } },
    );
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ duplicate: true, request: { id: first.body.request.id } });
    // Clearing the source makes every delivery new again.
    await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/webhooks/${webhook.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: null }),
    });
    const fresh = await deliver({ "request-id": "attempt-3" }, { action: "triggered", data: { event } });
    expect(fresh.body.request.id).not.toBe(first.body.request.id);
  });

  it("never writes the URL credential to the backend's own logs, even when admission fails", async () => {
    const { webhook, url } = await providerWebhook("log-hygiene");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.map(String).join(" "));
    });
    try {
      await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TRIGGER block_claim BEFORE INSERT ON project_webhook_requests
           BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`,
        );
      });
      const response = await SELF.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "triggered" }),
      });
      expect(response.status).toBe(500);
    } finally {
      spy.mockRestore();
      await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER block_claim");
      });
    }
    const failure = errors.find((line) => line.includes("edge.request_failed"));
    expect(failure).toBeDefined();
    expect(failure).toContain(`/v1/agent-webhooks/${webhook.id}/redacted`);
    expect(errors.join("\n")).not.toContain(webhook.token);
  });

  it("echoes a terminal failure on a same-identity retry instead of re-arming it", async () => {
    const { project, webhook, deliver } = await providerWebhook("terminal-echo");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      const first = await deliver({ "request-id": "r-terminal" }, { action: "triggered" });
      // Put the row where the terminal branch leaves it: failed, terminal, attempt 1.
      await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE project_webhook_requests
           SET outcome = 'failed', terminal = 1, attempt = 1, next_attempt_at = NULL,
               error = 'Session initialized without a runtime; resend the delivery under a new identity'
           WHERE id = ?`,
          first.body.request.id,
        );
      });
      const retry = await deliver({ "request-id": "r-terminal" }, { action: "triggered" });
      expect(retry.status).toBe(202);
      expect(retry.body).toMatchObject({
        duplicate: true,
        request: { id: first.body.request.id, outcome: "failed", terminal: true, attempt: 1 },
      });
      vi.setSystemTime(Date.now() + 60_000);
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
      const after = await settleWebhookRequest(project.id, webhook.id, first.body.request.id);
      expect(after).toMatchObject({ outcome: "failed", terminal: true, attempt: 1 });
      // A fresh explicit identity starts over.
      const fresh = await deliver({ "idempotency-key": "manual-resend-1" }, { action: "triggered" });
      expect(fresh.body.request.id).not.toBe(first.body.request.id);
      expect(fresh.body.request.outcome).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a delivery that would exceed the structured input limit once wrapped", async () => {
    const { deliver } = await providerWebhook("too-large");
    const exact = { data: "x".repeat(262_133) }; // 262 144 bytes as JSON
    const rejected = await deliver({}, exact);
    expect(rejected.status).toBe(400);
    const fits = await deliver({}, { data: "x".repeat(200_000) });
    expect(fits.status).toBe(202);
  });

  // ── Model access (work 011) ──────────────────────────────────────────────
  it("connects one Codex subscription per org via OAuth, replaces atomically, and disconnects", async () => {
    const account = env.ACCOUNTS.getByName("model-access-org");

    async function connect(
      organizationId: string,
      connectedByUserId: string,
      label?: string,
    ) {
      const started = await account.startModelAccessConnect({
        organizationId,
        connectedByUserId,
        provider: "openai",
        oauthCodeVerifier: "code-verifier",
        oauthRedirectUri: "https://app.opencomputer.dev/model-access/callback",
        label,
      });
      expect(started.status).toBe("connecting");
      const state = `${started.id}.nonce`;
      await account.setModelAccessOAuthState(started.id, `hash-${state}`);
      const intent = await account.modelAccessOAuthIntent(started.id);
      expect(intent?.codeVerifier).toBe("code-verifier");
      expect(intent.stateHash).toBe(`hash-${state}`);
      const completed = await account.completeModelAccessConnect({
        id: started.id,
        accessToken: `access-${connectedByUserId}`,
        refreshToken: `refresh-${connectedByUserId}`,
        tokenType: "Bearer",
        expiresAt: Date.now() + 3_600_000,
        externalAccountHint: `user-${connectedByUserId}`,
      });
      expect(completed.status).toBe("connected");
      return completed;
    }

    const first = await connect("model-access-org", "admin-1", "Codex workspace");
    expect(first.provider).toBe("openai");
    expect(first.kind).toBe("codex_subscription");
    expect(first.label).toBe("Codex workspace");

    // Only one connection per provider per organization: a second connect for
    // the same provider replaces in place (same id), it does not create a new row.
    const replaced = await connect("model-access-org", "admin-2");
    expect(replaced.id).toBe(first.id);
    expect(replaced.connectedByUserId).toBe("admin-2");

    const listed = await account.listModelAccessConnections("model-access-org");
    expect(
      listed.filter((c: ModelAccessConnection) => c.provider === "openai"),
    ).toHaveLength(1);

    // The credential is retrievable for dispatch, then removed on disconnect.
    await expect(account.modelAccessCredential(first.id)).resolves.toBe(
      "access-admin-2",
    );
    const disconnected = await account.disconnectModelAccess(first.id);
    expect(disconnected.status).toBe("revoked");
    await expect(account.modelAccessCredential(first.id)).resolves.toBeNull();
  });

  it("stores, replaces, disconnects, and reconnects a Claude setup token", async () => {
    const account = env.ACCOUNTS.getByName("model-access-claude");
    const first = await account.connectModelAccessToken({
      organizationId: "model-access-claude",
      connectedByUserId: "admin-1",
      provider: "anthropic",
      token: "claude-token-one",
    });
    expect(first.kind).toBe("claude_subscription");
    await expect(account.modelAccessCredential(first.id)).resolves.toBe(
      "claude-token-one",
    );

    const replaced = await account.connectModelAccessToken({
      organizationId: "model-access-claude",
      connectedByUserId: "admin-2",
      provider: "anthropic",
      token: "claude-token-two",
    });
    expect(replaced.id).toBe(first.id);
    await account.disconnectModelAccess(replaced.id);

    const reconnected = await account.connectModelAccessToken({
      organizationId: "model-access-claude",
      connectedByUserId: "admin-3",
      provider: "anthropic",
      token: "claude-token-three",
    });
    expect(reconnected.id).toBe(first.id);
    expect(reconnected.status).toBe("connected");
    await expect(account.modelAccessCredential(first.id)).resolves.toBe(
      "claude-token-three",
    );
  });

  it("stores API keys privately and revisions project and agent model routes", async () => {
    const account = env.ACCOUNTS.getByName("model-access-api-route");
    const connection = await account.connectModelAccessApiKey({
      organizationId: "model-access-api-route",
      connectedByUserId: "admin-1",
      provider: "openai_compatible",
      apiKey: "scx-secret-key",
      baseUrl: "https://api.scx.ai/v1",
      label: "SCX Australia",
    });
    expect(connection).toMatchObject({
      provider: "openai_compatible",
      kind: "openai_compatible_api",
      baseUrl: "https://api.scx.ai/v1",
      status: "connected",
    });
    expect(JSON.stringify(connection)).not.toContain("scx-secret-key");
    await expect(account.modelAccessCredential(connection.id)).resolves.toBe(
      "scx-secret-key",
    );

    const first = await account.putModelRoute({
      organizationId: "model-access-api-route",
      projectId: "prj_route",
      environment: "development",
      connectionId: connection.id,
      model: "GLM-5.3",
      fallback: "fail",
      updatedByUserId: "admin-1",
    });
    expect(first).toMatchObject({ model: "GLM-5.3", revision: 1 });
    const revised = await account.putModelRoute({
      organizationId: "model-access-api-route",
      projectId: "prj_route",
      environment: "development",
      connectionId: connection.id,
      model: "GLM-5.3-turbo",
      fallback: "managed",
      updatedByUserId: "admin-2",
    });
    expect(revised).toMatchObject({
      id: first.id,
      model: "GLM-5.3-turbo",
      fallback: "managed",
      revision: 2,
    });
    const agent = await account.putModelRoute({
      organizationId: "model-access-api-route",
      projectId: "prj_route",
      environment: "development",
      agentId: "subagent",
      connectionId: connection.id,
      model: "deepseek-v4-flash",
      fallback: "fail",
      updatedByUserId: "admin-1",
    });
    expect(agent.agentId).toBe("subagent");
    await expect(account.listModelRoutes("prj_route", "development")).resolves.toHaveLength(2);
  });

  it("enables a Codex connection per project environment and resolves it for dispatch", async () => {
    const account = env.ACCOUNTS.getByName("model-access-route");
    const project = await account.createProject({
      environmentMode: "legacy",
      id: "prj_model_access",
      name: "Model access project",
      slug: "model-access-project",
    });
    await account.registerDeployment({
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "artifacts",
        key: "agent.json",
        digest: "b".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });

    const started = await account.startModelAccessConnect({
      organizationId: "model-access-route",
      connectedByUserId: "admin-1",
      provider: "openai",
      oauthCodeVerifier: "code-verifier",
      oauthRedirectUri: "https://app.opencomputer.dev/model-access/callback",
    });
    const connection = await account.completeModelAccessConnect({
      id: started.id,
      accessToken: "access-route",
      refreshToken: "refresh-route",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
    });

    // Newly connected provider starts disabled for every project environment.
    const before = await account.listModelAccessBindings(project.id, "development");
    expect(before.find((b: ModelAccessBinding) => b.provider === "openai")?.enabled).not.toBe(true);

    const binding = await account.putModelAccessBinding({
      organizationId: "model-access-route",
      projectId: project.id,
      environment: "development",
      provider: "openai",
      enabled: true,
      enabledByUserId: "admin-1",
    });
    expect(binding.enabled).toBe(true);
    expect(binding.connectionId).toBe(connection.id);

    // Development and production bindings are independent.
    const production = await account.listModelAccessBindings(
      project.id,
      "production",
    );
    expect(production.find((b: ModelAccessBinding) => b.provider === "openai")?.enabled).not.toBe(
      true,
    );

    // Disabling returns the provider to Managed routing for that environment.
    const disabled = await account.putModelAccessBinding({
      organizationId: "model-access-route",
      projectId: project.id,
      environment: "development",
      provider: "openai",
      enabled: false,
      enabledByUserId: "admin-1",
    });
    expect(disabled.enabled).toBe(false);
  });

  it("rejects a second provider and deactivates bindings on disconnect", async () => {
    const account = env.ACCOUNTS.getByName("model-access-disc");
    const project = await account.createProject({
      environmentMode: "legacy",
      id: "prj_model_disc",
      name: "Disconnect project",
      slug: "disconnect-project",
    });
    const started = await account.startModelAccessConnect({
      organizationId: "model-access-disc",
      connectedByUserId: "admin-1",
      provider: "openai",
      oauthCodeVerifier: "code-verifier",
      oauthRedirectUri: "https://app.opencomputer.dev/model-access/callback",
    });
    const connection = await account.completeModelAccessConnect({
      id: started.id,
      accessToken: "access-disc",
      refreshToken: "refresh-disc",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
    });
    await account.putModelAccessBinding({
      organizationId: "model-access-disc",
      projectId: project.id,
      environment: "development",
      provider: "openai",
      enabled: true,
      enabledByUserId: "admin-1",
    });

    await account.disconnectModelAccess(connection.id);
    const bindings = await account.listModelAccessBindings(
      project.id,
      "development",
    );
    expect(
      bindings.find((b: ModelAccessBinding) => b.provider === "openai")?.enabled,
    ).not.toBe(true);
  });

  it("relays a locally-exchanged Codex credential into a connected subscription", async () => {
    const account = env.ACCOUNTS.getByName("model-access-relay");
    const started = await account.startModelAccessConnect({
      organizationId: "model-access-relay",
      connectedByUserId: "admin-1",
      provider: "openai",
      oauthCodeVerifier: "local-verifier",
      oauthRedirectUri: "http://localhost:1455/auth/callback",
    });
    // The CLI exchanged the code locally; it relays only the credential.
    const connected = await account.completeModelAccessConnect({
      id: started.id,
      accessToken: "relayed-access",
      refreshToken: "relayed-refresh",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
    });
    expect(connected.status).toBe("connected");
    await expect(account.modelAccessCredential(started.id)).resolves.toBe(
      "relayed-access",
    );
    const refresh = await account.modelAccessRefreshCredential(started.id);
    expect(refresh?.refreshToken).toBe("relayed-refresh");
  });
});

describe("channel delivery storage", () => {
  async function session(name: string) {
    const stub = env.SESSIONS.getByName(name);
    await stub.initialize({
      id: name,
      accountId: "local",
      userId: "user-1",
      agentId: "agent-1",
      deploymentId: `agent-1:${"a".repeat(64)}`,
    });
    return stub;
  }

  const delivery = {
    connectionId: "conn-1",
    channelId: "C123",
    externalUserId: "U456",
    threadTimestamp: "1700000000.000100",
  };

  it("records the addressing a reply needs, and the principal who asked", async () => {
    const stub = await session("delivery-basic");
    await stub.enqueueSlackTurn(
      { input: "hello", idempotencyKey: "slack:E1" },
      delivery,
    );
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT * FROM slack_deliveries")
        .toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connected_account_id: "conn-1",
      channel_id: "C123",
      external_user_id: "U456",
      thread_timestamp: "1700000000.000100",
      status: "pending",
      attempts: 0,
    });
    // Written on insert and never read since; kept here so a migration that
    // drops it has to do so deliberately.
    expect(rows[0]!.progress_message_timestamp).toBeNull();

    await expect(stub.channelPrincipal()).resolves.toEqual({
      provider: "slack",
      connectionId: "conn-1",
      externalUserId: "U456",
    });
  });

  it("keeps one delivery per turn when the provider retries the same event", async () => {
    const stub = await session("delivery-idempotent");
    await stub.enqueueSlackTurn({ input: "hi", idempotencyKey: "slack:E2" }, delivery);
    await stub.enqueueSlackTurn({ input: "hi", idempotencyKey: "slack:E2" }, delivery);
    const count = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM slack_deliveries")
        .toArray()[0]!.n,
    );
    expect(count).toBe(1);
  });

  it("reports the most recent principal when a thread has several", async () => {
    const stub = await session("delivery-principal");
    await stub.enqueueSlackTurn({ input: "one", idempotencyKey: "slack:E3" }, delivery);
    await stub.enqueueSlackTurn(
      { input: "two", idempotencyKey: "slack:E4" },
      { ...delivery, externalUserId: "U999" },
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE slack_deliveries SET updated_at = ? WHERE external_user_id = ?",
        new Date(Date.now() + 1000).toISOString(),
        "U999",
      );
    });
    await expect(stub.channelPrincipal()).resolves.toMatchObject({
      externalUserId: "U999",
    });
  });

  it("has no principal before any channel turn", async () => {
    const stub = await session("delivery-empty");
    await expect(stub.channelPrincipal()).resolves.toBeNull();
  });
});

describe("channel delivery migration", () => {
  async function session(name: string) {
    const stub = env.SESSIONS.getByName(name);
    await stub.initialize({
      id: name,
      accountId: "local",
      userId: "user-1",
      agentId: "agent-1",
      deploymentId: `agent-1:${"a".repeat(64)}`,
    });
    return stub;
  }

  it("stores the provider and the addressing a reply needs", async () => {
    const stub = await session("migration-forward");
    await stub.enqueueSlackTurn(
      { input: "hello", idempotencyKey: "slack:M1" },
      {
        connectionId: "conn-1",
        channelId: "C123",
        externalUserId: "U456",
        threadTimestamp: "1700000000.000100",
      },
    );
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ provider: string; delivery_ref: string }>(
          "SELECT provider, delivery_ref FROM slack_deliveries",
        )
        .toArray()[0]!,
    );
    expect(row.provider).toBe("slack");
    expect(JSON.parse(row.delivery_ref)).toEqual({
      channelId: "C123",
      threadTimestamp: "1700000000.000100",
    });
  });

  it("backfills a row written before the columns existed", async () => {
    const stub = await session("migration-backfill");
    // A row as it looked before this change: no provider, no delivery_ref.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO slack_deliveries (
           turn_id, connected_account_id, channel_id, external_user_id,
           thread_timestamp, status, attempts, updated_at
         ) VALUES ('legacy-turn', 'conn-legacy', 'CLEGACY', 'ULEGACY',
                   '1600000000.000200', 'pending', 0, '2026-01-01T00:00:00.000Z')`,
      );
      state.storage.sql.exec(
        "UPDATE slack_deliveries SET provider = NULL, delivery_ref = NULL WHERE turn_id = 'legacy-turn'",
      );
    });
    // An old row still resolves a principal, because the read tolerates a null
    // provider rather than requiring the backfill to have run first.
    await expect(stub.channelPrincipal()).resolves.toEqual({
      provider: "slack",
      connectionId: "conn-legacy",
      externalUserId: "ULEGACY",
    });
  });

  it("leaves the columns a reply is still sent from untouched", async () => {
    const stub = await session("migration-compat");
    await stub.enqueueSlackTurn(
      { input: "hi", idempotencyKey: "slack:M2" },
      {
        connectionId: "conn-2",
        channelId: "C999",
        externalUserId: "U999",
        threadTimestamp: "1700000000.000300",
      },
    );
    // Reads still go through the original columns: this change adds, it does
    // not move. Flipping the delivery path onto delivery_ref is separate.
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ channel_id: string; thread_timestamp: string }>(
          "SELECT channel_id, thread_timestamp FROM slack_deliveries",
        )
        .toArray()[0]!,
    );
    expect(row).toEqual({
      channel_id: "C999",
      thread_timestamp: "1700000000.000300",
    });
  });
});

describe("one deployment behind many workspaces", () => {
  const SIGNING_SECRET = "a".repeat(32);
  const TOKEN = "slack-app-webhook-token";
  const APP = "app-shared";

  async function hex(value: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function registerApp() {
    const account = env.ACCOUNTS.getByName("local");
    await account.registerDeployment({
      agentId: "agent-shared",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "artifacts",
        key: "shared.json",
        digest: "d".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    await account.createChannelApp({
      id: APP,
      provider: "slack",
      externalAppId: "A-SHARED",
      agentId: "agent-shared",
      alias: "development",
      signingSecret: SIGNING_SECRET,
      label: "Shared",
    });
    await env.ACCOUNTS.getByName(`slack-app:${APP}`).setChannelAppRoute({
      accountId: "local",
      appId: APP,
      webhookTokenHash: await hex(TOKEN),
      provider: "slack",
    });
    return account;
  }

  async function event(teamId: string, eventId: string) {
    const url = `https://example.com/v1/webhooks/slack/app/${APP}/${TOKEN}`;
    const payload = JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      api_app_id: "A-SHARED",
      team_id: teamId,
      event: {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        ts: "1.1",
        text: "hello",
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`v0:${timestamp}:${payload}`),
      ),
    );
    return SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      },
      body: payload,
    });
  }

  it("routes each workspace to its own installation on one shared URL", async () => {
    const account = await registerApp();
    // Two of the customer's customers, both on the one Request URL a Slack
    // app is allowed to have.
    const acme = await account.upsertAppInstallation({
      appId: APP,
      provider: "slack",
      agentId: "agent-shared",
      alias: "development",
      channelId: "slack",
      workspaceId: "T-ACME",
      botToken: "xoxb-acme",
      signingSecret: SIGNING_SECRET,
      tenantId: "org_acme",
    });
    const globex = await account.upsertAppInstallation({
      appId: APP,
      provider: "slack",
      agentId: "agent-shared",
      alias: "development",
      channelId: "slack",
      workspaceId: "T-GLOBEX",
      botToken: "xoxb-globex",
      signingSecret: SIGNING_SECRET,
      tenantId: "org_globex",
    });
    expect(acme.id).not.toBe(globex.id);

    expect(
      (await account.findAppInstallation(APP, "T-ACME"))?.id,
    ).toBe(acme.id);
    expect(
      (await account.findAppInstallation(APP, "T-GLOBEX"))?.id,
    ).toBe(globex.id);
    expect(await account.findAppInstallation(APP, "T-UNKNOWN")).toBeUndefined();

    expect((await event("T-ACME", "Ev1")).status).toBe(200);
  });

  it("re-importing an installation updates it rather than doubling it", async () => {
    const account = await registerApp();
    const input = {
      appId: APP,
      provider: "slack",
      agentId: "agent-shared",
      alias: "development",
      channelId: "slack",
      workspaceId: "T-REPEAT",
      botToken: "xoxb-first",
      signingSecret: SIGNING_SECRET,
    };
    // A migration that cannot be re-run is a migration nobody dares start.
    const first = await account.upsertAppInstallation(input);
    const second = await account.upsertAppInstallation({
      ...input,
      botToken: "xoxb-second",
    });
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(
      (await account.listAppInstallations(APP)).filter(
        (installation: { id: string }) => installation.id === first.id,
      ),
    ).toHaveLength(1);
  });

  it("stores an installation's token where sending will look for it", async () => {
    const account = await registerApp();
    const installed = await account.upsertAppInstallation({
      appId: APP,
      provider: "slack",
      agentId: "agent-shared",
      alias: "development",
      channelId: "slack",
      workspaceId: "T-SENDS",
      botToken: "xoxb-sends",
      signingSecret: SIGNING_SECRET,
      tenantId: "org_sends",
    });
    // Receiving reads the channel row; sending reads `connections`. An
    // installation that writes only the first can take messages and never
    // answer one, which is how a card came back "credentials are unavailable"
    // on an installation that had just been imported successfully.
    const posted: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      posted.push(String(url));
      return Response.json({ ok: true, ts: "12.3" });
    }) as unknown as typeof globalThis.fetch;
    try {
      await expect(
        account.sendChannelReply(
          "slack",
          installed.id,
          { channelId: "C1", threadTimestamp: "1.1" },
          "hello",
        ),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(posted.some((u) => u.includes("chat.postMessage"))).toBe(true);
  });

  it("serves the interactivity URL it hands out, not just the events one", async () => {
    const account = await registerApp();
    await account.upsertAppInstallation({
      appId: APP,
      provider: "slack",
      agentId: "agent-shared",
      alias: "development",
      channelId: "slack",
      workspaceId: "T-CLICK",
      botToken: "xoxb-click",
      signingSecret: SIGNING_SECRET,
    });
    // Registration generates `<events>/interactivity`, and for a long moment
    // nothing served that path: the click fell through to the authenticated
    // API surface and Slack showed the user a 401 under the button.
    const payload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        api_app_id: "A-SHARED",
        team: { id: "T-CLICK" },
        user: { id: "U-BRIAN" },
        channel: { id: "C1" },
        message: { ts: "9.9", thread_ts: "1.1" },
        actions: [
          {
            action_id: "opencomputer_approval_deny",
            value: "apr_does_not_exist",
          },
        ],
      }),
    }).toString();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`v0:${timestamp}:${payload}`),
      ),
    );
    const response = await SELF.fetch(
      `https://example.com/v1/webhooks/slack/app/${APP}/${TOKEN}/interactivity`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        },
        body: payload,
      },
    );
    expect(response.status).toBe(200);
  });

  it("refuses a click whose signature does not match the app secret", async () => {
    await registerApp();
    const response = await SELF.fetch(
      `https://example.com/v1/webhooks/slack/app/${APP}/${TOKEN}/interactivity`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
          "x-slack-signature": "v0=deadbeef",
        },
        body: new URLSearchParams({ payload: "{}" }).toString(),
      },
    );
    expect(response.status).toBe(401);
  });

  it("answers a workspace it has never heard of with a success", async () => {
    await registerApp();
    // An uninstalled workspace, or one never imported. An error would make
    // Slack redeliver it forever.
    expect((await event("T-STRANGER", "Ev9")).status).toBe(200);
  });

  it("refuses an event signed with the wrong secret", async () => {
    await registerApp();
    const response = await SELF.fetch(
      `https://example.com/v1/webhooks/slack/app/${APP}/${TOKEN}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
          "x-slack-signature": "v0=deadbeef",
        },
        body: JSON.stringify({ type: "event_callback", team_id: "T-ACME" }),
      },
    );
    expect(response.status).toBe(401);
  });
});

describe("a gated tool proposing a write", () => {
  const SIGNING_SECRET = "p".repeat(32);

  async function slackConnection(
    account: ReturnType<typeof env.ACCOUNTS.getByName>,
    id: string,
  ) {
    await account.createSlackConnection({
      id,
      agentId: "agent-propose",
      alias: "development",
      appName: "Proposals",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        team_id: "T1",
        team: "Acme",
        user_id: "B1",
        bot_id: "BOT1",
      })) as unknown as typeof globalThis.fetch;
    try {
      await account.completeSlackConnection(id, "xoxb-propose", "A1", SIGNING_SECRET);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  async function deployed(gatedTools: Array<{ agentId: string; toolId: string }>) {
    const account = env.ACCOUNTS.getByName("local");
    const graph: ProjectDeploymentReference = {
      id: "project:prj_propose:graph",
      digest: "e".repeat(64),
      localAgentId: "biller",
      agents: [
        { localId: "biller", agentId: "agent-propose", artifactDigest: "e".repeat(64) },
      ],
      resources: {
        version: 1,
        channels: [],
        channelRegistrations: [],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [],
        gatedTools,
      },
    };
    await account.registerDeployment({
      agentId: "agent-propose",
      alias: "development",
      channels: [],
      connections: [],
      projectDeployment: graph,
      artifact: {
        bucket: "artifacts",
        key: "propose.json",
        digest: "e".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    return account;
  }

  /** A session with a conversation to address a proposal to. */
  async function conversing(connectionId: string) {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent-propose@development" }),
      }),
    );
    await env.SESSIONS.getByName(created.session.id).enqueueChannelTurn(
      {
        input: "move acme to pro",
        agentInput: { source: "channel", text: "move acme to pro" },
        idempotencyKey: `slack:${created.session.id}`,
      },
      {
        provider: "slack",
        connectionId,
        externalUserId: "U-BRIAN",
        deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
      },
    );
    return created;
  }

  function propose(
    created: InitializeSessionResult,
    body: Record<string, unknown>,
  ) {
    return SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/approvals`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${created.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  }

  it("records the proposal and posts the card that asks", async () => {
    const account = await deployed([{ agentId: "biller", toolId: "attach" }]);
    await slackConnection(account, "conn-propose");
    const created = await conversing("conn-propose");

    const posted: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      posted.push({
        url: String(url),
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      return Response.json({ ok: true, ts: "77.7" });
    }) as unknown as typeof globalThis.fetch;
    let response: Response;
    try {
      response = await propose(created, {
        toolId: "attach",
        input: { plan: "pro" },
        preview: {
          title: "Move Acme to Pro",
          facts: [{ label: "Charged now", value: "$240.00" }],
        },
        idempotencyKey: "msg-1",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(response.status).toBe(202);
    const recorded = await json<{ id: string; message: string }>(response);
    // The platform supplies the sentence, so every agent tells the same story.
    expect(recorded.message).toContain("Recorded for approval");

    const approval = await account.getApproval(recorded.id);
    expect(approval).toMatchObject({
      status: "pending",
      toolId: "attach",
      connectionId: "conn-propose",
      // Only the person being spoken to may answer it.
      deciderPrincipal: "U-BRIAN",
      // The arguments the human is agreeing to, kept verbatim.
      input: { plan: "pro" },
    });
    // The card, so a decision can rewrite it in place.
    expect(approval?.externalMessageId).toBe("77.7");
    expect(approval?.deliveryRef).toEqual({
      channelId: "C1",
      threadTimestamp: "1.1",
    });

    // The admission ack is also a chat.postMessage; the card is the one
    // carrying the approval actions.
    const card = posted.find(
      (call) =>
        String(call.url).includes("chat.postMessage") &&
        JSON.stringify(call.body).includes("opencomputer_approval_approve"),
    );
    expect(card).toBeDefined();
    const blocks = (card!.body as { blocks: Array<Record<string, unknown>> }).blocks;
    expect(JSON.stringify(blocks)).toContain("Move Acme to Pro");
  });

  it("records one approval however many times the tool call is retried", async () => {
    const account = await deployed([{ agentId: "biller", toolId: "attach" }]);
    await slackConnection(account, "conn-retry");
    const created = await conversing("conn-retry");
    const body = {
      toolId: "attach",
      input: { plan: "pro" },
      preview: { title: "Move Acme to Pro" },
      idempotencyKey: "msg-retry",
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ ok: true, ts: "88.8" })) as unknown as typeof globalThis.fetch;
    try {
      const first = await propose(created, body);
      expect(first.status).toBe(202);
      // A resumed turn replays the tool call. One card, not two.
      const second = await propose(created, body);
      expect(second.status).toBe(200);
      expect((await json<{ id: string }>(second)).id).toBe(
        (await account.listApprovals("agent-propose", "development"))[0]!.id,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(
      await account.listApprovals("agent-propose", "development"),
    ).toHaveLength(1);
  });

  it("explains a refusal in words the agent can repeat", async () => {
    const account = await deployed([{ agentId: "biller", toolId: "attach" }]);
    await slackConnection(account, "conn-words");
    const created = await conversing("conn-words");
    const response = await propose(created, {
      toolId: "refund_everything",
      input: {},
      preview: { title: "Refund everything" },
      idempotencyKey: "msg-words",
    });
    const body = await response.json<{ error: { message: string } }>();
    // Whatever is said here reaches the model, which repeats it to a person.
    // A bare status invites it to invent a reason — it once turned a 409 into
    // a confident story about the customer already being on the plan.
    expect(body.error.message).toContain("nothing was changed");
    expect(body.error.message).not.toMatch(/\b40[39]\b|\b50[0-9]\b/);
  });

  it("says plainly when there is nobody to ask, without naming a status", async () => {
    await deployed([{ agentId: "biller", toolId: "attach" }]);
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent-propose@development" }),
      }),
    );
    const response = await propose(created, {
      toolId: "attach",
      input: {},
      preview: { title: "Move Acme to Pro" },
      idempotencyKey: "msg-nowords",
    });
    const body = await response.json<{ error: { message: string } }>();
    expect(body.error.message).toContain("approve it");
    expect(body.error.message).toContain("Nothing was changed");
  });

  it("shows what was proposed and what became of it", async () => {
    const account = await deployed([{ agentId: "biller", toolId: "attach" }]);
    await slackConnection(account, "conn-readable");
    const created = await conversing("conn-readable");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ ok: true, ts: "99.9" })) as unknown as typeof globalThis.fetch;
    try {
      await propose(created, {
        toolId: "attach",
        input: { plan: "pro" },
        preview: { title: "Move Acme to Pro" },
        idempotencyKey: "msg-readable",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    const listed = await json<{
      approvals: Array<{ id: string; status: string; toolId: string; input: unknown }>;
    }>(
      await SELF.fetch(
        "https://managedagents.test/v1/approvals?agentId=agent-propose&environment=development",
      ),
    );
    // Without this the only way to tell a settled approval from one stuck
    // pending was to infer it from a status code.
    expect(listed.approvals).toHaveLength(1);
    expect(listed.approvals[0]).toMatchObject({
      status: "pending",
      toolId: "attach",
      input: { plan: "pro" },
    });
  });

  it("refuses to propose what its runtime could never carry out", async () => {
    const account = await deployed([{ agentId: "biller", toolId: "attach" }]);
    await slackConnection(account, "conn-workerd");
    const created = await conversing("conn-workerd");
    // A workerd session cannot be created here — it needs a runtime binding the
    // test environment has no version of — so the deployment's mode is flipped
    // underneath it. The guard reads the deployment, which is the state that
    // matters.
    await runInDurableObject(env.ACCOUNTS.getByName("local"), (_i, state) => {
      state.storage.sql.exec(
        "UPDATE deployments SET runtime_mode = 'workerd-lazy-sandbox' WHERE agent_id = ?",
        "agent-propose",
      );
    });

    const response = await propose(created, {
      toolId: "attach",
      input: { plan: "pro" },
      preview: { title: "Move Acme to Pro" },
      idempotencyKey: "msg-workerd",
    });
    // Showing a card, taking a click and silently never writing is the worst
    // of the available outcomes. Refuse before anything is recorded.
    expect(response.status).toBe(409);
    const body = await response.json<{ error: { message: string } }>();
    expect(body.error.message).toContain("nothing was changed");
    // Nothing recorded means nothing for a sweep to have to explain later.
    const recorded = await account.listApprovals("agent-propose", "development");
    expect(
      recorded.some((a: { toolId: string }) => a.toolId === "attach"),
    ).toBe(false);
  });

  it("refuses a tool the deployment never declared as gated", async () => {
    const account = await deployed([{ agentId: "biller", toolId: "attach" }]);
    await slackConnection(account, "conn-undeclared");
    const created = await conversing("conn-undeclared");
    const response = await propose(created, {
      toolId: "refund_everything",
      input: {},
      preview: { title: "Refund everything" },
      idempotencyKey: "msg-undeclared",
    });
    expect(response.status).toBe(403);
  });

  it("says plainly that a session with no conversation has nobody to ask", async () => {
    await deployed([{ agentId: "biller", toolId: "attach" }]);
    // A playground, schedule or webhook session. There is no card to post and
    // nobody to post it to; inventing a surface would be worse than saying so.
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent-propose@development" }),
      }),
    );
    const response = await propose(created, {
      toolId: "attach",
      input: {},
      preview: { title: "Move Acme to Pro" },
      idempotencyKey: "msg-nowhere",
    });
    expect(response.status).toBe(409);
  });

  it("turns away a proposal without the session's runtime token", async () => {
    const account = await deployed([{ agentId: "biller", toolId: "attach" }]);
    await slackConnection(account, "conn-unauthed");
    const created = await conversing("conn-unauthed");
    const response = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/approvals`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer not-the-runtime-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          toolId: "attach",
          input: {},
          preview: { title: "Move Acme to Pro" },
          idempotencyKey: "msg-unauthed",
        }),
      },
    );
    expect(response.status).toBe(401);
  });
});

describe("choosing where an approved write runs", () => {
  const healthy = { status: "running", microvmState: "running", userId: "u1" };

  it("uses the session that proposed it when that session can still run", () => {
    expect(selectApplySession({ sessionId: "s1" }, healthy)).toEqual({
      kind: "use",
      sessionId: "s1",
      userId: "u1",
    });
  });

  it("wakes a suspended session rather than starting a second one", () => {
    expect(
      selectApplySession(
        { sessionId: "s1" },
        { ...healthy, microvmState: "suspended" },
      ),
    ).toEqual({ kind: "resume", sessionId: "s1", userId: "u1" });
  });

  /**
   * Observed live: a decision arrived while the session was winding down, the
   * write was dispatched into it, and the runtime stopped mid-call. The egress
   * went out, the answer came back to nobody, and the approval sat in
   * `applying` until the sweep gave up.
   */
  it("wakes a session that is on its way down rather than writing into it", () => {
    for (const winding of [
      { ...healthy, status: "suspending" },
      { ...healthy, status: "suspended" },
      { ...healthy, status: "resuming" },
      { ...healthy, microvmState: "suspending" },
      { ...healthy, microvmState: "resuming" },
    ]) {
      expect(selectApplySession({ sessionId: "s1" }, winding)).toEqual({
        kind: "resume",
        sessionId: "s1",
        userId: "u1",
      });
    }
  });

  it("starts a fresh session when there is nothing left to run in", () => {
    // Decisions arrive hours later, so every one of these is ordinary rather
    // than exceptional.
    for (const snapshot of [
      { ...healthy, status: "ended" },
      { ...healthy, status: "failed" },
      { ...healthy, microvmState: "terminated" },
    ]) {
      expect(selectApplySession({ sessionId: "s1" }, snapshot)).toEqual({
        kind: "create",
      });
    }
    expect(selectApplySession({ sessionId: "s1" }, null)).toEqual({
      kind: "create",
    });
    expect(selectApplySession({}, healthy)).toEqual({ kind: "create" });
  });
});

describe("carrying out an approved write", () => {
  const SIGNING_SECRET = "w".repeat(32);

  async function ready(connectionId: string) {
    const account = env.ACCOUNTS.getByName("local");
    await account.registerDeployment({
      agentId: "agent-carry",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "artifacts",
        key: "carry.json",
        digest: "f".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    await account.createSlackConnection({
      id: connectionId,
      agentId: "agent-carry",
      alias: "development",
      appName: "Carry",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        team_id: "T1",
        team: "Acme",
        user_id: "B1",
        bot_id: "BOT1",
      })) as unknown as typeof globalThis.fetch;
    try {
      await account.completeSlackConnection(
        connectionId,
        "xoxb-carry",
        "A1",
        SIGNING_SECRET,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    return account;
  }

  async function session() {
    return json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent-carry@development" }),
      }),
    );
  }

  /** Bind a runtime the way the platform would once a MicroVM is up. */
  async function bindMicrovm(sessionId: string, state: string) {
    await SELF.fetch(
      `https://managedagents.test/v1/sessions/${sessionId}/microvm`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ microvmId: `microvm-${sessionId}`, state }),
      },
    );
  }

  async function proposal(
    account: ReturnType<typeof env.ACCOUNTS.getByName>,
    connectionId: string,
    sessionId: string | undefined,
    key: string,
  ) {
    const approval = await account.createApproval({
      agentId: "agent-carry",
      alias: "development",
      deploymentId: `agent-carry:${"f".repeat(64)}`,
      ...(sessionId ? { sessionId } : {}),
      toolId: "attach",
      toolInput: { plan: "pro" },
      preview: { title: "Move Acme to Pro" },
      connectionId,
      provider: "slack",
      deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
      deciderPrincipal: "U-BRIAN",
      idempotencyKey: key,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await account.recordApprovalMessage(approval.id, "44.4");
    await account.decideApproval({
      id: approval.id,
      choice: "approved",
      decidedBy: "U-BRIAN",
    });
    return approval;
  }

  it("sends the write to the session that proposed it, when that session is up", async () => {
    const account = await ready("conn-carry-use");
    const created = await session();
    await bindMicrovm(created.session.id, "running");
    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    const approval = await proposal(
      account,
      "conn-carry-use",
      created.session.id,
      "carry-use",
    );
    await account.beginApply(approval.id);

    const dispatched = await env.SESSIONS.getByName(
      created.session.id,
    ).dispatchGatedTool({
      approvalId: approval.id,
      toolId: "attach",
      toolInput: { plan: "pro" },
      decision: { id: approval.id, decidedAt: "2026-09-10T00:00:00Z" },
    });
    expect(dispatched).toEqual({ dispatched: true });
    const ask = await nextFrame<Record<string, unknown>>(
      runtime,
      (frame) => frame.type === "tool.apply",
      5_000,
    );
    expect(ask).toMatchObject({ toolId: "attach", input: { plan: "pro" } });
  });

  it("leaves the write in flight when no runtime is listening, rather than failing it", async () => {
    const account = await ready("conn-carry-create");
    const created = await session();
    const approval = await proposal(
      account,
      "conn-carry-create",
      created.session.id,
      "carry-create",
    );
    await account.beginApply(approval.id);

    // No runtime has connected. This is ordinary for a session that was just
    // created, so the record stays `applying` and the sweep decides later —
    // giving up here would report a failure that never happened.
    const dispatched = await env.SESSIONS.getByName(
      created.session.id,
    ).dispatchGatedTool({
      approvalId: approval.id,
      toolId: "attach",
      toolInput: { plan: "pro" },
      decision: { id: approval.id, decidedAt: "2026-09-10T00:00:00Z" },
    });
    expect(dispatched).toEqual({
      dispatched: false,
      reason: "runtime_not_connected",
    });
    expect((await account.getApproval(approval.id))?.status).toBe("applying");
  });

  it("does not start the same write twice", async () => {
    const account = await ready("conn-carry-twice");
    const created = await session();
    const approval = await proposal(
      account,
      "conn-carry-twice",
      created.session.id,
      "carry-twice",
    );
    // Slack retries the decision; only one caller may carry the write out.
    const first = await account.beginApply(approval.id);
    const second = await account.beginApply(approval.id);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
  });

  it("answers a write for a session that is gone by picking a fresh one", async () => {
    await ready("conn-carry-ended");
    const created = await session();
    await env.SESSIONS.getByName(created.session.id).end();
    const snapshot = await env.SESSIONS.getByName(created.session.id).snapshot();
    expect(snapshot.status).toBe("ended");
    // Decisions arrive hours later, so the proposing session being over is
    // the ordinary case rather than the exception.
    expect(selectApplySession({ sessionId: created.session.id }, snapshot)).toEqual(
      { kind: "create" },
    );
  });

  it("wakes a suspended session instead of abandoning the write", async () => {
    await ready("conn-carry-suspended");
    const created = await session();
    await bindMicrovm(created.session.id, "running");
    await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/microvm`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          microvmId: `microvm-${created.session.id}`,
          state: "suspended",
        }),
      },
    );
    const snapshot = await env.SESSIONS.getByName(created.session.id).snapshot();
    expect(snapshot.microvmState).toBe("suspended");
    expect(
      selectApplySession({ sessionId: created.session.id }, snapshot),
    ).toMatchObject({ kind: "resume", sessionId: created.session.id });
  });
});

describe("a decision on something the agent proposed", () => {
  const SIGNING_SECRET = "s".repeat(32);
  const TOKEN = "slack-interactivity-token";

  async function hex(value: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function deployed() {
    const account = env.ACCOUNTS.getByName("local");
    await account.registerDeployment({
      agentId: "agent-approvals",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "artifacts",
        key: "approvals.json",
        digest: "b".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    return account;
  }

  async function connectSlack(connectionId: string) {
    await env.ACCOUNTS.getByName(`slack:${connectionId}`).setChannelRoute({
      accountId: "local",
      connectionId,
      webhookTokenHash: await hex(TOKEN),
      provider: "slack",
    });
    const account = env.ACCOUNTS.getByName("local");
    await account.createSlackConnection({
      id: connectionId,
      agentId: "agent-approvals",
      alias: "development",
      appName: "Approvals",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        ok: true,
        team_id: "T1",
        team: "Acme",
        user_id: "B1",
        bot_id: "BOT1",
      })) as unknown as typeof globalThis.fetch;
    try {
      await account.completeSlackConnection(
        connectionId,
        "xoxb-approvals",
        "A1",
        SIGNING_SECRET,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    return account;
  }

  async function propose(
    account: ReturnType<typeof env.ACCOUNTS.getByName>,
    connectionId: string,
    idempotencyKey: string,
    deciderPrincipal = "U-BRIAN",
  ) {
    return account.createApproval({
      agentId: "agent-approvals",
      alias: "development",
      deploymentId: `agent-approvals:${"c".repeat(64)}`,
      toolId: "attach",
      toolInput: { plan: "pro" },
      preview: { title: "Move Acme to Pro", facts: [{ label: "Charged", value: "$240.00" }] },
      connectionId,
      provider: "slack",
      deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
      deciderPrincipal,
      idempotencyKey,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  async function click(
    connectionId: string,
    approvalId: string,
    input: { actionId: string; userId: string },
  ) {
    const url = `https://example.com/v1/webhooks/slack/${connectionId}/${TOKEN}/interactivity`;
    const payload = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        api_app_id: "A1",
        team: { id: "T1" },
        user: { id: input.userId },
        channel: { id: "C1" },
        message: { ts: "9.9", thread_ts: "1.1" },
        actions: [{ action_id: input.actionId, value: approvalId }],
      }),
    }).toString();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`v0:${timestamp}:${payload}`),
      ),
    );
    const signature = `v0=${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    return SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: payload,
    });
  }

  async function settled(
    account: ReturnType<typeof env.ACCOUNTS.getByName>,
    id: string,
  ) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const approval = await account.getApproval(id);
      if (approval && approval.status !== "pending") return approval;
      await scheduler.wait(20);
    }
    throw new Error("the approval never settled");
  }

  /**
   * A click is answered on the card after the route has responded, so the
   * fetch stub sees the chat.update some time after `click` returns. Waits
   * for it to have been observed; a fixed wait here lost the race under
   * full-suite load.
   */
  async function cardUpdated(observed: () => boolean) {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (observed()) return;
      await scheduler.wait(20);
    }
    throw new Error("the card was never updated");
  }

  it("records a denial once, however many times Slack sends it", async () => {
    const account = await connectSlack("conn-deny");
    const approval = await propose(account, "conn-deny", "msg-deny");
    // Slack retries interactivity and people double-click. Two clicks must
    // not become two decisions.
    const first = await click("conn-deny", approval.id, {
      actionId: "opencomputer_approval_deny",
      userId: "U-BRIAN",
    });
    expect(first.status).toBe(200);
    const settledApproval = await settled(account, approval.id);
    expect(settledApproval.status).toBe("applied");
    expect(settledApproval.decidedBy).toBe("U-BRIAN");
    const decidedAt = settledApproval.decidedAt;

    await click("conn-deny", approval.id, {
      actionId: "opencomputer_approval_deny",
      userId: "U-BRIAN",
    });
    await scheduler.wait(100);
    // Same decision, same moment: the second click changed nothing.
    expect((await account.getApproval(approval.id))?.decidedAt).toBe(decidedAt);
  });

  it("sends the write the arguments that were on the card, and settles on the answer", async () => {
    await deployed();
    const account = await connectSlack("conn-apply");
    const approval = await propose(account, "conn-apply", "msg-apply");

    // Stand in for the session runtime.
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent-approvals@development" }),
      }),
    );
    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    if (welcome.type !== "runtime.welcome") throw new Error("no welcome");

    const dispatched = await env.SESSIONS.getByName(
      created.session.id,
    ).dispatchGatedTool({
      approvalId: approval.id,
      toolId: "attach",
      toolInput: { plan: "pro" },
      decision: {
        id: approval.id,
        decidedAt: "2026-09-10T00:00:00Z",
        decidedBy: "U-BRIAN",
      },
    });
    expect(dispatched).toEqual({ dispatched: true });

    const ask = await nextFrame<Record<string, unknown>>(
      runtime,
      (frame) => frame.type === "tool.apply",
      10_000,
    );
    // The exact arguments the human agreed to, with no model in between.
    expect(ask).toMatchObject({
      toolId: "attach",
      input: { plan: "pro" },
      decision: { decidedBy: "U-BRIAN" },
    });

    // Nothing was held open waiting: the answer settles the record whenever
    // it turns up.
    runtime.send(
      JSON.stringify({
        type: "tool.applied",
        epoch: welcome.epoch,
        applyId: approval.id,
        ok: true,
        result: { charged: "$240.00" },
      }),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const settledApproval = await account.getApproval(approval.id);
      if (settledApproval?.status === "applied") {
        expect(settledApproval.result).toEqual({ charged: "$240.00" });
        return;
      }
      await scheduler.wait(20);
    }
    throw new Error("the approval never settled");
  });

  it("runs a write that was waiting when the runtime finally connects", async () => {
    await deployed();
    const account = await connectSlack("conn-waits");
    const approval = await propose(account, "conn-waits", "msg-waits");
    await account.decideApproval({
      id: approval.id,
      choice: "approved",
      decidedBy: "U-BRIAN",
    });
    await account.beginApply(approval.id);

    // A decision that lands while the session is cold: the write is recorded
    // against the session and has to wait. Nothing else retries it — the sweep
    // only gives up — so if the runtime does not pick it up on connect, an
    // approved change silently never happens.
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent-approvals@development" }),
      }),
    );
    await account.recordApplyTarget(approval.id, created.session.id);

    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    const welcome = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    if (welcome.type !== "runtime.welcome") throw new Error("no welcome");
    runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));

    const ask = await nextFrame<Record<string, unknown>>(
      runtime,
      (frame) => frame.type === "tool.apply",
      10_000,
    );
    expect(ask).toMatchObject({
      toolId: "attach",
      input: { plan: "pro" },
      decision: { decidedBy: "U-BRIAN" },
    });
  });

  it("says it cannot confirm a write that never reported back", async () => {
    await deployed();
    const account = await connectSlack("conn-stuck");
    const approval = await propose(account, "conn-stuck", "msg-stuck");
    await account.recordApprovalMessage(approval.id, "66.6");
    await account.decideApproval({
      id: approval.id,
      choice: "approved",
      decidedBy: "U-BRIAN",
    });
    const claimed = await account.beginApply(approval.id);
    expect(claimed.started).toBe(true);

    // Pretend the dispatch went out long ago and nothing ever came back.
    await runInDurableObject(env.ACCOUNTS.getByName("local"), (_i, state) => {
      state.storage.sql.exec(
        "UPDATE approvals SET applying_at = ? WHERE id = ?",
        new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
        approval.id,
      );
    });
    await account.armApprovalExpiry();

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ ok: true, ts: "66.6" })) as unknown as typeof globalThis.fetch;
    try {
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
    } finally {
      globalThis.fetch = realFetch;
    }

    // Not "failed". The write may well have landed and simply not reported,
    // and a card reading "Failed" over a real charge is the worse lie.
    const swept = await account.getApproval(approval.id);
    expect(swept?.status).toBe("unknown");
    expect(swept?.error).toContain("may or may not have happened");
  });

  it("acknowledges the click before it starts the work", async () => {
    await deployed();
    const account = await connectSlack("conn-ack");
    const approval = await propose(account, "conn-ack", "msg-ack");
    await account.recordApprovalMessage(approval.id, "44.4");

    const updates: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      if (String(url).includes("chat.update")) updates.push(String(init.body));
      return Response.json({ ok: true, ts: "44.4" });
    }) as unknown as typeof globalThis.fetch;
    try {
      await click("conn-ack", approval.id, {
        actionId: "opencomputer_approval_approve",
        userId: "U-BRIAN",
      });
      await cardUpdated(() => updates.length > 0);
    } finally {
      globalThis.fetch = realFetch;
    }

    // Finding a runtime takes seconds. A card that sits unchanged through that
    // reads as a button that did nothing, so the first thing a click does is
    // say it landed — and take the buttons away so it cannot be pressed again.
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]).toContain("applying now");
    expect(updates[0]).not.toContain("opencomputer_approval_approve");
  });

  it("tells the agent what was decided, in the thread it asked in", async () => {
    await deployed();
    const account = await connectSlack("conn-told");
    // A session that is still around to be told.
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "agent-approvals@development" }),
      }),
    );
    const approval = await account.createApproval({
      agentId: "agent-approvals",
      alias: "development",
      deploymentId: `agent-approvals:${"b".repeat(64)}`,
      sessionId: created.session.id,
      toolId: "attach",
      toolInput: { plan: "pro" },
      preview: { title: "Move Acme to Pro" },
      connectionId: "conn-told",
      provider: "slack",
      deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
      deciderPrincipal: "U-BRIAN",
      idempotencyKey: "msg-told",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await click("conn-told", approval.id, {
      actionId: "opencomputer_approval_deny",
      userId: "U-BRIAN",
    });
    await settled(account, approval.id);

    // Without this the thread reads oddly: the agent asks, the card changes,
    // and it never acknowledges any of it.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = await env.SESSIONS.getByName(created.session.id).snapshot();
      const told = snapshot.turns.find((turn: { input: string }) =>
        turn.input.includes("did not approve"),
      );
      if (told) {
        expect(told.input).toContain("U-BRIAN");
        expect(told.input).toContain("Move Acme to Pro");
        // `channel` is required on a channel input. Sending one without it
        // crashed every agent that read it — which the type says is allowed —
        // and the failure surfaced to the customer as "could not complete
        // this request".
        const stored = await runInDurableObject(
          env.SESSIONS.getByName(created.session.id),
          (_instance, state) =>
            state.storage.sql
              .exec<{ input_json: string }>(
                "SELECT input_json FROM turns ORDER BY created_at DESC",
              )
              .toArray(),
        );
        const decision = stored
          .map((row) => JSON.parse(row.input_json) as Record<string, unknown>)
          .find((input) => String(input.text ?? "").includes("did not approve"));
        expect(decision?.channel).toMatchObject({
          provider: "slack",
          connectionId: "conn-told",
          userId: "U-BRIAN",
        });
        return;
      }
      await scheduler.wait(20);
    }
    throw new Error("the agent was never told");
  });

  it("closes out a card nobody ever answered", async () => {
    await deployed();
    const account = await connectSlack("conn-expire");
    const approval = await account.createApproval({
      agentId: "agent-approvals",
      alias: "development",
      deploymentId: `agent-approvals:${"b".repeat(64)}`,
      toolId: "attach",
      toolInput: { plan: "pro" },
      preview: { title: "Move Acme to Pro" },
      connectionId: "conn-expire",
      provider: "slack",
      deliveryRef: { channelId: "C1", threadTimestamp: "1.1" },
      deciderPrincipal: "U-BRIAN",
      idempotencyKey: "msg-expire",
      // Already past. Expiry was only ever checked on a click, so without a
      // sweep this sits pending and clickable forever.
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await account.recordApprovalMessage(approval.id, "55.5");
    await account.armApprovalExpiry();

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ ok: true, ts: "55.5" })) as unknown as typeof globalThis.fetch;
    try {
      await runDurableObjectAlarm(env.ACCOUNTS.getByName("local"));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect((await account.getApproval(approval.id))?.status).toBe("expired");
  });

  it("answers a click on a card that has already been decided", async () => {
    await deployed();
    const account = await connectSlack("conn-stale");
    const approval = await propose(account, "conn-stale", "msg-stale");
    await account.recordApprovalMessage(approval.id, "33.3");
    await account.decideApproval({
      id: approval.id,
      choice: "approved",
      decidedBy: "U-BRIAN",
    });
    await account.beginApply(approval.id);

    const updates: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      updates.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
      return Response.json({ ok: true, ts: "33.3" });
    }) as unknown as typeof globalThis.fetch;
    try {
      await click("conn-stale", approval.id, {
        actionId: "opencomputer_approval_approve",
        userId: "U-BRIAN",
      });
      await cardUpdated(() => updates.some((u) => String(u.url).includes("chat.update")));
    } finally {
      globalThis.fetch = realFetch;
    }

    // Silence here reads as the product being broken: the button stays live
    // and pressing it does nothing at all.
    const update = updates.find((u) => String(u.url).includes("chat.update"));
    expect(update).toBeDefined();
    expect(JSON.stringify(update!.body)).toContain("applying now");
    expect(JSON.stringify(update!.body)).not.toContain("opencomputer_approval_approve");
  });

  it("ignores a click from somebody the proposal was not made to", async () => {
    const account = await connectSlack("conn-bystander");
    const approval = await propose(account, "conn-bystander", "msg-bystander");
    // A Slack thread is visible to the whole channel; without this anyone
    // watching could approve somebody else's write.
    const response = await click("conn-bystander", approval.id, {
      actionId: "opencomputer_approval_approve",
      userId: "U-SOMEONE-ELSE",
    });
    expect(response.status).toBe(200);
    await scheduler.wait(100);
    expect((await account.getApproval(approval.id))?.status).toBe("pending");
  });

  it("refuses a click whose signature does not check out", async () => {
    await connectSlack("conn-forged");
    const url = `https://example.com/v1/webhooks/slack/conn-forged/${TOKEN}/interactivity`;
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
        "x-slack-signature": "v0=deadbeef",
      },
      body: new URLSearchParams({ payload: "{}" }).toString(),
    });
    expect(response.status).toBe(401);
  });

  it("passes over a button that is not ours", async () => {
    const account = await connectSlack("conn-other-button");
    const approval = await propose(account, "conn-other-button", "msg-other");
    // Every button in the workspace reaches this URL. An error here would
    // show the user a failure for something we do not own.
    const response = await click("conn-other-button", approval.id, {
      actionId: "some_other_app_button",
      userId: "U-BRIAN",
    });
    expect(response.status).toBe(200);
    await scheduler.wait(100);
    expect((await account.getApproval(approval.id))?.status).toBe("pending");
  });
});

describe("what a channel turn tells the agent", () => {
  /**
   * `structuredAgentInput` rebuilds its result from validated pieces rather
   * than spreading what it was given, so a field added on the write side is
   * silently dropped until the reader learns it too. This asserts on the frame
   * the runtime actually receives, which is the only place that is observable.
   */
  it("carries the channel identity through to the runtime", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "local/examples/hello-agent",
          deploymentId: "development",
        }),
      }),
    );
    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );

    const channel = {
      provider: "slack",
      connectionId: "conn-identity",
      workspaceId: "T-ACME",
      conversationId: "C-BILLING",
      userId: "U-BRIAN",
    };
    await env.SESSIONS.getByName(created.session.id).enqueueChannelTurn(
      {
        input: "who am I talking to",
        agentInput: {
          source: "channel",
          text: "who am I talking to",
          channel,
        },
        idempotencyKey: "slack:identity-1",
      },
      {
        provider: "slack",
        connectionId: "conn-identity",
        externalUserId: "U-BRIAN",
        deliveryRef: { channelId: "C-BILLING", threadTimestamp: "1.1" },
      },
    );

    const start = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start",
    );
    expect(start.type).toBe("turn.start");
    if (start.type !== "turn.start") return;
    expect(start.agentInput).toMatchObject({ source: "channel", channel });
  });

  it("keeps the first turn when a provider re-delivers an edited message under the same id; the public route still conflicts", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "local/examples/hello-agent",
          deploymentId: "development",
        }),
      }),
    );
    const stub = env.SESSIONS.getByName(created.session.id);
    const delivery = {
      provider: "slack",
      connectionId: "conn-edit",
      externalUserId: "U-EDIT",
      deliveryRef: { channelId: "C-EDIT", threadTimestamp: "1.1" },
    };
    const first = await stub.enqueueChannelTurn(
      {
        input: "ship it",
        agentInput: { source: "channel", text: "ship it" },
        idempotencyKey: "slack:msg-edit-1",
      },
      delivery,
    );
    expect(first.duplicate).toBe(false);
    // The same provider message, edited: another fingerprint under the key.
    // The channel keeps the prior behaviour, the first turn stands and the
    // edit is not admitted (work 029, O3 review point).
    const edited = await stub.enqueueChannelTurn(
      {
        input: "ship it now",
        agentInput: { source: "channel", text: "ship it now" },
        idempotencyKey: "slack:msg-edit-1",
      },
      delivery,
    );
    expect(edited).toMatchObject({ turnId: first.turnId, duplicate: true });
    const snapshot = await stub.snapshot();
    expect(snapshot.turns.map((turn: { id: string; input: string }) => [turn.id, turn.input])).toEqual([[first.turnId, "ship it"]]);

    // The public turns route keeps the contract: a reused key with other
    // input is 409 idempotency_conflict, even for the turn a channel admitted.
    const conflict = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "ship it now", idempotencyKey: "slack:msg-edit-1" }),
      },
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json<{ error: { code: string } }>()).error.code).toBe("idempotency_conflict");
    expect((await stub.snapshot()).turns).toHaveLength(1);
  });

  it("keeps a turn usable when the identity is malformed", async () => {
    const created = await json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "local/examples/hello-agent",
          deploymentId: "development",
        }),
      }),
    );
    const runtime = await connect(
      `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
    );
    await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "runtime.welcome",
    );
    await env.SESSIONS.getByName(created.session.id).enqueueChannelTurn(
      {
        input: "still say something",
        agentInput: {
          source: "channel",
          text: "still say something",
          // No connectionId: not enough to identify anyone.
          channel: { provider: "slack" },
        } as never,
        idempotencyKey: "slack:identity-2",
      },
      {
        provider: "slack",
        connectionId: "conn-identity-2",
        externalUserId: "U-2",
        deliveryRef: { channelId: "C", threadTimestamp: "1.1" },
      },
    );
    const start = await nextFrame<SessionToRuntimeFrame>(
      runtime,
      (frame) => frame.type === "turn.start",
    );
    if (start.type !== "turn.start") return;
    // The message still reaches the agent; it just arrives anonymous. Dropping
    // the turn because we could not name the sender would be worse.
    expect(start.agentInput).toMatchObject({ source: "channel" });
    expect(
      (start.agentInput as { channel?: unknown }).channel,
    ).toBeUndefined();
  });
});

describe("channel delivery addressing", () => {
  async function session(name: string) {
    const stub = env.SESSIONS.getByName(name);
    await stub.initialize({
      id: name,
      accountId: "local",
      userId: "user-1",
      agentId: "agent-1",
      deploymentId: `agent-1:${"a".repeat(64)}`,
    });
    return stub;
  }

  const readRow = (stub: ReturnType<typeof env.SESSIONS.getByName>) =>
    runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, string | null>>(
          "SELECT turn_id, channel_id, thread_timestamp, delivery_ref FROM slack_deliveries",
        )
        .toArray()[0]!,
    );

  it("addresses a reply from delivery_ref, not the legacy columns", async () => {
    const stub = await session("addressing-ref");
    await stub.enqueueSlackTurn(
      { input: "hi", idempotencyKey: "slack:A1" },
      {
        connectionId: "conn-1",
        channelId: "C-OLD",
        externalUserId: "U1",
        threadTimestamp: "1.1",
      },
    );
    // Diverge the two so the source of truth is observable.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE slack_deliveries SET delivery_ref = ?",
        JSON.stringify({ channelId: "C-NEW", threadTimestamp: "2.2" }),
      );
    });
    const row = await readRow(stub);
    expect(JSON.parse(row.delivery_ref!)).toEqual({
      channelId: "C-NEW",
      threadTimestamp: "2.2",
    });
    // The legacy columns still say the old thing; the resolver prefers the ref.
    expect(row.channel_id).toBe("C-OLD");
  });

  it("keeps the legacy columns intact as the fallback for a bad ref", async () => {
    const stub = await session("addressing-fallback");
    await stub.enqueueSlackTurn(
      { input: "hi", idempotencyKey: "slack:A2" },
      {
        connectionId: "conn-2",
        channelId: "C-FALLBACK",
        externalUserId: "U2",
        threadTimestamp: "3.3",
      },
    );
    for (const ref of [null, "{not json", JSON.stringify({ channelId: "C" })]) {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE slack_deliveries SET delivery_ref = ?",
          ref,
        );
      });
      const row = await readRow(stub);
      expect(row.channel_id).toBe("C-FALLBACK");
      expect(row.thread_timestamp).toBe("3.3");
    }
  });
});

describe("channel route storage", () => {
  const route = (connectionId: string, provider: string) => ({
    accountId: "local",
    connectionId,
    webhookTokenHash: `hash-${connectionId}`,
    provider,
  });

  it("holds a Slack and a Twilio connection on one account at once", async () => {
    // Each connection gets its own route object, named by provider and id, so
    // there is no single slot for them to contend over.
    const slack = env.ACCOUNTS.getByName("slack:conn-slack");
    const twilio = env.ACCOUNTS.getByName("twilio:conn-twilio");
    await slack.setChannelRoute(route("conn-slack", "slack"));
    await twilio.setChannelRoute(route("conn-twilio", "twilio"));

    await expect(slack.getChannelRoute()).resolves.toMatchObject({
      connectionId: "conn-slack",
      provider: "slack",
    });
    await expect(twilio.getChannelRoute()).resolves.toMatchObject({
      connectionId: "conn-twilio",
      provider: "twilio",
    });
  });

  it("resolves a route written before providers were named", async () => {
    const stub = env.ACCOUNTS.getByName("slack:conn-legacy");
    // Exactly what an older release wrote: the old key, no provider.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("slackRoute", {
        accountId: "local",
        connectionId: "conn-legacy",
        webhookTokenHash: "hash-legacy",
      });
    });
    await expect(stub.getChannelRoute()).resolves.toEqual({
      accountId: "local",
      connectionId: "conn-legacy",
      webhookTokenHash: "hash-legacy",
      provider: "slack",
    });
    // Reading migrates it forward, so the fallback is not paid twice.
    const migrated = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get("channelRoute"),
    );
    expect(migrated).toMatchObject({ provider: "slack" });
  });

  it("keeps writing the old key so a rollback still routes", async () => {
    const stub = env.ACCOUNTS.getByName("slack:conn-rollback");
    await stub.setChannelRoute(route("conn-rollback", "slack"));
    const legacy = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get("slackRoute"),
    );
    expect(legacy).toMatchObject({ connectionId: "conn-rollback" });
  });

  it("clears both keys, and only for the connection that owns the route", async () => {
    const stub = env.ACCOUNTS.getByName("slack:conn-clear");
    await stub.setChannelRoute(route("conn-clear", "slack"));
    await stub.clearChannelRoute("someone-else");
    await expect(stub.getChannelRoute()).resolves.toMatchObject({
      connectionId: "conn-clear",
    });
    await stub.clearChannelRoute("conn-clear");
    await expect(stub.getChannelRoute()).resolves.toBeNull();
    const remaining = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get("slackRoute"),
    );
    expect(remaining).toBeUndefined();
  });
});

describe("the Twilio doorbell", () => {
  const TOKEN = "twilio-webhook-token";
  const AUTH = "twilio-auth-token";

  async function connect(connectionId: string) {
    // The route lives in its own object, named by provider and connection.
    await env.ACCOUNTS.getByName(`twilio:${connectionId}`).setChannelRoute({
      accountId: "local",
      connectionId,
      webhookTokenHash: await sha256Hex(TOKEN),
      provider: "twilio",
    });
    // The credential lives on the account that owns the connection.
    await env.ACCOUNTS.getByName("local").createTwilioConnection({
      id: connectionId,
      agentId: "agent-1",
      alias: "development",
      accountSid: "AC1",
      authToken: AUTH,
      phoneNumber: "+15125550100",
    });
  }

  async function sha256Hex(value: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function signed(url: string, params: Record<string, string>) {
    const body = new URLSearchParams(params).toString();
    const message =
      url +
      Object.keys(params)
        .sort()
        .map((k) => `${k}${params[k]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(AUTH),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
    );
    return {
      body,
      signature: btoa(String.fromCharCode(...digest)),
    };
  }

  it("rejects a request with the wrong webhook token", async () => {
    await connect("conn-token");
    const url = "https://example.com/v1/webhooks/twilio/conn-token/wrong/sms";
    const response = await SELF.fetch(url, { method: "POST", body: "" });
    expect(response.status).toBe(401);
  });

  it("rejects a request Twilio did not sign", async () => {
    await connect("conn-sig");
    const url = `https://example.com/v1/webhooks/twilio/conn-sig/${TOKEN}/sms`;
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "not-a-signature",
      },
      body: new URLSearchParams({ From: "+1", To: "+2", Body: "hi" }).toString(),
    });
    expect(response.status).toBe(401);
  });

  it("answers a call with TwiML that records, rather than hanging up", async () => {
    await connect("conn-voice");
    const url = `https://example.com/v1/webhooks/twilio/conn-voice/${TOKEN}/voice`;
    const { body, signature } = await signed(url, {
      CallSid: "CA1",
      From: "+15125550147",
      To: "+15125550100",
    });
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    const twiml = await response.text();
    expect(twiml).toContain("<Say>");
    expect(twiml).toContain("<Record");
    // The recording has to come back to us, or the voicemail is lost.
    expect(twiml).toContain(`/${TOKEN}/recording`);
  });

  it("acknowledges a finished recording with TwiML, not JSON", async () => {
    await connect("conn-rec");
    const url = `https://example.com/v1/webhooks/twilio/conn-rec/${TOKEN}/recording`;
    const { body, signature } = await signed(url, {
      CallSid: "CA2",
      From: "+15125550147",
      To: "+15125550100",
      RecordingUrl: "https://api.twilio.com/rec/RE1",
      RecordingDuration: "14",
    });
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    expect(await response.text()).toContain("<Response/>");
  });

  it("takes a signed text message", async () => {
    await connect("conn-sms");
    const url = `https://example.com/v1/webhooks/twilio/conn-sms/${TOKEN}/sms`;
    const { body, signature } = await signed(url, {
      AccountSid: "AC1",
      MessageSid: "SM1",
      From: "+15125550147",
      To: "+15125550100",
      Body: "my water heater is leaking",
    });
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body,
    });
    expect(response.status).toBe(204);
  });

  it("does not ask Twilio to retry a status callback it cannot act on", async () => {
    await connect("conn-status");
    const url = `https://example.com/v1/webhooks/twilio/conn-status/${TOKEN}/sms`;
    const { body, signature } = await signed(url, {
      AccountSid: "AC1",
      MessageSid: "SM2",
      From: "+15125550147",
      To: "+15125550100",
      MessageStatus: "delivered",
    });
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body,
    });
    // A 4xx or 5xx here makes Twilio redeliver a callback forever.
    expect(response.status).toBe(204);
  });
});

describe("an inbound text becomes a turn", () => {
  const TOKEN = "twilio-webhook-token";
  const AUTH = "twilio-auth-token";
  const CALLER = "+15125550147";
  const SHOP = "+15125550100";

  async function hex(value: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function text(connectionId: string, body: string, messageSid: string) {
    const url = `https://example.com/v1/webhooks/twilio/${connectionId}/${TOKEN}/sms`;
    const params = {
      AccountSid: "AC1",
      MessageSid: messageSid,
      From: CALLER,
      To: SHOP,
      Body: body,
    };
    const payload = new URLSearchParams(params).toString();
    const message =
      url +
      Object.keys(params)
        .sort()
        .map((k) => `${k}${params[k as keyof typeof params]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(AUTH),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
    );
    return SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": btoa(String.fromCharCode(...digest)),
      },
      body: payload,
    });
  }

  async function connect(connectionId: string) {
    await env.ACCOUNTS.getByName(`twilio:${connectionId}`).setChannelRoute({
      accountId: "local",
      connectionId,
      webhookTokenHash: await hex(TOKEN),
      provider: "twilio",
    });
    const account = env.ACCOUNTS.getByName("local");
    await account.registerDeployment({
      agentId: "agent-1",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "artifacts",
        key: `${connectionId}.json`,
        digest: "b".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    await account.createTwilioConnection({
      id: connectionId,
      agentId: "agent-1",
      alias: "development",
      accountSid: "AC1",
      authToken: AUTH,
      phoneNumber: SHOP,
    });
  }

  /**
   * The turn is started after the response, because Twilio redelivers anything
   * it does not get a prompt 2xx for. So the binding appears a moment later.
   */
  /**
   * The binding is written before the first turn is queued, so waiting on it
   * alone can observe a session with no turns — which passes locally and fails
   * on a slower machine. Wait for the turns these assertions are about.
   */
  async function boundSession(connectionId: string, turns = 1) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const sessionId = await env.ACCOUNTS.getByName(
        "local",
      ).getChannelThreadSession(connectionId, CALLER);
      if (sessionId) {
        const snapshot = await env.SESSIONS.getByName(sessionId).snapshot();
        if (snapshot.turns.length >= turns) return sessionId;
      }
      await scheduler.wait(20);
    }
    throw new Error(`no session with ${String(turns)} turn(s) appeared`);
  }

  it("binds the caller's number to a session and queues what they said", async () => {
    await connect("conn-turn");
    expect((await text("conn-turn", "my water heater is leaking", "SM1")).status).toBe(204);

    // The conversation is keyed by the number, since a text has no thread.
    const sessionId = await boundSession("conn-turn");
    expect(sessionId).toBeTruthy();

    const snapshot = await env.SESSIONS.getByName(sessionId!).snapshot();
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]!.input).toContain("my water heater is leaking");

    // The reply address is stored so the answer goes back the way it came.
    const delivery = await runInDurableObject(
      env.SESSIONS.getByName(sessionId!),
      (_instance, state) =>
        state.storage.sql
          .exec<{ provider: string; delivery_ref: string }>(
            "SELECT provider, delivery_ref FROM slack_deliveries",
          )
          .toArray()[0]!,
    );
    expect(delivery.provider).toBe("twilio");
    expect(JSON.parse(delivery.delivery_ref)).toEqual({ to: CALLER, from: SHOP });

    // Who sent it, in Twilio's own terms. An agent behind one number ignores
    // this; an agent behind many reads its tenant off it.
    const stored = await runInDurableObject(
      env.SESSIONS.getByName(sessionId!),
      (_instance, state) =>
        state.storage.sql
          .exec<{ input_json: string }>("SELECT input_json FROM turns")
          .toArray()[0]!,
    );
    expect(JSON.parse(stored.input_json).channel).toEqual({
      provider: "twilio",
      connectionId: "conn-turn",
      workspaceId: "AC1",
      conversationId: SHOP,
      userId: CALLER,
    });
  });

  it("continues the same conversation on a second text", async () => {
    await connect("conn-continue");
    await text("conn-continue", "first", "SM10");
    const first = await boundSession("conn-continue");
    await text("conn-continue", "second", "SM11");
    const second = await boundSession("conn-continue", 2);
    // One conversation, not two: this is the whole point of a channel.
    expect(second).toBe(first);
    const snapshot = await env.SESSIONS.getByName(second!).snapshot();
    expect(snapshot.turns).toHaveLength(2);
  });

  it("does not start a second turn when Twilio redelivers the same message", async () => {
    await connect("conn-dupe");
    await text("conn-dupe", "hello", "SM20");
    const sessionId = await boundSession("conn-dupe");
    await text("conn-dupe", "hello", "SM20");
    await scheduler.wait(200);
    const snapshot = await env.SESSIONS.getByName(sessionId!).snapshot();
    expect(snapshot.turns).toHaveLength(1);
  });

  it("ignores a text for a number the connection does not own", async () => {
    await connect("conn-wrongnum");
    const url = `https://example.com/v1/webhooks/twilio/conn-wrongnum/${TOKEN}/sms`;
    const params = {
      AccountSid: "AC1",
      MessageSid: "SM30",
      From: CALLER,
      To: "+15125559999",
      Body: "hi",
    };
    const payload = new URLSearchParams(params).toString();
    const signed =
      url + Object.keys(params).sort().map((k) => `${k}${params[k as keyof typeof params]}`).join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(AUTH),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
    );
    const response = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": btoa(String.fromCharCode(...digest)),
      },
      body: payload,
    });
    expect(response.status).toBe(204);
    await expect(
      env.ACCOUNTS.getByName("local").getChannelThreadSession("conn-wrongnum", CALLER),
    ).resolves.toBeNull();
  });
});

describe("the reply goes back the way it came", () => {
  async function session(name: string, provider: string, ref: object) {
    const stub = env.SESSIONS.getByName(name);
    await stub.initialize({
      id: name,
      accountId: "local",
      userId: "user-1",
      agentId: "agent-1",
      deploymentId: `agent-1:${"a".repeat(64)}`,
    });
    await stub.enqueueChannelTurn(
      { input: "hi", idempotencyKey: `${provider}:E1` },
      {
        provider,
        connectionId: "conn-1",
        externalUserId: "U1",
        deliveryRef: ref,
      },
    );
    return stub;
  }

  it("stores the provider, so delivery knows which adapter to send through", async () => {
    const stub = await session("reply-twilio", "twilio", {
      to: "+15125550147",
      from: "+15125550100",
    });
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ provider: string; delivery_ref: string }>(
          "SELECT provider, delivery_ref FROM slack_deliveries",
        )
        .toArray()[0]!,
    );
    expect(row.provider).toBe("twilio");
    expect(JSON.parse(row.delivery_ref)).toEqual({
      to: "+15125550147",
      from: "+15125550100",
    });
  });

  it("shows no progress on a provider that cannot edit a sent message", async () => {
    const stub = await session("reply-noprogress", "twilio", {
      to: "+1512",
      from: "+1513",
    });
    // A text cannot be taken back, so there is no status to keep current.
    // Interim texts to somebody's phone would be worse than silence.
    const progress = await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as {
          progressForTurn(turnId: string, create?: boolean): unknown;
        }
      ).progressForTurn("any-turn", true),
    );
    expect(progress).toBeUndefined();
  });

  it("still shows progress on Slack, which can", async () => {
    const stub = await session("reply-progress", "slack", {
      channelId: "C1",
      threadTimestamp: "1.1",
    });
    const turnId = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ turn_id: string }>("SELECT turn_id FROM slack_deliveries")
        .toArray()[0]!.turn_id,
    );
    const progress = await runInDurableObject(stub, (instance) =>
      Boolean(
        (
          instance as unknown as {
            progressForTurn(turnId: string, create?: boolean): unknown;
          }
        ).progressForTurn(turnId, true),
      ),
    );
    expect(progress).toBe(true);
  });
});

describe("a voicemail and the texts after it are one conversation", () => {
  const TOKEN = "twilio-webhook-token";
  const AUTH = "twilio-auth-token";
  const CALLER = "+15125550147";
  const SHOP = "+15125550100";

  async function hex(value: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function post(path: string, params: Record<string, string>) {
    const url = `https://example.com/v1/webhooks/twilio/conn-vm/${TOKEN}/${path}`;
    const body = new URLSearchParams(params).toString();
    const signed =
      url +
      Object.keys(params)
        .sort()
        .map((k) => `${k}${params[k]}`)
        .join("");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(AUTH),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
    );
    return SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": btoa(String.fromCharCode(...digest)),
      },
      body,
    });
  }

  /**
   * The session is bound to the caller's number before its first turn is
   * queued, so waiting on the binding alone can observe a session with no
   * turns. Wait for the turn, which is what these assertions are about.
   */
  async function boundWithTurns(turns = 1) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = await env.ACCOUNTS.getByName("local").getChannelThreadSession(
        "conn-vm",
        CALLER,
      );
      if (id) {
        const snapshot = await env.SESSIONS.getByName(id).snapshot();
        if (snapshot.turns.length >= turns) return { id, snapshot };
      }
      await scheduler.wait(20);
    }
    throw new Error(`no session with ${String(turns)} turn(s) appeared`);
  }

  beforeEach(async () => {
    await env.ACCOUNTS.getByName("twilio:conn-vm").setChannelRoute({
      accountId: "local",
      connectionId: "conn-vm",
      webhookTokenHash: await hex(TOKEN),
      provider: "twilio",
    });
    const account = env.ACCOUNTS.getByName("local");
    await account.registerDeployment({
      agentId: "agent-1",
      alias: "development",
      channels: [],
      connections: [],
      artifact: {
        bucket: "artifacts",
        key: "vm.json",
        digest: "c".repeat(64),
        size: 10,
      },
      imageArn: "image",
      imageVersion: "1",
    });
    await account.createTwilioConnection({
      id: "conn-vm",
      agentId: "agent-1",
      alias: "development",
      accountSid: "AC1",
      authToken: AUTH,
      phoneNumber: SHOP,
    });
  });

  it("starts a session from a missed call, which a later text continues", async () => {
    // No AI binding in the test config, so transcription yields nothing — the
    // path that matters is that the lead survives anyway.
    const recording = await post("recording", {
      CallSid: "CA1",
      From: CALLER,
      To: SHOP,
      RecordingUrl: "https://api.twilio.com/rec/RE1",
      RecordingDuration: "18",
    });
    expect(recording.status).toBe(200);

    const { snapshot: afterCall } = await boundWithTurns(1);
    expect(afterCall.turns[0]!.input).toContain("Missed call from");

    // The text they send next is keyed on the same number, so it lands in the
    // session the voicemail opened rather than starting a second one.
    await post("sms", {
      AccountSid: "AC1",
      MessageSid: "SM1",
      From: CALLER,
      To: SHOP,
      Body: "1912 Cedar St",
    });
    const { snapshot: after } = await boundWithTurns(2);
    expect(after.turns[1]!.input).toContain("1912 Cedar St");
  });

  it("still reaches the shop when the caller hung up without speaking", async () => {
    const response = await post("recording", {
      CallSid: "CA2",
      From: CALLER,
      To: SHOP,
      RecordingDuration: "1",
    });
    expect(response.status).toBe(200);
    const { snapshot } = await boundWithTurns(1);
    expect(snapshot.turns[0]!.input).toContain("No message was left");
  });
});

describe("a Slack mention becomes a turn", () => {
  const SIGNING_SECRET = "a1b2c3d4".repeat(4)
  const TOKEN = "slack-webhook-token";

  async function hex(value: string) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /** Slack signs `v0:{timestamp}:{body}` — the body, never the URL. */
  async function slackSigned(body: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`v0:${timestamp}:${body}`),
      ),
    );
    return {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${[...digest]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`,
    };
  }

  function slackApiStub() {
    // Everything this path calls out to Slack for: proving the token on
    // connect, then posting progress and replies.
    vi.stubGlobal("fetch", async (url: string) =>
      Response.json(
        String(url).includes("auth.test")
          ? { ok: true, team_id: "T1", app_id: "A1", bot_id: "B1", user_id: "U0" }
          : { ok: true, ts: "1.1", channel: "C1" },
      ),
    );
  }

  async function connect(connectionId: string) {
    const account = env.ACCOUNTS.getByName("local");
    await account.registerDeployment({
      agentId: "reviewer",
      alias: "development",
      channels: [],
      connections: [],
      artifact: { bucket: "a", key: "s.json", digest: "d".repeat(64), size: 10 },
      imageArn: "image",
      imageVersion: "1",
    });
    await account.createSlackConnection({
      id: connectionId,
      agentId: "reviewer",
      alias: "development",
      appName: "Reviewer",
    });
    slackApiStub();
    await account.completeSlackConnection(
      connectionId,
      "xoxb-test-token",
      "A1",
      SIGNING_SECRET,
    );
    await env.ACCOUNTS.getByName(`slack:${connectionId}`).setChannelRoute({
      accountId: "local",
      connectionId,
      webhookTokenHash: await hex(TOKEN),
      provider: "slack",
    });
  }

  async function mention(connectionId: string, text: string, eventId: string, ts = "111.1") {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      api_app_id: "A1",
      team_id: "T1",
      event: {
        type: "app_mention",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts,
        text: `<@U0> ${text}`,
      },
    });
    return SELF.fetch(
      `https://example.com/v1/webhooks/slack/${connectionId}/${TOKEN}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await slackSigned(body)),
        },
        body,
      },
    );
  }

  /**
   * The binding is written before the first turn is queued (and admission
   * itself awaits the Account DO), so waiting on the binding alone can
   * observe a session with no turns. Wait for the turns these assertions
   * are about, as the other channel tests do.
   */
  async function bound(connectionId: string, key: string, turns = 1) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = await env.ACCOUNTS.getByName("local").getChannelThreadSession(
        connectionId,
        key,
      );
      if (id) {
        const snapshot = await env.SESSIONS.getByName(id).snapshot();
        if (snapshot.turns.length >= turns) return id;
      }
      await scheduler.wait(20);
    }
    throw new Error(`no session with ${String(turns)} turn(s) appeared for ${key}`);
  }

  afterEach(() => vi.unstubAllGlobals());

  it("keys the conversation by speaker and thread, as it always has", async () => {
    await connect("conn-slack");
    expect((await mention("conn-slack", "review this", "Ev1")).status).toBe(200);

    // The key existing conversations are bound under. A thread-wide key would
    // orphan every one of them and hand one person's session to another.
    const sessionId = await bound("conn-slack", "U1:111.1");
    expect(sessionId).toBeTruthy();

    const snapshot = await env.SESSIONS.getByName(sessionId!).snapshot();
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]!.input).toContain("review this");
    // The bot mention is stripped before the agent sees it.
    expect(snapshot.turns[0]!.input).not.toContain("<@U0>");
  });

  it("continues the same session for the same speaker in the same thread", async () => {
    await connect("conn-slack-2");
    await mention("conn-slack-2", "first", "Ev2");
    const first = await bound("conn-slack-2", "U1:111.1");
    await mention("conn-slack-2", "second", "Ev3");
    expect(await bound("conn-slack-2", "U1:111.1", 2)).toBe(first);
    const snapshot = await env.SESSIONS.getByName(first!).snapshot();
    expect(snapshot.turns).toHaveLength(2);
  });

  it("gives a second speaker in the same thread their own session", async () => {
    await connect("conn-slack-3");
    await mention("conn-slack-3", "mine", "Ev4");
    const mine = await bound("conn-slack-3", "U1:111.1");

    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev5",
      api_app_id: "A1",
      team_id: "T1",
      event: {
        type: "app_mention",
        channel: "C1",
        channel_type: "channel",
        user: "U2",
        ts: "222.2",
        thread_ts: "111.1",
        text: "<@U0> and mine",
      },
    });
    await SELF.fetch(
      `https://example.com/v1/webhooks/slack/conn-slack-3/${TOKEN}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(await slackSigned(body)) },
        body,
      },
    );
    const theirs = await bound("conn-slack-3", "U2:111.1");
    // Two people in one thread do not share agent state.
    expect(theirs).toBeTruthy();
    expect(theirs).not.toBe(mine);
  });

  it("acknowledges a still-running turn with a link to the session, once", async () => {
    await connect("conn-slack-ack");
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (init?.body) {
        posted.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return Response.json(
        String(url).includes("auth.test")
          ? { ok: true, team_id: "T1", app_id: "A1", bot_id: "B1", user_id: "U0" }
          : { ok: true, ts: "1.1", channel: "C1" },
      );
    });
    expect((await mention("conn-slack-ack", "review this", "EvAck")).status).toBe(
      200,
    );
    const sessionId = await bound("conn-slack-ack", "U1:111.1");
    const stub = env.SESSIONS.getByName(sessionId!);
    const acks = () =>
      posted.filter((body) => String(body.text ?? "").includes("On it"));

    // A turn past its grace — due or not — gets no ack once it is settled:
    // its answer is the acknowledgement. The alarm handler is invoked
    // directly: nothing else is armed, so there is no scheduled alarm to run.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE turns SET status = 'completed'");
      state.storage.sql.exec("UPDATE slack_deliveries SET ack_due_at_ms = 0");
    });
    await runInDurableObject(stub, (instance) =>
      (instance as SessionDurableObject).alarm(),
    );
    expect(acks()).toHaveLength(0);

    // The same slot coming due while the turn still runs posts the ack —
    // once, no matter how often the alarm fires.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE turns SET status = 'running'");
      state.storage.sql.exec("UPDATE slack_deliveries SET ack_due_at_ms = 0");
    });
    await runInDurableObject(stub, (instance) =>
      (instance as SessionDurableObject).alarm(),
    );
    expect(acks()).toHaveLength(1);
    expect(String(acks()[0]!.text)).toContain(`/sessions/${sessionId}`);
    await runInDurableObject(stub, (instance) =>
      (instance as SessionDurableObject).alarm(),
    );
    expect(acks()).toHaveLength(1);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("UPDATE turns SET status = 'completed'"),
    );

    // A redelivery of the same event is a duplicate admission and must not
    // post a second reply into the thread.
    expect((await mention("conn-slack-ack", "review this", "EvAck")).status).toBe(
      200,
    );
    await scheduler.wait(200);
    expect(acks()).toHaveLength(1);
  });

  it("refuses an event Slack did not sign", async () => {
    await connect("conn-slack-4");
    const response = await SELF.fetch(
      `https://example.com/v1/webhooks/slack/conn-slack-4/${TOKEN}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-slack-signature": "v0=deadbeef",
        },
        body: JSON.stringify({
          type: "event_callback",
          event_id: "Ev9",
          api_app_id: "A1",
          team_id: "T1",
          event: { type: "app_mention", channel: "C1", user: "U1", ts: "1.1", text: "hi" },
        }),
      },
    );
    expect(response.status).toBe(401);
  });
})

describe("an agent that says nothing sends nothing", () => {
  async function turnFor(name: string) {
    const stub = env.SESSIONS.getByName(name);
    await stub.initialize({
      id: name,
      accountId: "local",
      userId: "user-1",
      agentId: "agent-1",
      deploymentId: `agent-1:${"a".repeat(64)}`,
    });
    const turn = await stub.enqueueChannelTurn(
      { input: "stop texting me", idempotencyKey: `twilio:${name}` },
      {
        provider: "twilio",
        connectionId: "conn-1",
        externalUserId: "+15125550147",
        deliveryRef: { to: "+15125550147", from: "+15125550100" },
      },
    );
    return { stub, turnId: turn.turnId };
  }

  async function deliveryStatus(stub: DurableObjectStub, turnId: string) {
    return runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM slack_deliveries WHERE turn_id = ?",
          turnId,
        )
        .toArray()[0]!.status,
    );
  }

  it("marks the delivery done without sending, when the answer is empty", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      sent.push(String(url));
      return Response.json({ ok: true });
    });
    const { stub, turnId } = await turnFor("silent-turn");
    // A turn that completes with no message at all. Someone texted STOP; the
    // only correct reply is none.
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { deliverSlackTurn(id: string): Promise<void> }
      ).deliverSlackTurn(turnId),
    ).catch(() => undefined);
    expect(sent.filter((url) => url.includes("Messages.json"))).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("does not leave the delivery pending, so the alarm stops retrying it", async () => {
    const { stub, turnId } = await turnFor("silent-settled");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE turns SET status = 'completed' WHERE id = ?",
        turnId,
      );
    });
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { deliverSlackTurn(id: string): Promise<void> }
      ).deliverSlackTurn(turnId),
    ).catch(() => undefined);
    // Silence is a finished delivery, not a stuck one.
    await expect(deliveryStatus(stub, turnId)).resolves.toBe("delivered");
  });
})

describe("deploying a project that declares a Twilio channel", () => {
  function graph(channel: Record<string, unknown>) {
    return {
      id: "receptionist:preview",
      digest: "f".repeat(64),
      localAgentId: "receptionist",
      agents: [
        {
          localId: "receptionist",
          agentId: "receptionist",
          artifactDigest: "a".repeat(64),
        },
      ],
      resources: {
        version: 1,
        channels: [channel],
        channelRegistrations: [
          { agentId: "receptionist", channelId: "shop-sms", triggers: ["message"] },
        ],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [],
      },
    };
  }

  // The validator runs in the deployment endpoint, not the Durable Object, so
  // this has to go over HTTP the way the CLI does.
  const deploy = (agentId: string, channel: Record<string, unknown>) =>
    SELF.fetch("https://example.com/v1/deployments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId,
        alias: "development",
        channels: [],
        connections: [],
        projectDeployment: graph(channel),
        artifact: {
          bucket: "artifacts",
          key: `${agentId}.json`,
          digest: "e".repeat(64),
          size: 10,
        },
        imageArn: "image",
        imageVersion: "1",
      }),
    });

  it("accepts a Twilio channel, which declares no scopes", async () => {
    // This is what refused the real deployment: a runtime check that predates
    // the other providers and answers only "the agent request was invalid".
    const response = await deploy("receptionist", {
      id: "shop-sms",
      type: "twilio",
      displayName: "Customer calls and texts",
      events: ["message.inbound"],
      destinations: { reply: { type: "reply" } },
      routing: { whenAmbiguous: "ask" },
      idle: { suspendAfterSeconds: 120 },
    });
    expect(response.status).toBe(201);
  });

  it("still requires scopes on a Slack channel", async () => {
    const response = await deploy("scopeless", {
      id: "shop-sms",
      type: "slack",
      events: ["app_mention"],
      destinations: {},
    });
    expect(response.status).toBe(400);
  });

  it("refuses a provider the platform has no adapter for", async () => {
    const response = await deploy("pigeon", {
      id: "shop-sms",
      type: "carrier-pigeon",
      events: ["message.inbound"],
      destinations: {},
    });
    expect(response.status).toBe(400);
  });
})

describe("a channel session lets go of its runtime", () => {
  async function channelSession(name: string, idleSuspendSeconds?: number) {
    const stub = env.SESSIONS.getByName(name);
    await stub.initialize({
      id: name,
      accountId: "local",
      userId: "user-1",
      agentId: "agent-1",
      deploymentId: `agent-1:${"a".repeat(64)}`,
      source: "channel",
    });
    await stub.enqueueChannelTurn(
      { input: "hi", idempotencyKey: `twilio:${name}` },
      {
        provider: "twilio",
        connectionId: "conn-1",
        externalUserId: "+15125550147",
        deliveryRef: { to: "+15125550147", from: "+15125550100" },
        ...(idleSuspendSeconds ? { idleSuspendSeconds } : {}),
      },
    );
    return stub;
  }

  const stored = (stub: DurableObjectStub, key: string) =>
    runInDurableObject(stub, (_instance, state) => state.storage.get(key));

  it("remembers how long the channel says to wait", async () => {
    const stub = await channelSession("idle-remembers", 120);
    await expect(stored(stub, "channelIdleSeconds")).resolves.toBe(120);
  });

  it("holds on forever when the channel asks for no suspension", async () => {
    // Absent or zero means never let go — a session that should stay warm.
    const stub = await channelSession("idle-absent");
    await expect(stored(stub, "channelIdleSeconds")).resolves.toBeUndefined();
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { armChannelIdleSuspend(): Promise<void> }
      ).armChannelIdleSuspend(),
    );
    await expect(stored(stub, "channelIdleAtMs")).resolves.toBeUndefined();
  });

  it("sets a deadline that is in the future, not the past", async () => {
    const stub = await channelSession("idle-deadline", 60);
    const before = Date.now();
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { armChannelIdleSuspend(): Promise<void> }
      ).armChannelIdleSuspend(),
    );
    const at = (await stored(stub, "channelIdleAtMs")) as number;
    expect(at).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("leaves a session alone while its deadline has not passed", async () => {
    const stub = await channelSession("idle-early", 3600);
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { armChannelIdleSuspend(): Promise<void> }
      ).armChannelIdleSuspend(),
    );
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { suspendIfChannelIdle(): Promise<void> }
      ).suspendIfChannelIdle(),
    );
    // Still armed: nothing was suspended, so the deadline stands.
    await expect(stored(stub, "channelIdleAtMs")).resolves.toBeTruthy();
  });

  it("does not suspend a session with a turn still running", async () => {
    const stub = await channelSession("idle-running", 1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.put("channelIdleAtMs", Date.now() - 1000);
      state.storage.sql.exec("UPDATE session SET status = 'running'");
    });
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { suspendIfChannelIdle(): Promise<void> }
      ).suspendIfChannelIdle(),
    );
    // A turn in flight has to finish; the deadline is untouched.
    await expect(stored(stub, "channelIdleAtMs")).resolves.toBeTruthy();
  });

  it("lets go of a scheduled run's runtime once it goes idle", async () => {
    // Nobody talks to a scheduled run after its turn; held to the runtime's
    // lifetime, every run left a sandbox behind.
    const stub = env.SESSIONS.getByName("idle-schedule");
    await stub.initialize({
      id: "idle-schedule",
      accountId: "local",
      userId: "user-1",
      agentId: "agent-1",
      deploymentId: `agent-1:${"a".repeat(64)}`,
      source: "schedule",
    });
    const before = Date.now();
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { armChannelIdleSuspend(): Promise<void> }
      ).armChannelIdleSuspend(),
    );
    const at = (await stored(stub, "channelIdleAtMs")) as number;
    expect(at).toBeGreaterThanOrEqual(before + 300_000);
    expect(at).toBeLessThan(before + 301_000 + 60_000);
  });

  describe("the idle sandbox sweep", () => {
    async function sweptSession(name: string, sandboxId?: string) {
      const stub = env.SESSIONS.getByName(name);
      await stub.initialize({
        id: name,
        accountId: "local",
        userId: "user-1",
        agentId: "agent-1",
        deploymentId: `agent-1:${"a".repeat(64)}`,
        source: "schedule",
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE session SET execution_mode = 'microvm', status = 'idle'");
        if (sandboxId) {
          state.storage.sql.exec(
            `INSERT INTO microvm_binding (slot, microvm_id, state, updated_at)
             VALUES (1, ?, 'running', ?)`,
            sandboxId,
            new Date().toISOString(),
          );
        }
      });
      return stub;
    }

    it("arms the idle suspend a settled run never armed", async () => {
      const stub = await sweptSession("sweep-arm", "sb-arm");
      await expect(stub.sweepRuntime("sb-arm")).resolves.toEqual({
        verdict: "armed",
        accountId: "local",
      });
      await expect(stored(stub, "channelIdleAtMs")).resolves.toBeTruthy();
      // Armed once: the next sweep leaves the deadline to the alarm.
      await expect(stub.sweepRuntime("sb-arm")).resolves.toMatchObject({ verdict: "waiting" });
    });

    it("keeps the sandbox of a turn in flight", async () => {
      const stub = await sweptSession("sweep-busy", "sb-busy");
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE session SET status = 'running'");
      });
      await expect(stub.sweepRuntime("sb-busy")).resolves.toMatchObject({ verdict: "keep" });
      await expect(stored(stub, "channelIdleAtMs")).resolves.toBeUndefined();
    });

    it("calls a sandbox the session is not bound to an orphan", async () => {
      const stub = await sweptSession("sweep-moved", "sb-current");
      await expect(stub.sweepRuntime("sb-old")).resolves.toEqual({
        verdict: "orphan",
        accountId: "local",
      });
    });

    it("calls an ended session's sandbox an orphan", async () => {
      const stub = await sweptSession("sweep-ended", "sb-ended");
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE session SET status = 'ended'");
      });
      await expect(stub.sweepRuntime("sb-ended")).resolves.toMatchObject({ verdict: "orphan" });
    });

    it("leaves a Workerd session's sandboxes to its host", async () => {
      const stub = await sweptSession("sweep-workerd");
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE session SET execution_mode = 'workerd'");
      });
      await expect(stub.sweepRuntime("sb-tool")).resolves.toEqual({ verdict: "keep" });
    });
  });
})

describe("a turn wakes a suspended runtime", () => {
  async function suspendedSession(name: string, microvmState = "suspended") {
    const stub = env.SESSIONS.getByName(name);
    await stub.initialize({
      id: name,
      accountId: "local",
      userId: "user-1",
      agentId: "agent-1",
      deploymentId: `agent-1:${"a".repeat(64)}`,
      source: "api",
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE session SET execution_mode = 'microvm', status = 'suspended'");
      state.storage.sql.exec(
        `INSERT INTO microvm_binding (slot, microvm_id, state, updated_at)
         VALUES (1, ?, ?, ?)`,
        `vm-${name}`,
        microvmState,
        new Date().toISOString(),
      );
    });
    return stub;
  }

  const stored = (stub: DurableObjectStub, key: string) =>
    runInDurableObject(stub, (_instance, state) => state.storage.get(key));

  async function expireWake(stub: DurableObjectStub, attempts: number) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put({ runtimeWakeAttempts: attempts, runtimeWakeAtMs: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() - 1);
    });
    await runDurableObjectAlarm(stub);
  }

  it("starts a wake with a deadline when a turn queues behind a suspended runtime", async () => {
    const stub = await suspendedSession("wake-queued");
    const before = Date.now();
    await stub.enqueueTurn({ input: "hello again", idempotencyKey: "wake-queued-1" });
    await vi.waitFor(async () => expect(await stored(stub, "runtimeWakeAttempts")).toBe(1));
    const deadline = (await stored(stub, "runtimeWakeAtMs")) as number;
    expect(deadline).toBeGreaterThanOrEqual(before + 60_000);
    expect(deadline).toBeLessThan(before + 120_000);
  });

  it("leaves a runtime that is still starting alone", async () => {
    const stub = await suspendedSession("wake-starting", "running");
    await stub.enqueueTurn({ input: "hello", idempotencyKey: "wake-starting-1" });
    await expect(stored(stub, "runtimeWakeAttempts")).resolves.toBeUndefined();
  });

  it("tries the wake again when the runtime has not connected by the deadline", async () => {
    const stub = await suspendedSession("wake-retry");
    await stub.enqueueTurn({ input: "hello", idempotencyKey: "wake-retry-1" });
    await expireWake(stub, 1);
    await expect(stored(stub, "runtimeWakeAttempts")).resolves.toBe(2);
    expect((await stub.snapshot()).turns[0]?.status).toBe("queued");
  });

  it("fails the queued turn once the wakes are used up", async () => {
    const stub = await suspendedSession("wake-exhausted");
    await stub.enqueueTurn({ input: "hello", idempotencyKey: "wake-exhausted-1" });
    await expireWake(stub, 2);
    const snapshot = await stub.snapshot();
    expect(snapshot.turns[0]?.status).toBe("failed");
    expect(snapshot.status).toBe("idle");
    const failed = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ data: string }>("SELECT data FROM events WHERE type = 'turn.failed'")
        .toArray(),
    );
    expect(JSON.parse(failed[0]!.data)).toMatchObject({ code: "runtime_wake_failed" });
    await expect(stored(stub, "runtimeWakeAttempts")).resolves.toBeUndefined();
  });
});

describe("GitHub repositories and the credential environment", () => {
  const GITHUB_APP_ENVIRONMENT = [
    "OC_GITHUB_APP_ID",
    "OC_GITHUB_APP_SLUG",
    "OC_GITHUB_APP_PRIVATE_KEY",
    "OC_GITHUB_APP_CLIENT_ID",
    "OC_GITHUB_APP_CLIENT_SECRET",
  ] as const;

  /**
   * The Account object reads the App configuration from its bindings; the
   * test worker has none, so a key generated here is placed on the object's
   * environment for the test and removed after it.
   */
  async function configureGitHubApp(): Promise<void> {
    const key = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer,
    );
    let binary = "";
    for (const byte of pkcs8) binary += String.fromCharCode(byte);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
    await runInDurableObject(env.ACCOUNTS.getByName("local"), (instance) => {
      Object.assign((instance as unknown as { env: Record<string, string> }).env, {
        OC_GITHUB_APP_ID: "4242",
        OC_GITHUB_APP_SLUG: "opencomputer-test",
        OC_GITHUB_APP_PRIVATE_KEY: pem,
        OC_GITHUB_APP_CLIENT_ID: "client-id",
        OC_GITHUB_APP_CLIENT_SECRET: "client-secret",
      });
    });
  }

  async function installGitHub(
    projectId: string,
    attachments: Array<{ id: string; installationId: number; environment: "development" | "production" }>,
  ): Promise<void> {
    await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) => {
      const now = new Date().toISOString();
      for (const attachment of attachments) {
        state.storage.sql.exec(
          `INSERT INTO github_installations
             (id, github_installation_id, account_login, account_type,
              repository_selection, state, created_at, updated_at)
           VALUES (?, ?, 'octo-org', 'Organization', 'selected', 'active', ?, ?)`,
          attachment.id,
          attachment.installationId,
          now,
          now,
        );
        state.storage.sql.exec(
          `INSERT INTO github_attachments
             (project_id, environment, installation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          projectId,
          attachment.environment,
          attachment.id,
          now,
          now,
        );
      }
    });
  }

  interface GitHubRepositoryRow {
    id: number;
    full_name: string;
    private: boolean;
    default_branch: string;
    archived: boolean;
  }

  /**
   * A GitHub that mints installation tokens and lists what each installation
   * covers. Mints are counted and inspected so the test can say what the
   * token carried; the selection is mutable so a change shows on the next read.
   */
  function fakeGitHub(selection: Map<number, GitHubRepositoryRow[]>) {
    const mints: Array<{ installationId: number; permissions: Record<string, string> }> = [];
    let listingStatus = 200;
    let mintStatus = 201;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const mint = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (mint) {
        const installationId = Number(mint[1]);
        const body = JSON.parse(String(init?.body)) as { permissions: Record<string, string> };
        mints.push({ installationId, permissions: body.permissions });
        if (mintStatus !== 201) return new Response("mint failed", { status: mintStatus });
        return Response.json(
          {
            token: `token-${String(installationId)}-${String(mints.length)}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/installation/repositories") {
        if (listingStatus !== 200) return new Response("down", { status: listingStatus });
        const token = new Headers(init?.headers).get("authorization") ?? "";
        const installationId = Number(token.match(/^Bearer token-(\d+)-/)?.[1]);
        const repositories = selection.get(installationId) ?? [];
        const perPage = Number(url.searchParams.get("per_page"));
        const page = Number(url.searchParams.get("page"));
        return Response.json({
          total_count: repositories.length,
          repository_selection: "selected",
          repositories: repositories.slice((page - 1) * perPage, page * perPage),
        });
      }
      throw new Error(`Unexpected GitHub request: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      mints,
      fetchMock,
      failListing(status: number) {
        listingStatus = status;
      },
      failMint(status: number) {
        mintStatus = status;
      },
    };
  }

  function repository(id: number, name: string, extra: Partial<GitHubRepositoryRow> = {}): GitHubRepositoryRow {
    return {
      id,
      full_name: `octo-org/${name}`,
      private: true,
      default_branch: "main",
      archived: false,
      ...extra,
    };
  }

  beforeEach(configureGitHubApp);

  afterEach(async () => {
    await runInDurableObject(env.ACCOUNTS.getByName("local"), (instance) => {
      const bindings = (instance as unknown as { env: Record<string, string> }).env;
      for (const name of GITHUB_APP_ENVIRONMENT) delete bindings[name];
    });
  });

  it("reconciles a reinstalled GitHub App without changing project attachments", async () => {
    const project = await json<{ id: string }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Reinstalled", slug: "reinstalled" }),
      }),
    );
    const account = env.ACCOUNTS.getByName("local");
    await runInDurableObject(account, (_instance, state) => {
      const now = new Date().toISOString();
      state.storage.sql.exec(
        `INSERT INTO github_installations
           (id, github_installation_id, account_login, account_type,
            repository_selection, state, created_at, updated_at)
         VALUES ('ghi_attached', 100, 'octo-org', 'Organization', 'selected',
                 'active', ?, ?),
                ('ghi_duplicate', 200, 'octo-org', 'Organization', 'selected',
                 'active', ?, ?)`,
        now, now, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO github_attachments
           (project_id, environment, installation_id, created_at, updated_at)
         VALUES (?, 'development', 'ghi_attached', ?, ?)`,
        project.id, now, now,
      );
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "temporary-user-token" });
      }
      if (url === "https://api.github.com/user/installations?per_page=100") {
        return Response.json({
          total_count: 1,
          installations: [{
            id: 200,
            app_id: 4242,
            account: { id: 99, login: "octo-org", type: "Organization" },
            repository_selection: "selected",
            suspended_at: null,
          }],
        });
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }));

    await expect(account.bindGitHubInstallation({
      githubInstallationId: 200,
      code: "one-time-code",
    })).resolves.toMatchObject({
      id: "ghi_attached",
      githubInstallationId: 200,
      accountLogin: "octo-org",
      state: "active",
    });
    await expect(account.listGitHubInstallations()).resolves.toMatchObject([
      { id: "ghi_attached", githubInstallationId: 200 },
    ]);
    expect((await account.getGitHubStatus(project.id))[0]).toMatchObject({
      environment: "development",
      state: "active",
      installation: { id: "ghi_attached", githubInstallationId: 200 },
    });
  });

  it("marks an installation deleted when GitHub rejects its installation id", async () => {
    const project = await json<{ id: string }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Deleted install", slug: "deleted-install" }),
      }),
    );
    await installGitHub(project.id, [
      { id: "ghi_deleted", installationId: 404, environment: "development" },
    ]);
    const github = fakeGitHub(new Map());
    github.failMint(404);

    await expect(env.ACCOUNTS.getByName("local").mintGitHubToken({
      projectId: project.id,
      environment: "development",
      permissions: { contents: "read" },
    })).resolves.toMatchObject({
      outcome: "failed",
      code: "installation_not_found",
      retryable: false,
    });
    expect((await env.ACCOUNTS.getByName("local").getGitHubStatus(project.id))[0])
      .toMatchObject({
        environment: "development",
        state: "deleted",
        installation: { id: "ghi_deleted", state: "deleted" },
      });
  });

  it("lists the environment's installation repositories live from GitHub with a metadata-only token", async () => {
    const project = await json<{ id: string }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Repositories", slug: "repositories" }),
      }),
    );
    await installGitHub(project.id, [
      { id: "ghi_dev", installationId: 123, environment: "development" },
    ]);
    const selection = new Map<number, GitHubRepositoryRow[]>([
      [123, [
        repository(1, "service"),
        repository(2, "docs", { private: false, default_branch: "trunk", archived: true }),
      ]],
    ]);
    const github = fakeGitHub(selection);
    const route = `https://managedagents.test/v1/projects/${project.id}/github/repositories`;

    const listed = await json<{ repositories: unknown[]; nextCursor: string | null }>(
      await SELF.fetch(`${route}?environment=development`),
    );
    expect(listed).toEqual({
      repositories: [
        { id: 1, fullName: "octo-org/service", private: true, defaultBranch: "main", archived: false },
        { id: 2, fullName: "octo-org/docs", private: false, defaultBranch: "trunk", archived: true },
      ],
      nextCursor: null,
    });
    expect(github.mints).toEqual([{ installationId: 123, permissions: { metadata: "read" } }]);

    // The selection changes in GitHub; the next read reflects it and mints again.
    selection.set(123, [repository(1, "service"), repository(3, "new-service")]);
    const changed = await json<{ repositories: Array<{ fullName: string }> }>(
      await SELF.fetch(`${route}?environment=development`),
    );
    expect(changed.repositories.map((entry) => entry.fullName)).toEqual([
      "octo-org/service",
      "octo-org/new-service",
    ]);
    expect(github.mints).toHaveLength(2);

    // Paging past one hundred: a page is at most 100 and the cursor is GitHub's next page.
    selection.set(
      123,
      Array.from({ length: 150 }, (_, index) => repository(index + 1, `repo-${String(index + 1)}`)),
    );
    const first = await json<{ repositories: Array<{ id: number }>; nextCursor: string | null }>(
      await SELF.fetch(`${route}?environment=development&limit=100`),
    );
    expect(first.repositories).toHaveLength(100);
    expect(first.nextCursor).toBe("2");
    const second = await json<{ repositories: Array<{ id: number }>; nextCursor: string | null }>(
      await SELF.fetch(`${route}?environment=development&limit=100&cursor=${first.nextCursor}`),
    );
    expect(second.repositories).toHaveLength(50);
    expect(second.repositories[0]!.id).toBe(101);
    expect(second.nextCursor).toBeNull();
    const listingUrls = github.fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/installation/repositories"));
    expect(listingUrls.at(-2)).toContain("per_page=100&page=1");
    expect(listingUrls.at(-1)).toContain("per_page=100&page=2");

    // Nothing about the listing is persisted: the status route still knows only the attachment.
    const status = await json<{ environments: Array<Record<string, unknown>> }>(
      await SELF.fetch(`https://managedagents.test/v1/projects/${project.id}/github`),
    );
    expect(JSON.stringify(status)).not.toContain("repo-1");

    // The environment without an installation.
    const missing = await SELF.fetch(`${route}?environment=production`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "github_connection_not_found" },
    });

    // Query validation.
    for (const [query, code] of [
      ["", "invalid_environment"],
      ["environment=staging", "invalid_environment"],
      ["environment=development&limit=101", "invalid_limit"],
      ["environment=development&limit=0", "invalid_limit"],
      ["environment=development&cursor=page-two", "invalid_cursor"],
    ] as const) {
      const invalid = await SELF.fetch(`${route}?${query}`);
      expect(invalid.status, query).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ error: { code } });
    }
    const write = await SELF.fetch(`${route}?environment=development`, { method: "POST" });
    expect(write.status).toBe(405);

    // GitHub failing on the listing, and on the mint.
    github.failListing(503);
    const down = await SELF.fetch(`${route}?environment=development`);
    expect(down.status).toBe(502);
    await expect(down.json()).resolves.toMatchObject({ error: { code: "github_unavailable" } });
    github.failListing(200);
    github.failMint(500);
    const mintDown = await SELF.fetch(`${route}?environment=development`);
    expect(mintDown.status).toBe(502);
    await expect(mintDown.json()).resolves.toMatchObject({ error: { code: "github_unavailable" } });
  });

  it("hands each session the credentials of its own environment when one artifact is promoted to both", async () => {
    const project = await json<{ id: string; agents: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Promoted", slug: "promoted" }),
      }),
    );
    const agentId = project.agents[0]!.id;
    const artifact = {
      bucket: "managed-agent-artifacts",
      key: "agents/promoted/digest.json",
      digest: "d".repeat(64),
      size: 512,
    };
    const register = (alias: "development" | "production") =>
      SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          alias,
          connections: ["github"],
          githubConnections: [
            {
              id: "github",
              provider: {
                kind: "github-app",
                permissions: { contents: "write", metadata: "read" },
              },
            },
          ],
          artifact,
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      });
    const deployment = await json<AgentDeployment>(await register("development"));
    const promoted = await json<AgentDeployment>(await register("production"));
    expect(promoted.id).toBe(deployment.id);
    // The row keeps the alias it was first registered with; both aliases
    // point at it. The alias-derived rule would read every session of this
    // artifact as development.
    const account = env.ACCOUNTS.getByName("local");
    await expect(account.getDeployment(deployment.id)).resolves.toMatchObject({
      alias: "development",
    });
    await expect(account.resolveDeployment(`${agentId}@production`)).resolves.toMatchObject({
      id: deployment.id,
    });

    await installGitHub(project.id, [
      { id: "ghi_dev", installationId: 111, environment: "development" },
      { id: "ghi_prod", installationId: 222, environment: "production" },
    ]);
    for (const [environment, value] of [
      ["development", "dev-target"],
      ["production", "prod-target"],
    ] as const) {
      const set = await SELF.fetch(
        `https://managedagents.test/v1/projects/${project.id}/runtime-variables/TARGET`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value, environment }),
        },
      );
      expect(set.status).toBe(200);
    }
    const github = fakeGitHub(new Map());

    const sessions = new Map<"development" | "production", InitializeSessionResult>();
    for (const environment of ["development", "production"] as const) {
      sessions.set(
        environment,
        await json<InitializeSessionResult>(
          await SELF.fetch("https://managedagents.test/v1/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentId: `${agentId}@${environment}` }),
          }),
        ),
      );
    }
    for (const [environment, session] of sessions) {
      expect(session.session.deploymentId).toBe(deployment.id);
      expect(session.session.environment).toBe(environment);
      const resolved = await json<{
        variables: Record<string, string>;
        github: { expiresAt: string };
      }>(
        await SELF.fetch(
          `https://managedagents.test/v1/sessions/${session.session.id}/runtime-variables`,
          { headers: { authorization: `Bearer ${session.runtimeToken}` } },
        ),
      );
      const installationId = environment === "development" ? 111 : 222;
      expect(resolved.variables.TARGET).toBe(
        environment === "development" ? "dev-target" : "prod-target",
      );
      expect(resolved.variables.GH_TOKEN).toMatch(new RegExp(`^token-${String(installationId)}-`));
      expect(resolved.variables.GITHUB_TOKEN).toBe(resolved.variables.GH_TOKEN);
      expect(Date.parse(resolved.github.expiresAt)).toBeGreaterThan(Date.now());
    }
    expect(github.mints.map((mint) => mint.installationId)).toEqual([111, 222]);
    expect(github.mints[0]!.permissions).toEqual({ contents: "write", metadata: "read" });

    // Logs the production session ships are filed under production, not the row's alias.
    const production = sessions.get("production")!;
    const shipped = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${production.session.id}/runtime-logs`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${production.runtimeToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          entries: [{ level: "info", stream: "stdout", message: "pushed to the production installation" }],
        }),
      },
    );
    expect(shipped.status).toBe(202);
    const productionLogs = await json<{ logs: Array<{ event: string; sessionId?: string }> }>(
      await SELF.fetch(
        `https://managedagents.test/v1/logs?agentId=${agentId}&environment=production`,
      ),
    );
    expect(productionLogs.logs.some((entry) => entry.event === "runtime.log")).toBe(true);
    const developmentLogs = await json<{ logs: Array<{ event: string }> }>(
      await SELF.fetch(
        `https://managedagents.test/v1/logs?agentId=${agentId}&environment=development`,
      ),
    );
    expect(developmentLogs.logs.some((entry) => entry.event === "runtime.log")).toBe(false);
  });
});

describe("workspace artifacts", () => {
  async function createSession(): Promise<InitializeSessionResult> {
    return json<InitializeSessionResult>(
      await SELF.fetch("https://managedagents.test/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "local/examples/hello-agent", deploymentId: "development" }),
      }),
    );
  }

  const sha = "a".repeat(64);
  const receipt = {
    bucket: "artifacts",
    key: "accounts/local/sessions/s/workspace-artifacts/x",
    etag: '"etag"',
    sourceEtag: '"src"',
    sourceVersionId: null,
  };
  const retained = (path: string, size = 12, sha256 = sha) => ({
    path,
    size,
    sha256,
    mediaType: "application/octet-stream",
    snapshotId: '"src"',
    receipt,
  });

  async function exportWithKey(sessionId: string, key: string | null, body: Record<string, unknown>) {
    return SELF.fetch(`https://managedagents.test/v1/sessions/${sessionId}/workspace/exports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });
  }

  it("keeps one manifest per (path, sha256) so a second export of the same snapshot converges on the same artifact id", async () => {
    const created = await createSession();
    const stub = env.SESSIONS.getByName(created.session.id);
    const begin = async (key: string | null) =>
      stub.beginWorkspaceExport({ idempotencyKey: key, requestDigest: "d".repeat(64), path: "evidence/capture.har", expected: null });
    const first = await begin("k1");
    expect(first.outcome).toBe("created");
    expect(first.export).toMatchObject({
      id: expect.stringMatching(/^wsexp_[a-f0-9]{32}$/),
      state: "snapshotting",
      idempotencyKey: "k1",
      artifactId: null,
      error: null,
      completedAt: null,
      projectId: expect.any(String),
      deploymentId: "development",
    });
    const done = await stub.completeWorkspaceExport(first.export.id, retained("evidence/capture.har"));
    expect(done.artifact.id).toMatch(/^wsart_[a-f0-9]{32}$/);
    expect(done.artifact).toMatchObject({
      exportId: first.export.id,
      mediaType: "application/octet-stream",
      snapshotId: '"src"',
      retention: { policy: "until_deleted", expiresAt: null },
    });
    expect(done.export).toMatchObject({ state: "delivered", artifactId: done.artifact.id, completedAt: expect.any(String) });

    const second = await begin("k2");
    expect(second.outcome).toBe("created");
    const again = await stub.completeWorkspaceExport(second.export.id, retained("evidence/capture.har"));
    expect(again.artifact).toEqual(done.artifact);
    expect(again.export.id).not.toBe(first.export.id);

    const third = await begin(null);
    const changed = await stub.completeWorkspaceExport(third.export.id, retained("evidence/capture.har", 13, "b".repeat(64)));
    expect(changed.artifact.id).not.toBe(done.artifact.id);
    expect((await stub.listWorkspaceArtifacts()).map((artifact: { id: string }) => artifact.id).sort()).toEqual(
      [done.artifact.id, changed.artifact.id].sort(),
    );
    expect((await stub.listWorkspaceExports()).map((record: { id: string }) => record.id).sort()).toEqual(
      [first.export.id, second.export.id, third.export.id].sort(),
    );
    expect(await stub.getWorkspaceArtifact(done.artifact.id)).toEqual(done.artifact);
    expect(await stub.getWorkspaceArtifact("wsart_missing")).toBeNull();
    expect(await stub.getWorkspaceExport(first.export.id)).toEqual({ export: done.export, artifact: done.artifact });
  });

  it("replays a repeated Idempotency-Key, refuses a reused one and never rewrites a terminal export", async () => {
    const created = await createSession();
    const stub = env.SESSIONS.getByName(created.session.id);
    const request = { idempotencyKey: "key", requestDigest: "1".repeat(64), path: "out.txt", expected: { bytes: 3 } };
    const first = await stub.beginWorkspaceExport(request);
    const inFlight = await stub.beginWorkspaceExport(request);
    expect(inFlight).toEqual({ export: first.export, artifact: null, outcome: "in_flight" });

    const transient = await stub.failWorkspaceExport(first.export.id, { code: "workspace_unavailable", message: "later", retrySafe: true });
    expect(transient.state).toBe("failed");
    const redriven = await stub.beginWorkspaceExport(request);
    expect(redriven.outcome).toBe("created");
    expect(redriven.export).toMatchObject({ id: first.export.id, state: "snapshotting", error: null, completedAt: null });

    const failed = await stub.failWorkspaceExport(first.export.id, { code: "artifact_not_found", message: "gone", retrySafe: false });
    expect(failed).toMatchObject({ state: "failed", error: { code: "artifact_not_found", retrySafe: false } });
    const replayed = await stub.beginWorkspaceExport(request);
    expect(replayed).toEqual({ export: failed, artifact: null, outcome: "replayed" });
    // A settled export is final: a late completion is refused and records nothing.
    const late = await stub.completeWorkspaceExport(first.export.id, retained("out.txt", 3)).then(
      () => "completed",
      (error: Error) => error.message,
    );
    expect(late).toMatch(/already failed/);
    expect((await stub.getWorkspaceExport(first.export.id))?.export).toEqual(failed);
    expect(await stub.listWorkspaceArtifacts()).toEqual([]);

    const { events } = await json<{ events: Array<{ type: string; data: Record<string, unknown> }> }>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/events`),
    );
    const lifecycle = events.filter((event) => event.type.startsWith("artifact.export."));
    expect(lifecycle.map((event) => event.type)).toEqual([
      "artifact.export.started",
      "artifact.export.failed",
      "artifact.export.started",
      "artifact.export.failed",
    ]);
    expect(lifecycle[3]?.data).toEqual({
      exportId: first.export.id,
      path: "out.txt",
      error: { code: "artifact_not_found", retrySafe: false },
    });
  });

  it("expires an export left snapshotting past its deadline instead of replaying it forever", async () => {
    const created = await createSession();
    const stub = env.SESSIONS.getByName(created.session.id);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const request = { idempotencyKey: "slow", requestDigest: "3".repeat(64), path: "a.bin", expected: null };
      const first = await stub.beginWorkspaceExport(request);
      vi.setSystemTime(new Date("2026-01-01T00:16:00Z"));
      const later = await stub.beginWorkspaceExport(request);
      expect(later.outcome).toBe("replayed");
      expect(later.export).toMatchObject({ id: first.export.id, state: "expired", error: { code: "export_expired", retrySafe: false } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains manifests after the session ends and serves them over the session API", async () => {
    const created = await createSession();
    const stub = env.SESSIONS.getByName(created.session.id);
    const begun = await stub.beginWorkspaceExport({ idempotencyKey: null, requestDigest: "4".repeat(64), path: "shots/1.png", expected: null });
    const { artifact, export: record } = await stub.completeWorkspaceExport(begun.export.id, retained("shots/1.png", 5));
    expect((await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/end`, { method: "POST" })).status).toBe(200);

    const listed = await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ artifacts: [artifact], exports: [record] });

    const one = await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports/${artifact.id}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ artifact });

    const exported = await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports/${record.id}`);
    expect(exported.status).toBe(200);
    expect(await exported.json()).toEqual({ export: record, artifact });

    const missing = await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports/wsart_nope`);
    expect(missing.status).toBe(404);
    expect((await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports/wsexp_nope`)).status).toBe(404);
  });

  it("rejects unsafe export paths and malformed expectations before contacting the platform", async () => {
    const created = await createSession();
    for (const path of ["../etc/passwd", "/etc/passwd", ".git/config", "a\\b", 7]) {
      const response = await exportWithKey(created.session.id, null, { path });
      expect(response.status, String(path)).toBe(400);
      expect((await response.json<{ error: { code: string; retrySafe: boolean } }>()).error).toMatchObject({
        code: "artifact_path_invalid",
        retrySafe: false,
      });
    }
    const malformed = await exportWithKey(created.session.id, null, { path: "ok.txt", expected: { sha256: "nope" } });
    expect(malformed.status).toBe(400);
    expect((await malformed.json<{ error: { code: string } }>()).error.code).toBe("artifact_path_invalid");
    const longKey = await exportWithKey(created.session.id, "k".repeat(257), { path: "ok.txt" });
    expect(longKey.status).toBe(400);
    expect((await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports`).then((r) => r.json())) as object).toEqual({
      artifacts: [],
      exports: [],
    });
  });

  it("records a failed export with a retry-safe code when no runtime service is bound, and replays it under the same key", async () => {
    const created = await createSession();
    const first = await exportWithKey(created.session.id, "same", { path: "ok.txt", expected: { bytes: 3 } });
    expect(first.status).toBe(503);
    const body = await first.json<{ error: { code: string; retrySafe: boolean; exportId: string } }>();
    expect(body.error).toMatchObject({ code: "workspace_unavailable", retrySafe: true, exportId: expect.stringMatching(/^wsexp_/) });

    const replay = await exportWithKey(created.session.id, "same", { expected: { bytes: 3 }, path: "/workspace/ok.txt" });
    expect(replay.status).toBe(503);
    expect((await replay.json<{ error: { exportId: string } }>()).error.exportId).toBe(body.error.exportId);

    const conflict = await exportWithKey(created.session.id, "same", { path: "other.txt" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json<{ error: { code: string } }>()).error.code).toBe("export_idempotency_conflict");

    const record = await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports/${body.error.exportId}`);
    expect(await record.json()).toMatchObject({
      export: { state: "failed", idempotencyKey: "same", expected: { bytes: 3 }, error: { code: "workspace_unavailable" } },
      artifact: null,
    });
  });

  it("answers artifact downloads with 503 when no runtime service is bound instead of leaking bytes", async () => {
    const created = await createSession();
    const stub = env.SESSIONS.getByName(created.session.id);
    const begun = await stub.beginWorkspaceExport({ idempotencyKey: null, requestDigest: "5".repeat(64), path: "out.txt", expected: null });
    const { artifact } = await stub.completeWorkspaceExport(begun.export.id, retained("out.txt", 3));
    const content = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports/${artifact.id}/content`,
    );
    expect(content.status).toBe(503);
    expect((await content.json<{ error: { code: string } }>()).error.code).toBe("workspace_unavailable");
    const download = await SELF.fetch(
      `https://managedagents.test/v1/sessions/${created.session.id}/workspace/exports/${artifact.id}/download`,
    );
    expect(download.status).toBe(503);
    expect((await download.json<{ error: { code: string } }>()).error.code).toBe("workspace_unavailable");
  });
});

describe("public template inspection", () => {
  it("answers anonymous inspection requests without account auth", async () => {
    const response = await SELF.fetch(
      "https://managedagents.test/v1/public/template-inspections",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryUrl: "not-a-repository" }),
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
      "invalid_template_repository",
    );
  });
});
