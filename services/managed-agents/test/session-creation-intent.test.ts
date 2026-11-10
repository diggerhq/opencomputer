import { abortAllDurableObjects, env, SELF, runInDurableObject } from "cloudflare:test";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DeploymentPoolDurableObject } from "../src/edge/deployment-pool-do.js";
import type { SessionDurableObject } from "../src/edge/session-do.js";
import type { AgentDeployment, InitializeSessionResult, Project, SessionSnapshot } from "../src/protocol.js";

/**
 * Creation identity under an Idempotency-Key is the caller's intent (the
 * alias addressed, or the deployment pinned), recorded at first admission.
 * A replay compares that intent, never what the alias resolves to now, so a
 * promotion between the first admission and a retry returns the original
 * session with its original deployment. Different intent under the same key
 * still conflicts, and authorization is checked afresh.
 */

const base = "https://managedagents.test";

/**
 * The fake Workerd runtime's test control, present when this file runs in
 * the `managed-session-workerd` project: there a creation awaits the
 * runtime, which is the window in which concurrent admissions of one
 * session interleave. In the `worker` project nothing is awaited and the
 * race tests are moot, so they run only against the real host path.
 */
const fakeRuntime = (env as unknown as { WORKERD_RUNTIME?: Fetcher }).WORKERD_RUNTIME;
const control = "https://workerd-runtime.invalid/__test/creation";

async function delayCreation(delayMs: number): Promise<void> {
  if (!fakeRuntime) return;
  await fakeRuntime.fetch(control, jsonRequest("POST", { delayMs }));
}

async function creationsInFlight(): Promise<string[]> {
  if (!fakeRuntime) return [];
  return (await (await fakeRuntime.fetch(control)).json<{ inFlight: string[] }>()).inFlight;
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the fake runtime");
}

afterEach(async () => {
  await delayCreation(0);
});

afterAll(async () => {
  await abortAllDurableObjects();
});

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
  /** Registers an artifact under the alias; a second call with a new version promotes a new deployment. Every digest is unique. */
  deploy(alias: "development" | "production", version: string): Promise<AgentDeployment>;
  create(body: Record<string, unknown>, key?: string): Promise<Response>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
}

async function fixture(): Promise<Fixture> {
  const created = await SELF.fetch(`${base}/v1/projects`, jsonRequest("POST", { environmentMode: "legacy", name: `Intent ${crypto.randomUUID().slice(0, 8)}` }));
  expect(created.status).toBe(201);
  const body = await created.json<{ project?: Project } & Project>();
  const project = body.project ?? body;
  return {
    project,
    deploy: async (alias, version) => {
      const response = await SELF.fetch(
        `${base}/v1/deployments`,
        jsonRequest("POST", {
          agentId: project.agentId,
          alias,
          channels: [],
          connections: [],
          imageArn: "test-image",
          imageVersion: version,
          artifact: {
            bucket: "b",
            key: `accounts/local/agents/${project.agentId}/${version}/artifact.json`,
            digest: `${version}-${crypto.randomUUID()}`.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
            size: 1,
          },
        }),
      );
      expect(response.status).toBe(201);
      return response.json<AgentDeployment>();
    },
    create: (input, key) =>
      SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", input, key ? { "idempotency-key": key } : {})),
    snapshot: async (sessionId) => {
      const response = await SELF.fetch(`${base}/v1/sessions/${sessionId}`);
      expect(response.status).toBe(200);
      return response.json<SessionSnapshot>();
    },
  };
}

