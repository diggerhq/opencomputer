import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";

import type { OpenComputerClient } from "./api.js";
import type { ResolvedConfig } from "./config.js";
import {
  ensureProjectBinding,
  findOpenComputerProjectRoot,
  type ProjectBinding,
  type ProjectBindingOptions,
} from "./binding.js";
import { startGateway } from "./local.js";
import {
  buildAgentArtifact,
  readProjectAgents,
  readProjectResources,
  type BuiltAgentArtifact,
  type ProjectResourceManifest,
} from "./project.js";

const DEVELOPMENT_ALIAS = "development";
const DEBOUNCE_MS = 180;

type DevelopmentResults = Awaited<
  ReturnType<typeof publishProjectDevelopment>
>;

interface SecretSyncState {
  version: 1;
  apiUrl: string;
  projectId: string;
  hashes: Record<string, string>;
}

function secretSyncStatePath(projectRoot: string): string {
  return resolve(projectRoot, ".opencomputer", "dev-secrets.json");
}

async function readSecretSyncState(
  projectRoot: string,
  config: ResolvedConfig,
  binding: ProjectBinding,
): Promise<SecretSyncState> {
  try {
    const value = JSON.parse(
      await readFile(secretSyncStatePath(projectRoot), "utf8"),
    ) as Partial<SecretSyncState>;
    if (
      value.version === 1 &&
      value.apiUrl === config.apiUrl &&
      value.projectId === binding.projectId &&
      value.hashes &&
      typeof value.hashes === "object"
    ) {
      return value as SecretSyncState;
    }
  } catch {
    // A missing or invalid state file requires fresh consent.
  }
  return {
    version: 1,
    apiUrl: config.apiUrl,
    projectId: binding.projectId,
    hashes: {},
  };
}

function secretOrigins(results: DevelopmentResults): Map<string, string[]> {
  const origins = new Map<string, Set<string>>();
  for (const { built } of results) {
    for (const connection of built.httpConnections) {
      for (const header of Object.values(connection.headers)) {
        if (typeof header === "string") continue;
        const current = origins.get(header.name) ?? new Set<string>();
        current.add(connection.origin);
        for (const redirect of connection.redirectOrigins ?? []) {
          current.add(redirect.origin);
        }
        origins.set(header.name, current);
      }
    }
  }
  return new Map(
    [...origins].map(([name, values]) => [name, [...values].sort()]),
  );
}

function secretHash(value: string, origins: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ value, origins }))
    .digest("hex");
}

async function confirmNewSecrets(
  secrets: Array<{ name: string; origins: string[] }>,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  process.stdout.write("\nSecrets found in opencomputer/.env.local:\n\n");
  for (const secret of secrets) {
    process.stdout.write(
      `  ${secret.name.padEnd(28)} → ${secret.origins.map((origin) => new URL(origin).host).join(", ")}\n`,
    );
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await terminal.question("\nSync these development secrets? [Y/n] ")
    )
      .trim()
      .toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    terminal.close();
  }
}

