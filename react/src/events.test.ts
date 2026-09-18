import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvents,
  emptyTimeline,
  failureMessage,
  inputMessageId,
  isSettledTurn,
  memorySaveFromEvent,
  turnsOf,
  type AgentEvent,
  type Turn,
} from "./events.js";

const turn: AgentEvent[] = [
  { seq: 1, turnId: "t1", type: "message.received", data: { input: "hi" } },
  { seq: 2, turnId: "t1", type: "turn.started", data: {} },
  { seq: 3, turnId: "t1", type: "message.delta", data: { text: "hel" } },
  { seq: 4, turnId: "t1", type: "message.delta", data: { text: "lo" } },
  {
    seq: 5,
    turnId: "t1",
    type: "memory.saved",
    timestamp: "2026-09-10T12:00:00.000Z",
    data: { resource: "notes", documentId: "workshop", revision: "r2", bytes: 12 },
  },
  { seq: 6, turnId: "t1", type: "message.completed", data: { text: "hello" } },
  { seq: 7, turnId: "t1", type: "turn.completed", data: {} },
];

test("a turn reduces to one user and one assistant message", () => {
  const queued = applyEvents(emptyTimeline(), turn.slice(0, 1));
  assert.equal(queued.turns.t1?.status, "queued");
  assert.equal(queued.turns.t1?.input, "hi");
  assert.equal(isSettledTurn(queued, "t1"), false);
  const partial = applyEvents(emptyTimeline(), turn.slice(0, 4));
  assert.equal(partial.isRunning, true);
  assert.equal(partial.turns.t1?.status, "running");
  assert.deepEqual(partial.messages, [
    { id: inputMessageId("t1"), role: "user", text: "hi", turnId: "t1" },
    { id: "turn:t1:reply", role: "assistant", text: "hello", turnId: "t1", streaming: true },
  ]);

  const complete = applyEvents(partial, turn.slice(4));
  assert.equal(complete.isRunning, false);
  assert.equal(complete.cursor, 7);
  assert.equal(complete.turns.t1?.status, "completed");
  assert.equal(isSettledTurn(complete, "t1"), true);
  assert.equal(isSettledTurn(complete, "t2"), false);
  assert.deepEqual(complete.messages, [
    { id: inputMessageId("t1"), role: "user", text: "hi", turnId: "t1" },
    { id: "turn:t1:reply", role: "assistant", text: "hello", turnId: "t1", streaming: false },
  ]);
  assert.deepEqual(complete.memorySaves, [
    {
      seq: 5,
      turnId: "t1",
      timestamp: "2026-09-10T12:00:00.000Z",
      resource: "notes",
      documentId: "workshop",
      revision: "r2",
      bytes: 12,
    },
  ]);
});

test("a completed message without deltas is still one message", () => {
  const timeline = applyEvents(emptyTimeline(), [turn[0], turn[1], turn[5], turn[6]]);
  assert.deepEqual(
    timeline.messages.map((message) => [message.role, message.text, message.streaming]),
    [["user", "hi", undefined], ["assistant", "hello", false]],
  );
});

test("events at or below the cursor are ignored, so overlapping pages do not duplicate", () => {
  const once = applyEvents(emptyTimeline(), turn);
  const twice = applyEvents(once, turn);
  assert.deepEqual(twice, once);
  assert.equal(twice.messages.length, 2);
  assert.equal(twice.memorySaves.length, 1);
});

test("a message sent locally is confirmed, not duplicated, by its message.received", () => {
  const optimistic = {
    ...emptyTimeline(),
    messages: [{ id: inputMessageId("t1"), role: "user" as const, text: "hi", turnId: "t1" }],
  };
  const timeline = applyEvents(optimistic, turn.slice(0, 2));
  assert.equal(timeline.messages.length, 1);
  assert.equal(timeline.isRunning, true);
});

test("cancelled and failed turns stop running and settle the streaming reply", () => {
  for (const type of ["turn.failed", "turn.cancelled"]) {
    const timeline = applyEvents(emptyTimeline(), [
      ...turn.slice(0, 4),
      { seq: 5, turnId: "t1", type, data: { message: "stopped" } },
    ]);
    assert.equal(timeline.isRunning, false);
    assert.equal(timeline.messages[1]?.streaming, false);
  }
  assert.equal(
    failureMessage({ seq: 5, turnId: "t1", type: "turn.failed", data: { message: "boom" } }),
    "boom",
  );
  assert.equal(
    failureMessage({ seq: 5, type: "runtime.disconnected", data: {} }),
    "runtime disconnected",
  );
  assert.equal(failureMessage(turn[6]), undefined);
});

