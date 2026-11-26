import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Repo } from "@pierre/storage";

const execFileAsync = promisify(execFile);
const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_BUILD_BUNDLE_BYTES = 20 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const LINKED_PROJECT_MANIFEST = `schema = 1
[template]
name = "Linked repository deployment"
description = "Internal build metadata for an existing OpenComputer project."
`;

function isSensitiveEnvironmentFile(segment: string): boolean {
  return (
    /^\.env(?:\.|$)/.test(segment) &&
    !/\.(?:example|sample|template)$/.test(segment)
  );
}

function safeRepositoryPath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Buffer.byteLength(path) > MAX_PATH_BYTES
  ) {
    throw new Error(`Template source contains an invalid path: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment === ".git" ||
        segment === "node_modules" ||
        isSensitiveEnvironmentFile(segment),
    )
  ) {
    throw new Error(`Template source contains a forbidden path: ${path}`);
  }
  return segments.join("/");
}

async function responseBytes(
  response: Response,
  expectedSize: number,
): Promise<Uint8Array> {
  if (!response.ok) {
    throw new Error(`Code.Storage file read failed (${response.status})`);
  }
  if (!response.body) throw new Error("Code.Storage returned an empty file body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > expectedSize || size > MAX_FILE_BYTES) {
      await reader.cancel();
      throw new Error("Code.Storage file exceeded its declared size");
    }
    chunks.push(value);
  }
  if (size !== expectedSize) {
    throw new Error("Code.Storage file size did not match its metadata");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function materializeTemplateSnapshot(
  repository: Pick<Repo, "listFilesWithMetadata" | "getFileStream">,
  commitSha: string,
  destination: string,
): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error("Template build requires an immutable commit SHA");
  }
  const files: Array<{ path: string; size: number; type?: string }> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let totalSize = 0;
  do {
    const page = await repository.listFilesWithMetadata({
      ref: commitSha,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    for (const file of page.files) {
      if (file.type && file.type !== "blob") {
        throw new Error(
          `Template source must contain regular files only: ${file.path}`,
        );
      }
      const path = safeRepositoryPath(file.path);
      if (seen.has(path)) throw new Error(`Duplicate template path: ${path}`);
      seen.add(path);
      if (!Number.isSafeInteger(file.size) || file.size < 0) {
        throw new Error(`Template source has an invalid file size: ${path}`);
      }
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(`Template source file exceeds 2 MiB: ${path}`);
      }
      totalSize += file.size;
      if (totalSize > MAX_SOURCE_BYTES) {
        throw new Error("Template source exceeds 20 MiB");
      }
      files.push({ path, size: file.size, ...(file.type ? { type: file.type } : {}) });
      if (files.length > MAX_FILES) {
        throw new Error(`Template source exceeds ${MAX_FILES} files`);
      }
    }
    cursor = page.hasMore ? page.nextCursor : undefined;
    if (page.hasMore && !cursor) {
      throw new Error("Code.Storage file listing did not provide a cursor");
    }
  } while (cursor);

  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const response = await repository.getFileStream({
      path: file.path,
      ref: commitSha,
    });
    const bytes = await responseBytes(response, file.size);
    const target = resolve(destination, file.path);
    if (!target.startsWith(`${resolve(destination)}/`)) {
      throw new Error(`Template source escaped its destination: ${file.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: 0o600 });
  }
}

function diagnostic(error: unknown): string {
  const value = error as { stdout?: string | Buffer; stderr?: string | Buffer };
  return String(value.stderr || value.stdout || error)
    .replace(/https:\/\/t:[^@\s]+@/g, "https://t:[redacted]@")
    .slice(-4_000);
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {},
): Promise<void> {
  try {
    await execFileAsync(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      timeout: (options.timeout ?? 300) * 1_000,
      maxBuffer: 64_000,
    });
  } catch (error) {
    throw new Error(`${command} failed: ${diagnostic(error)}`);
  }
}

