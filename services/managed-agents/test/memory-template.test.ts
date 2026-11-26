import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { memoryObjectName, type MemoryDeclaration } from "../src/edge/memory-contract.js";
import { templateDeployments, validTemplateBundle } from "../src/edge/template-service.js";
import type { InitializeSessionResult, Project, ProjectResourceManifest } from "../src/protocol.js";

/**
 * Template installation with memory declarations (integration review,
 * finding 5): the compiled artifact's `memory` must reach deployment
 * registration, so the promotion applies the configuration and sessions
 * of the installed project can bind the resources.
 */

const base = "https://managedagents.test";
const notes: MemoryDeclaration = {
  id: "notes",
  description: "Workshop notes.",
  provider: { kind: "document", maxBytes: 2_048 },
};

const resources: ProjectResourceManifest = {
  version: 1,
  channels: [],
  channelRegistrations: [],
  outboxes: [],
  outboxRegistrations: [],
  schedules: [],
};

beforeEach(async () => {
  await env.SERVERLESS_AGENTS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS session_creations (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      countable INTEGER NOT NULL DEFAULT 1,
      exclusion_reason TEXT,
      outcome_at TEXT
    )`,
  ).run();
});

async function project(): Promise<Project> {
  const response = await SELF.fetch(`${base}/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentMode: "legacy", name: `Tpl ${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(response.status).toBe(201);
  const created = await response.json<{ project?: Project } & Project>();
  return created.project ?? created;
}

function artifact(localAgentId: string, digest: string, memory?: MemoryDeclaration[]) {
  return {
    localAgentId,
    name: `Agent ${localAgentId}`,
    digest,
    size: 1,
    contentType: "application/json",
    connections: [],
    httpConnections: [],
    ...(memory ? { memory } : {}),
    artifact: { bucket: "b", key: `template-cache/${digest}`, digest, size: 1 },
  };
}

describe("template installation with memory", () => {
  it("forwards each artifact's memory declarations into its deployment registration", async () => {
    const created = await project();
    const deployments = await templateDeployments({
      installationId: "inst_1",
      accountId: "local",
      project: created,
      artifacts: [artifact("coordinator", "1".repeat(64), [notes]), artifact("worker", "2".repeat(64))],
      resources,
      imageArn: "test-image",
      imageVersion: "1",
      runtimeMode: "microvm",
    });
    expect(deployments.map((deployment) => deployment.memory)).toEqual([[notes], undefined]);
    expect(deployments.map((deployment) => deployment.alias)).toEqual(["development", "development"]);
  });

  it("an installed template's project applies the limits and admits bindings", async () => {
    const created = await project();
    const deployments = await templateDeployments({
      installationId: "inst_2",
      accountId: "local",
      project: created,
      artifacts: [artifact("coordinator", "3".repeat(64), [notes])],
      resources,
      imageArn: "test-image",
      imageVersion: "1",
      runtimeMode: "microvm",
    });
    const account = env.ACCOUNTS.getByName("local");
    for (const deployment of deployments) await account.registerDeployment(deployment);
    const memory = env.MEMORY.getByName(memoryObjectName("local", created.id, "development"));
    expect(await memory.resourceConfig("notes")).toEqual({ resource: "notes", provider: "document", maxBytes: 2_048 });
    const agentId = deployments[0]!.agentId;
    expect((await account.resolveDeployment(`${agentId}@development`))?.memory).toEqual([notes]);

    const document = await SELF.fetch(
      `${base}/v1/projects/${created.id}/memory/notes/documents/workshop?environment=development`,
      { method: "PUT", headers: { "content-type": "application/json", "if-none-match": "*" }, body: JSON.stringify({ title: "Workshop", text: "v1" }) },
    );
    expect(document.status).toBe(201);
    const session = await SELF.fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: `${agentId}@development`,
        memory: { notes: { scope: "document", id: "workshop", access: "read-write" } },
      }),
    });
    expect(session.status).toBe(201);
    expect((await session.json<InitializeSessionResult>()).session.memoryAdmission).toEqual({ state: "issued" });
  });

  it("rejects a bundle whose artifact carries malformed memory declarations", () => {
    const bundle = (memory: unknown) => ({
      schema: 1,
      template: {},
      agents: [{ id: "coordinator", name: "Coordinator" }],
      artifacts: [{ ...artifact("coordinator", "4".repeat(64)), body: "{}", memory }],
      resources,
      requirements: { secrets: [], runtimeVariables: [], connections: [] },
    });
    expect(validTemplateBundle(bundle(undefined))).toBe(true);
    expect(validTemplateBundle(bundle([notes]))).toBe(true);
    expect(validTemplateBundle(bundle([{ id: "notes", description: "x", provider: { kind: "document", maxBytes: 100_000 } }]))).toBe(false);
    expect(validTemplateBundle(bundle("notes"))).toBe(false);
  });
});