describe("creation intent under an idempotency key", () => {
  it("replays the original session and deployment after a promotion", async () => {
    const f = await fixture();
    const first = await f.deploy("development", "1");
    const key = `submission-${crypto.randomUUID()}`;
    const body = { agentId: `${f.project.agentId}@development` };

    const initial = await f.create(body, key);
    expect(initial.status).toBe(201);
    const admitted = await initial.json<InitializeSessionResult & { deployment?: AgentDeployment }>();
    expect(admitted.deployment?.id).toBe(first.id);
    expect((await f.snapshot(admitted.session.id)).creation).toEqual({ agent: `${f.project.agentId}@development` });

    // The reply was lost; meanwhile a new version is promoted to development.
    const second = await f.deploy("development", "2");
    expect(second.id).not.toBe(first.id);

    const retry = await f.create(body, key);
    expect(retry.status).toBe(200);
    const replayed = await retry.json<InitializeSessionResult & { deployment?: AgentDeployment }>();
    expect(replayed.session.id).toBe(admitted.session.id);
    expect(replayed.deployment?.id).toBe(first.id);
    expect((await f.snapshot(admitted.session.id)).deploymentId).toBe(first.id);

    // A new submission after the promotion gets the new version.
    const fresh = await f.create(body, `submission-${crypto.randomUUID()}`);
    expect(fresh.status).toBe(201);
    expect((await fresh.json<{ deployment?: AgentDeployment }>()).deployment?.id).toBe(second.id);
  });

  it("answers a bare agent id and its production alias as one intent", async () => {
    const f = await fixture();
    await f.deploy("production", "1");
    const key = `submission-${crypto.randomUUID()}`;
    const initial = await f.create({ agentId: f.project.agentId }, key);
    expect(initial.status).toBe(201);
    const replay = await f.create({ agentId: `${f.project.agentId}@production` }, key);
    expect(replay.status).toBe(200);
    expect((await f.snapshot((await initial.json<InitializeSessionResult>()).session.id)).creation).toEqual({
      agent: `${f.project.agentId}@production`,
    });
  });

  it("converges concurrent submissions under one key on one session, while the runtime is still initializing it", async () => {
    const f = await fixture();
    const first = await f.deploy("development", "1");
    const key = `submission-${crypto.randomUUID()}`;
    const body = { agentId: `${f.project.agentId}@development` };
    // The runtime takes 75 ms to create the session: every request passes
    // the edge's lookup and reaches the Session object before the first
    // admission has written anything.
    await delayCreation(75);
    const responses = await Promise.all([f.create(body, key), f.create(body, key), f.create(body, key)]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 200, 201]);
    const ids = new Set<string>();
    for (const response of responses) {
      const answer = await response.json<InitializeSessionResult & { deployment?: AgentDeployment }>();
      ids.add(answer.session.id);
      expect(answer.deployment?.id).toBe(first.id);
    }
    expect(ids.size).toBe(1);
    const [id] = ids;
    const snapshot = await f.snapshot(id!);
    // One runtime slot, held by the one admission; the losers created nothing.
    const slots = await runInDurableObject(env.SESSIONS.getByName(id!), (instance: SessionDurableObject) =>
      Number(
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM workerd_session")
          .one().count,
      ),
    );
    expect(slots).toBe(snapshot.executionMode === "workerd" ? 1 : 0);
  });

  it.skipIf(!fakeRuntime)("replays a request that arrives while the first admission is in flight, across a promotion", async () => {
    const f = await fixture();
    const first = await f.deploy("development", "1");
    const key = `submission-${crypto.randomUUID()}`;
    const body = { agentId: `${f.project.agentId}@development` };
    await delayCreation(400);
    const initial = f.create(body, key);
    await until(async () => (await creationsInFlight()).includes(first.artifact.digest));
    // While the runtime is still creating the first session, the alias
    // moves on and the same submission is sent again: it resolves the new
    // deployment, loses the admission, and converges on the original.
    const second = await f.deploy("development", "2");
    const racing = await f.create(body, key);
    const admitted = await initial;
    expect(admitted.status).toBe(201);
    expect(racing.status).toBe(200);
    const a = await admitted.json<InitializeSessionResult & { deployment?: AgentDeployment }>();
    const b = await racing.json<InitializeSessionResult & { deployment?: AgentDeployment }>();
    expect(b.session.id).toBe(a.session.id);
    expect(a.deployment?.id).toBe(first.id);
    expect(b.deployment?.id).toBe(first.id);
    expect((await f.snapshot(a.session.id)).deploymentId).toBe(first.id);
    // A new submission gets the promoted deployment.
    const fresh = await f.create(body, `submission-${crypto.randomUUID()}`);
    expect(fresh.status).toBe(201);
    expect((await fresh.json<{ deployment?: AgentDeployment }>()).deployment?.id).toBe(second.id);
  });

  it.skipIf(!fakeRuntime)("returns the losers' prewarmed leases to the pool and binds one to the session", async () => {
    const f = await fixture();
    const deployment = await f.deploy("development", "1");
    // Registering the deployment prewarms its pool; wait for the standbys.
    const pool = env.POOLS.getByName(["local", deployment.id, deployment.imageVersion].join(":"));
    await until(async () => {
      const counts = await pool.inspectWorkerd();
      return counts.filling === 0 && counts.ready === 3;
    });
    const standbys = (
      await runInDurableObject(pool, (instance: DeploymentPoolDurableObject) =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
          .exec<{ runtime_session_id: string }>("SELECT runtime_session_id FROM workerd_pool WHERE status = 'ready'")
          .toArray(),
      )
    ).map((row) => row.runtime_session_id);
    expect(standbys).toHaveLength(3);
    const key = `submission-${crypto.randomUUID()}`;
    const body = { agentId: `${f.project.agentId}@development` };
    await delayCreation(75);
    // Every request claims a lease before the admission; only the winner's is spent.
    const responses = await Promise.all([f.create(body, key), f.create(body, key), f.create(body, key)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 201]);
    const ids = new Set<string>();
    for (const response of responses) ids.add((await response.json<InitializeSessionResult>()).session.id);
    expect(ids.size).toBe(1);
    const [id] = ids;
    const held = await runInDurableObject(env.SESSIONS.getByName(id!), (instance: SessionDurableObject) =>
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
        .exec<{ runtime_session_id: string }>("SELECT runtime_session_id FROM workerd_session")
        .one().runtime_session_id,
    );
    expect(standbys).toContain(held);
    const afterwards = await runInDurableObject(pool, (instance: DeploymentPoolDurableObject) => {
      const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      return {
        bound: sql
          .exec<{ slot_id: string }>(
            "SELECT slot_id FROM workerd_model_gateway_capabilities WHERE session_id = ?",
            id!,
          )
          .toArray().length,
        returned: sql
          .exec<{ runtime_session_id: string }>(
            `SELECT pool.runtime_session_id FROM workerd_pool AS pool
             JOIN workerd_model_gateway_capabilities AS capability ON capability.slot_id = pool.slot_id
             WHERE pool.status = 'ready' AND capability.session_id IS NULL`,
          )
          .toArray()
          .map((row) => row.runtime_session_id),
      };
    });
    // One capability serves the session; the two leases the losers claimed
    // are standing by again, and the refill's newcomers sit beside them.
    expect(afterwards.bound).toBe(1);
    expect(afterwards.returned.filter((runtime) => standbys.includes(runtime)).sort()).toEqual(
      standbys.filter((runtime) => runtime !== held).sort(),
    );
  });

  it("still conflicts on a different environment or a different pinned deployment, and accepts a pin to the session's own", async () => {
    const f = await fixture();
    const first = await f.deploy("development", "1");
    await f.deploy("production", "1");
    const key = `submission-${crypto.randomUUID()}`;
    const initial = await f.create({ agentId: `${f.project.agentId}@development` }, key);
    expect(initial.status).toBe(201);

    expect(await error(await f.create({ agentId: `${f.project.agentId}@production` }, key))).toEqual({
      status: 409,
      code: "idempotency_conflict",
    });
    const second = await f.deploy("development", "2");
    expect(await error(await f.create({ deploymentId: second.id, environment: "development" }, key))).toEqual({
      status: 409,
      code: "idempotency_conflict",
    });
    // Pinning the deployment the session already holds is the same request.
    const pinnedSame = await f.create({ deploymentId: first.id, environment: "development" }, key);
    expect(pinnedSame.status).toBe(200);
    // A session created by an explicit pin replays on that pin after a promotion too.
    const pinKey = `submission-${crypto.randomUUID()}`;
    const pinned = await f.create({ deploymentId: second.id, environment: "development" }, pinKey);
    expect(pinned.status).toBe(201);
    await f.deploy("development", "3");
    const pinnedReplay = await f.create({ deploymentId: second.id, environment: "development" }, pinKey);
    expect(pinnedReplay.status).toBe(200);
    expect((await pinnedReplay.json<{ deployment?: AgentDeployment }>()).deployment?.id).toBe(second.id);
  });

  it("checks identity on a replay", async () => {
    const f = await fixture();
    await f.deploy("development", "1");
    const key = `submission-${crypto.randomUUID()}`;
    const initial = await f.create({ agentId: `${f.project.agentId}@development` }, key);
    expect(initial.status).toBe(201);
    const { session } = await initial.json<InitializeSessionResult>();
    // The session was admitted for another user: the same key from this identity is not its replay.
    await runInDurableObject(env.SESSIONS.getByName(session.id), (instance: SessionDurableObject) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "UPDATE session SET user_id = 'someone-else'",
      );
    });
    expect(await error(await f.create({ agentId: `${f.project.agentId}@development` }, key))).toEqual({
      status: 409,
      code: "idempotency_conflict",
    });
  });

  it("keeps the earlier rule for sessions created before intent was recorded", async () => {
    const f = await fixture();
    const first = await f.deploy("development", "1");
    const key = `submission-${crypto.randomUUID()}`;
    const body = { agentId: `${f.project.agentId}@development` };
    const initial = await f.create(body, key);
    expect(initial.status).toBe(201);
    const { session } = await initial.json<InitializeSessionResult>();
    await runInDurableObject(env.SESSIONS.getByName(session.id), (instance: SessionDurableObject) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "UPDATE session SET creation_json = NULL",
      );
    });
    expect((await f.snapshot(session.id)).creation).toBeUndefined();
    // Before a promotion the alias still resolves to the pinned deployment: a replay.
    const before = await f.create(body, key);
    expect(before.status).toBe(200);
    expect((await before.json<{ deployment?: AgentDeployment }>()).deployment?.id).toBe(first.id);
    // After a promotion the earlier rule refuses, as it always did.
    await f.deploy("development", "2");
    expect(await error(await f.create(body, key))).toEqual({ status: 409, code: "idempotency_conflict" });
  });
});
