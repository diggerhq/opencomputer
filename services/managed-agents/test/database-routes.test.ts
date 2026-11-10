import { SELF, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(reset);

async function createProject() {
  const response = await SELF.fetch("https://managedagents.test/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentMode: "legacy", name: `Database UI ${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; agentId: string };
}

describe("project database inspection route", () => {
  it("requires a deployed environment and never provisions from dashboard reads", async () => {
    const project = await createProject();
    const response = await SELF.fetch(
      `https://managedagents.test/v1/projects/${project.id}/database/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environment: "development",
          sql: "SELECT 1",
          parameters: [],
        }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "database_not_deployed" },
    });
  });

  it("distinguishes legacy deployments whose database was never provisioned", async () => {
    const project = await createProject();
    const deployment = await SELF.fetch(
      "https://managedagents.test/v1/deployments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: project.agentId,
          alias: "development",
          channels: [],
          connections: [],
          imageArn: "test-image",
          imageVersion: "1",
          artifact: {
            bucket: "managed-agent-artifacts",
            key: `legacy/${project.id}/artifact.json`,
            digest: "a".repeat(64),
            size: 1,
          },
        }),
      },
    );
    expect(deployment.status).toBe(201);

    const response = await SELF.fetch(
      `https://managedagents.test/v1/projects/${project.id}/database/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          environment: "development",
          sql: "SELECT 1",
          parameters: [],
        }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "database_not_provisioned",
        message:
          "Redeploy this project to development to provision its database",
      },
    });
  });

  it("validates method, project scope, and environment before database access", async () => {
    const project = await createProject();
    const route = `https://managedagents.test/v1/projects/${project.id}/database/query`;
    expect((await SELF.fetch(route)).status).toBe(405);
    expect(
      (
        await SELF.fetch(
          "https://managedagents.test/v1/projects/missing/database/query",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ environment: "development", sql: "SELECT 1" }),
          },
        )
      ).status,
    ).toBe(404);
    const invalidEnvironment = await SELF.fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment: "preview", sql: "SELECT 1" }),
    });
    expect(invalidEnvironment.status).toBe(400);
    await expect(invalidEnvironment.json()).resolves.toMatchObject({
      error: { code: "invalid_environment" },
    });
  });
});
