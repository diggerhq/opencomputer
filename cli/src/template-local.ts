import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface TemplateCheckout {
  directory: string;
  commitSha: string;
}

export function defaultTemplateDirectory(repositoryUrl: string): string {
  return basename(new URL(repositoryUrl).pathname);
}

function runGit(args: string[], capture = false): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`git ${args[0]} failed with exit code ${code}`));
    });
  });
}

export async function materializeTemplateCheckout(
  repositoryUrl: string,
  commitSha: string,
  directory = defaultTemplateDirectory(repositoryUrl),
): Promise<TemplateCheckout> {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error("Template commit must be a full lowercase Git SHA");
  }
  const target = resolve(directory);
  await access(target)
    .then(() => {
      throw new Error(`Refusing to replace existing path: ${target}`);
    })
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    });
  await runGit(["clone", "--no-checkout", repositoryUrl, target]);
  await runGit([
    "-C",
    target,
    "checkout",
    "-b",
    `opencomputer-template-${commitSha.slice(0, 8)}`,
    commitSha,
  ]);
  const actual = await runGit(["-C", target, "rev-parse", "HEAD"], true);
  if (actual !== commitSha) {
    throw new Error(`Cloned commit ${actual || "unknown"} did not match ${commitSha}`);
  }
  return { directory: target, commitSha };
}
