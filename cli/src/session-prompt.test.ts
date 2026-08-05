import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import test from "node:test";

import { runSessionPrompt } from "./session-prompt.js";

test("session prompt renders a simple multi-turn transcript", async () => {
  const input = Readable.from(["hello\nagain\n/exit\n"]);
  const output = new PassThrough();
  output.setEncoding("utf8");
  let rendered = "";
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });
  const sessions: Array<string | undefined> = [];

  await runSessionPrompt({
    agentName: "Email triage",
    input,
    output,
    send: async (prompt, sessionId, emit) => {
      sessions.push(sessionId);
      if (prompt === "hello") {
        emit({ type: "message.delta", data: { text: "Hi" } });
        emit({ type: "message.delta", data: { text: " there" } });
        return "session-1";
      }
      emit({ type: "message.completed", data: { text: "Welcome back" } });
      return "session-1";
    },
  });

  assert.deepEqual(sessions, [undefined, "session-1"]);
  assert.equal(
    rendered,
    "OpenComputer session — Email triage\n" +
      "Type /exit or /quit to leave.\n\n" +
      "User: hello\n" +
      "Agent: Hi there\n\n" +
      "User: again\n" +
      "Agent: Welcome back\n\n" +
      "User: /exit\n\n",
  );
});

test("session prompt reports a failed turn and keeps reading", async () => {
  const input = Readable.from(["fail\n/quit\n"]);
  const output = new PassThrough();
  output.setEncoding("utf8");
  let rendered = "";
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });

  await runSessionPrompt({
    agentName: "Test agent",
    input,
    output,
    send: async () => {
      throw new Error("request failed");
    },
  });

  assert.match(rendered, /Agent: Error: request failed\n\nUser:/);
});

test("session prompt shows a lightweight spinner on interactive output", async () => {
  const input = Readable.from(["hello\n/exit\n"]);
  const output = Object.assign(new PassThrough(), { isTTY: true });
  output.setEncoding("utf8");
  let rendered = "";
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });

  await runSessionPrompt({
    agentName: "Test agent",
    input,
    output,
    send: async (_prompt, _sessionId, emit) => {
      emit({ type: "message.completed", data: { text: "Hello" } });
      return "session-1";
    },
  });

  assert.ok(rendered.includes("Agent: ⠋\b \bHello"));
});

test("session prompt prints non-message events only in verbose mode", async () => {
  const input = Readable.from(["hello\n/exit\n"]);
  const output = new PassThrough();
  output.setEncoding("utf8");
  let rendered = "";
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });

  await runSessionPrompt({
    agentName: "Test agent",
    verbose: true,
    input,
    output,
    send: async (_prompt, _sessionId, emit) => {
      emit({ type: "session.created", data: { sessionId: "session-1" } });
      emit({
        type: "tool.started",
        data: { tool: "gmail_search", input: { query: "unread" } },
      });
      emit({ type: "tool.completed", data: { tool: "gmail_search" } });
      emit({ type: "message.completed", data: { text: "Found two emails" } });
      return "session-1";
    },
  });

  assert.match(rendered, /Event: session\.created/);
  assert.match(rendered, /Event: tool\.started/);
  assert.match(rendered, /Event: tool\.completed/);
  assert.match(rendered, /Agent: Found two emails/);
});
