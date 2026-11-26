import { describe, expect, it } from "vitest";

import {
  buildArtifactSkillTool,
  packagedSkillsFromArtifact,
} from "../src/workerd-runtime/skills.js";

function artifact(): Map<string, string> {
  return new Map([
    [
      ".opencode/skills/billing/SKILL.md",
      "---\nname: billing\ndescription: Handle billing changes safely.\n---\n\n# Billing\n\nFollow the checklist.\n",
    ],
    [".opencode/skills/billing/CHECKLIST.md", "1. Verify the customer.\n"],
    [".opencode/skills/billing/examples/upgrade.md", "Upgrade example.\n"],
    [
      ".opencode/skills/investigate/SKILL.md",
      "---\nname: investigate\ndescription: Investigate request failures.\n---\n\nStart with the trace.\n",
    ],
    ["agent.js", "export default () => ''"],
  ]);
}

describe("Workerd artifact skills", () => {
  it("projects skill bodies and supporting files from the immutable artifact", async () => {
    const skills = packagedSkillsFromArtifact(artifact());
    expect(skills.map((skill) => skill.name)).toEqual(["billing", "investigate"]);
    expect(skills[0]).toMatchObject({
      description: "Handle billing changes safely.",
      files: ["CHECKLIST.md", "examples/upgrade.md"],
    });

    const tool = buildArtifactSkillTool(artifact());
    expect(tool?.description).toContain("billing: Handle billing changes safely.");
    await expect(tool?.execute({ name: "billing" })).resolves.toEqual({
      content: expect.stringContaining("Follow the checklist."),
    });
    await expect(
      tool?.execute({ name: "billing", file: "examples/upgrade.md" }),
    ).resolves.toEqual({ content: "Upgrade example.\n" });
  });

  it("cannot read outside the selected skill", async () => {
    const tool = buildArtifactSkillTool(artifact());
    await expect(
      tool?.execute({ name: "billing", file: "../investigate/SKILL.md" }),
    ).resolves.toEqual({
      content: expect.stringContaining("has no file"),
    });
    await expect(
      tool?.execute({ name: "billing", file: "/etc/passwd" }),
    ).resolves.toEqual({
      content: expect.stringContaining("has no file"),
    });
  });

  it("ignores skill files outside the direct packaged-skill layout", () => {
    const files = artifact();
    files.set(".opencode/skills/nested/child/SKILL.md", "nested");
    files.set("skills/unpackaged/SKILL.md", "unpackaged");
    expect(packagedSkillsFromArtifact(files).map((skill) => skill.name)).toEqual([
      "billing",
      "investigate",
    ]);
  });
});
