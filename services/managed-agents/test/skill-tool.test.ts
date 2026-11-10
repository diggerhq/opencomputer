import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildSkillTool, readPackagedSkills } from "../src/runtime/skill-tool.js";

async function packagedSkills(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencomputer-skills-"));
  await mkdir(join(root, "billing"), { recursive: true });
  await writeFile(
    join(root, "billing", "SKILL.md"),
    `---\nname: billing\ndescription: How to change what a customer is billed.\n---\n\n# Billing\n\nDefault to invoice mode.\n`,
  );
  await mkdir(join(root, "billing", "examples"), { recursive: true });
  await writeFile(join(root, "billing", "CHECKLIST.md"), "1. Read the customer.\n");
  await writeFile(join(root, "billing", "examples", "upgrade.md"), "An upgrade example.\n");
  await mkdir(join(root, "investigate"), { recursive: true });
  await writeFile(
    join(root, "investigate", "SKILL.md"),
    `---\nname: investigate\ndescription: Reading request logs.\n---\n\nStart from the customer.\n`,
  );
  return root;
}

describe("loading a packaged skill", () => {
  it("reads name, description and body out of the frontmatter", async () => {
    const skills = await readPackagedSkills(await packagedSkills());
    expect(skills.map((s) => s.name)).toEqual(["billing", "investigate"]);
    expect(skills[0]!.description).toBe("How to change what a customer is billed.");
    // The body is what the model needs; the frontmatter is routing.
    expect(skills[0]!.body).toContain("Default to invoice mode.");
    expect(skills[0]!.body).not.toContain("description:");
  });

  it("offers one tool that names every skill it can load", async () => {
    const tool = await buildSkillTool(await packagedSkills());
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("load_agent_skill");
    const added = [tool!] as unknown as Array<Record<string, unknown>>;
    // The model decides whether to ask by reading this, so the catalogue has
    // to be in the description rather than the system prompt.
    expect(String(added[0]!.description)).toContain("billing: How to change");
    expect(String(added[0]!.description)).toContain("investigate: Reading request logs.");
  });

  it("returns the skill body when asked for one", async () => {
    const added = [(await buildSkillTool(await packagedSkills()))!] as unknown as Array<Record<string, unknown>>;
    const execute = added[0]!.execute as (
      input: unknown,
    ) => Promise<{ content: string }>;
    await expect(execute({ name: "billing" })).resolves.toEqual({
      content: expect.stringContaining("Default to invoice mode."),
    });
  });

  it("names the skills that do exist when asked for one that does not", async () => {
    const added = [(await buildSkillTool(await packagedSkills()))!] as unknown as Array<Record<string, unknown>>;
    const execute = added[0]!.execute as (
      input: unknown,
    ) => Promise<{ content: string }>;
    const result = await execute({ name: "nonsense" });
    // A model that asked wrongly can then ask rightly.
    expect(result.content).toContain("billing, investigate");
  });

  it("registers nothing when the agent shipped no skills", async () => {
    expect(await buildSkillTool(join(tmpdir(), "no-such-dir"))).toBeNull();
  });

  it("lists the files packaged beside the procedure", async () => {
    const skills = await readPackagedSkills(await packagedSkills());
    // The docs tell authors to put longer material beside SKILL.md; nested
    // files count, and SKILL.md itself does not.
    expect(skills[0]!.files).toEqual(["CHECKLIST.md", "examples/upgrade.md"]);
    expect(skills[1]!.files).toEqual([]);
  });

  it("tells the model what else it can load, and loads it", async () => {
    const tool = (await buildSkillTool(await packagedSkills()))!;
    const first = await tool.execute({ name: "billing" });
    expect(first.content).toContain("Default to invoice mode.");
    expect(first.content).toContain("CHECKLIST.md, examples/upgrade.md");

    await expect(tool.execute({ name: "billing", file: "CHECKLIST.md" })).resolves.toEqual({
      content: expect.stringContaining("Read the customer."),
    });
    await expect(
      tool.execute({ name: "billing", file: "examples/upgrade.md" }),
    ).resolves.toEqual({ content: expect.stringContaining("An upgrade example.") });
  });

  it("serves only files packaged with that skill", async () => {
    const tool = (await buildSkillTool(await packagedSkills()))!;
    // Matched against the list read from disk, so a path cannot be used to
    // reach anything the skill did not ship.
    const escape = await tool.execute({ name: "billing", file: "../investigate/SKILL.md" });
    expect(escape.content).toContain("has no file");
    const absolute = await tool.execute({ name: "billing", file: "/etc/passwd" });
    expect(absolute.content).toContain("has no file");
  });
});
