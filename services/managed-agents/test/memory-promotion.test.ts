import { abortAllDurableObjects, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountDurableObject } from "../src/edge/account-do.js";
import { ACTIVATION_ATTEMPT_DEADLINE_MS, type MemoryActivationRow } from "../src/edge/memory-activation.js";
import type { MemoryDurableObject } from "../src/edge/memory-do.js";
import { memoryObjectName, type MemoryDeclaration } from "../src/edge/memory-contract.js";
import type { AgentDeployment, Project } from "../src/protocol.js";

/**
 * Configuration activation on promotion: allocate the seq, apply to the
 * Memory DO, flip the alias. Failures are injected by swapping the Account
 * DO's `MEMORY` namespace for one that loses the reply; eviction restores
 * the real one, and the account alarm re-drives the recorded intent.
 */

const base = "https://managedagents.test";

function notes(maxBytes: number, kind: "document" | "http" = "document"): MemoryDeclaration {
  return kind === "document"
    ? { id: "notes", description: "Notes.", provider: { kind: "document", maxBytes } }
    : {
        id: "notes",
        description: "Notes.",
        provider: { kind: "http", connection: "svc", path: "/memory", maxBytes, tools: [] },
      };
}

async function project(): Promise<Project> {
  const response = await SELF.fetch(`${base}/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentMode: "legacy", name: `Promo ${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(response.status).toBe(201);
  const created = await response.json<{ project?: Project } & Project>();
  return created.project ?? created;
}

function deploymentBody(agentId: string, digest: string, memory: MemoryDeclaration[]) {
  return {
    agentId,
    alias: "development",
    channels: [],
    connections: [],
    imageArn: "test-image",
    imageVersion: "1",
    artifact: {
      bucket: "managed-agent-artifacts",
      key: `accounts/local/agents/${agentId}/artifact.json`,
      digest: digest.repeat(64),
      size: 512,
    },
    memory,
  };
}

async function deploy(agentId: string, digest: string, memory: MemoryDeclaration[]): Promise<Response> {
  return SELF.fetch(`${base}/v1/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deploymentBody(agentId, digest, memory)),
  });
}

const account = () => env.ACCOUNTS.getByName("local");

function memoryFor(created: Project) {
  return env.MEMORY.getByName(memoryObjectName("local", created.id, "development"));
}

/** The object's storage; `ctx` is protected on the class, the tests reach in deliberately. */
function storage(instance: AccountDurableObject): DurableObjectStorage {
  return (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
}

async function activations(projectId: string): Promise<MemoryActivationRow[]> {
  return runInDurableObject(account(), (instance: AccountDurableObject) =>
    storage(instance).sql
      .exec<MemoryActivationRow>(
        "SELECT * FROM memory_activations WHERE project_id = ? ORDER BY seq",
        projectId,
      )
      .toArray(),
  );
}

async function environmentRow(projectId: string) {
  return runInDurableObject(account(), (instance: AccountDurableObject) =>
    storage(instance).sql
      .exec<{ active_deployment_id: string | null; activation_seq: number; selected_activation_seq: number | null }>(
        "SELECT active_deployment_id, activation_seq, selected_activation_seq FROM project_environments WHERE project_id = ? AND name = 'development'",
        projectId,
      )
      .toArray()[0],
  );
}

/**
 * Registers a deployment inside the Account DO with a MEMORY namespace whose
 * applyConfig loses its reply. Runs in the object rather than over RPC: an
 * RPC method that throws leaves this test runner's eviction waiting forever,
 * while an in-object throw is just a rejected callback.
 */
async function deployWithLostApplyReply(agentId: string, digest: string, memory: MemoryDeclaration[]): Promise<string> {
  return runInDurableObject(account(), async (instance: AccountDurableObject) => {
    const host = instance as unknown as { env: Record<string, unknown> };
    const real = host.env;
    host.env = {
      ...real,
      MEMORY: {
        getByName: () => ({
          applyConfig: async () => {
            throw new Error("injected lost applyConfig reply");
          },
        }),
      },
    };
    try {
      await instance.registerDeployment({ ...deploymentBody(agentId, digest, memory), accountId: "local" });
      return "registered";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      host.env = real;
    }
  });
}

/**
 * Leaves the Account DO with a MEMORY namespace whose applyConfig never
 * replies, so the next promotion is stuck with the call in flight. With
 * `commit`, the real Memory DO applies the configuration first: the remote
 * side is done and only the local acknowledgement is missing.
 */
async function hangApplyReply(options: { commit: boolean }): Promise<void> {
  await runInDurableObject(account(), (instance: AccountDurableObject) => {
    const host = instance as unknown as { env: Record<string, unknown> };
    const real = host.env.MEMORY as DurableObjectNamespace<MemoryDurableObject>;
    host.env = {
      ...host.env,
      MEMORY: {
        getByName: (name: string) => ({
          applyConfig: async (...args: unknown[]) => {
            if (options.commit) {
              const stub = real.getByName(name) as unknown as { applyConfig: (...input: unknown[]) => Promise<unknown> };
              await stub.applyConfig(...args);
            }
            await new Promise<never>(() => undefined);
          },
        }),
      },
    };
  });
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the object to reach the expected state");
}

// A held clock a day ahead: alarms armed from it never fire on their own,
// so every alarm run in these tests is an explicit one. Eviction's drain
// wait misbehaves under a faked Date, so the clock is released around it.
const clock = {
  held: Date.now() + 24 * 60 * 60_000,
  hold(): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(this.held));
  },
  advance(ms: number): void {
    this.held += ms;
    vi.setSystemTime(new Date(this.held));
  },
  async release(): Promise<void> {
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 100));
  },
};

async function evictAccount(): Promise<void> {
  await clock.release();
  await evictDurableObject(account());
  clock.hold();
}

/** Kills every live object at once, in-flight calls included; storage survives. */
async function crashAll(): Promise<void> {
  await clock.release();
  await abortAllDurableObjects();
  clock.hold();
}

beforeEach(async () => {
  clock.hold();
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

afterEach(() => {
  vi.useRealTimers();
});

describe("memory configuration on promotion", () => {
  it("applies the declared limits before selecting the code and exposes the declarations", async () => {
    const created = await project();
    const response = await deploy(created.agentId, "a", [notes(4_096)]);
    expect(response.status).toBe(201);
    const deployment = await response.json<AgentDeployment>();
    expect(deployment.memory).toEqual([notes(4_096)]);

    expect(await memoryFor(created).resourceConfig("notes")).toEqual({ resource: "notes", provider: "document", maxBytes: 4_096 });
    expect(await environmentRow(created.id)).toEqual({
      active_deployment_id: deployment.id,
      activation_seq: 1,
      selected_activation_seq: 1,
    });
    expect((await activations(created.id)).map((row) => [row.seq, row.state])).toEqual([[1, "selected"]]);
    const resolved = await account().resolveDeployment(`${created.agentId}@development`);
    expect(resolved?.id).toBe(deployment.id);
    expect(resolved?.memory).toEqual([notes(4_096)]);
  });

  it("A, B, then A again are three activations; the Memory DO ends on A's limits", async () => {
    const created = await project();
    expect((await deploy(created.agentId, "a", [notes(8_192)])).status).toBe(201);
    expect((await deploy(created.agentId, "b", [notes(2_048)])).status).toBe(201);
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 2_048 });
    expect((await deploy(created.agentId, "a", [notes(8_192)])).status).toBe(201);
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 8_192 });
    expect((await activations(created.id)).map((row) => [row.seq, row.deployment_id.slice(-1), row.state])).toEqual([
      [1, "a", "selected"],
      [2, "b", "selected"],
      [3, "a", "selected"],
    ]);
    expect(await environmentRow(created.id)).toMatchObject({ activation_seq: 3, selected_activation_seq: 3 });
  });

  it("refuses a provider kind change without flipping the alias", async () => {
    const created = await project();
    const first = await (await deploy(created.agentId, "a", [notes(8_192)])).json<AgentDeployment>();
    const response = await deploy(created.agentId, "b", [notes(8_192, "http")]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "memory_configuration_conflict" } });
    expect((await account().resolveDeployment(`${created.agentId}@development`))?.id).toBe(first.id);
    expect(await environmentRow(created.id)).toMatchObject({ active_deployment_id: first.id, selected_activation_seq: 1 });
    expect((await activations(created.id)).map((row) => [row.seq, row.state])).toEqual([[1, "selected"], [2, "rejected"]]);
  });

  it("a lost apply reply leaves a recorded intent that the alarm re-drives after eviction", async () => {
    const created = await project();
    expect(await deployWithLostApplyReply(created.agentId, "a", [notes(4_096)])).toBe("injected lost applyConfig reply");
    expect((await activations(created.id)).map((row) => [row.seq, row.state, row.attempts])).toEqual([[1, "allocated", 1]]);
    // Nothing selected yet: the alias did not flip ahead of the configuration.
    expect(await account().resolveDeployment(`${created.agentId}@development`)).toBeNull();
    expect(await memoryFor(created).resourceConfig("notes")).toBeNull();

    await evictAccount();
    clock.advance(5_000);
    expect(await runDurableObjectAlarm(account())).toBe(true);
    expect((await activations(created.id)).map((row) => [row.seq, row.state])).toEqual([[1, "selected"]]);
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 4_096 });
    expect((await account().resolveDeployment(`${created.agentId}@development`))?.artifact.digest).toBe("a".repeat(64));
  });

  for (const commit of [false, true]) {
    it(`an object killed with applyConfig in flight${commit ? " after the remote commit" : ""} is woken by its alarm`, async () => {
      const created = await project();
      await hangApplyReply({ commit });
      const promotion = deploy(created.agentId, "a", [notes(4_096)]).catch(() => null);
      await until(async () => (await activations(created.id)).some((row) => row.state === "allocated"));
      await crashAll();
      await promotion;
      expect((await activations(created.id)).map((row) => [row.seq, row.state])).toEqual([[1, "allocated"]]);
      expect(await account().resolveDeployment(`${created.agentId}@development`)).toBeNull();
      expect(await memoryFor(created).resourceConfig("notes")).toEqual(
        commit ? { resource: "notes", provider: "document", maxBytes: 4_096 } : null,
      );
      // The wake-up was persisted before the call left; it applies (or
      // finds applied) and selects the code.
      clock.advance(ACTIVATION_ATTEMPT_DEADLINE_MS + 1_000);
      expect(await runDurableObjectAlarm(account())).toBe(true);
      expect((await activations(created.id)).map((row) => [row.seq, row.state])).toEqual([[1, "selected"]]);
      expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 4_096 });
      expect((await account().resolveDeployment(`${created.agentId}@development`))?.artifact.digest).toBe("a".repeat(64));
      expect(await environmentRow(created.id)).toMatchObject({ activation_seq: 1, selected_activation_seq: 1 });
    });
  }

  it("a delayed older promotion never overwrites a newer one", async () => {
    const created = await project();
    expect(await deployWithLostApplyReply(created.agentId, "a", [notes(1_024)])).toBe("injected lost applyConfig reply");
    await evictAccount();
    // B promotes while A's intent is still waiting for its retry.
    expect((await deploy(created.agentId, "b", [notes(2_048)])).status).toBe(201);
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 2_048 });
    clock.advance(5_000);
    await runDurableObjectAlarm(account());
    expect((await activations(created.id)).map((row) => [row.seq, row.state])).toEqual([
      [1, "superseded"],
      [2, "selected"],
    ]);
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 2_048 });
    expect((await account().resolveDeployment(`${created.agentId}@development`))?.artifact.digest).toBe("b".repeat(64));
  });

  it("rejects malformed declarations", async () => {
    const created = await project();
    const response = await deploy(created.agentId, "a", [
      { id: "notes", description: "x", provider: { kind: "document", maxBytes: 100_000 } },
    ]);
    expect(response.status).toBe(400);
  });
});

describe("secondary agents deployed alone (B2)", () => {
  function declaration(id: string, maxBytes: number): MemoryDeclaration {
    return { id, description: `${id}.`, provider: { kind: "document", maxBytes } };
  }

  it("activates the environment's aggregate configuration when a worker deploys alone", async () => {
    const created = await project();
    const worker = `${created.agentId}--worker`;
    const primary = await (await deploy(created.agentId, "a", [notes(1_024)])).json<AgentDeployment>();
    const response = await deploy(worker, "b", [declaration("worker-notes", 64)]);
    expect(response.status).toBe(201);
    const deployment = await response.json<AgentDeployment>();
    // The worker's resource is live in the environment's Memory DO next to
    // the primary's, under the environment's next activation.
    expect(await memoryFor(created).resourceConfig("worker-notes")).toEqual({ resource: "worker-notes", provider: "document", maxBytes: 64 });
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 1_024 });
    expect((await activations(created.id)).map((row) => [row.seq, row.state])).toEqual([[1, "selected"], [2, "selected"]]);
    expect(await environmentRow(created.id)).toEqual({ active_deployment_id: primary.id, activation_seq: 2, selected_activation_seq: 2 });
    expect((await account().resolveDeployment(`${worker}@development`))?.id).toBe(deployment.id);
    expect((await account().resolveDeployment(`${created.agentId}@development`))?.id).toBe(primary.id);
    const owner = await SELF.fetch(`${base}/v1/projects/${created.id}/memory/worker-notes/documents/plan?environment=development`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-none-match": "*" },
      body: JSON.stringify({ title: "Plan", text: "worker text" }),
    });
    expect(owner.status).toBe(201);
    // The primary redeploys: the worker's resource stays part of the aggregate.
    expect((await deploy(created.agentId, "c", [notes(2_048)])).status).toBe(201);
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 2_048 });
    expect(await memoryFor(created).resourceConfig("worker-notes")).toMatchObject({ maxBytes: 64 });
    expect(await environmentRow(created.id)).toMatchObject({ activation_seq: 3, selected_activation_seq: 3 });
  });

  it("a worker deployed before the primary activates alone and the primary joins the aggregate", async () => {
    const created = await project();
    const worker = `${created.agentId}--worker`;
    const response = await deploy(worker, "b", [declaration("worker-notes", 64)]);
    expect(response.status).toBe(201);
    expect(await memoryFor(created).resourceConfig("worker-notes")).toMatchObject({ maxBytes: 64 });
    expect(await environmentRow(created.id)).toEqual({ active_deployment_id: null, activation_seq: 1, selected_activation_seq: 1 });
    const primary = await (await deploy(created.agentId, "a", [notes(1_024)])).json<AgentDeployment>();
    expect(await environmentRow(created.id)).toEqual({ active_deployment_id: primary.id, activation_seq: 2, selected_activation_seq: 2 });
    expect(await memoryFor(created).resourceConfig("worker-notes")).toMatchObject({ maxBytes: 64 });
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 1_024 });
  });

  it("refuses a worker whose declaration disagrees with an active member, before its alias is published", async () => {
    const created = await project();
    const worker = `${created.agentId}--worker`;
    expect((await deploy(created.agentId, "a", [notes(1_024)])).status).toBe(201);
    const response = await deploy(worker, "b", [notes(8)]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "memory_configuration_conflict" } });
    expect(await account().resolveDeployment(`${worker}@development`)).toBeNull();
    expect(await memoryFor(created).resourceConfig("notes")).toMatchObject({ maxBytes: 1_024 });
    expect((await activations(created.id)).map((row) => [row.seq, row.state])).toEqual([[1, "selected"]]);
    // The same declaration as the primary is fine.
    expect((await deploy(worker, "b", [notes(1_024)])).status).toBe(201);
    expect((await account().resolveDeployment(`${worker}@development`))?.artifact.digest).toBe("b".repeat(64));
  });

  it("refuses memory declarations on an agent outside any project", async () => {
    const response = await deploy(`orphan-${crypto.randomUUID().slice(0, 8)}`, "a", [notes(1_024)]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "memory_configuration_conflict" } });
  });
});