test("session end is terminal", () => {
  const timeline = applyEvents(emptyTimeline(), [
    ...turn.slice(0, 2),
    { seq: 3, type: "session.ended", data: {} },
  ]);
  assert.equal(timeline.ended, true);
  assert.equal(timeline.isRunning, false);
});

test("only memory.saved events describe a save", () => {
  assert.equal(memorySaveFromEvent(turn[0]), undefined);
  assert.deepEqual(memorySaveFromEvent({ seq: 9, type: "memory.saved", data: {} }), {
    seq: 9,
    resource: "",
    documentId: "",
    revision: "",
    bytes: 0,
  });
});

// A recorded log of a coding turn: a clone, a check that failed, and the
// result tool reporting twice, the second call replacing the first.
const activity: AgentEvent[] = [
  { seq: 1, turnId: "t1", type: "message.received", data: { input: "Fix the login page", mode: "queue", payload: { repo: "acme/web" } } },
  { seq: 2, turnId: "t1", type: "turn.started", data: {} },
  { seq: 3, turnId: "t1", type: "tool.started", data: { tool: "shell", callId: "c1", title: "git clone", input: { command: "git clone acme/web" } } },
  { seq: 4, turnId: "t1", type: "tool.completed", data: { tool: "shell", callId: "c1", title: "git clone", output: { exitCode: 0 } } },
  { seq: 5, turnId: "t1", type: "tool.started", data: { tool: "report", callId: "c2", title: "report", input: { baseSha: "abc" } } },
  { seq: 6, turnId: "t1", type: "tool.completed", data: { tool: "report", callId: "c2", title: "report", output: { baseSha: "abc" }, result: true } },
  { seq: 7, turnId: "t1", type: "tool.started", data: { tool: "shell", callId: "c3", title: "npm test" } },
  { seq: 8, turnId: "t1", type: "tool.failed", data: { tool: "shell", callId: "c3", message: "exit 1" } },
  { seq: 9, turnId: "t1", type: "tool.started", data: { tool: "report", callId: "c4", title: "report" } },
  { seq: 10, turnId: "t1", type: "tool.completed", data: { tool: "report", callId: "c4", output: { baseSha: "abc", branch: "task/1" }, result: true } },
  { seq: 11, turnId: "t1", type: "message.delta", data: { text: "Opened a draft PR." } },
  { seq: 12, turnId: "t1", type: "message.completed", data: { text: "Opened a draft PR." } },
  { seq: 13, turnId: "t1", type: "turn.completed", data: {} },
  { seq: 14, turnId: "t2", type: "message.received", data: { input: "Also fix signup" } },
  { seq: 15, turnId: "t2", type: "turn.started", data: {} },
  { seq: 16, turnId: "t2", type: "turn.failed", data: { code: "tool_failed", message: "A tool failed", tool: "shell" } },
];

test("turns are reduced from the log with tool calls keyed on callId, the result from the result tool, and failures", () => {
  const turns = turnsOf(applyEvents(emptyTimeline(), activity));
  assert.equal(turns.length, 2);
  const [first, second] = turns as [Turn, Turn];
  assert.equal(first.id, "t1");
  assert.equal(first.status, "completed");
  assert.equal(first.input, "Fix the login page");
  assert.deepEqual(first.messages.map((message) => [message.role, message.text]), [
    ["user", "Fix the login page"],
    ["assistant", "Opened a draft PR."],
  ]);
  assert.deepEqual(first.toolCalls, [
    { callId: "c1", tool: "shell", title: "git clone", input: { command: "git clone acme/web" }, output: { exitCode: 0 }, status: "completed" },
    { callId: "c2", tool: "report", title: "report", input: { baseSha: "abc" }, output: { baseSha: "abc" }, status: "completed" },
    { callId: "c3", tool: "shell", title: "npm test", status: "failed" },
    { callId: "c4", tool: "report", title: "report", output: { baseSha: "abc", branch: "task/1" }, status: "completed" },
  ]);
  // The later committed call replaces the result.
  assert.deepEqual(first.result, { baseSha: "abc", branch: "task/1" });
  assert.equal(first.failure, undefined);
  assert.equal(second.id, "t2");
  assert.equal(second.status, "failed");
  assert.deepEqual(second.failure, { code: "tool_failed", message: "A tool failed" });
  assert.deepEqual(second.toolCalls, []);
  assert.equal(second.result, undefined);
});

test("replaying the whole log and applying it live in pages produce the same turns", () => {
  const replayed = turnsOf(applyEvents(emptyTimeline(), activity));
  let live = emptyTimeline();
  for (let start = 0; start < activity.length; start += 3) {
    live = applyEvents(live, activity.slice(start, start + 3));
  }
  assert.deepEqual(turnsOf(live), replayed);
  // A page that overlaps changes nothing.
  assert.deepEqual(turnsOf(applyEvents(live, activity.slice(4, 9))), replayed);
});

