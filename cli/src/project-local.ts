import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, posix, resolve } from "node:path";

const MAX_PROJECT_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_LIST_BYTES = 8 * 1024 * 1024;

async function pathDoesNotExist(path: string): Promise<void> {
  await access(path)
    .then(() => {
      throw new Error(`Refusing to replace existing path: ${path}`);
    })
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    });
}

function listArchive(path: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["-tzf", path], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_ARCHIVE_LIST_BYTES) {
        child.kill();
        reject(new Error("Project archive contains too many paths"));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Could not inspect project archive (tar exited ${code})`));
        return;
      }
      resolvePromise(stdout.split("\n").filter(Boolean));
    });
  });
}

function validateArchivePaths(paths: string[]): void {
  if (!paths.length) throw new Error("Project archive is empty");
  for (const path of paths) {
    const normalized = posix.normalize(path.replace(/^\.\//, ""));
    if (
      path.includes("\0") ||
      isAbsolute(path) ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error("Project archive contains an unsafe path");
    }
  }
}

function extractArchive(path: string, directory: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", path, "-C", directory, "--no-same-owner", "--no-same-permissions"],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Could not extract project archive (tar exited ${code})`));
    });
  });
}

export async function materializeProjectArchive(input: {
  response: Response;
  directory: string;
}): Promise<{ directory: string; bytes: number }> {
  const target = resolve(input.directory);
  await pathDoesNotExist(target);
  if (!input.response.body) throw new Error("Project archive response was empty");

  const temporary = await mkdtemp(resolve(tmpdir(), "opencomputer-project-"));
  const archivePath = resolve(temporary, "project.tar.gz");
  const extractPath = resolve(temporary, "project");
  let bytes = 0;
  try {
    const archive = await open(archivePath, "wx", 0o600);
    try {
      const reader = input.response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_PROJECT_ARCHIVE_BYTES) {
          await reader.cancel();
          throw new Error("Project archive exceeds the 512 MB download limit");
        }
        await archive.write(value);
      }
    } finally {
      await archive.close();
    }
    validateArchivePaths(await listArchive(archivePath));
    await mkdir(extractPath);
    await extractArchive(archivePath, extractPath);
    await mkdir(resolve(target, ".."), { recursive: true });
    await rename(extractPath, target);
    return { directory: target, bytes };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
