import assert from "node:assert/strict";
import test from "node:test";

import { OpenComputerClient } from "./api.js";
import { memoryResources } from "./memory.js";

const config = { apiUrl: "https://app.opencomputer.dev", apiKey: "test" };

function route(input: string | URL | Request): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return `${url.pathname}${url.search}`;
}

test("memory resources come from the durable inventory, undeclared ones included", async (context) => {
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    paths.push(route(input));
    return Response.json({
      resources: [
        {
          id: "scratch",
          provider: { kind: "document", maxBytes: 4096 },
          declared: false,
          documents: 2,
        },
        {
          id: "requirements",
          provider: { kind: "document", maxBytes: 8192 },
          declared: true,
          documents: 3,
        },
      ],
    });
  });

  const listing = await memoryResources(
    new OpenComputerClient(config),
    "prj_1",
    "production",
  );

  assert.deepEqual(paths, [
    "/api/managed-agents/projects/prj_1/memory?environment=production",
  ]);
  assert.equal(listing.source, "inventory");
  assert.deepEqual(
    listing.resources.map((resource) => [
      resource.id,
      resource.declared,
      resource.documents,
    ]),
    [
      ["requirements", true, 3],
      ["scratch", false, 2],
    ],
  );
});

test("without the inventory route, memory resources merge every project member's active declarations", async (context) => {
  const paths: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = route(input);
    paths.push(path);
    if (path.startsWith("/api/managed-agents/projects/prj_1/memory")) {
      return Response.json(
        { error: { code: "not_found", message: "Route not found" } },
        { status: 404 },
      );
    }
    if (path === "/api/managed-agents/projects") {
      return Response.json({
        projects: [
          {
            id: "prj_1",
            slug: "muse",
            name: "Muse",
            agents: [
              { id: "muse", name: "Coordinator" },
              { id: "muse--worker", name: "Worker" },
            ],
            environments: [
              {
                name: "development",
                agentId: "muse",
                activeDeploymentId: "muse:dev",
                updatedAt: "2026-09-10T00:00:00.000Z",
              },
              {
                name: "production",
                agentId: "muse",
                activeDeploymentId: "muse:prod",
                updatedAt: "2026-09-10T00:00:00.000Z",
              },
              {
                name: "development",
                agentId: "muse--worker",
                activeDeploymentId: "muse--worker:dev",
                updatedAt: "2026-09-10T00:00:00.000Z",
              },
              {
                name: "production",
                agentId: "muse--worker",
                updatedAt: "2026-09-10T00:00:00.000Z",
              },
            ],
            createdAt: "2026-09-10T00:00:00.000Z",
            updatedAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      });
    }
    if (path === "/api/managed-agents/deployments/muse%3Adev") {
      return Response.json({
        id: "muse:dev",
        agentId: "muse",
        alias: "development",
        createdAt: "2026-09-10T00:00:00.000Z",
        memory: [
          {
            id: "requirements",
            provider: { kind: "document", maxBytes: 8192 },
          },
        ],
      });
    }
    if (path === "/api/managed-agents/deployments/muse--worker%3Adev") {
      return Response.json({
        id: "muse--worker:dev",
        agentId: "muse--worker",
        alias: "development",
        createdAt: "2026-09-10T00:00:00.000Z",
        memory: [
          { id: "requirements", provider: { kind: "document", maxBytes: 8192 } },
          { id: "worker-notes", provider: { kind: "document", maxBytes: 4096 } },
        ],
      });
    }
    throw new Error(`unexpected request ${path}`);
  });

  const listing = await memoryResources(
    new OpenComputerClient(config),
    "prj_1",
    "development",
  );

  assert.equal(listing.source, "declarations");
  assert.deepEqual(listing.resources, [
    {
      id: "requirements",
      provider: { kind: "document", maxBytes: 8192 },
      declared: true,
    },
    {
      id: "worker-notes",
      provider: { kind: "document", maxBytes: 4096 },
      declared: true,
    },
  ]);
  assert.ok(paths.includes("/api/managed-agents/deployments/muse--worker%3Adev"));
  assert.ok(!paths.some((path) => path.includes("muse%3Aprod")));
});
