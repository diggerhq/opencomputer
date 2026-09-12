import assert from "node:assert/strict";
import test from "node:test";

import { APIError, OpenComputerClient } from "./api.js";

// Review reproduction (U6): the header names the operation the caller's key
// stands for, not the request it was sent with. The body is the backend's
// to compare; hashing it here turned a retry with different inputs into a
// second resource instead of the conflict the key promises.
test("mutations derive idempotency headers from the caller's key and the target only", async (context) => {
  const requests: Request[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ id: "project", agents: [], environments: [], session: { id: "ses" } });
  });
  const client = new OpenComputerClient(
    { apiUrl: "https://app.opencomputer.dev", apiKey: "test" },
    "retry-42",
  );

  await client.createProject("Agent", "agent");
  await client.createProject("Agent", "agent");
  await client.createProject("Different", "different");
  await client.createSession("muse@development");
  await client.projects();

  const keys = requests.map((request) => request.headers.get("idempotency-key"));
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], keys[2], "a different body is the same operation");
  assert.notEqual(keys[0], keys[3], "a different target is a different operation");
  assert.equal(keys[4], null, "reads carry no key");
  assert.equal(keys[0]?.includes("retry-42"), false);
});

test("memory documents travel with their ETag and send it back as a precondition", async (context) => {
  const requests: Request[] = [];
  const document = {
    id: "workshop",
    title: "Workshop requirements",
    text: "Node.js 22.",
    summary: "",
    agentWrites: "enabled",
    revision: "rev-1",
    bytes: 11,
    maxBytes: 8192,
    updatedAt: "2026-09-10T12:00:00.000Z",
    writer: { kind: "owner" },
  };
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(document, { headers: { etag: '"rev-1"' } });
  });
  const client = new OpenComputerClient({
    apiUrl: "https://app.opencomputer.dev",
    apiKey: "test",
  });
  const target = {
    projectId: "prj_1",
    resource: "requirements",
    id: "workshop",
    environment: "development" as const,
  };

  const created = await client.createMemoryDocument({
    ...target,
    title: "Workshop requirements",
    text: "Node.js 22.",
  });
  assert.equal(created.etag, '"rev-1"');
  assert.equal(created.document.revision, "rev-1");
  await client.replaceMemoryDocument({ ...target, etag: created.etag, text: "Node 22" });
  await client.patchMemoryDocument({ ...target, etag: created.etag, agentWrites: "disabled" });
  await client.deleteMemoryDocument({ ...target, etag: created.etag });
  await client.memoryDocuments({ ...target, cursor: "c2" });

  const [create, replace, patch, remove, list] = requests;
  assert.ok(create && replace && patch && remove && list);
  assert.equal(
    create.url,
    "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory/requirements/documents/workshop?environment=development",
  );
  assert.equal(create.method, "PUT");
  assert.equal(create.headers.get("if-none-match"), "*");
  assert.equal(create.headers.get("if-match"), null);
  assert.deepEqual(await create.json(), {
    title: "Workshop requirements",
    text: "Node.js 22.",
  });
  assert.equal(replace.headers.get("if-match"), '"rev-1"');
  assert.deepEqual(await replace.json(), { text: "Node 22" });
  assert.equal(patch.method, "PATCH");
  assert.deepEqual(await patch.json(), { agentWrites: "disabled" });
  assert.equal(remove.method, "DELETE");
  assert.equal(remove.headers.get("if-match"), '"rev-1"');
  assert.equal(
    list.url,
    "https://app.opencomputer.dev/api/managed-agents/projects/prj_1/memory/requirements/documents?environment=development&cursor=c2",
  );
  for (const request of requests) {
    assert.equal(request.headers.get("x-api-key"), "test");
  }
});

test("memory precondition failures surface the API's code", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { code: "precondition_failed", message: "The document changed." } },
      { status: 412 },
    ),
  );
  const client = new OpenComputerClient({
    apiUrl: "https://app.opencomputer.dev",
    apiKey: "test",
  });

  await assert.rejects(
    client.replaceMemoryDocument({
      projectId: "prj_1",
      resource: "requirements",
      id: "workshop",
      environment: "development",
      etag: '"rev-0"',
      text: "stale",
    }),
    (error: unknown) =>
      error instanceof APIError &&
      error.status === 412 &&
      error.code === "precondition_failed" &&
      error.message === "The document changed.",
  );
});