export async function buildMirroredTemplate(input: {
  repository: Pick<Repo, "listFilesWithMetadata" | "getFileStream">;
  commitSha: string;
  cliSource: { repositoryUrl: string; commitSha: string };
}): Promise<unknown> {
  if (!/^[0-9a-f]{40}$/.test(input.cliSource.commitSha)) {
    throw new Error("Template compiler source requires an immutable commit SHA");
  }
  const root = await mkdtemp(join(tmpdir(), "opencomputer-template-"));
  const sourceRoot = join(root, "source");
  try {
    await materializeTemplateSnapshot(
      input.repository,
      input.commitSha,
      sourceRoot,
    );
    return await compileTemplateSource(root, sourceRoot, input.cliSource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Checks out one commit of a GitHub repository with a short-lived installation
 * token and compiles it. The token travels in an `Authorization` header set
 * through git's `GIT_CONFIG_*` environment rather than the remote URL or the
 * command line, so it never reaches logs, `/proc/<pid>/cmdline`, or the
 * checkout's `.git/config` remote.
 */
export async function buildGitCommit(input: {
  repositoryUrl: string;
  token: string;
  ref: string;
  commitSha: string;
  /** Repo-relative directory the template compiles from; omit for the root. */
  path?: string;
  cliSource: { repositoryUrl: string; commitSha: string };
}): Promise<unknown> {
  if (!/^[0-9a-f]{40}$/.test(input.commitSha)) {
    throw new Error("Git builds require an immutable commit SHA");
  }
  if (!/^refs\/(heads|pull)\/[^\s~^:?*[\\]+$/.test(input.ref)) {
    throw new Error(`Git builds require a branch or pull request ref: ${input.ref}`);
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/.test(input.repositoryUrl)) {
    throw new Error("Git builds only clone github.com repositories");
  }
  if (input.path !== undefined) {
    const segments = input.path.split("/");
    if (
      !input.path ||
      input.path.length > 500 ||
      input.path.startsWith("/") ||
      input.path.endsWith("/") ||
      input.path.includes("\\") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error(`Invalid source directory: ${input.path}`);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "opencomputer-git-build-"));
  const sourceRoot = join(root, "source");
  const authorization = `Authorization: Basic ${Buffer.from(
    `x-access-token:${input.token}`,
  ).toString("base64")}`;
  const gitEnv: Record<string, string> = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: authorization,
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[], options: { cwd?: string; timeout?: number } = {}) =>
    run("git", args, { ...options, env: gitEnv });
  try {
    await mkdir(sourceRoot, { recursive: true });
    await git(["init", "--quiet", sourceRoot]);
    await git(["remote", "add", "origin", input.repositoryUrl], { cwd: sourceRoot });
    await git(
      ["fetch", "--quiet", "--depth", "1", "origin", `${input.ref}:refs/remotes/origin/build`],
      { cwd: sourceRoot, timeout: 300 },
    );
    try {
      await git(["checkout", "--quiet", "--detach", input.commitSha], { cwd: sourceRoot });
    } catch {
      // The ref moved past the requested commit: the newer push will build it.
      throw new Error(
        `Commit ${input.commitSha} is no longer the tip of ${input.ref}; a newer build supersedes it`,
      );
    }
    await rm(join(sourceRoot, ".git"), { recursive: true, force: true });
    await removeSensitiveFiles(sourceRoot);
    const compileRoot = input.path ? join(sourceRoot, input.path) : sourceRoot;
    const compileStat = await stat(compileRoot).catch(() => null);
    if (!compileStat?.isDirectory()) {
      throw new Error(
        `Directory ${input.path ?? ""} was not found in ${input.repositoryUrl} at ${input.commitSha}`,
      );
    }
    await prepareLinkedProjectSource(compileRoot);
    return await compileTemplateSource(root, compileRoot, input.cliSource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Linked repository deployments compile the project's agents and resources,
 * not an installable template. The shared CLI bundle compiler currently
 * accepts template-shaped metadata, so create that metadata only inside the
 * disposable checkout instead of requiring `oc-template.toml` from users.
 * Remove an existing entry first so a repository symlink cannot redirect the
 * write outside the checkout and repository template metadata cannot affect a
 * linked project's deployment.
 */
export async function prepareLinkedProjectSource(
  sourceRoot: string,
): Promise<void> {
  const manifest = join(sourceRoot, "oc-template.toml");
  await rm(manifest, { recursive: true, force: true });
  await writeFile(manifest, LINKED_PROJECT_MANIFEST, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function removeSensitiveFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        await rm(path, { recursive: true, force: true });
      } else {
        await removeSensitiveFiles(path);
      }
    } else if (isSensitiveEnvironmentFile(entry.name)) {
      await rm(path, { force: true });
    }
  }
}

async function compileTemplateSource(
  root: string,
  sourceRoot: string,
  cliSource: { repositoryUrl: string; commitSha: string },
): Promise<unknown> {
  const compilerRoot = join(root, "opencomputer");
  const output = join(root, "bundle.json");
  {
    await run("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      cliSource.repositoryUrl,
      compilerRoot,
    ]);
    await run("git", ["checkout", "--detach", cliSource.commitSha], {
      cwd: compilerRoot,
    });
    await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], {
      cwd: join(compilerRoot, "cli"),
      timeout: 600,
    });
    await run("npm", ["run", "build:server"], {
      cwd: join(compilerRoot, "cli"),
      timeout: 600,
    });
    await run(
      process.execPath,
      [
        join(compilerRoot, "cli", "dist", "index.js"),
        "template",
        "build",
        sourceRoot,
        "--output",
        output,
      ],
      { timeout: 600 },
    );
    const metadata = await stat(output);
    if (!metadata.isFile() || !metadata.size || metadata.size > MAX_BUILD_BUNDLE_BYTES) {
      throw new Error("Template build bundle is empty or exceeds the size limit");
    }
    return JSON.parse(await readFile(output, "utf8")) as unknown;
  }
}