export async function syncDevelopmentSecrets(
  client: Pick<OpenComputerClient, "putSecret">,
  config: ResolvedConfig,
  projectRoot: string,
  binding: ProjectBinding,
  results: DevelopmentResults,
  options: {
    confirm?: (
      secrets: Array<{ name: string; origins: string[] }>,
    ) => Promise<boolean>;
  } = {},
): Promise<string[]> {
  const path = resolve(projectRoot, "opencomputer", ".env.local");
  let values: Record<string, string | undefined>;
  try {
    values = parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const origins = secretOrigins(results);
  const referenced = [...origins]
    .filter(([name]) => typeof values[name] === "string" && values[name] !== "")
    .map(([name, allowedOrigins]) => ({
      name,
      value: values[name]!,
      origins: allowedOrigins,
    }));
  const unmatched = Object.keys(values)
    .filter(
      (name) =>
        typeof values[name] === "string" &&
        values[name] !== "" &&
        !origins.has(name),
    )
    .sort();
  for (const name of unmatched) {
    process.stderr.write(
      `Skipped ${name}: it is not referenced by a defineConnection() declaration.\n`,
    );
  }
  if (!referenced.length) return [];

  const state = await readSecretSyncState(projectRoot, config, binding);
  const pending = referenced.filter(
    (secret) =>
      state.hashes[secret.name] !== secretHash(secret.value, secret.origins),
  );
  if (!pending.length) return [];
  const newSecrets = pending.filter((secret) => !(secret.name in state.hashes));
  if (newSecrets.length) {
    const confirmed = await (options.confirm ?? confirmNewSecrets)(newSecrets);
    if (!confirmed) {
      process.stderr.write(
        "Development secret sync skipped. Use `opencomputer secrets set` or restart `opencomputer deploy --watch` to approve it.\n",
      );
      return [];
    }
  }

  const synced: string[] = [];
  for (const secret of pending) {
    await client.putSecret({
      projectId: binding.projectId,
      name: secret.name,
      value: secret.value,
      environment: "development",
      allowedOrigins: secret.origins,
    });
    state.hashes[secret.name] = secretHash(secret.value, secret.origins);
    synced.push(secret.name);
    process.stdout.write(
      `Synced development secret ${secret.name} for ${secret.origins.join(", ")}\n`,
    );
  }
  await mkdir(resolve(projectRoot, ".opencomputer"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    secretSyncStatePath(projectRoot),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
  return synced;
}

export async function publishDevelopment(
  client: Pick<OpenComputerClient, "registerDeployment">,
  root: string,
  agentId?: string,
  projectDeployment?: {
    id: string;
    digest: string;
    localAgentId: string;
    agents: Array<{ localId: string; agentId: string; artifactDigest: string }>;
    resources: ProjectResourceManifest;
  },
) {
  const built = await buildAgentArtifact(root, agentId);
  return registerBuiltDeployment(
    client,
    built,
    DEVELOPMENT_ALIAS,
    projectDeployment,
  );
}

async function registerBuiltDeployment(
  client: Pick<OpenComputerClient, "registerDeployment">,
  built: BuiltAgentArtifact,
  alias: string,
  projectDeployment?: {
    id: string;
    digest: string;
    localAgentId: string;
    agents: Array<{ localId: string; agentId: string; artifactDigest: string }>;
    resources: ProjectResourceManifest;
  },
) {
  const deployment = await client.registerDeployment({
    agentId: built.agentId,
    name: built.name,
    alias,
    channels: built.channels,
    connections: built.connections,
    httpConnections: built.httpConnections,
    ...(projectDeployment ? { projectDeployment } : {}),
    source: {
      digest: built.digest,
      size: built.body.byteLength,
      contentType: "application/vnd.opencomputer.agent+json",
      body: built.body.toString("utf8"),
    },
    ...(built.environment
      ? {
          environmentSource: {
            digest: built.environment.digest,
            size: built.environment.size,
            contentType: built.environment.contentType,
            body: built.environment.body.toString("utf8"),
            baseImage: built.environment.baseImage,
            architecture: built.environment.architecture,
          },
        }
      : {}),
  });
  return { built, deployment };
}

export function cloudAgentId(
  binding: ProjectBinding,
  localId: string,
  index: number,
) {
  return index === 0 ? binding.agentId : `${binding.agentId}--${localId}`;
}

export async function publishProjectDevelopment(
  client: Pick<OpenComputerClient, "registerDeployment">,
  projectRoot: string,
  binding: ProjectBinding,
) {
  return publishProjectDeployment(
    client,
    projectRoot,
    binding,
    DEVELOPMENT_ALIAS,
  );
}

export async function publishProjectDeployment(
  client: Pick<OpenComputerClient, "registerDeployment">,
  projectRoot: string,
  binding: ProjectBinding,
  alias: string,
) {
  const agents = await readProjectAgents(projectRoot);
  const resources = await readProjectResources(projectRoot);
  const builtAgents = [];
  for (const [index, agent] of agents.entries()) {
    builtAgents.push({
      source: agent,
      built: await buildAgentArtifact(
        agent.root,
        cloudAgentId(binding, agent.localId, index),
      ),
    });
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        resources: resources.digest,
        agents: builtAgents.map(({ source, built }) => ({
          id: source.localId,
          artifact: built.digest,
          environment: built.environment?.digest,
        })),
      }),
    )
    .digest("hex");
  const id = `project:${binding.projectId}:${digest}`;
  const roster = builtAgents.map(({ source, built }) => ({
    localId: source.localId,
    agentId: built.agentId,
    artifactDigest: built.digest,
  }));
  const results = [];
  for (const { source, built } of builtAgents) {
    results.push(
      await registerBuiltDeployment(client, built, alias, {
        id,
        digest,
        localAgentId: source.localId,
        agents: roster,
        resources: resources.manifest,
      }),
    );
  }
  return results;
}

function sourceChange(filename: string | Buffer | null): boolean {
  if (!filename) return true;
  const normalized = filename.toString().replaceAll("\\", "/");
  return !normalized.split("/").includes(".opencomputer");
}

function secretFileChange(filename: string | Buffer | null): boolean {
  if (!filename) return false;
  return filename.toString().replaceAll("\\", "/") === ".env.local";
}

function waitForShutdown(web?: ChildProcess): Promise<void> {
  return new Promise((done) => {
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      web?.off("exit", webStopped);
    };
    const stop = () => {
      cleanup();
      done();
    };
    const webStopped = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      process.stderr.write(
        `React dev server stopped${signal ? ` (${signal})` : ` (${String(code)})`}.\n`,
      );
      done();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    web?.once("exit", webStopped);
  });
}

