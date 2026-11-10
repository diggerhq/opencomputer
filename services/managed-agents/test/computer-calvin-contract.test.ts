import { describe, expect, it } from "vitest";

import { capabilities, PLAN_EXIT_MODES } from "../src/computer/capabilities.js";
import { decodeCursor, encodeCursor } from "../src/computer/list-cursor.js";
import fixture from "./fixtures/calvin/capabilities.v1.json" with { type: "json" };
import * as calvin from "./fixtures/calvin/list-cursor.js";
import type { CursorKind } from "./fixtures/calvin/list-cursor.js";

/**
 * Work 084 review r2 P2-5: blue serves capabilities over HTTP and checks create/PATCH against its own list;
 * calvin serves its list in `sessions.attached`. The vendored copy of calvin's exported list keeps them equal.
 */
describe("capabilities match calvin's", () => {
  it("models, modes and features are calvin's exactly", () => {
    const { models, modes, features } = fixture as unknown as ReturnType<typeof capabilities>;
    expect(capabilities()).toEqual({ models, modes, features });
  });

  it("plan-exit modes are calvin's, when calvin exports them", () => {
    const exported = (fixture as { planExitModes?: string[] }).planExitModes;
    if (exported) expect([...PLAN_EXIT_MODES]).toEqual(exported);
  });
});

/**
 * Review r2 P2-6: calvin's socket `asks.list`/`subagents.list` mint and read blue's cursor format. The vendored
 * calvin/src/api/list-cursor.ts (b9de827) and blue's list-cursor.ts must read each other's cursors.
 */
describe("list cursors match calvin's", () => {
  const cases: Array<[CursorKind, number, string]> = [
    ["t", 1, ""],
    ["t", 42, "completed,failed"],
    ["a", 7, "open"],
    ["a", 9_007_199_254_740_991, "all"],
    ["s", 3, "running"],
    ["s", 120, "all"],
  ];

  it("encode the same text, and each decodes the other's", () => {
    for (const [kind, seq, filter] of cases) {
      const ours = encodeCursor(kind, seq, filter);
      const theirs = calvin.encodeCursor(kind, seq, filter);
      expect(ours).toBe(theirs);
      expect(decodeCursor(kind, theirs, filter)).toBe(seq);
      expect(calvin.decodeCursor(kind, ours, filter)).toBe(seq);
    }
  });

  it("both refuse another list, another filter, or garbage", () => {
    const cursor = encodeCursor("a", 7, "open");
    for (const decode of [decodeCursor, calvin.decodeCursor]) {
      expect(decode("s", cursor, "open")).toBeNull();
      expect(decode("a", cursor, "all")).toBeNull();
      expect(decode("a", "not a cursor!", "open")).toBeNull();
      expect(decode("a", calvin.encodeCursor("a", 7, "open") + "x", "open")).toBeNull();
    }
  });
});
