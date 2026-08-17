import { describe, expect, it } from "vitest";
import { scoreOutput } from "./evals";

const pass = (scores: { name: string; pass: boolean }[], name: string) =>
  scores.find((s) => s.name === name)?.pass;

describe("evals scoreOutput", () => {
  it("always scores completion from the turn outcome", () => {
    expect(pass(scoreOutput({}, { output: "hi", outcome: "ok", tools: [] }), "completed")).toBe(true);
    expect(pass(scoreOutput({}, { output: "", outcome: "error", tools: [] }), "completed")).toBe(false);
  });

  it("contains: case-insensitive, all substrings required", () => {
    const obs = { output: "Paris is the capital, and 12*13 = 156.", outcome: "ok", tools: [] };
    expect(pass(scoreOutput({ contains: ["paris", "156"] }, obs), "contains")).toBe(true);
    expect(pass(scoreOutput({ contains: ["paris", "999"] }, obs), "contains")).toBe(false);
  });

  it("equals: normalized (trim + case)", () => {
    expect(pass(scoreOutput({ equals: "yes" }, { output: "  YES ", outcome: "ok", tools: [] }), "equals")).toBe(true);
    expect(pass(scoreOutput({ equals: "yes" }, { output: "no", outcome: "ok", tools: [] }), "equals")).toBe(false);
  });

  it("regex: case-insensitive; invalid regex fails safe", () => {
    expect(pass(scoreOutput({ iregex: "^\\d+$" }, { output: "42", outcome: "ok", tools: [] }), "regex")).toBe(true);
    const bad = scoreOutput({ iregex: "(" }, { output: "x", outcome: "ok", tools: [] });
    expect(pass(bad, "regex")).toBe(false);
    expect(bad.find((s) => s.name === "regex")?.detail).toBe("invalid regex");
  });

  it("tools: every named tool must be called", () => {
    const obs = { output: "done", outcome: "ok", tools: ["bash", "read"] };
    expect(pass(scoreOutput({ tools: ["bash"] }, obs), "tools")).toBe(true);
    expect(pass(scoreOutput({ tools: ["bash", "write"] }, obs), "tools")).toBe(false);
  });

  it("cost: at or under budget", () => {
    expect(pass(scoreOutput({ max_cost_usd: 0.05 }, { output: "x", outcome: "ok", cost_usd: 0.02, tools: [] }), "cost")).toBe(true);
    expect(pass(scoreOutput({ max_cost_usd: 0.05 }, { output: "x", outcome: "ok", cost_usd: 0.10, tools: [] }), "cost")).toBe(false);
  });

  it("only emits scores for declared expectations (plus completion)", () => {
    const names = scoreOutput({ contains: ["a"] }, { output: "a", outcome: "ok", tools: [] }).map((s) => s.name);
    expect(names).toEqual(["completed", "contains"]);
  });
});
