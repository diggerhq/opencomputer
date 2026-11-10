import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { memoryObjectName, type MemoryDeclaration } from "../src/edge/memory-contract.js";
import type { AgentDeployment, InitializeSessionResult, Project, SessionSnapshot } from "../src/protocol.js";

/**
 * Environment identity at session admission (integration review, finding
 * 1). One artifact promoted to both environments has one deployment row
 * whose original alias never changes; the session's environment must come
 * from the request, never from that row, and the same Idempotency-Key in two
 * environments names two different memory scopes.
 */

const base = "https://managedagents.test";
const notes: MemoryDeclaration = { id: "notes", description: "Notes.", provider: { kind: "document", maxBytes: 1_024 } };
const rw = { notes: { scope: "document", id: "workshop", access: "read-write" } };

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

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

async function error(response: Response): Promise<{ status: number; code: string }> {
  const body = await response.json<{ error: { code: string } }>();
  return { status: response.status, code: body.error.code };
}

interface Fixture {
  project: Project;
  deployment: AgentDeployment;
  memory(environment: "development" | "production"): DurableObjectStub<import("../src/edge/memory-do.js").MemoryDurableObject>;
  create(body: Record<string, unknown>, key?: string): Promise<Response>;
}

/**
 * One artifact deployed to development, then promoted to production, with a
 * `workshop` document in each environment carrying different text.
 */
