import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvents,
  emptyTimeline,
  failureMessage,
  inputMessageId,
  memorySaveFromEvent,
  type AgentEvent,
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
  const partial = applyEvents(emptyTimeline(), turn.slice(0, 4));
  assert.equal(partial.isRunning, true);
  assert.deepEqual(partial.messages, [
    { id: inputMessageId("t1"), role: "user", text: "hi", turnId: "t1" },
    { id: "turn:t1:reply", role: "assistant", text: "hello", turnId: "t1", streaming: true },
  ]);

  const complete = applyEvents(partial, turn.slice(4));
  assert.equal(complete.isRunning, false);
  assert.equal(complete.cursor, 7);
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
