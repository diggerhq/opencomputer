import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useAgent,
  type AgentEvent,
  type UseAgentOptions,
  type UseAgentResult,
} from "./index.js";

// React DOM needs a document; the hook itself needs only fetch and timers.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

// A fake of the three routes the hook proxies: the event log paged by
// `after`, turn creation that appends the input to the log, and interrupt.
function fakeSession(sessionId: string) {
  const log: AgentEvent[] = [];
  const calls: Call[] = [];
  let failNext = 0;
  let turns = 0;
  const append = (event: Omit<AgentEvent, "seq">) => {
    log.push({ ...event, seq: log.length + 1 });
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://app.test");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as Record<string, unknown> }
        : {}),
    };
    calls.push(call);
    if (failNext > 0) {
      failNext -= 1;
      throw new TypeError("network down");
    }
    const prefix = `/app/agent/sessions/${sessionId}`;
    if (call.method === "GET" && url.pathname === `${prefix}/events`) {
      const after = Number(url.searchParams.get("after") ?? "0");
      return Response.json({
        events: log.filter((event) => event.seq > after).slice(0, 3),
      });
    }
    if (call.method === "POST" && url.pathname === `${prefix}/turns`) {
      turns += 1;
      const turnId = `turn-${String(turns)}`;
      append({
        turnId,
        type: "message.received",
        data: { input: call.body?.input, mode: "queue" },
      });
      append({ turnId, type: "turn.started", data: {} });
      return Response.json({ turnId, status: "queued", duplicate: false }, { status: 202 });
    }
    if (call.method === "POST" && url.pathname === `${prefix}/interrupt`) {
      return Response.json({ id: sessionId, status: "idle" });
    }
    return Response.json(
      { error: { code: "not_found", message: `no route ${call.method} ${url.pathname}` } },
      { status: 404 },
    );
  };
  return {
    log,
    calls,
    fetch,
    append,
    failNext: (count: number) => {
      failNext = count;
    },
  };
}

function mount(context: TestContext, options: UseAgentOptions | string) {
  const container = dom.window.document.createElement("div");
  const root: Root = createRoot(container);
  const renders: UseAgentResult[] = [];
  let latest: UseAgentResult | undefined;
  function Harness() {
    latest = useAgent(options);
    renders.push(latest);
    return null;
  }
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => {
      root.unmount();
    });
  };
  // A failed assertion must not leave the polling loop running.
  context.after(unmount);
  return {
    async render() {
      await act(async () => {
        root.render(createElement(Harness));
      });
    },
    result: () => latest!,
    first: () => renders[0]!,
    async until(predicate: (result: UseAgentResult) => boolean, label: string) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (latest && predicate(latest)) return latest;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    unmount,
  };
}

