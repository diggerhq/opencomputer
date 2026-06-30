import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, readPrompt, readSkills } from "./node-deploy.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-agentdir-"));
  writeFileSync(join(dir, "agent.toml"), [
    'name  = "issue-fixer"',
    'model = "anthropic/claude-sonnet-4-6"',
    "",
    "[runtime]",
    'family = "claude"',
    'type   = "default"',
    "",
    "[limits]",
    "turns = 24",
  ].join("\n"));
  writeFileSync(join(dir, "prompt.md"), "You fix issues.\n");
  mkdirSync(join(dir, "skills/triage"), { recursive: true });
  writeFileSync(join(dir, "skills/triage/SKILL.md"), "# Triage\n");
  writeFileSync(join(dir, "skills/triage/run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(dir, "skills/triage/run.sh"), 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("deployAgentDir directory reading", () => {
  it("parses agent.toml (smol-toml): name/model/runtime/type/limits", () => {
    const m = readManifest(dir);
    expect(m.name).toBe("issue-fixer");
    expect(m.model).toBe("anthropic/claude-sonnet-4-6");
    expect(m.runtime).toBe("claude");
    expect(m.runtimeType).toBe("default");
    expect(m.limits).toEqual({ turns: 24 });
  });

  it("requires name + model", () => {
    const bad = mkdtempSync(join(tmpdir(), "oc-bad-"));
    writeFileSync(join(bad, "agent.toml"), 'model = "anthropic/x"');
    expect(() => readManifest(bad)).toThrow(/name/);
    rmSync(bad, { recursive: true, force: true });
  });

  it("reads prompt.md", () => {
    expect(readPrompt(dir)).toBe("You fix issues.\n");
  });

  it("walks skills/ with skill-root-relative paths + exec → 0755", () => {
    const skills = readSkills(dir).sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(skills.map((s) => s.path)).toEqual(["triage/SKILL.md", "triage/run.sh"]);
    const run = skills.find((s) => s.path === "triage/run.sh")!;
    const md = skills.find((s) => s.path === "triage/SKILL.md")!;
    expect(run.mode).toBe(0o755);
    expect(md.mode).toBe(0o644);
    expect(md.content).toBe("# Triage\n");
  });

  it("absent skills/ → empty array", () => {
    const noskills = mkdtempSync(join(tmpdir(), "oc-noskills-"));
    expect(readSkills(noskills)).toEqual([]);
    rmSync(noskills, { recursive: true, force: true });
  });
});
