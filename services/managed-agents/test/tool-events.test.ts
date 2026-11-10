import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEventInput } from "../src/protocol.js";
import { OpenCode2ReactiveHarness } from "../src/runtime/opencode2-harness.js";

/**
 * The MicroVM runtime's tool events in the public shape (design C1, one
 * shape on every runtime; review finding 7). The harness reads OpenCode's
 * own event stream, where the tool's name travels on
 * `session.tool.input.started`, its input on `session.tool.called`, its
 * result as content parts on `session.tool.success` and its error as
 * `{ type, message }` on `session.tool.failed`; what it yields to the
 * Session object must carry `callId`, `tool`, `title`, `input`, `output`
 * and `message`, never the native names. `messageId` is the one host field
 * that travels with every call event: the Session object folds it into the
 * call's `identity` and it is never a top-level public field.
 */

const sessionID = "ses_public_events";

function sse(events: Array<{ type: string; data: Record<string, unknown> }>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const openCodeTurn = [
  { type: "session.text.delta", data: { sessionID, assistantMessageID: "msg-1", ordinal: 0, delta: "Looking. " } },
  { type: "session.tool.input.started", data: { sessionID, assistantMessageID: "msg-1", id: "call-0", name: "lookup" } },
  { type: "session.tool.called", data: { sessionID, assistantMessageID: "msg-1", id: "call-0", input: { q: "x" }, executed: true } },
  {
    type: "session.tool.failed",
    data: { sessionID, assistantMessageID: "msg-1", id: "call-0", error: { type: "UnknownError", message: "lookup exploded" }, executed: true },
  },
  { type: "session.tool.input.started", data: { sessionID, assistantMessageID: "msg-1", id: "call-1", name: "report" } },
  { type: "session.tool.called", data: { sessionID, assistantMessageID: "msg-1", id: "call-1", input: { branch: "task/1" }, executed: true } },
  { type: "session.tool.progress", data: { sessionID, assistantMessageID: "msg-1", id: "call-1", metadata: { stage: "verifying" } } },
  {
    type: "session.tool.success",
    data: {
      sessionID,
      assistantMessageID: "msg-1",
      id: "call-1",
      content: [{ type: "text", text: '{"branch":"task/1"}' }],
      metadata: { elapsed: 3 },
      executed: true,
    },
  },
  // Another session's events never reach this turn.
  { type: "session.tool.called", data: { sessionID: "ses_other", assistantMessageID: "msg-9", id: "call-9", input: {} } },
  { type: "session.text.delta", data: { sessionID, assistantMessageID: "msg-1", ordinal: 0, delta: "Done." } },
  { type: "session.execution.succeeded", data: { sessionID } },
];

async function runTurn(): Promise<RuntimeEventInput[]> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/health") return Response.json({ healthy: true });
      if (path === "/api/session" && init?.method === "POST") return Response.json({ data: { id: sessionID } });
      if (path === "/api/event") return sse(openCodeTurn);
      if (path.endsWith("/prompt")) return Response.json({ data: {} });
      return Response.json({ error: `unexpected ${path}` }, { status: 500 });
    }),
  );
  const harness = new OpenCode2ReactiveHarness("http://127.0.0.1:4096", "/workspace", "openrouter/anthropic/claude-sonnet-4.6");
  await harness.start();
  const events: RuntimeEventInput[] = [];
  for await (const event of harness.run({
    turnId: "turn-1",
    input: "Report the branch",
    agentInput: { source: "user", text: "Report the branch" },
    epoch: 1,
  })) {
    events.push(event);
  }
  return events;
}

const PUBLIC_KEYS = new Set(["callId", "tool", "title", "input", "output", "message", "messageId"]);
const NATIVE_KEYS = ["id", "name", "content", "assistantMessageID", "sessionID", "error", "metadata", "executed"];

describe("the MicroVM harness emits tool events in the public shape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names every call, carries input on start, output text on completion and the error message on failure, never the native fields", async () => {
    const events = await runTurn();
    const toolEvents = events.filter((event) => event.type.startsWith("tool."));
    for (const event of toolEvents) {
      const data = event.data ?? {};
      expect(typeof data.callId).toBe("string");
      expect(typeof data.tool).toBe("string");
      // Every variant, progress included, names the assistant message behind the call.
      expect(data.messageId).toBe("msg-1");
      for (const native of NATIVE_KEYS) expect(data).not.toHaveProperty(native);
      if (event.type !== "tool.progress") {
        for (const key of Object.keys(data)) expect(PUBLIC_KEYS.has(key)).toBe(true);
        expect(typeof data.title).toBe("string");
      }
    }
    expect(toolEvents).toEqual([
      { type: "tool.started", data: { callId: "call-0", tool: "lookup", title: "lookup", input: { q: "x" }, messageId: "msg-1" } },
      { type: "tool.failed", data: { callId: "call-0", tool: "lookup", title: "lookup", messageId: "msg-1", message: "lookup exploded" } },
      { type: "tool.started", data: { callId: "call-1", tool: "report", title: "report", input: { branch: "task/1" }, messageId: "msg-1" } },
      { type: "tool.progress", data: { stage: "verifying", callId: "call-1", tool: "report", messageId: "msg-1" } },
      { type: "tool.completed", data: { callId: "call-1", tool: "report", title: "report", output: '{"branch":"task/1"}', messageId: "msg-1" } },
    ]);
    // A call starts and completes under the same callId.
    const started = toolEvents.filter((event) => event.type === "tool.started").map((event) => event.data?.callId);
    const settled = toolEvents
      .filter((event) => event.type === "tool.completed" || event.type === "tool.failed")
      .map((event) => event.data?.callId);
    expect(settled.sort()).toEqual(started.sort());
    expect(events.at(-1)).toMatchObject({ type: "message.completed", data: { text: "Looking. Done." } });
  });
});
