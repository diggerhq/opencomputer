import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenComputerClient } from "./api.js";
import { CLIError } from "./errors.js";
import {
  createSessionWithMemory,
  ensureMemoryDocuments,
  memoryResources,
  saveMemoryEdit,
} from "./memory-commands.js";

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

async function draftFile(): Promise<{
  path: string;
  discarded: () => boolean;
  discard: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "opencomputer-memory-test-"));
  const path = join(directory, "requirements--workshop.md");
  await writeFile(path, "Exercises must run on Node.js 22.\n", "utf8");
  let discarded = false;
  return {
    path,
    discarded: () => discarded,
    discard: async () => {
      discarded = true;
      await rm(directory, { recursive: true, force: true });
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

const target = {
  projectId: "prj_1",
  resource: "requirements",
  id: "workshop",
  environment: "development" as const,
  etag: '"rev-1"',
  text: "Exercises must run on Node.js 22.\n",
};

test("an over-limit save keeps the edited draft and says where it is", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          code: "memory_limit_exceeded",
          message: "Text is 9000 bytes; the limit is 8192.",
        },
      },
      { status: 413 },
    ),
  );
  const draft = await draftFile();
  try {
    const error = await saveMemoryEdit(new OpenComputerClient(config), {
      ...target,
      draft,
    }).catch((error: unknown) => error);

    assert.ok(error instanceof CLIError);
    assert.equal(error.code, "memory_too_large");
    assert.match(error.message, /requirements\/workshop was not saved: Text is 9000 bytes/);
    assert.match(error.hint, new RegExp(`kept at ${draft.path}`));
    assert.match(error.hint, /--text-file/);
    assert.deepEqual(error.details, {
      status: 413,
      apiCode: "memory_limit_exceeded",
      editedTextPath: draft.path,
    });
    assert.equal(draft.discarded(), false);
    await access(draft.path);
  } finally {
    await draft.cleanup();
  }
});

test("a save that never reaches the API keeps the edited draft", async (context) => {
  context.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  const draft = await draftFile();
  try {
    const error = await saveMemoryEdit(new OpenComputerClient(config), {
      ...target,
      draft,
    }).catch((error: unknown) => error);

    assert.ok(error instanceof CLIError);
    assert.equal(error.code, "command_failed");
    assert.match(error.message, /was not saved: fetch failed/);
    assert.match(error.hint, new RegExp(`kept at ${draft.path}`));
    assert.deepEqual(error.details, { editedTextPath: draft.path });
    await access(draft.path);
  } finally {
    await draft.cleanup();
  }
});

test("a saved edit discards its draft", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        id: "workshop",
        title: "Workshop requirements",
        text: target.text,
        summary: "",
        agentWrites: "enabled",
        revision: "rev-2",
        bytes: 34,
        maxBytes: 8192,
        updatedAt: "2026-09-10T12:00:00.000Z",
        writer: { kind: "owner" },
      },
      { headers: { etag: '"rev-2"' } },
    ),
  );
  const draft = await draftFile();
  try {
    const document = await saveMemoryEdit(new OpenComputerClient(config), {
      ...target,
      draft,
    });
    assert.equal(document.revision, "rev-2");
    assert.equal(draft.discarded(), true);
    await assert.rejects(access(draft.path));
  } finally {
    await draft.cleanup();
  }
});

test("--create-document creates missing bound documents, keeps existing ones, and refuses deleted ids", async (context) => {
  const requests: Array<{ method: string; path: string; ifNoneMatch: string | null }> = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = route(request);
    requests.push({ method: request.method, path, ifNoneMatch: request.headers.get("if-none-match") });
    const document = (id: string, revision: string) =>
      Response.json({ id, title: id, text: "", summary: "", agentWrites: "enabled", revision, bytes: 0, maxBytes: 8192, updatedAt: "2026-09-10T00:00:00.000Z", writer: { kind: "owner" } }, { status: request.method === "PUT" ? 201 : 200, headers: { etag: `"${revision}"` } });
    if (path.includes("/documents/fresh?")) return document("fresh", "r1");
    if (path.includes("/documents/kept?")) {
      return request.method === "PUT"
        ? Response.json({ error: { code: "precondition_failed", message: "used" } }, { status: 412 })
        : document("kept", "r9");
    }
    if (path.includes("/documents/gone?")) {
      return request.method === "PUT"
        ? Response.json({ error: { code: "precondition_failed", message: "used" } }, { status: 412 })
        : Response.json({ error: { code: "not_found", message: "deleted" } }, { status: 404 });
    }
    throw new Error(`unexpected ${request.method} ${path}`);
  });
  const client = new OpenComputerClient(config);

  const ensured = await ensureMemoryDocuments(client, {
    projectId: "prj_1",
    environment: "development",
    bindings: {
      topics: { scope: "document", id: "fresh", access: "read-write" },
      profile: { scope: "document", id: "kept", access: "read" },
      archive: { scope: "collection" },
    },
  });
  assert.deepEqual(ensured, [
    { resource: "topics", id: "fresh", created: true, revision: "r1" },
    { resource: "profile", id: "kept", created: false, revision: "r9" },
  ]);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.path.split("?")[0]} ${request.ifNoneMatch ?? ""}`.trim()), [
    "PUT /api/managed-agents/projects/prj_1/memory/topics/documents/fresh *",
    "PUT /api/managed-agents/projects/prj_1/memory/profile/documents/kept *",
    "GET /api/managed-agents/projects/prj_1/memory/profile/documents/kept",
  ]);

  await assert.rejects(
    ensureMemoryDocuments(client, {
      projectId: "prj_1",
      environment: "development",
      bindings: { topics: { scope: "document", id: "gone" } },
    }),
    (error: unknown) => error instanceof CLIError && error.code === "memory_document_deleted" && /reserved/.test(error.message),
  );
});

test("session create sends bindings, reports replay, and names a reused key's conflict", async (context) => {
  const bodies: Array<Record<string, unknown>> = [];
  let status = 201;
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(route(request), "/api/managed-agents/sessions");
    bodies.push((await request.json()) as Record<string, unknown>);
    if (status === 409) {
      return Response.json({ error: { code: "idempotency_conflict", message: "Idempotency-Key was already used with different session input" } }, { status });
    }
    return Response.json({ session: { id: "ses-1", status: "connecting" }, deployment: { id: "muse:dev", agentId: "muse", alias: "development" } }, { status });
  });
  const client = new OpenComputerClient(config, "topic/workshop/1");
  const memory = { topics: { scope: "document" as const, id: "workshop", access: "read-write" as const } };

  const created = await createSessionWithMemory(client, "muse@development", memory);
  assert.equal(created.created, true);
  assert.equal(created.session.id, "ses-1");
  assert.deepEqual(bodies[0], { agentId: "muse@development", memory });

  status = 200;
  const replayed = await createSessionWithMemory(client, "muse@development", memory);
  assert.equal(replayed.created, false);

  status = 201;
  await createSessionWithMemory(client, "muse@development");
  assert.deepEqual(bodies[2], { agentId: "muse@development" });

  status = 409;
  await assert.rejects(
    createSessionWithMemory(client, "muse@development", memory),
    (error: unknown) => error instanceof CLIError && error.code === "session_idempotency_conflict" && /different agent, deployment, environment or memory bindings/.test(error.message),
  );
});
