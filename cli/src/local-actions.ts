import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import type { CompiledActionManifest } from "./actions/protocol.js";

const execFileAsync = promisify(execFile);

export interface LocalActionRuntime {
  mcp: {
    type: "local";
    command: string[];
    environment: Record<string, string>;
    timeout: number;
  };
  ledger: string;
  close(): Promise<void>;
}

async function git(args: string[], cwd?: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      resolvePromise();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

export async function startLocalActionRuntime(input: {
  agentRoot: string;
  runtime: string;
  agentId: string;
  repositories?: Array<{
    id: string;
    mirror: string;
    defaultBranch: string;
  }>;
}): Promise<LocalActionRuntime | undefined> {
  const manifestPath = resolve(
    input.runtime,
    ".opencomputer",
    "reactive.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    actions?: CompiledActionManifest;
  };
  if (!manifest.actions) return undefined;

  const sessionId = `local-${randomUUID()}`;
  const stateRoot = resolve(
    input.agentRoot,
    ".opencomputer",
    "action-ledgers",
    sessionId,
  );
  const remote = resolve(stateRoot, "session.git");
  const bridgeRepository = resolve(stateRoot, "bridge");
  const workerRepository = resolve(stateRoot, "worker");
  await mkdir(stateRoot, { recursive: true });
  await git(["init", "--bare", remote]);
  await git(["clone", remote, bridgeRepository]);
  await git(["clone", remote, workerRepository]);

  const names = [
    ...new Set(
      manifest.actions.definitions.flatMap((definition) =>
        Object.values(definition.secrets),
      ),
    ),
  ];
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) secrets[name] = value;
  }
  const secretsFile = resolve(stateRoot, "secrets.json");
  await writeFile(secretsFile, `${JSON.stringify(secrets)}\n`, { mode: 0o600 });
  const repositoriesFile = resolve(stateRoot, "repositories.json");
  await writeFile(
    repositoriesFile,
    `${JSON.stringify(
      Object.fromEntries(
        (input.repositories ?? []).map((repository) => [
          repository.id,
          {
            id: repository.id,
            remote: repository.mirror,
            defaultBranch: repository.defaultBranch,
          },
        ]),
      ),
    )}\n`,
    { mode: 0o600 },
  );

  const bundle = resolve(dirname(manifestPath), manifest.actions.entry);
  const policyDigest = `sha256:${createHash("sha256")
    .update(await readFile(bundle))
    .digest("hex")}`;
  const workerEntry = fileURLToPath(
    new URL("./actions/local-worker.js", import.meta.url),
  );
  const mcpEntry = fileURLToPath(
    new URL("./actions/mcp-stdio.js", import.meta.url),
  );
  const workerEnvironment = {
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C",
    OPENCOMPUTER_ACTION_SECRETS_FILE: secretsFile,
    OPENCOMPUTER_ACTION_REPOSITORIES_FILE: repositoriesFile,
    OPENCOMPUTER_REACTIVE_MANIFEST_PATH: manifestPath,
    OPENCOMPUTER_ACTION_REPOSITORY: workerRepository,
    OPENCOMPUTER_ACTION_BUNDLE: bundle,
    OPENCOMPUTER_ACTION_POLICY_DIGEST: policyDigest,
    OPENCOMPUTER_ACTION_POLL_MS: "50",
  };
  const worker = spawn(process.execPath, [workerEntry], {
    env: workerEnvironment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  worker.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[local action worker] ${chunk.toString("utf8")}`);
  });

  const bridgeEnvironment = {
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C",
    OPENCOMPUTER_REACTIVE_MANIFEST_PATH: manifestPath,
    OPENCOMPUTER_ACTION_REPOSITORY: bridgeRepository,
    OPENCOMPUTER_PROJECT_ID: "local",
    OPENCOMPUTER_ENVIRONMENT: "local",
    OPENCOMPUTER_AGENT_ID: input.agentId,
    OPENCOMPUTER_SESSION_ID: sessionId,
    OPENCOMPUTER_DEPLOYMENT_DIGEST: policyDigest,
    OPENCOMPUTER_ACTION_TIMEOUT_MS: "60000",
  };

  return {
    mcp: {
      type: "local",
      command: [process.execPath, mcpEntry],
      environment: bridgeEnvironment,
      timeout: 65_000,
    },
    ledger: remote,
    async close() {
      await stop(worker);
      await rm(secretsFile, { force: true });
      await rm(repositoriesFile, { force: true });
    },
  };
}