test("attach replays the session's history, then reports memory saves and new turns", async (t) => {
  const session = fakeSession("ses-1");
  session.append({ turnId: "t0", type: "message.received", data: { input: "What do you know?" } });
  session.append({ turnId: "t0", type: "turn.started", data: {} });
  session.append({ turnId: "t0", type: "message.delta", data: { text: "Notes " } });
  session.append({ turnId: "t0", type: "message.delta", data: { text: "say Node 22." } });
  session.append({
    turnId: "t0",
    type: "memory.saved",
    data: { resource: "notes", documentId: "workshop", revision: "r1", bytes: 40 },
  });
  session.append({ turnId: "t0", type: "message.completed", data: { text: "Notes say Node 22." } });
  session.append({ turnId: "t0", type: "turn.completed", data: {} });

  const seen: string[] = [];
  const saves: string[] = [];
  const view = mount(t, {
    sessionId: "ses-1",
    basePath: "/app/agent",
    fetch: session.fetch,
    pollIntervalMs: 5,
    onEvent: (event) => seen.push(event.type),
    onMemorySaved: (save) => saves.push(`${save.resource}/${save.documentId}@${save.revision}`),
  });
  await view.render();
  // The first render is attached but has nothing yet; the fake replies at once.
  assert.equal(view.first().isReplaying, true);
  assert.equal(view.first().sessionId, "ses-1");
  assert.deepEqual(view.first().messages, []);

  const replayed = await view.until((result) => !result.isReplaying, "history replay");
  assert.deepEqual(
    replayed.messages.map((message) => [message.role, message.text, message.streaming]),
    [["user", "What do you know?", undefined], ["assistant", "Notes say Node 22.", false]],
  );
  assert.equal(replayed.isRunning, false);
  assert.equal(replayed.cursor, 7);
  assert.deepEqual(saves, ["notes/workshop@r1"]);
  assert.equal(replayed.memorySaves.length, 1);
  assert.equal(seen.length, 7);
  // History is paged by the server; every page resumes from the cursor.
  assert.deepEqual(
    session.calls.filter((call) => call.method === "GET").slice(0, 4).map((call) => call.path),
    [
      "/app/agent/sessions/ses-1/events?after=0",
      "/app/agent/sessions/ses-1/events?after=3",
      "/app/agent/sessions/ses-1/events?after=6",
      "/app/agent/sessions/ses-1/events?after=7",
    ],
  );

  // A live save on a later turn reaches the list and the callback once.
  session.append({ turnId: "t1", type: "turn.started", data: {} });
  session.append({
    turnId: "t1",
    type: "memory.saved",
    data: { resource: "notes", documentId: "workshop", revision: "r2", bytes: 44 },
  });
  const live = await view.until((result) => result.memorySaves.length === 2, "live save");
  assert.equal(live.isRunning, true);
  assert.deepEqual(saves, ["notes/workshop@r1", "notes/workshop@r2"]);
  await view.unmount();
});

test("attach resumes from its cursor after a failed poll instead of replaying", async (t) => {
  const session = fakeSession("ses-2");
  session.append({ turnId: "t0", type: "message.received", data: { input: "hello" } });
  session.append({ turnId: "t0", type: "turn.started", data: {} });
  const view = mount(t, { sessionId: "ses-2", basePath: "/app/agent", fetch: session.fetch, pollIntervalMs: 5 });
  await view.render();
  await view.until((result) => !result.isReplaying, "history replay");

  session.failNext(1);
  await view.until((result) => result.error === "network down", "the failed poll");
  session.append({ turnId: "t0", type: "message.completed", data: { text: "hi" } });
  session.append({ turnId: "t0", type: "turn.completed", data: {} });
  const recovered = await view.until((result) => result.cursor === 4, "recovery");
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.messages.length, 2);
  assert.equal(recovered.isRunning, false);
  const afters = session.calls
    .filter((call) => call.method === "GET")
    .map((call) => call.path.replace(/.*after=/, ""));
  assert.ok(!afters.slice(1).includes("0"), `no poll restarted from 0: ${afters.join(",")}`);
  await view.unmount();
});

test("attach sends turns and interrupts through the app's routes without duplicating the input", async (t) => {
  const session = fakeSession("ses-3");
  const view = mount(t, { sessionId: "ses-3", basePath: "/app/agent", fetch: session.fetch, pollIntervalMs: 5 });
  await view.render();
  await view.until((result) => !result.isReplaying, "empty history");

  await act(async () => {
    await view.result().send("  Book the venue  ");
  });
  const sent = view.result();
  assert.equal(sent.isRunning, true);
  assert.deepEqual(sent.messages, [
    { id: "turn:turn-1:input", role: "user", text: "Book the venue", turnId: "turn-1" },
  ]);
  const turn = session.calls.find((call) => call.method === "POST" && call.path.endsWith("/turns"));
  assert.equal(turn?.body?.input, "Book the venue");
  assert.equal(typeof turn?.body?.idempotencyKey, "string");
  assert.equal(turn?.headers["content-type"], "application/json");

  const confirmed = await view.until((result) => result.cursor === 2, "message.received");
  assert.equal(confirmed.messages.length, 1);

  await act(async () => {
    await view.result().stop();
  });
  assert.ok(
    session.calls.some((call) => call.method === "POST" && call.path === "/app/agent/sessions/ses-3/interrupt"),
  );
  session.append({ turnId: "turn-1", type: "turn.cancelled", data: { reason: "interrupted" } });
  const stopped = await view.until((result) => !result.isRunning, "cancellation");
  assert.equal(stopped.error, undefined);
  await view.unmount();
});

