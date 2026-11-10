import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type {
  AgentDeployment,
  InitializeSessionResult,
  Project,
  ProjectDeploymentReference,
} from "../src/protocol.js";

/**
 * Single-mode projects (work 028). A project created with
 * `environmentMode: "single"` has one canonical `default` scope: publishing,
 * sessions, and environment-scoped resources resolve to it, an older CLI's
 * `development` is translated to it, and explicit `production` is refused
 * with a typed error. New projects default to single mode; legacy mode remains
 * available only when explicitly requested.
 */

const base = "https://managedagents.test";

beforeEach(async () => {
  await env.SERVERLESS_AGENTS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS session_creations (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
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

async function fetchProject(id: string): Promise<Project> {
  const listed = await SELF.fetch(`${base}/v1/projects`);
  expect(listed.status).toBe(200);
  const body = await listed.json<{ projects: Project[] } | Project[]>();
  const projects = Array.isArray(body) ? body : body.projects;
  const project = projects.find((candidate) => candidate.id === id);
  expect(project).toBeDefined();
  return project!;
}

async function createProject(input: Record<string, unknown>): Promise<Project> {
  const created = await SELF.fetch(
    `${base}/v1/projects`,
    jsonRequest("POST", { name: `Single ${crypto.randomUUID().slice(0, 8)}`, ...input }),
  );
  expect(created.status).toBe(201);
  const body = await created.json<{ project?: Project } & Project>();
  return body.project ?? body;
}

function deploy(project: Project, alias: string, digest = "e".repeat(64)): Promise<Response> {
  return SELF.fetch(
    `${base}/v1/deployments`,
    jsonRequest("POST", {
      agentId: project.agentId,
      alias,
      channels: [],
      connections: [],
      imageArn: "test-image",
      imageVersion: "1",
      artifact: { bucket: "b", key: `accounts/local/agents/${project.agentId}/artifact.json`, digest, size: 1 },
    }),
  );
}

describe("single-environment projects", () => {
  it("creates single-mode projects by default and legacy projects on request", async () => {
    const single = await createProject({});
    expect(single.environmentMode).toBe("single");
    expect(single.environments.map((environment) => environment.name)).toEqual(["default"]);

    const legacy = await createProject({ environmentMode: "legacy" });
    expect(legacy.environmentMode).toBe("legacy");
    expect(legacy.environments.map((environment) => environment.name).sort()).toEqual(["development", "production"]);

    expect((await fetchProject(single.id)).environmentMode).toBe("single");

    expect(await error(await SELF.fetch(`${base}/v1/projects`, jsonRequest("POST", { name: "x", environmentMode: "dual" })))).toEqual({
      status: 400,
      code: "invalid_environment_mode",
    });
  });

  it("lists projects when a legacy agent id exceeds SQLite's LIKE pattern limit", async () => {
    const project = await createProject({ environmentMode: "single" });
    const oversizedLegacyAgentId = "%".repeat(50_001);
    await runInDurableObject(env.ACCOUNTS.getByName("local"), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE projects SET agent_id = ? WHERE id = ?",
        oversizedLegacyAgentId,
        project.id,
      );
    });

    const listed = await SELF.fetch(`${base}/v1/projects`);
    expect(listed.status).toBe(200);
  });

  it("publishes to the default scope, translating an older CLI's development and refusing production", async () => {
    const project = await createProject({ environmentMode: "single" });

    const compat = await deploy(project, "development");
    expect(compat.status).toBe(201);
    const translated = await compat.json<AgentDeployment & { aliasCompatibility?: string }>();
    expect(translated.alias).toBe("default");
    expect(translated.aliasCompatibility).toBe("legacy-development-default");

    const explicit = await deploy(project, "default", "f".repeat(64));
    expect(explicit.status).toBe(201);
    const current = await explicit.json<AgentDeployment>();
    expect(current.alias).toBe("default");

    expect(await error(await deploy(project, "production", "a".repeat(64)))).toEqual({
      status: 409,
      code: "single_environment_project",
    });
    expect(await error(await deploy(project, "staging", "a".repeat(64)))).toEqual({
      status: 400,
      code: "invalid_environment",
    });

    const environments = (await fetchProject(project.id)).environments;
    expect(environments).toHaveLength(1);
    expect(environments[0]).toMatchObject({ name: "default", activeDeploymentId: current.id });
  });

  it("admits sessions against the default scope from bare, development, and default references", async () => {
    const project = await createProject({ environmentMode: "single" });
    const published = await deploy(project, "default");
    expect(published.status).toBe(201);
    const deployment = await published.json<AgentDeployment>();

    for (const agentId of [project.agentId, `${project.agentId}@development`, `${project.agentId}@default`]) {
      const response = await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { agentId }));
      expect(response.status, agentId).toBe(201);
      const { session } = await response.json<InitializeSessionResult>();
      expect(session.environment).toBe("default");
      expect(session.deploymentId).toBe(deployment.id);
    }

    expect(
      await error(await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { agentId: `${project.agentId}@production` }))),
    ).toEqual({ status: 409, code: "single_environment_project" });
    expect(
      await error(await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { agentId: project.agentId, environment: "production" }))),
    ).toEqual({ status: 409, code: "single_environment_project" });
  });

  it("keeps existing sessions pinned when the current deployment advances", async () => {
    const project = await createProject({ environmentMode: "single" });
    const first = await (await deploy(project, "default")).json<AgentDeployment>();
    const before = await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { agentId: project.agentId }));
    expect(before.status).toBe(201);
    const pinned = (await before.json<InitializeSessionResult>()).session;
    expect(pinned.deploymentId).toBe(first.id);

    const second = await (await deploy(project, "default", "f".repeat(64))).json<AgentDeployment>();
    expect(second.id).not.toBe(first.id);
    const after = await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { agentId: project.agentId }));
    expect((await after.json<InitializeSessionResult>()).session.deploymentId).toBe(second.id);

    const still = await SELF.fetch(`${base}/v1/sessions/${pinned.id}`);
    expect(still.status).toBe(200);
    const snapshot = await still.json<{ session?: { deploymentId: string } } & { deploymentId?: string }>();
    expect((snapshot.session ?? snapshot).deploymentId).toBe(first.id);
  });

  it("scopes variables and secrets to default and refuses production", async () => {
    const project = await createProject({ environmentMode: "single" });
    const variables = `${base}/v1/projects/${project.id}/runtime-variables`;

    expect((await SELF.fetch(`${variables}/GREETING`, jsonRequest("PUT", { value: "hi" }))).status).toBeLessThan(300);
    const listed = await SELF.fetch(variables);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain("GREETING");

    const compat = await SELF.fetch(`${variables}?environment=development`);
    expect(compat.status).toBe(200);
    expect(JSON.stringify(await compat.json())).toContain("GREETING");

    expect(await error(await SELF.fetch(`${variables}?environment=production`))).toEqual({
      status: 409,
      code: "single_environment_project",
    });
    expect(
      await error(await SELF.fetch(`${variables}/OTHER`, jsonRequest("PUT", { value: "x", environment: "production" }))),
    ).toEqual({ status: 409, code: "single_environment_project" });
  });

  it("lists single-mode sessions under an older CLI's development filter and filters account-wide logs by default", async () => {
    const project = await createProject({ environmentMode: "single" });
    expect((await deploy(project, "default")).status).toBe(201);
    const created = await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { agentId: project.agentId }));
    expect(created.status).toBe(201);
    const { session } = await created.json<InitializeSessionResult>();

    for (const environment of ["development", "default"]) {
      const listed = await SELF.fetch(`${base}/v1/sessions?project=${project.id}&environment=${environment}`);
      expect(listed.status, environment).toBe(200);
      const body = await listed.json<{ sessions: Array<{ id: string }> }>();
      expect(body.sessions.map((entry) => entry.id), environment).toContain(session.id);
    }
    expect(
      await error(await SELF.fetch(`${base}/v1/sessions?project=${project.id}&environment=production`)),
    ).toEqual({ status: 409, code: "single_environment_project" });

    expect((await SELF.fetch(`${base}/v1/logs?environment=default`)).status).toBe(200);
    expect(await error(await SELF.fetch(`${base}/v1/logs?environment=staging`))).toEqual({
      status: 400,
      code: "invalid_environment",
    });
  });

  it("admits a session pinned by deploymentId alone into a single-mode project's default scope", async () => {
    const project = await createProject({ environmentMode: "single" });
    const deployment = await (await deploy(project, "default")).json<AgentDeployment>();

    const implicit = await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { deploymentId: deployment.id }));
    expect(implicit.status).toBe(201);
    expect((await implicit.json<InitializeSessionResult>()).session).toMatchObject({
      deploymentId: deployment.id,
      environment: "default",
    });

    const explicit = await SELF.fetch(
      `${base}/v1/sessions`,
      jsonRequest("POST", { deploymentId: deployment.id, environment: "default" }),
    );
    expect(explicit.status).toBe(201);
    expect((await explicit.json<InitializeSessionResult>()).session.environment).toBe("default");

    expect(
      await error(
        await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { deploymentId: deployment.id, environment: "production" })),
      ),
    ).toEqual({ status: 409, code: "single_environment_project" });
  });

  it("lists single-mode sessions under an agent filter with an older CLI's development environment", async () => {
    const project = await createProject({ environmentMode: "single" });
    expect((await deploy(project, "default")).status).toBe(201);
    const created = await SELF.fetch(`${base}/v1/sessions`, jsonRequest("POST", { agentId: project.agentId }));
    expect(created.status).toBe(201);
    const { session } = await created.json<InitializeSessionResult>();

    const listed = await SELF.fetch(
      `${base}/v1/sessions?agent=${encodeURIComponent(project.agentId)}&environment=development`,
    );
    expect(listed.status).toBe(200);
    const body = await listed.json<{ sessions: Array<{ id: string }> }>();
    expect(body.sessions.map((entry) => entry.id)).toContain(session.id);
    expect(
      await error(
        await SELF.fetch(`${base}/v1/sessions?agent=${encodeURIComponent(project.agentId)}&environment=production`),
      ),
    ).toEqual({ status: 409, code: "single_environment_project" });
  });

  it("treats a legacy project's default alias as a deployment alias, not an environment", async () => {
    const project = await createProject({ environmentMode: "legacy" });
    const published = await deploy(project, "default");
    expect(published.status).toBe(201);
    const deployment = await published.json<AgentDeployment>();

    const environments = (await fetchProject(project.id)).environments;
    expect(environments.map((environment) => environment.name).sort()).toEqual(["development", "production"]);
    expect(environments.every((environment) => environment.activeDeploymentId !== deployment.id)).toBe(true);

    const response = await SELF.fetch(
      `${base}/v1/sessions`,
      jsonRequest("POST", { agentId: `${project.agentId}@default` }),
    );
    expect(response.status).toBe(201);
    const { session } = await response.json<InitializeSessionResult>();
    expect(session.deploymentId).toBe(deployment.id);
    expect(session.environment).not.toBe("default");
  });

  it("keeps legacy deployments reachable under non-environment aliases", async () => {
    const project = await createProject({ environmentMode: "legacy" });
    const published = await deploy(project, "preview");
    expect(published.status).toBe(201);
    const deployment = await published.json<AgentDeployment>();
    const response = await SELF.fetch(
      `${base}/v1/sessions`,
      jsonRequest("POST", { agentId: `${project.agentId}@preview` }),
    );
    expect(response.status).toBe(201);
    expect((await response.json<InitializeSessionResult>()).session.deploymentId).toBe(deployment.id);
  });

  it("runs preview deployment aliases in a single-mode project's default scope", async () => {
    const project = await createProject({ environmentMode: "single" });
    const account = env.ACCOUNTS.getByName("local");
    const deployment = await account.registerDeployment({
      agentId: project.agentId,
      alias: "pr-7",
      channels: [],
      connections: [],
      imageArn: "test-image",
      imageVersion: "1",
      artifact: {
        bucket: "b",
        key: `accounts/local/agents/${project.agentId}/preview.json`,
        digest: "7".repeat(64),
        size: 1,
      },
    });

    const response = await SELF.fetch(
      `${base}/v1/sessions`,
      jsonRequest("POST", { agentId: `${project.agentId}@pr-7` }),
    );
    expect(response.status).toBe(201);
    expect((await response.json<InitializeSessionResult>()).session).toMatchObject({
      deploymentId: deployment.id,
      environment: "default",
    });

    expect(
      await error(
        await SELF.fetch(
          `${base}/v1/sessions`,
          jsonRequest("POST", { agentId: `${project.agentId}@pr-8` }),
        ),
      ),
    ).toEqual({ status: 404, code: "deployment_not_found" });
  });

  it("resolves an older client's agent@development reference to a single-mode project's default deployment", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const project = await createProject({ environmentMode: "single" });
    const published = await deploy(project, "development");
    expect(published.status).toBe(201);
    const deployment = await published.json<AgentDeployment>();
    expect((await account.resolveDeployment(`${project.agentId}@development`))?.id).toBe(deployment.id);
    expect((await account.resolveDeployment(`${project.agentId}@default`))?.id).toBe(deployment.id);
    expect((await account.resolveDeployment(project.agentId))?.id).toBe(deployment.id);
    expect(await account.resolveDeployment(`${project.agentId}@production`)).toBeNull();
  });

  it("activates production-enabled schedules in a single-mode project's default scope and keeps development-only ones manual", async () => {
    const account = env.ACCOUNTS.getByName("local");
    const project = await createProject({ environmentMode: "single" });
    const graph: ProjectDeploymentReference = {
      id: `project:${project.id}:graph-one`,
      digest: "f".repeat(64),
      localAgentId: "hygiene",
      agents: [{ localId: "hygiene", agentId: project.agentId, artifactDigest: "a".repeat(64) }],
      resources: {
        version: 1,
        channels: [],
        channelRegistrations: [],
        outboxes: [],
        outboxRegistrations: [],
        schedules: [
          {
            id: "weekday-hygiene",
            agentId: "hygiene",
            cron: "0 9 * * 1-5",
            timezone: "UTC",
            enabled: ["production"],
            overlap: "skip",
            dispatch: { text: "Review stale flags" },
          },
          {
            id: "development-only",
            agentId: "hygiene",
            cron: "0 10 * * *",
            timezone: "UTC",
            enabled: ["development"],
            overlap: "skip",
            dispatch: { text: "Ship" },
          },
        ],
      },
    };
    await account.registerDeployment({
      agentId: project.agentId,
      alias: "default",
      channels: [],
      connections: [],
      projectDeployment: graph,
      artifact: { bucket: "artifacts", key: "hygiene.json", digest: "a".repeat(64), size: 10 },
      imageArn: "image",
      imageVersion: "1",
    });
    await account.reconcileProjectSchedules({
      accountId: "local",
      userId: "scheduler",
      projectId: project.id,
      environment: "default",
      edgeOrigin: base,
      projectDeployment: graph,
    });
    const schedules = await account.listProjectSchedules({ projectId: project.id, environment: "default" });
    expect(Object.fromEntries(schedules.map((schedule: { id: string; status: string }) => [schedule.id, schedule.status]))).toEqual({
      "weekday-hygiene": "active",
      "development-only": "manual",
    });
  });
});
