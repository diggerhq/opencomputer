import { watch, type FSWatcher } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OpenComputerClient } from "./api.js";
import type { ResolvedConfig } from "./config.js";
import {
  ensureProjectBinding,
  findOpenComputerProjectRoot,
  type ProjectBinding,
  type ProjectBindingOptions,
} from "./binding.js";
import { startGateway } from "./local.js";
import { buildAgentArtifact, readProjectAgents } from "./project.js";

const DEVELOPMENT_ALIAS = "development";
const DEBOUNCE_MS = 180;
const DEVELOPMENT_LEASE_HEARTBEAT_MS = 25_000;

export async function publishDevelopment(
  client: Pick<OpenComputerClient, "registerDeployment">,
  root: string,
  agentId?: string,
) {
  const built = await buildAgentArtifact(root, agentId);
  const deployment = await client.registerDeployment({
    agentId: built.agentId,
    name: built.name,
    alias: DEVELOPMENT_ALIAS,
    channels: built.channels,
    connections: built.connections,
    httpConnections: built.httpConnections,
    source: {
      digest: built.digest,
      size: built.body.byteLength,
      contentType: "application/vnd.opencomputer.agent+json",
      body: built.body.toString("utf8"),
    },
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
  const agents = await readProjectAgents(projectRoot);
  const results = [];
  for (const [index, agent] of agents.entries()) {
    results.push(
      await publishDevelopment(
        client,
        agent.root,
        cloudAgentId(binding, agent.localId, index),
      ),
    );
  }
  return results;
}

function sourceChange(filename: string | Buffer | null): boolean {
  if (!filename) return true;
  const normalized = filename.toString().replaceAll("\\", "/");
  return !normalized.split("/").includes(".opencomputer");
}

function waitForShutdown(): Promise<void> {
  return new Promise((done) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      done();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

export async function runCloudDevelopment(
  client: OpenComputerClient,
  config: ResolvedConfig,
  root: string,
  options: ProjectBindingOptions = {},
): Promise<void> {
  const projectRoot = await findOpenComputerProjectRoot(root);
  const binding = await ensureProjectBinding(
    client,
    config,
    projectRoot,
    options,
  );
  const gateway = await startGateway(config);
  const stateDirectory = resolve(root, ".opencomputer");
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
  let timer: NodeJS.Timeout | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  let leaseRenewal: Promise<void> | undefined;
  let publishing = false;
  let pending = false;
  const lastDigests = new Map<string, string>();

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
          const results = await publishProjectDevelopment(
            client,
            projectRoot,
            binding,
          );
          for (const result of results) {
            if (
              result.built.digest !== lastDigests.get(result.deployment.agentId)
            ) {
              lastDigests.set(result.deployment.agentId, result.built.digest);
              process.stdout.write(
                `Synced ${result.deployment.agentId}@development  ${result.deployment.id}\n`,
              );
            }
          }
        } catch (error) {
          process.stderr.write(
            `Sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
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
    for (const result of initial) {
      lastDigests.set(result.deployment.agentId, result.built.digest);
    }
    const developmentAgents = initial.map(
      (result) => result.deployment.agentId,
    );
    const renewLeases = (announce = false): Promise<void> => {
      if (leaseRenewal) return leaseRenewal;
      leaseRenewal = (async () => {
        try {
          const leases = await Promise.all(
            developmentAgents.map((agentId) =>
              client.renewDevelopmentLease(agentId),
            ),
          );
          if (announce) {
            process.stdout.write(
              `Standby:    ${leases.map((lease) => `${lease.agentId} ${lease.ready ? "ready" : lease.status}`).join(", ")}\n`,
            );
          }
        } catch (error) {
          process.stderr.write(
            `Standby unavailable; new sessions will start cold: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      })().finally(() => {
        leaseRenewal = undefined;
      });
      return leaseRenewal;
    };
    process.stdout.write(
      `Development (Cloud)\n` +
        `Project:    ${binding.projectName} (${binding.projectId})\n` +
        `Agents:     ${initial.map((result) => `${result.deployment.agentId}@development`).join(", ")}\n` +
        `Deployments:${initial.map((result) => ` ${result.deployment.id}`).join("\n            ")}\n` +
        `Watching:   ${projectRoot}\n` +
        `React:      run npm run dev:web in another terminal\n` +
        `Standby:    warming ${developmentAgents.join(", ")}…\n`,
    );
    watcher = watch(projectRoot, { recursive: true }, (_event, filename) => {
      if (!sourceChange(filename)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void publish(), DEBOUNCE_MS);
    });
    void renewLeases(true);
    leaseTimer = setInterval(
      () => void renewLeases(),
      DEVELOPMENT_LEASE_HEARTBEAT_MS,
    );
    await waitForShutdown();
  } finally {
    if (timer) clearTimeout(timer);
    if (leaseTimer) clearInterval(leaseTimer);
    watcher?.close();
    await leaseRenewal?.catch(() => undefined);
    await Promise.allSettled(
      [...lastDigests.keys()].map((agentId) =>
        client.releaseDevelopmentLease(agentId),
      ),
    );
    await rm(stateFile, { force: true });
    await gateway.close();
  }
}
