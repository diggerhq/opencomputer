// Node-only: bundle an agent DIRECTORY into a deploy (design 009 §4/§13). "An agent is a
// directory": agent.toml (manifest) + prompt.md + skills/. Reads the tree, ensures the agent
// exists (idempotent by name), and deploys a revision. NOT browser-safe (fs) — exported from
// `@opencomputer/sdk/node`, never the browser entry.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { OpenComputer } from "./client.js";
import type { Runtime } from "./types.js";
import type { DeployResult, SkillFileInput } from "./revisions.js";

export interface AgentManifest {
  name: string;
  model: string;
  runtime: Runtime;        // [runtime] family (claude | codex)
  runtimeType: "default" | "custom";
  limits?: Record<string, unknown>;
}

/** Parse agent.toml (the manifest). Requires `name` + `model`; defaults runtime to claude/default. */
export function readManifest(dir: string): AgentManifest {
  const path = join(dir, "agent.toml");
  if (!existsSync(path)) throw new Error(`no agent.toml in ${dir} — an agent directory needs a manifest`);
  const t = parseToml(readFileSync(path, "utf8")) as Record<string, any>;
  const name = typeof t.name === "string" ? t.name : undefined;
  const model = typeof t.model === "string" ? t.model : undefined;
  if (!name) throw new Error("agent.toml: `name` is required");
  if (!model) throw new Error("agent.toml: `model` is required");
  const runtime = (t.runtime?.family ?? "claude") as Runtime;
  const runtimeType = (t.runtime?.type ?? "default") as "default" | "custom";
  return { name, model, runtime, runtimeType, limits: t.limits as Record<string, unknown> | undefined };
}

/** Read prompt.md (the system prompt). Required. */
export function readPrompt(dir: string): string {
  const path = join(dir, "prompt.md");
  if (!existsSync(path)) throw new Error(`no prompt.md in ${dir}`);
  return readFileSync(path, "utf8");
}

/** Walk skills/ → SkillFileInput[] with SKILL-ROOT-relative paths (the leading `skills/` stripped),
 *  mode 0755 for executable files else 0644. Absent skills/ ⇒ []. */
export function readSkills(dir: string): SkillFileInput[] {
  const root = join(dir, "skills");
  if (!existsSync(root)) return [];
  const out: SkillFileInput[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue; // skip symlinks/sockets — not transported
      const st = statSync(full);
      out.push({
        path: relative(root, full).split("\\").join("/"),
        content: readFileSync(full, "utf8"),
        mode: st.mode & 0o111 ? 0o755 : 0o644,
      });
    }
  };
  walk(root);
  return out;
}

export interface DeployAgentDirOptions { activate?: boolean; gitSha?: string; }
export interface DeployAgentDirResult { agentId: string; agentName: string; manifest: AgentManifest; deploy: DeployResult; }

/**
 * Deploy an agent directory: ensure the agent exists (create-or-get, idempotent by name), then
 * deploy a revision carrying prompt.md + skills/. Note: a brand-new agent's create makes
 * revision #1 (prompt only); the subsequent deploy adds skills as the next revision (a no-skills
 * deploy dedups to a no-op). Returns the agent + the deploy result.
 */
export async function deployAgentDir(oc: OpenComputer, dir: string, opts: DeployAgentDirOptions = {}): Promise<DeployAgentDirResult> {
  const manifest = readManifest(dir);
  const prompt = readPrompt(dir);
  const skills = readSkills(dir);
  const agent = await oc.agents.create({ name: manifest.name, prompt, model: manifest.model, runtime: manifest.runtime });
  const deploy = await oc.agents.revisions.create(agent.id, {
    prompt,
    model: manifest.model,
    skills,
    runtime: { type: manifest.runtimeType },
    activate: opts.activate ?? true,
    source: { via: "cli", path: dir, gitSha: opts.gitSha },
  });
  return { agentId: agent.id, agentName: agent.name, manifest, deploy };
}
