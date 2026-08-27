import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { RepositoryManifestDefinition } from "./project.js";

const execFileAsync = promisify(execFile);

export interface LocalRepositoryCheckout {
  id: string;
  mirror: string;
  checkout: string;
  defaultBranch: string;
  sessionBranch: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(
  args: string[],
  options: { cwd?: string; publicOnly?: boolean } = {},
): Promise<string> {
  const command = options.publicOnly
    ? ["-c", "credential.helper=", ...args]
    : args;
  const { stdout } = await execFileAsync("git", command, {
    cwd: options.cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function inside(root: string, path: string, label: string): string {
  const target = resolve(root, path);
  const offset = relative(root, target);
  if (offset.startsWith("..") || offset === "" || offset.includes("\0")) {
    throw new Error(`${label} escapes the local runtime`);
  }
  return target;
}

function githubURL(repository: RepositoryManifestDefinition): string {
  return `https://github.com/${repository.source.owner}/${repository.source.name}.git`;
}

export async function provisionLocalRepositories(
  agentRoot: string,
  runtime: string,
  options: {
    sourceURL?: (repository: RepositoryManifestDefinition) => string;
    sessionRef?: string;
  } = {},
): Promise<LocalRepositoryCheckout[]> {
  const manifest = JSON.parse(
    await readFile(
      resolve(runtime, ".opencomputer", "reactive.json"),
      "utf8",
    ),
  ) as { repositories?: RepositoryManifestDefinition[] };
  const repositories = manifest.repositories ?? [];
  const stateRoot = resolve(agentRoot, ".opencomputer", "mirrors");
  await mkdir(stateRoot, { recursive: true });
  const checkouts: LocalRepositoryCheckout[] = [];

  if (repositories.length) {
    await git(["init", runtime]);
  }

  for (const repository of repositories) {
    const mirror = inside(stateRoot, `${repository.id}.git`, "Mirror path");
    const source = options.sourceURL?.(repository) ?? githubURL(repository);
    const publicOnly = repository.source.auth === "public";
    if (!(await exists(resolve(mirror, "HEAD")))) {
      await rm(mirror, { recursive: true, force: true });
      await git(["clone", "--bare", source, mirror], { publicOnly });
    }
    const defaultRef = await git(["symbolic-ref", "HEAD"], { cwd: mirror });
    if (!defaultRef.startsWith("refs/heads/")) {
      throw new Error(`Repository ${repository.id} has no default branch`);
    }
    const defaultBranch = defaultRef.slice("refs/heads/".length);
    await git(
      [
        "fetch",
        source,
        `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`,
      ],
      { cwd: mirror, publicOnly },
    );

    const checkout = inside(
      runtime,
      repository.workspace.path,
      `Repository ${repository.id} workspace path`,
    );
    await mkdir(dirname(checkout), { recursive: true });
    await rm(checkout, { recursive: true, force: true });
    await git(["clone", mirror, checkout]);
    const sessionBranch = options.sessionRef ?? "opencomputer/local";
    await git(["checkout", "-B", sessionBranch, `origin/${defaultBranch}`], {
      cwd: checkout,
    });
    if (repository.workspace.access === "read-only") {
      await git(["remote", "set-url", "--push", "origin", "disabled"], {
        cwd: checkout,
      });
    }
    checkouts.push({
      id: repository.id,
      mirror,
      checkout,
      defaultBranch,
      sessionBranch,
    });
  }
  return checkouts;
}
