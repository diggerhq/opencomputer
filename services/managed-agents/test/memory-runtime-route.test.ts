import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { memoryObjectName, type MemoryDeclaration } from "../src/edge/memory-contract.js";
import type { AgentEvent, InitializeSessionResult, Project } from "../src/protocol.js";

/**
 * The sandbox session runtime's memory route: recall, save, read and list
 * through the edge with the runtime token, the same outcomes the Workerd
 * host gets from the Memory DO directly, and the `memory.saved` event a
 * save leaves on the session.
 */

const base = "https://managedagents.test";
const notes: MemoryDeclaration = { id: "notes", description: "Notes.", provider: { kind: "document", maxBytes: 1_024 } };
const archive: MemoryDeclaration = { id: "archive", description: "Archive.", provider: { kind: "document", maxBytes: 1_024 } };

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

/** A project with one deployed agent declaring `notes` and `archive`, with documents `workshop` and `run-1`. */
async function fixture(): Promise<{ project: Project; agent: string }> {
  const created = await SELF.fetch(`${base}/v1/projects`, jsonRequest("POST", { environmentMode: "legacy", name: `Rt ${crypto.randomUUID().slice(0, 8)}` }));
  expect(created.status).toBe(201);
  const body = await created.json<{ project?: Project } & Project>();
  const project = body.project ?? body;
  const deployed = await SELF.fetch(
    `${base}/v1/deployments`,
    jsonRequest("POST", {
      agentId: project.agentId,
      alias: "development",
      channels: [],
      connections: [],
      imageArn: "test-image",
      imageVersion: "1",
      artifact: { bucket: "b", key: `accounts/local/agents/${project.agentId}/artifact.json`, digest: "a".repeat(64), size: 1 },
      memory: [notes, archive],
    }),
  );
  expect(deployed.status).toBe(201);
  for (const [resource, id, text] of [["notes", "workshop", "v1"], ["archive", "run-1", "first run"]] as const) {
    const document = await SELF.fetch(
      `${base}/v1/projects/${project.id}/memory/${resource}/documents/${id}?environment=development`,
      jsonRequest("PUT", { title: id, text, summary: `${id} summary` }, { "if-none-match": "*" }),
    );
    expect(document.status).toBe(201);
  }
  return { project, agent: `${project.agentId}@development` };
}

async function createSession(agent: string, memory: unknown): Promise<InitializeSessionResult> {
  const response = await SELF.fetch(
    `${base}/v1/sessions`,
    jsonRequest("POST", { agentId: agent, memory }, { "idempotency-key": crypto.randomUUID() }),
  );
  expect(response.status).toBe(201);
  return response.json<InitializeSessionResult>();
}

const memoryRoute = (sessionId: string, operation = "") => `${base}/v1/sessions/${sessionId}/memory${operation ? `/${operation}` : ""}`;

describe("runtime memory route", () => {
  it("recalls the session's grants with their projections for the runtime token", async () => {
    const f = await fixture();
    const created = await createSession(f.agent, {
      notes: { scope: "document", id: "workshop", access: "read-write" },
      archive: { scope: "collection" },
    });
    const response = await SELF.fetch(memoryRoute(created.session.id), {
      headers: { authorization: `Bearer ${created.runtimeToken}` },
    });
    expect(response.status).toBe(200);
    const recalled = await response.json<{ bindings: Array<Record<string, unknown>> }>();
    // Bindings come back as admitted: sorted by resource.
    expect(recalled.bindings).toEqual([
      {
        resource: "archive",
        scope: "collection",
        access: "read",
        projection: expect.objectContaining({ writable: false }),
      },
      {
        resource: "notes",
        scope: "document",
        id: "workshop",
        access: "read-write",
        projection: expect.objectContaining({ text: "v1", writable: true, revision: "1", documentId: "workshop" }),
      },
    ]);
    expect((recalled.bindings[0]!.projection as { text: string }).text).toContain("run-1");

    // Anyone without the runtime token is refused; a session without grants recalls nothing.
    expect((await SELF.fetch(memoryRoute(created.session.id))).status).toBe(401);
    const plain = await createSession(f.agent, undefined);
    const empty = await SELF.fetch(memoryRoute(plain.session.id), {
      headers: { authorization: `Bearer ${plain.runtimeToken}` },
    });
    expect(await empty.json()).toEqual({ bindings: [] });
  });

  it("saves against the recalled revision, reports the save on the session, and serves the collection tools", async () => {
    const f = await fixture();
    const created = await createSession(f.agent, {
      notes: { scope: "document", id: "workshop", access: "read-write" },
      archive: { scope: "collection" },
    });
    const auth = { authorization: `Bearer ${created.runtimeToken}` };
    const sessionId = created.session.id;

    const saved = await SELF.fetch(memoryRoute(sessionId, "save"), jsonRequest("POST", { resource: "notes", text: "v2", expectedRevision: "1" }, auth));
    expect(await saved.json()).toEqual({ status: "saved", revision: "2", bytes: 2 });
    const memory = env.MEMORY.getByName(memoryObjectName("local", f.project.id, "development"));
    expect(await memory.recall(sessionId, "notes")).toMatchObject({ kind: "projection", projection: { text: "v2", revision: "2" } });
    const { events } = await (await SELF.fetch(`${base}/v1/sessions/${sessionId}/events`)).json<{ events: AgentEvent[] }>();
    expect(events.filter((event) => event.type === "memory.saved").map((event) => event.data)).toEqual([
      { resource: "notes", documentId: "workshop", revision: "2", bytes: 2 },
    ]);

    // A save from a stale revision is the Memory DO's conflict, as a result.
    const conflict = await SELF.fetch(memoryRoute(sessionId, "save"), jsonRequest("POST", { resource: "notes", text: "v3", expectedRevision: "1" }, auth));
    expect(await conflict.json()).toMatchObject({ status: "conflict", text: "v2" });

    const listed = await SELF.fetch(memoryRoute(sessionId, "list"), jsonRequest("POST", { resource: "archive" }, auth));
    expect(await listed.json()).toEqual({
      documents: [expect.objectContaining({ id: "run-1", title: "run-1", summary: "run-1 summary", revision: "1" })],
      nextCursor: null,
    });
    const read = await SELF.fetch(memoryRoute(sessionId, "read"), jsonRequest("POST", { resource: "archive", id: "run-1" }, auth));
    expect(await read.json()).toMatchObject({ id: "run-1", text: "first run", revision: "1" });
    const missing = await SELF.fetch(memoryRoute(sessionId, "read"), jsonRequest("POST", { resource: "archive", id: "absent" }, auth));
    expect(await missing.json()).toEqual({ status: "rejected", reason: "not_found" });

    // A resource the session holds no grant for is `not_bound`, with what it holds.
    const unbound = await SELF.fetch(memoryRoute(sessionId, "list"), jsonRequest("POST", { resource: "other" }, auth));
    expect(await unbound.json()).toEqual({ status: "rejected", reason: "not_bound", bound: ["archive", "notes"] });
    expect((await SELF.fetch(memoryRoute(sessionId, "save"), jsonRequest("POST", { resource: "notes", text: "v4", expectedRevision: "2" }))).status).toBe(401);
  });
});