async function promotedToBoth(): Promise<Fixture> {
  const created = await SELF.fetch(`${base}/v1/projects`, jsonRequest("POST", { environmentMode: "legacy", name: `Env ${crypto.randomUUID().slice(0, 8)}` }));
  expect(created.status).toBe(201);
  const body = await created.json<{ project?: Project } & Project>();
  const project = body.project ?? body;
  const deploy = (alias: "development" | "production") =>
    SELF.fetch(
      `${base}/v1/deployments`,
      jsonRequest("POST", {
        agentId: project.agentId,
        alias,
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: { bucket: "b", key: `accounts/local/agents/${project.agentId}/artifact.json`, digest: "e".repeat(64), size: 1 },
        memory: [notes],
      }),
    );
  const development = await deploy("development");
  expect(development.status).toBe(201);
  const deployment = await development.json<AgentDeployment>();
  expect((await deploy("production")).status).toBe(201);
  // One row, original alias: the trap the review found.
  expect((await env.ACCOUNTS.getByName("local").getDeployment(deployment.id))?.alias).toBe("development");
  for (const environment of ["development", "production"] as const) {
    const document = await SELF.fetch(
      `${base}/v1/projects/${project.id}/memory/notes/documents/workshop?environment=${environment}`,
      jsonRequest("PUT", { title: "Workshop", text: `${environment} text` }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
  }
  return {
    project,
    deployment,
    memory: (environment) => env.MEMORY.getByName(memoryObjectName("local", project.id, environment)),
    create: (input, key) =>
      SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", input, key ? { "idempotency-key": key } : {})),
  };
}

describe("environment identity at admission", () => {
  it("binds the environment the request names when the deployment is pinned, not the row's original alias", async () => {
    const f = await promotedToBoth();
    const response = await f.create({ agentId: `${f.project.agentId}@production`, deploymentId: f.deployment.id, memory: rw });
    expect(response.status).toBe(201);
    const { session } = await response.json<InitializeSessionResult>();
    expect(session.environment).toBe("production");
    expect(session.memoryObject).toBe(memoryObjectName("local", f.project.id, "production"));
    expect(await f.memory("production").recall(session.id, "notes")).toMatchObject({
      kind: "projection",
      projection: { text: "production text" },
    });
    expect(await f.memory("development").recall(session.id, "notes")).toEqual({ kind: "rejected", reason: "not_bound" });
  });

  it("takes an explicit environment with a pinned deployment and refuses one the deployment is not promoted to", async () => {
    const f = await promotedToBoth();
    const explicit = await f.create({ deploymentId: f.deployment.id, environment: "production", memory: rw });
    expect(explicit.status).toBe(201);
    expect((await explicit.json<InitializeSessionResult>()).session.environment).toBe("production");

    // Promote another artifact to production: the pinned one is no longer
    // active there, so binding production memory through it is refused.
    const other = await SELF.fetch(
      `${base}/v1/deployments`,
      jsonRequest("POST", {
        agentId: f.project.agentId,
        alias: "production",
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: { bucket: "b", key: `accounts/local/agents/${f.project.agentId}/artifact.json`, digest: "f".repeat(64), size: 1 },
        memory: [notes],
      }),
    );
    expect(other.status).toBe(201);
    expect(await error(await f.create({ deploymentId: f.deployment.id, environment: "production", memory: rw }))).toEqual({
      status: 409,
      code: "deployment_not_promoted",
    });
    expect(
      await error(await f.create({ agentId: `${f.project.agentId}@development`, deploymentId: f.deployment.id, environment: "production", memory: rw })),
    ).toEqual({ status: 400, code: "invalid_environment" });
    // Development still has it; a session pinned there binds development memory.
    const development = await f.create({ deploymentId: f.deployment.id, environment: "development", memory: rw });
    expect(development.status).toBe(201);
    const { session } = await development.json<InitializeSessionResult>();
    expect(await f.memory("development").recall(session.id, "notes")).toMatchObject({ projection: { text: "development text" } });
  });

  it("refuses the same Idempotency-Key across environments instead of returning the other environment's session", async () => {
    const f = await promotedToBoth();
    const first = await f.create({ agentId: `${f.project.agentId}@development`, memory: rw }, "env-key");
    expect(first.status).toBe(201);
    const { session } = await first.json<InitializeSessionResult>();
    expect(session.environment).toBe("development");
    expect(await error(await f.create({ agentId: `${f.project.agentId}@production`, memory: rw }, "env-key"))).toEqual({
      status: 409,
      code: "idempotency_conflict",
    });
    // The replay in the original environment still returns the session.
    const replay = await f.create({ agentId: `${f.project.agentId}@development`, memory: rw }, "env-key");
    expect(replay.status).toBe(200);
    expect((await replay.json<{ session: SessionSnapshot }>()).session.id).toBe(session.id);
    // Production memory was never touched by that session.
    expect(await f.memory("production").recall(session.id, "notes")).toEqual({ kind: "rejected", reason: "not_bound" });
  });

  it("returns the original receipt for an identical pinned retry after a later promotion (B1)", async () => {
    const f = await promotedToBoth();
    const body = { deploymentId: f.deployment.id, environment: "development", memory: rw };
    const first = await f.create(body, "pinned-key");
    expect(first.status).toBe(201);
    const { session } = await first.json<InitializeSessionResult>();
    // Promote another artifact to development: the pinned deployment is no
    // longer eligible for a new session there, but the receipt stands.
    const other = await SELF.fetch(
      `${base}/v1/deployments`,
      jsonRequest("POST", {
        agentId: f.project.agentId,
        alias: "development",
        channels: [],
        connections: [],
        imageArn: "test-image",
        imageVersion: "1",
        artifact: { bucket: "b", key: `accounts/local/agents/${f.project.agentId}/artifact.json`, digest: "f".repeat(64), size: 1 },
        memory: [notes],
      }),
    );
    expect(other.status).toBe(201);
    const replay = await f.create(body, "pinned-key");
    expect(replay.status).toBe(200);
    expect((await replay.json<{ session: SessionSnapshot }>()).session.id).toBe(session.id);
    // A fresh pinned session there is still refused.
    expect(await error(await f.create(body, "pinned-key-2"))).toEqual({ status: 409, code: "deployment_not_promoted" });
    // A different environment under the same key still conflicts.
    expect(await error(await f.create({ ...body, environment: "production" }, "pinned-key"))).toEqual({
      status: 409,
      code: "idempotency_conflict",
    });
  });

  it("a pinned retry without a named environment takes the receipt's environment, not the current promotion set (B1)", async () => {
    const created = await SELF.fetch(`${base}/v1/projects`, jsonRequest("POST", { environmentMode: "legacy", name: `Env ${crypto.randomUUID().slice(0, 8)}` }));
    const body = await created.json<{ project?: Project } & Project>();
    const project = body.project ?? body;
    const deploy = (digest: string) =>
      SELF.fetch(
        `${base}/v1/deployments`,
        jsonRequest("POST", {
          agentId: project.agentId,
          alias: "development",
          channels: [],
          connections: [],
          imageArn: "test-image",
          imageVersion: "1",
          artifact: { bucket: "b", key: `accounts/local/agents/${project.agentId}/artifact.json`, digest: digest.repeat(64), size: 1 },
          memory: [notes],
        }),
      );
    const first = await deploy("a");
    expect(first.status).toBe(201);
    const deployment = await first.json<AgentDeployment>();
    const document = await SELF.fetch(
      `${base}/v1/projects/${project.id}/memory/notes/documents/workshop?environment=development`,
      jsonRequest("PUT", { title: "Workshop", text: "text" }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
    const create = (key: string) =>
      SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { deploymentId: deployment.id, memory: rw }, { "idempotency-key": key }));
    // Active in development only: the bare pinned request resolves it.
    const initial = await create("bare-key");
    expect(initial.status).toBe(201);
    const { session } = await initial.json<InitializeSessionResult>();
    expect(session.environment).toBe("development");
    // Another artifact takes development; the pinned one is active nowhere.
    expect((await deploy("b")).status).toBe(201);
    const replay = await create("bare-key");
    expect(replay.status).toBe(200);
    expect((await replay.json<{ session: SessionSnapshot }>()).session.id).toBe(session.id);
    // A new bare pinned session cannot name its environment any more.
    expect(await error(await create("bare-key-2"))).toEqual({ status: 400, code: "invalid_memory_binding" });
  });

  it("records the environment on sessions without bindings and conflicts a replay from the other environment", async () => {
    const f = await promotedToBoth();
    const first = await f.create({ agentId: `${f.project.agentId}@production` }, "env-plain");
    expect(first.status).toBe(201);
    const { session } = await first.json<InitializeSessionResult>();
    expect(session.environment).toBe("production");
    expect(session.memoryObject).toBeUndefined();
    expect(await error(await f.create({ agentId: `${f.project.agentId}@development` }, "env-plain"))).toEqual({
      status: 409,
      code: "idempotency_conflict",
    });
  });
});
