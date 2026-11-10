import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildSkillToolFromSkills,
  parseSkill,
  type PackagedSkill,
  type SkillToolDefinition,
} from "./skill-tool-core.js";

/**
 * Loading a packaged skill, on demand.
 *
 * OpenCode delivers a skill body two ways — `session.skill()`, and skills
 * attached to a prompt — and a plugin can reach neither: `SessionDomain` picks
 * `prompt`, `generate`, `command` and the rest, but deliberately not `skill`.
 * Attaching at prompt time would mean choosing before the model has read the
 * question, which is the one decision the model is better at than we are.
 *
 * So the body is served as a tool result instead. The model asks for a skill
 * when it decides it needs one, mid-turn, and nothing is in context until it
 * does — which is what the documentation already promises and what an agent
 * prompt saying "load the matching skill before acting" already assumes.
 */

/** Every file beside `SKILL.md`, including nested ones, as relative paths. */
async function supportingFiles(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await supportingFiles(resolve(directory, entry.name), relative)));
    } else if (relative !== "SKILL.md") {
      files.push(relative);
    }
  }
  return files;
}

export async function readPackagedSkills(
  directory: string,
): Promise<PackagedSkill[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const skills: PackagedSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const home = resolve(directory, entry.name);
    const file = resolve(home, "SKILL.md");
    if (!existsSync(file)) continue;
    const skill = parseSkill(entry.name, await readFile(file, "utf8"));
    skills.push({
      ...skill,
      files: await supportingFiles(home),
      read: (supportingFile) => readFile(resolve(home, supportingFile), "utf8"),
    });
  }
  return skills;
}

export type { SkillToolDefinition } from "./skill-tool-core.js";

/**
 * Build the tool, if this agent shipped any skills.
 *
 * Returned rather than registered, so the caller can add it inside the same
 * `tool.transform` as everything else — a second, separate transform did not
 * survive, and the tool never reached the model.
 *
 * The descriptions go in the tool's own description rather than the system
 * prompt: the model needs to know what is available to decide whether to ask,
 * and a tool description is where it already looks.
 */
export async function buildSkillTool(
  directory: string,
): Promise<SkillToolDefinition | null> {
  const skills = await readPackagedSkills(directory);
  return buildSkillToolFromSkills(skills);
}
