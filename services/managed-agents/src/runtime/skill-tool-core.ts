/** A skill whose contents are already constrained to one packaged source. */
export interface PackagedSkill {
  name: string;
  description: string;
  body: string;
  /** Anything beside `SKILL.md`, relative to the skill's own directory. */
  files: string[];
  read(file: string): Promise<string>;
}

/** `SKILL.md` opens with YAML frontmatter naming and describing the skill. */
export function parseSkill(
  name: string,
  source: string,
): Pick<PackagedSkill, "name" | "description" | "body"> {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  const frontmatter = match?.[1] ?? "";
  const described = /^description:\s*(.+)$/m.exec(frontmatter);
  const named = /^name:\s*(.+)$/m.exec(frontmatter);
  return {
    name: named?.[1]?.trim() || name,
    description: described?.[1]?.trim() ?? "",
    body: match ? source.slice(match[0].length) : source,
  };
}

export interface SkillToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute: (rawInput: unknown) => Promise<{ content: string }>;
}

/** Build the runtime tool from skills already bounded to their package. */
export function buildSkillToolFromSkills(
  skills: readonly PackagedSkill[],
): SkillToolDefinition | null {
  if (!skills.length) return null;

  const catalogue = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  return {
    // Both "skill" and "use_skill" are OpenCode's own — registering either
    // gets shadowed by a built-in that is gated off.
    name: "load_agent_skill",
    description:
      "Load a skill: a procedure this agent was given for a particular kind " +
      "of work. Call it before acting when one applies — the instructions are " +
      "returned to you directly. Available skills:\n" + catalogue,
    input: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "The skill to load.",
          enum: skills.map((skill) => skill.name),
        },
        file: {
          type: "string",
          description:
            "A supporting file packaged with that skill, when its procedure " +
            "tells you to read one. Omit to load the procedure itself.",
        },
      },
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async (rawInput: unknown) => {
      const given =
        rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {};
      const requested = String(given.name ?? "");
      const skill = skills.find((candidate) => candidate.name === requested);
      if (!skill) {
        return {
          content:
            `There is no skill called ${JSON.stringify(requested)}. ` +
            `Available: ${skills.map((candidate) => candidate.name).join(", ")}.`,
        };
      }

      const wanted = typeof given.file === "string" ? given.file.trim() : "";
      if (wanted) {
        if (!skill.files.includes(wanted)) {
          return {
            content: skill.files.length
              ? `${skill.name} has no file ${JSON.stringify(wanted)}. ` +
                `It has: ${skill.files.join(", ")}.`
              : `${skill.name} has no supporting files.`,
          };
        }
        return { content: await skill.read(wanted) };
      }

      const note = skill.files.length
        ? `\n\nSupporting files, each loadable by calling this tool again ` +
          `with file set: ${skill.files.join(", ")}.`
        : "";
      return { content: skill.body + note };
    },
  };
}
