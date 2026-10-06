import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  ManagedProject,
  OpenComputerClient,
  ProjectEnvironmentMode,
} from "./api.js";
import type { ResolvedConfig } from "./config.js";
import {
  agentIdFromName,
} from "./project.js";

export interface ProjectBinding {
  version: 1;
  apiUrl: string;
  projectId: string;
  projectName: string;
  agentId: string;
}

/**
 * A binding plus the project's current lifecycle mode. The mode is read from
 * the project record on every resolution and never written to disk: the saved
 * binding names the project, the server says what kind of project it is.
 */
export interface ResolvedProject extends ProjectBinding {
  environmentMode: ProjectEnvironmentMode;
}

export interface ProjectBindingOptions {
  /** Use this project (id or slug) for one command; the saved binding is untouched unless `persist`. */
  project?: string;
  /** Create (or reuse by slug) a project and save it as this checkout's binding. */
  createProjectName?: string;
  /** Save the selected project as the checkout's binding (`opencomputer link`). */
  persist?: boolean;
}

export function projectEnvironmentMode(
  project: Pick<ManagedProject, "environmentMode">,
): ProjectEnvironmentMode {
  return project.environmentMode === "single" ? "single" : "legacy";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The cloud agent id a local agent deploys as: the bound id for the first, `<bound>--<local>` for the rest. */
export function cloudAgentId(
  binding: Pick<ProjectBinding, "agentId">,
  localId: string,
  index: number,
): string {
  return index === 0 ? binding.agentId : `${binding.agentId}--${localId}`;
}

/** The link this checkout carries, if any, read without an API origin check; for tools that only report it. */
export async function readLinkedProject(
  projectRoot: string,
): Promise<ProjectBinding | null> {
  try {
    const value = JSON.parse(
      await readFile(bindingPath(projectRoot), "utf8"),
    ) as Partial<ProjectBinding>;
    return value.version === 1 &&
      typeof value.apiUrl === "string" &&
      typeof value.projectId === "string" &&
      typeof value.projectName === "string" &&
      typeof value.agentId === "string"
      ? (value as ProjectBinding)
      : null;
  } catch {
    return null;
  }
}

/**
 * What a command resolved, printed before it acts: the project and where it
 * lives, and each local agent with the cloud id it deploys as.
 */
export function describeResolution(input: {
  binding: ProjectBinding | null;
  localIds: readonly string[];
  alias?: string;
}): string {
  const { binding, localIds, alias } = input;
  if (!binding) {
    return (
      "Project: not linked. Run `opencomputer link --project <id|slug>` " +
      "or `opencomputer link --create-project <name>`.\n"
    );
  }
  const lines = [
    `Project: ${binding.projectName} (${binding.projectId}) at ${binding.apiUrl}` +
      (alias ? `, alias ${alias}` : ""),
  ];
  for (const [index, localId] of localIds.entries()) {
    lines.push(`Agent:   ${localId} -> ${cloudAgentId(binding, localId, index)}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function findOpenComputerProjectRoot(
  agentRoot: string,
): Promise<string> {
  let directory = resolve(agentRoot);
  for (;;) {
    if (await exists(resolve(directory, "opencomputer", "project.ts"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    "This agent is not inside an OpenComputer app. Run `opencomputer init <directory>` first.",
  );
}

function bindingPath(projectRoot: string): string {
  return resolve(projectRoot, ".opencomputer", "project.json");
}

async function readBinding(
  projectRoot: string,
  apiUrl: string,
): Promise<ProjectBinding | null> {
  try {
    const value = JSON.parse(
      await readFile(bindingPath(projectRoot), "utf8"),
    ) as Partial<ProjectBinding>;
    return value.version === 1 &&
      value.apiUrl === apiUrl &&
      typeof value.projectId === "string" &&
      typeof value.projectName === "string" &&
      typeof value.agentId === "string"
      ? (value as ProjectBinding)
      : null;
  } catch {
    return null;
  }
}

function bindingFor(
  config: ResolvedConfig,
  project: ManagedProject,
): ProjectBinding {
  const agent = project.agents[0];
  if (!agent) throw new Error(`Project ${project.name} has no agent to bind.`);
  return {
    version: 1,
    apiUrl: config.apiUrl,
    projectId: project.id,
    projectName: project.name,
    agentId: agent.id,
  };
}

async function persistBinding(
  projectRoot: string,
  binding: ProjectBinding,
): Promise<ProjectBinding> {
  const directory = dirname(bindingPath(projectRoot));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    bindingPath(projectRoot),
    `${JSON.stringify(binding, null, 2)}\n`,
    { mode: 0o600 },
  );
  return binding;
}

/**
 * Resolve the project a command acts on. Precedence: an explicit `--project`
 * for this command only, then the checkout's saved binding, then a typed
 * error pointing at `opencomputer link`. Only `link` (`persist`) and project
 * creation write `.opencomputer/project.json`; an explicit `--project` on any
 * other command never rewrites what `link` chose.
 */
export async function ensureProjectBinding(
  client: Pick<OpenComputerClient, "projects" | "createProject">,
  config: ResolvedConfig,
  agentRoot: string,
  options: ProjectBindingOptions = {},
): Promise<ResolvedProject> {
  if (options.project && options.createProjectName) {
    throw new Error("--project and --create-project cannot be combined.");
  }
  const projectRoot = await findOpenComputerProjectRoot(agentRoot);
  const projects = await client.projects();
  if (!options.project && !options.createProjectName) {
    const existing = await readBinding(projectRoot, config.apiUrl);
    const current = existing
      ? projects.find(
          (project) =>
            project.id === existing.projectId &&
            project.agents.some((agent) => agent.id === existing.agentId),
        )
      : undefined;
    if (existing && current) {
      return { ...existing, environmentMode: projectEnvironmentMode(current) };
    }
    throw new Error(
      "This app is not connected to a cloud project. Run `opencomputer link --project <id|slug>` or `opencomputer link --create-project <name>`.",
    );
  }

  let project = options.project
    ? projects.find(
        (candidate) =>
          candidate.id === options.project || candidate.slug === options.project,
      )
    : undefined;
  if (options.project && !project) {
    throw new Error(`Project ${options.project} was not found in this account.`);
  }
  let persist = options.persist === true;
  const createName = options.createProjectName;
  if (!project && createName) {
    persist = true;
    const slug = agentIdFromName(createName);
    project =
      projects.find((candidate) => candidate.slug === slug) ??
      (await client.createProject(createName, slug));
  }
  if (!project) {
    throw new Error(
      "This app is not connected to a cloud project. Run `opencomputer link --project <id|slug>` or `opencomputer link --create-project <name>`.",
    );
  }
  const binding = bindingFor(config, project);
  if (persist) await persistBinding(projectRoot, binding);
  return { ...binding, environmentMode: projectEnvironmentMode(project) };
}
