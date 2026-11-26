import { env, SELF, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgentDeployment,
  AgentEvent,
  InitializeSessionResult,
  SessionSnapshot,
  SessionToRuntimeFrame,
  ToolInvocationIdentity,
} from "../src/protocol.js";
import { hostToolCallId } from "../src/tool-identity.js";

/**
 * The host-assigned identity on durable tool events (runtime-attested tool
 * identity, MVP). The Session object stamps every `tool.*` event with the
 * tuple it resolved from its own row (project, environment, canonical
 * agent, pinned deployment, session), the turn it admitted, and the message
 * and call the runtime host reported; whatever a runtime, or the model
 * behind it, put under `identity` is discarded first.
 */

afterEach(async () => {
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

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function connect(path: string): Promise<WebSocket> {
  const response = await SELF.fetch(`https://managedagents.test${path}`, {
    headers: { upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  const inbox: unknown[] = [];
  inboxes.set(socket, inbox);
  socket.addEventListener("message", (message) => {
    inbox.push(JSON.parse(String(message.data)) as unknown);
  });
  socket.accept();
  return socket;
}

function nextFrame<T>(socket: WebSocket, predicate: (frame: T) => boolean, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const inbox = inboxes.get(socket)!;
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      const index = inbox.findIndex((frame) => predicate(frame as T));
      if (index >= 0) {
        resolve(inbox.splice(index, 1)[0] as T);
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

const forged = {
  projectId: "prj_forged",
  environment: "production",
  agentId: "agent_forged",
  deploymentId: "dep_forged",
  sessionId: "ses_forged",
  turnId: "turn_forged",
  messageId: "msg_forged",
  toolCallId: "call_forged",
};

async function sessionWithRuntime(
  creation: Record<string, unknown> = { agentId: "local/examples/hello-agent", deploymentId: "development" },
): Promise<{
  created: InitializeSessionResult;
  runtime: WebSocket;
  epoch: number;
  turn: (input: string, key: string) => Promise<string>;
  batch: (turnId: string, frameId: string, events: Array<{ type: string; data: Record<string, unknown> }>) => void;
  events: () => Promise<AgentEvent[]>;
}> {
  const created = await json<InitializeSessionResult>(
    await SELF.fetch("https://managedagents.test/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(creation),
    }),
  );
  const runtime = await connect(
    `/v1/sessions/${created.session.id}/connect?role=runtime&token=${created.runtimeToken}`,
  );
  const welcome = await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "runtime.welcome");
  if (welcome.type !== "runtime.welcome") throw new Error("no welcome");
  runtime.send(JSON.stringify({ type: "model.configuration.request", epoch: welcome.epoch }));
  await nextFrame<SessionToRuntimeFrame>(runtime, (frame) => frame.type === "model.configuration");
  runtime.send(JSON.stringify({ type: "runtime.ready", epoch: welcome.epoch }));
  return {
    created,
    runtime,
    epoch: welcome.epoch,
    turn: async (input, idempotencyKey) => {
      const admitted = await json<{ turnId: string }>(
        await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/turns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, idempotencyKey }),
        }),
      );
      await nextFrame<SessionToRuntimeFrame>(
        runtime,
        (frame) => frame.type === "turn.start" && frame.turnId === admitted.turnId,
      );
      return admitted.turnId;
    },
    batch: (turnId, frameId, events) => {
      runtime.send(JSON.stringify({ type: "event.batch", epoch: welcome.epoch, frameId, turnId, events }));
    },
    events: async () => {
      await nextFrame<SessionToRuntimeFrame>(runtime, () => false, 20).catch(() => undefined);
      return (
        await json<{ events: AgentEvent[] }>(
          await SELF.fetch(`https://managedagents.test/v1/sessions/${created.session.id}/events`),
        )
      ).events;
    },
  };
}

function hostIdentity(sessionId: string, turnId: string, messageId: string, providerCallId: string): ToolInvocationIdentity {
  return {
    projectId: "project:local/examples/hello-agent",
    environment: "development",
    agentId: "local/examples/hello-agent",
    deploymentId: "development",
    sessionId,
    turnId,
    messageId,
    providerCallId,
    toolCallId: hostToolCallId({ sessionId, turnId, messageId, providerCallId }),
  };
}

describe("the host identity on durable tool events", () => {
  it("stamps the same tuple on started, progress, completed and failed, and discards the one the runtime sent (acceptance 1, 5)", async () => {
    const session = await sessionWithRuntime();
    const turnId = await session.turn("call two tools", "identity-1");
    // Every frame carries a forged `identity` and forged top-level ids as
    // the model might have echoed them; only `messageId` is the host's.
    session.batch(turnId, "frame-1", [
      { type: "tool.started", data: { callId: "call-a", tool: "lookup", title: "lookup", input: { q: "x", identity: forged, turnId: "turn_forged" }, messageId: "msg-1", identity: forged } },
      { type: "tool.progress", data: { callId: "call-a", tool: "lookup", stage: "fetching", messageId: "msg-1", identity: forged } },
      { type: "tool.completed", data: { callId: "call-a", tool: "lookup", title: "lookup", output: "found", messageId: "msg-1", identity: forged } },
      { type: "tool.started", data: { callId: "call-b", tool: "shell", title: "shell", input: {}, messageId: "msg-1", identity: forged } },
      { type: "tool.failed", data: { callId: "call-b", tool: "shell", title: "shell", message: "exploded", messageId: "msg-1", identity: forged } },
    ]);
    const events = (await session.events()).filter((event) => event.type.startsWith("tool."));
    expect(events.map((event) => event.type)).toEqual([
      "tool.started",
      "tool.progress",
      "tool.completed",
      "tool.started",
      "tool.failed",
    ]);
    for (const event of events) {
      const callId = String(event.data.callId);
      expect(event.data.identity).toEqual(hostIdentity(session.created.session.id, turnId, "msg-1", callId));
      // The host field is folded into the tuple, never left loose.
      expect(event.data).not.toHaveProperty("messageId");
    }
    // The model's copy inside the tool's input is data, kept as it was.
    expect(events[0]!.data.input).toEqual({ q: "x", identity: forged, turnId: "turn_forged" });
    session.runtime.close(1000, "done");
  });

  it("gives each of three turns its own turn and message while the session and deployment stay (acceptance 4)", async () => {
    const session = await sessionWithRuntime();
    const chains: ToolInvocationIdentity[] = [];
    for (const index of [1, 2, 3]) {
      const turnId = await session.turn(`turn ${index}`, `identity-turn-${index}`);
      session.batch(turnId, `frame-${index}`, [
        { type: "tool.started", data: { callId: `call-${index}`, tool: "lookup", title: "lookup", input: {}, messageId: `msg-${index}` } },
        { type: "tool.completed", data: { callId: `call-${index}`, tool: "lookup", title: "lookup", output: "ok", messageId: `msg-${index}` } },
        { type: "turn.completed", data: {} },
      ]);
      const completed = (await session.events()).filter(
        (event) => event.type === "tool.completed" && event.turnId === turnId,
      );
      expect(completed).toHaveLength(1);
      chains.push(completed[0]!.data.identity as ToolInvocationIdentity);
    }
    expect(new Set(chains.map((chain) => chain.turnId)).size).toBe(3);
    expect(new Set(chains.map((chain) => chain.messageId)).size).toBe(3);
    expect(new Set(chains.map((chain) => chain.toolCallId)).size).toBe(3);
    for (const chain of chains) {
      expect(chain).toMatchObject({
        projectId: "project:local/examples/hello-agent",
        environment: "development",
        agentId: "local/examples/hello-agent",
        deploymentId: "development",
        sessionId: session.created.session.id,
      });
    }
    session.runtime.close(1000, "done");
  });

  it("reports the environment the pinned deployment resolves to when the request named none (acceptance 2)", async () => {
    // One artifact promoted to both environments keeps the alias it was
    // first registered with: production. A session pinned to it by id, with
    // no environment named, records none of its own; its runtime
    // configuration (model routes, variables, logs) resolves through the
    // alias, so the tuple must say production too, not the default.
    const project = await json<{ id: string; agents: Array<{ id: string }> }>(
      await SELF.fetch("https://managedagents.test/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentMode: "legacy", name: "Identity", slug: "identity" }),
      }),
    );
    const agentId = project.agents[0]!.id;
    const register = (alias: "development" | "production") =>
      SELF.fetch("https://managedagents.test/v1/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          alias,
          artifact: {
            bucket: "managed-agent-artifacts",
            key: "agents/identity/digest.json",
            digest: "e".repeat(64),
            size: 512,
          },
          imageArn: "arn:aws:lambda:us-east-1:123:microvm-image:managed-agent-runtime",
          imageVersion: "1.0",
        }),
      });
    const deployment = await json<AgentDeployment>(await register("production"));
    const promoted = await json<AgentDeployment>(await register("development"));
    expect(promoted.id).toBe(deployment.id);
    expect(deployment.alias).toBe("production");

    // Naming the agent would name an alias too; pinning by id alone does not.
    const session = await sessionWithRuntime({ deploymentId: deployment.id });
    expect(session.created.session.deploymentId).toBe(deployment.id);
    expect(session.created.session.environment).toBeUndefined();
    const turnId = await session.turn("report", "identity-alias");
    session.batch(turnId, "frame-alias", [
      { type: "tool.started", data: { callId: "call-p", tool: "lookup", title: "lookup", input: {}, messageId: "msg-p", identity: forged } },
      { type: "tool.completed", data: { callId: "call-p", tool: "lookup", title: "lookup", output: "ok", messageId: "msg-p" } },
    ]);
    const events = (await session.events()).filter((event) => event.type.startsWith("tool."));
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.data.identity).toEqual({
        projectId: project.id,
        environment: "production",
        agentId,
        deploymentId: deployment.id,
        sessionId: session.created.session.id,
        turnId,
        messageId: "msg-p",
        providerCallId: "call-p",
        toolCallId: hostToolCallId({
          sessionId: session.created.session.id,
          turnId,
          messageId: "msg-p",
          providerCallId: "call-p",
        }),
      });
    }
    session.runtime.close(1000, "done");
  });

  it("keeps the tuple on events and the result once the session has ended (acceptance 7)", async () => {
    const session = await sessionWithRuntime();
    const turnId = await session.turn("report", "identity-end");
    const committed = await SELF.fetch(`https://managedagents.test/v1/sessions/${session.created.session.id}/result`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.created.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        turnId,
        callId: "call-r",
        tool: "report",
        runtime: { kind: "microvm", epoch: session.epoch },
        data: { ok: true, identity: forged },
        messageId: "msg-r",
      }),
    });
    expect(committed.status).toBe(200);
    session.batch(turnId, "frame-end", [{ type: "turn.completed", data: {} }]);
    await session.events();
    const ended = await SELF.fetch(`https://managedagents.test/v1/sessions/${session.created.session.id}/end`, {
      method: "POST",
    });
    expect([200, 202]).toContain(ended.status);
    const expected = hostIdentity(session.created.session.id, turnId, "msg-r", "call-r");
    const snapshot = await json<SessionSnapshot>(
      await SELF.fetch(`https://managedagents.test/v1/sessions/${session.created.session.id}`),
    );
    expect(snapshot.result).toMatchObject({
      turnId,
      callId: "call-r",
      // The model's copy stays inside the committed data.
      data: { ok: true, identity: forged },
      identity: expected,
    });
    const events = (await session.events()).filter(
      (event) => event.type === "tool.completed" && event.data.callId === "call-r",
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.data.identity).toEqual(expected);
    session.runtime.close(1000, "done");
  });
});
