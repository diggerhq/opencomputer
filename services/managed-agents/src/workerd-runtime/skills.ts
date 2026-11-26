import {
  buildSkillToolFromSkills,
  parseSkill,
  type PackagedSkill,
  type SkillToolDefinition,
} from "../runtime/skill-tool-core.js";

const skillsPrefix = ".opencode/skills/";
const skillEntry = /^\.opencode\/skills\/([^/]+)\/SKILL\.md$/;

/** Build skills directly from the deployment's already-validated artifact. */
export function packagedSkillsFromArtifact(
  artifact: ReadonlyMap<string, string>,
): PackagedSkill[] {
  const skills: PackagedSkill[] = [];
  for (const [path, source] of [...artifact.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const match = skillEntry.exec(path);
    const directory = match?.[1];
    if (!directory) continue;
    const prefix = `${skillsPrefix}${directory}/`;
    const supporting = [...artifact.entries()]
      .filter(([candidate]) => candidate.startsWith(prefix) && candidate !== path)
      .map(([candidate, content]) => [candidate.slice(prefix.length), content] as const)
      .filter(([relative]) => relative.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    const files = supporting.map(([relative]) => relative);
    const contents = new Map(supporting);
    skills.push({
      ...parseSkill(directory, source),
      files,
      read: async (file) => {
        const content = contents.get(file);
        if (content === undefined) {
          throw new Error(
            `Skill supporting file ${JSON.stringify(file)} was not packaged`,
          );
        }
        return content;
      },
    });
  }
  return skills;
}

export function buildArtifactSkillTool(
  artifact: ReadonlyMap<string, string>,
): SkillToolDefinition | null {
  return buildSkillToolFromSkills(packagedSkillsFromArtifact(artifact));
}
