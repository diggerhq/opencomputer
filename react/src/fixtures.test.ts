// Every fixture log under react/test/fixtures reduces through the same
// reducer the hook uses. `documented/` holds logs authored to
// docs/agents/events.mdx; `backend-emitted/` holds logs the platform's own
// tests recorded from a real host turn, in the shape the public API returns.
// The checks are the contract's invariants, so a recording that disagrees
// with the docs fails here rather than in a page: every turn settled, every
// tool row settled with its turn, no duplicate rows, and the result tool's
// committed output a decoded value that is the turn's result.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  applyEvents,
  emptyTimeline,
  isSettledStatus,
  turnsOf,
  type AgentEvent,
  type ToolCallStatus,
  type Turn,
} from "./events.js";

// Tests run from dist/, one level below the package root, like src/.
const root = new URL("../test/fixtures/", import.meta.url);

interface Fixture {
  events: AgentEvent[];
  /** The turns the log must reduce to, when the fixture pins them. */
  turns?: Turn[];
}

function fixturesIn(directory: string): Array<{ name: string; fixture: Fixture }> {
  const url = new URL(`${directory}/`, root);
  let names: string[];
  try {
    names = readdirSync(url).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((name) => ({
    name: `${directory}/${name}`,
    fixture: JSON.parse(readFileSync(new URL(name, url), "utf8")) as Fixture,
  }));
}

/** The `tool.completed` events of a turn that committed the session's result, in log order. */
function committedResults(events: AgentEvent[], turnId: string): AgentEvent[] {
  return events.filter(
    (event) => event.turnId === turnId && event.type === "tool.completed" && event.data.result === true,
  );
}

function check(name: string, fixture: Fixture): void {
  assert.ok(Array.isArray(fixture.events) && fixture.events.length > 0, `${name}: no events`);
  const whole = turnsOf(applyEvents(emptyTimeline(), fixture.events));
  let paged = emptyTimeline();
  for (let start = 0; start < fixture.events.length; start += 3) {
    paged = applyEvents(paged, fixture.events.slice(start, start + 3));
  }
  assert.deepEqual(turnsOf(paged), whole, `${name}: replay in pages differs from replay whole`);
  assert.ok(whole.length > 0, `${name}: the log names no turn`);
  for (const turn of whole) {
    // A fixture is a finished log: a turn left running would pin a moving target.
    assert.ok(isSettledStatus(turn.status), `${name}: turn ${turn.id} ends ${turn.status}, not a terminal status`);
    // A call is settled by its own completion or failure, or by the turn's
    // outcome; only an interrupt leaves a call `cancelled`.
    const settled: ToolCallStatus[] =
      turn.status === "cancelled" ? ["completed", "failed", "cancelled"] : ["completed", "failed"];
    for (const call of turn.toolCalls) {
      assert.ok(
        settled.includes(call.status),
        `${name}: turn ${turn.id} is ${turn.status} but its call ${call.callId} ends ${call.status}`,
      );
    }
    const ids = turn.toolCalls.map((call) => call.callId);
    assert.equal(new Set(ids).size, ids.length, `${name}: turn ${turn.id} has duplicate tool rows`);
    // The result is the result tool's committed output and nothing else: the
    // same decoded value on the tool row, on the turn, and in the event.
    const committed = committedResults(fixture.events, turn.id);
    const last = committed[committed.length - 1];
    if (!last) {
      assert.equal(turn.result, undefined, `${name}: turn ${turn.id} has a result but committed none`);
      continue;
    }
    const call = turn.toolCalls.find((candidate) => candidate.callId === last.data.callId);
    assert.ok(call, `${name}: turn ${turn.id} has no tool row for the committed result call`);
    assert.equal(call.status, "completed", `${name}: the result call ${call.callId} ends ${call.status}`);
    assert.equal(typeof call.output, "object", `${name}: the result call's output is not a decoded object`);
    assert.notEqual(call.output, null, `${name}: the result call's output is null`);
    assert.deepEqual(call.output, last.data.output, `${name}: the result call's output differs from the event`);
    assert.deepEqual(turn.result, call.output, `${name}: turn ${turn.id}'s result differs from its committed output`);
  }
  if (fixture.turns) assert.deepEqual(whole, fixture.turns, `${name}: turns differ from the pinned turns`);
}

for (const directory of ["documented", "backend-emitted"]) {
  test(`every ${directory} fixture reduces to settled turns, the same whole and in pages`, (t) => {
    const files = fixturesIn(directory);
    for (const { name, fixture } of files) check(name, fixture);
    t.diagnostic(`${directory}: ${String(files.length)} fixture file(s) ran`);
  });
}

test("the documented fixtures cover a result, an interrupt and a failure", () => {
  const names = fixturesIn("documented").map(({ name }) => name);
  assert.ok(names.length >= 3, `expected at least three documented fixtures, found ${String(names.length)}`);
});

test("a recorded host turn with a result call is among the backend-emitted fixtures", () => {
  const names = fixturesIn("backend-emitted").map(({ name }) => name);
  assert.ok(names.includes("backend-emitted/workerd-turn-with-result.json"), `found ${names.join(", ") || "none"}`);
});