test("attach reports a failed turn and a rejected send", async (t) => {
  const session = fakeSession("ses-4");
  const view = mount(t, { sessionId: "ses-4", basePath: "/app/agent", fetch: session.fetch, pollIntervalMs: 5 });
  await view.render();
  session.append({ turnId: "t0", type: "turn.started", data: {} });
  session.append({ turnId: "t0", type: "turn.failed", data: { message: "model unavailable" } });
  const failed = await view.until((result) => result.error !== undefined, "turn failure");
  assert.equal(failed.error, "model unavailable");
  assert.equal(failed.isRunning, false);

  const rejecting = mount(t, {
    sessionId: "ses-5",
    basePath: "/app/agent",
    fetch: async () =>
      Response.json({ error: { code: "session_ended", message: "Session has ended" } }, { status: 409 }),
    pollIntervalMs: 5,
  });
  await rejecting.render();
  await act(async () => {
    await rejecting.result().send("anything");
  });
  assert.equal(rejecting.result().error, "Session has ended");
  assert.deepEqual(rejecting.result().messages, []);
  await rejecting.unmount();
  await view.unmount();
});

test("create mode still creates the session on the first send and streams the reply", async (t) => {
  const calls: Call[] = [];
  const log: AgentEvent[] = [
    { seq: 1, type: "runtime.connected", data: {} },
    { seq: 2, turnId: "t1", type: "message.delta", data: { text: "Hello " } },
    { seq: 3, turnId: "t1", type: "message.delta", data: { text: "there" } },
    { seq: 4, turnId: "t1", type: "turn.completed", data: {} },
  ];
  let created = false;
  let turned = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://app.test");
    calls.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    });
    if (url.pathname === "/api/opencomputer/managed-agents/sessions" && init?.method === "POST") {
      created = true;
      return Response.json({ session: { id: "ses-new" } }, { status: 201 });
    }
    if (url.pathname.endsWith("/turns")) {
      turned = true;
      return Response.json({ turnId: "t1", status: "queued", duplicate: false }, { status: 202 });
    }
    if (url.pathname.endsWith("/events")) {
      const after = Number(url.searchParams.get("after"));
      const visible = log.filter((event) => event.seq > after && (turned || event.seq === 1));
      return Response.json({ events: created ? visible : [] });
    }
    return Response.json({ id: "ses-new", status: "suspended" });
  };
  const view = mount(t, { agent: "hello-world@development", fetch });
  await view.render();
  assert.equal(view.result().isReplaying, false);
  assert.equal(view.result().sessionId, undefined);

  await act(async () => {
    await view.result().send("Hi");
  });
  const result = view.result();
  assert.equal(result.sessionId, "ses-new");
  assert.equal(result.isRunning, false);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.messages.map((message) => [message.role, message.text]),
    [["user", "Hi"], ["assistant", "Hello there"]],
  );
  assert.equal(result.cursor, 4);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "POST /api/opencomputer/managed-agents/sessions",
      "GET /api/opencomputer/managed-agents/sessions/ses-new/events?after=0",
      "POST /api/opencomputer/managed-agents/sessions/ses-new/turns",
      "GET /api/opencomputer/managed-agents/sessions/ses-new/events?after=1",
      "POST /api/opencomputer/managed-agents/sessions/ses-new/suspend",
    ],
  );
  assert.deepEqual(calls[0].body, { agentId: "hello-world@development", source: "local-react" });
  await view.unmount();
});
