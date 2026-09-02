import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ManagedProject, OpenComputerClient } from "./api.js";
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

export interface ProjectBindingOptions {
  project?: string;
  createProjectName?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

async function persistBinding(
  projectRoot: string,
  config: ResolvedConfig,
  project: ManagedProject,
): Promise<ProjectBinding> {
  const agent = project.agents[0];
  if (!agent) throw new Error(`Project ${project.name} has no agent to bind.`);
  const binding: ProjectBinding = {
    version: 1,
    apiUrl: config.apiUrl,
    projectId: project.id,
    projectName: project.name,
    agentId: agent.id,
  };
  const directory = dirname(bindingPath(projectRoot));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    bindingPath(projectRoot),
    `${JSON.stringify(binding, null, 2)}\n`,
    { mode: 0o600 },
  );
  return binding;
}

export async function ensureProjectBinding(
  client: Pick<OpenComputerClient, "projects" | "createProject">,
  config: ResolvedConfig,
  agentRoot: string,
  options: ProjectBindingOptions = {},
): Promise<ProjectBinding> {
  if (options.project && options.createProjectName) {
    throw new Error("--project and --create-project cannot be combined.");
  }
  const projectRoot = await findOpenComputerProjectRoot(agentRoot);
  const projects = await client.projects();
  if (!options.project && !options.createProjectName) {
    const existing = await readBinding(projectRoot, config.apiUrl);
    if (
      existing &&
      projects.some(
        (project) =>
          project.id === existing.projectId &&
          project.agents.some((agent) => agent.id === existing.agentId),
      )
    ) {
      return existing;
    }
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
  let createName = options.createProjectName;
  if (!project && createName) {
    const slug = agentIdFromName(createName);
    project = projects.find((candidate) => candidate.slug === slug);
  }
  if (!project && !createName) {
    throw new Error(
      "This app is not connected to a cloud project. Run `opencomputer link --project <id|slug>` or `opencomputer link --create-project <name>`.",
    );
  }
  project ??= await client.createProject(
    createName!,
    agentIdFromName(createName!),
  );
  return persistBinding(projectRoot, config, project);
}