export function projectDashboardURL(apiUrl: string, projectId: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}`;
}

export function developmentWatchReadyMessage(input: {
  projectName: string;
  projectId: string;
  dashboardUrl: string;
  agents: string[];
  deployments: string[];
  watchedDirectory: string;
  startWebApp?: boolean;
}): string {
  return (
    `\nOpenComputer Development\n\n` +
    `✓ Deployment ready\n` +
    `  Project      ${input.projectName} (${input.projectId})\n` +
    `  Agents       ${input.agents.join(", ")}\n` +
    `  Deployments  ${input.deployments.join("\n               ")}\n` +
    `  Dashboard    ${input.dashboardUrl}\n\n` +
    `Watching ${input.watchedDirectory} for changes.\n` +
    `Changes deploy automatically. Press Ctrl+C to stop.\n` +
    (input.startWebApp ? `Starting legacy local web app with Vite.\n` : "")
  );
}

export async function hasReactSpa(projectRoot: string): Promise<boolean> {
  try {
    await Promise.all([
      access(resolve(projectRoot, "vite.config.ts")),
      access(resolve(projectRoot, "src", "main.tsx")),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function startReactDevServer(projectRoot: string): Promise<ChildProcess> {
  const vite = resolve(projectRoot, "node_modules", "vite", "bin", "vite.js");
  try {
    await access(vite);
  } catch {
    throw new Error(
      "This project includes a React SPA, but Vite is not installed. Run npm install first.",
    );
  }
  return spawn(process.execPath, [vite], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

export async function runDeploymentWatch(
  client: OpenComputerClient,
  config: ResolvedConfig,
  root: string,
  options: ProjectBindingOptions = {},
  behavior: { startWebApp?: boolean } = {},
): Promise<void> {
  const projectRoot = await findOpenComputerProjectRoot(root);
  const binding = await ensureProjectBinding(
    client,
    config,
    projectRoot,
    options,
  );
  const gateway = await startGateway(config);
  const stateDirectory = resolve(projectRoot, ".opencomputer");
  const stateFile = resolve(stateDirectory, "dev.json");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    stateFile,
    `${JSON.stringify({
      version: 5,
      url: gateway.url,
      token: gateway.token,
      projectId: binding.projectId,
      agent: `${binding.agentId}@development`,
    })}\n`,
    { mode: 0o600 },
  );

  let watcher: FSWatcher | undefined;
  let web: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let publishing = false;
  let pending = false;
  const lastDigests = new Map<string, string>();
  let latestResults: DevelopmentResults = [];
  let secretSync = Promise.resolve();

  const syncSecrets = () => {
    secretSync = secretSync
      .then(async () => {
        await syncDevelopmentSecrets(
          client,
          config,
          projectRoot,
          binding,
          latestResults,
        );
      })
      .catch((error) => {
        process.stderr.write(
          `Secret sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    return secretSync;
  };

  const publish = async () => {
    if (publishing) {
      pending = true;
      return;
    }
    publishing = true;
    try {
      do {
        pending = false;
        try {
          process.stdout.write("\nChange detected. Deploying to Development...\n");
          const results = await publishProjectDevelopment(
            client,
            projectRoot,
            binding,
          );
          latestResults = results;
          let changed = false;
          for (const result of results) {
            if (
              result.built.digest !== lastDigests.get(result.deployment.agentId)
            ) {
              changed = true;
              lastDigests.set(result.deployment.agentId, result.built.digest);
              process.stdout.write(
                `✓ Deployed ${result.deployment.agentId}@development\n` +
                  `  Deployment  ${result.deployment.id}\n`,
              );
            }
          }
          if (!changed) {
            process.stdout.write("✓ Development is already up to date.\n");
          }
          await syncSecrets();
        } catch (error) {
          process.stderr.write(
            `✗ Deployment failed: ${error instanceof Error ? error.message : String(error)}\n` +
              `Watching for the next change.\n`,
          );
        }
      } while (pending);
    } finally {
      publishing = false;
    }
  };

  try {
    const initial = await publishProjectDevelopment(
      client,
      projectRoot,
      binding,
    );
    latestResults = initial;
    for (const result of initial) {
      lastDigests.set(result.deployment.agentId, result.built.digest);
    }
    await syncSecrets();
    const spa = await hasReactSpa(projectRoot);
    const startWebApp = behavior.startWebApp === true && spa;
    process.stdout.write(
      developmentWatchReadyMessage({
        projectName: binding.projectName,
        projectId: binding.projectId,
        dashboardUrl: projectDashboardURL(config.apiUrl, binding.projectId),
        agents: initial.map(
          (result) => `${result.deployment.agentId}@development`,
        ),
        deployments: initial.map((result) => result.deployment.id),
        watchedDirectory: resolve(projectRoot, "opencomputer"),
        startWebApp,
      }),
    );
    if (startWebApp) web = await startReactDevServer(projectRoot);
    watcher = watch(
      resolve(projectRoot, "opencomputer"),
      { recursive: true },
      (_event, filename) => {
        if (secretFileChange(filename)) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void syncSecrets(), DEBOUNCE_MS);
          return;
        }
        if (!sourceChange(filename)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void publish(), DEBOUNCE_MS);
      },
    );
    await waitForShutdown(web);
  } finally {
    if (timer) clearTimeout(timer);
    watcher?.close();
    if (web?.exitCode === null && web.signalCode === null) web.kill("SIGTERM");
    await rm(stateFile, { force: true });
    await gateway.close();
  }
}

export async function runCloudDevelopment(
  client: OpenComputerClient,
  config: ResolvedConfig,
  root: string,
  options: ProjectBindingOptions = {},
): Promise<void> {
  return runDeploymentWatch(client, config, root, options, {
    startWebApp: true,
  });
}