test("a tool event without a callId still gets a stable id from its position", () => {
  const turns = turnsOf(
    applyEvents(emptyTimeline(), [
      { seq: 1, turnId: "t1", type: "turn.started", data: {} },
      { seq: 2, turnId: "t1", type: "tool.started", data: { tool: "shell" } },
    ]),
  );
  assert.equal(turns[0]?.input, "");
  assert.deepEqual(turns[0]?.toolCalls, [{ callId: "event:2", tool: "shell", title: "shell", status: "running" }]);
});

// The review's case in the documented shape: the result tool committed an
// object, a later shell call started and never reported a completion of its
// own, and the turn completed. The turn's word is final: the row is settled
// with the turn, the result is the decoded object, and an ordinary output
// that looks like a result is not one.
const unsettled: AgentEvent[] = [
  { seq: 1, turnId: "t1", type: "message.received", data: { input: "Fix the login page", mode: "queue" } },
  { seq: 2, turnId: "t1", type: "turn.started", data: {} },
  { seq: 3, turnId: "t1", type: "tool.started", data: { tool: "shell", callId: "c1", title: "git status", input: { command: "git status" } } },
  { seq: 4, turnId: "t1", type: "tool.completed", data: { tool: "shell", callId: "c1", title: "git status", output: { branch: "task/1", pr: { number: 7, url: "https://example.test/pr/7" } } } },
  { seq: 5, turnId: "t1", type: "tool.started", data: { tool: "report", callId: "c2", title: "report", input: { branch: "task/1" } } },
  { seq: 6, turnId: "t1", type: "tool.completed", data: { tool: "report", callId: "c2", title: "report", output: { branch: "task/1", pr: { number: 7, url: "https://example.test/pr/7" } }, result: true } },
  { seq: 7, turnId: "t1", type: "tool.started", data: { tool: "shell", callId: "c3", title: "npm test", input: { command: "npm test" } } },
  { seq: 8, turnId: "t1", type: "message.completed", data: { text: "Opened PR 7." } },
  { seq: 9, turnId: "t1", type: "turn.completed", data: {} },
];

test("a terminal turn event settles every tool row without a completion, and the result is the decoded value", () => {
  const timeline = applyEvents(emptyTimeline(), unsettled.slice(0, 7));
  assert.deepEqual(timeline.turns.t1?.toolCalls.map((call) => [call.callId, call.status]), [
    ["c1", "completed"],
    ["c2", "completed"],
    ["c3", "running"],
  ]);
  // The ordinary shell output equals the result object byte for byte and is
  // still not the result: only `result: true` commits one.
  const beforeReport = turnsOf(applyEvents(emptyTimeline(), unsettled.slice(0, 4)))[0];
  assert.equal(beforeReport?.result, undefined);
  assert.deepEqual(beforeReport?.toolCalls[0]?.output, { branch: "task/1", pr: { number: 7, url: "https://example.test/pr/7" } });

  const [turn] = turnsOf(applyEvents(emptyTimeline(), unsettled)) as [Turn];
  assert.equal(turn.status, "completed");
  assert.deepEqual(turn.toolCalls.map((call) => [call.callId, call.status]), [
    ["c1", "completed"],
    ["c2", "completed"],
    ["c3", "completed"],
  ]);
  assert.equal(typeof turn.result, "object");
  assert.deepEqual(turn.result, { branch: "task/1", pr: { number: 7, url: "https://example.test/pr/7" } });
  assert.deepEqual(turn.toolCalls[1]?.output, turn.result);

  const failed = turnsOf(applyEvents(emptyTimeline(), [
    ...unsettled.slice(0, 7),
    { seq: 8, turnId: "t1", type: "turn.failed", data: { code: "runtime_lost", message: "The runtime was lost" } },
  ]))[0];
  assert.deepEqual(failed?.toolCalls.map((call) => [call.callId, call.status]), [
    ["c1", "completed"],
    ["c2", "completed"],
    ["c3", "failed"],
  ]);
  assert.deepEqual(failed?.result, turn.result);

  const cancelled = turnsOf(applyEvents(emptyTimeline(), [
    ...unsettled.slice(0, 7),
    { seq: 8, turnId: "t1", type: "turn.cancelled", data: { reason: "interrupted", operationsSettled: 1 } },
  ]))[0];
  assert.deepEqual(cancelled?.toolCalls.map((call) => [call.callId, call.status]), [
    ["c1", "completed"],
    ["c2", "completed"],
    ["c3", "cancelled"],
  ]);
  assert.deepEqual(cancelled?.result, turn.result);
});
