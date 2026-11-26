import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { memoryObjectName, type Document, type MemoryDeclaration } from "../src/edge/memory-contract.js";
import type { Project } from "../src/protocol.js";

/**
 * The owner routes over the real worker: project authorization, the
 * conditional-request protocol (`If-None-Match: *`, `If-Match`, `ETag`) and
 * the documented status codes and error codes.
 */

const base = "https://managedagents.test";

async function project(): Promise<Project> {
  const response = await SELF.fetch(`${base}/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentMode: "legacy", name: `Memory ${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(response.status).toBe(201);
  const created = await response.json<{ project?: Project } & Project>();
  return created.project ?? created;
}

async function declared(resources = ["notes"]): Promise<{ project: Project; url: (resource: string, id?: string, query?: string) => string }> {
  const created = await project();
  const memory = env.MEMORY.getByName(memoryObjectName("local", created.id, "development"));
  await memory.applyConfig(
    1,
    "dep-1",
    resources.map((resource) => ({ resource, provider: "document" as const, maxBytes: 64 })),
  );
  return {
    project: created,
    url: (resource, id, query = "environment=development") =>
      `${base}/v1/projects/${created.id}/memory/${resource}/documents${id ? `/${id}` : ""}?${query}`,
  };
}

async function error(response: Response): Promise<{ status: number; code: string; message: string }> {
  const body = await response.json<{ error: { code: string; message: string } }>();
  return { status: response.status, code: body.error.code, message: body.error.message };
}

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

describe("memory owner routes", () => {
  it("creates with If-None-Match: *, returns 201 and an ETag, and refuses a second create", async () => {
    const { url } = await declared();
    const response = await SELF.fetch(
      url("notes", "workshop"),
      jsonRequest("PUT", { title: "Workshop requirements", text: "Node.js 22.", summary: "Runtime." }, { "if-none-match": "*" }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"1"');
    const document = await response.json<Document>();
    expect(document).toMatchObject({
      id: "workshop",
      title: "Workshop requirements",
      text: "Node.js 22.",
      summary: "Runtime.",
      agentWrites: "enabled",
      revision: "1",
      bytes: 11,
      maxBytes: 64,
      writer: { kind: "owner" },
    });
    expect(await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { title: "Again" }, { "if-none-match": "*" })))).toMatchObject({
      status: 412,
      code: "precondition_failed",
    });

    const read = await SELF.fetch(url("notes", "workshop"));
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe('"1"');
    expect(await read.json()).toEqual(document);

    const list = await (await SELF.fetch(url("notes"))).json<{ documents: Record<string, unknown>[]; nextCursor: string | null }>();
    expect(list).toEqual({
      documents: [expect.objectContaining({ id: "workshop", title: "Workshop requirements", revision: "1" })],
      nextCursor: null,
    });
    expect(list.documents[0]).not.toHaveProperty("text");
  });

  it("replaces, patches and deletes with If-Match; a stale revision is 412", async () => {
    const { url } = await declared();
    await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { title: "T", text: "v1", summary: "s1" }, { "if-none-match": "*" }));

    const replaced = await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { text: "v2" }, { "if-match": '"1"' }));
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get("etag")).toBe('"2"');
    expect(await replaced.json()).toMatchObject({ text: "v2", summary: "s1", revision: "2" });

    const stale = await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { text: "v3" }, { "if-match": '"1"' }));
    expect(await error(stale)).toMatchObject({ status: 412, code: "precondition_failed" });
    expect(stale.headers.get("etag")).toBe('"2"');

    const patched = await SELF.fetch(url("notes", "workshop"), jsonRequest("PATCH", { agentWrites: "disabled" }, { "if-match": "2" }));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ agentWrites: "disabled", text: "v2", revision: "3" });

    expect(await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PATCH", { title: "" }, { "if-match": '"3"' })))).toMatchObject({
      status: 413,
      code: "memory_limit_exceeded",
    });
    expect(await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PATCH", {}, { "if-match": '"3"' })))).toMatchObject({
      status: 400,
      code: "invalid_request",
    });

    const deleted = await SELF.fetch(url("notes", "workshop"), { method: "DELETE", headers: { "if-match": 'W/"3"' } });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(await error(await SELF.fetch(url("notes", "workshop")))).toMatchObject({ status: 404, code: "not_found" });
    expect(await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { title: "T" }, { "if-none-match": "*" })))).toMatchObject({
      status: 412,
      code: "precondition_failed",
    });
    expect(await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { text: "x" }, { "if-match": '"4"' })))).toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("requires condition headers, rejects conflicting ones and unknown fields", async () => {
    const { url } = await declared();
    expect(await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { title: "T" })))).toMatchObject({
      status: 428,
      code: "precondition_required",
    });
    expect(await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PATCH", { title: "T" })))).toMatchObject({
      status: 428,
      code: "precondition_required",
    });
    expect(await error(await SELF.fetch(url("notes", "workshop"), { method: "DELETE" }))).toMatchObject({
      status: 428,
      code: "precondition_required",
    });
    expect(
      await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { title: "T" }, { "if-none-match": "*", "if-match": '"1"' }))),
    ).toMatchObject({ status: 400, code: "invalid_request" });
    expect(
      await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { title: "T" }, { "if-none-match": '"1"' }))),
    ).toMatchObject({ status: 400, code: "invalid_request" });
    expect(
      await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { title: "T", colour: "red" }, { "if-none-match": "*" }))),
    ).toMatchObject({ status: 400, code: "invalid_request", message: expect.stringContaining("colour") });
    expect(
      await error(await SELF.fetch(url("notes", "workshop"), jsonRequest("PUT", { text: 1 }, { "if-none-match": "*" }))),
    ).toMatchObject({ status: 400, code: "invalid_request" });
    expect(await error(await SELF.fetch(url("notes", "bad id")))).toMatchObject({ status: 400, code: "invalid_request" });
    expect(await error(await SELF.fetch(url("notes", "workshop", "")))).toMatchObject({
      status: 400,
      code: "invalid_request",
      message: expect.stringContaining("environment"),
    });
    expect(await error(await SELF.fetch(url("notes", undefined, "environment=development&cursor=nope")))).toMatchObject({
      status: 400,
      code: "invalid_request",
    });
  });

  it("returns 413 when text exceeds the resource limit and 404 for undeclared resources", async () => {
    const { url } = await declared();
    expect(
      await error(await SELF.fetch(url("notes", "big"), jsonRequest("PUT", { title: "T", text: "x".repeat(65) }, { "if-none-match": "*" }))),
    ).toMatchObject({ status: 413, code: "memory_limit_exceeded", message: expect.stringContaining("64") });
    expect(await error(await SELF.fetch(url("elsewhere")))).toMatchObject({
      status: 404,
      code: "not_found",
      message: expect.stringContaining("not declared"),
    });
    // Production has its own object and no configuration yet.
    expect(await error(await SELF.fetch(url("notes", undefined, "environment=production")))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("is project-scoped", async () => {
    const { url } = await declared();
    expect(await error(await SELF.fetch(url("notes").replace(/prj_[a-f0-9]+/, "prj_missing")))).toMatchObject({
      status: 404,
      code: "project_not_found",
    });
  });

  it("paginates the listing with an opaque cursor", async () => {
    const { url } = await declared();
    for (let index = 0; index < 55; index += 1) {
      const response = await SELF.fetch(
        url("notes", `doc-${String(index).padStart(2, "0")}`),
        jsonRequest("PUT", { title: `Doc ${String(index)}` }, { "if-none-match": "*" }),
      );
      expect(response.status).toBe(201);
    }
    const first = await (await SELF.fetch(url("notes"))).json<{ documents: Array<{ id: string }>; nextCursor: string | null }>();
    expect(first.documents).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await (
      await SELF.fetch(url("notes", undefined, `environment=development&cursor=${encodeURIComponent(first.nextCursor!)}`))
    ).json<{ documents: Array<{ id: string }>; nextCursor: string | null }>();
    expect(second.documents).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.documents, ...second.documents].map((entry) => entry.id)).size).toBe(55);
  });
});

describe("memory resource inventory", () => {
  it("lists every configured resource with its live document count and whether active code declares it", async () => {
    const created = await project();
    const declaration = (id: string, maxBytes: number): MemoryDeclaration => ({
      id,
      description: `${id}.`,
      provider: { kind: "document", maxBytes },
    });
    const deploy = (digest: string, memory: MemoryDeclaration[]) =>
      SELF.fetch(
        `${base}/v1/deployments`,
        jsonRequest("POST", {
          agentId: created.agentId,
          alias: "development",
          channels: [],
          connections: [],
          imageArn: "test-image",
          imageVersion: "1",
          artifact: { bucket: "b", key: `accounts/local/agents/${created.agentId}/artifact.json`, digest: digest.repeat(64), size: 1 },
          memory,
        }),
      );
    // First code declares two resources; the next drops `plan` and raises
    // the `notes` limit. The inventory keeps `plan` with its data.
    expect((await deploy("8", [declaration("notes", 64), declaration("plan", 64)])).status).toBe(201);
    const url = (resource: string, id: string) =>
      `${base}/v1/projects/${created.id}/memory/${resource}/documents/${id}?environment=development`;
    for (const id of ["a", "b"]) {
      expect((await SELF.fetch(url("notes", id), jsonRequest("PUT", { title: id, text: id }, { "if-none-match": "*" }))).status).toBe(201);
    }
    expect((await SELF.fetch(url("plan", "roadmap"), jsonRequest("PUT", { title: "Roadmap" }, { "if-none-match": "*" }))).status).toBe(201);
    expect((await SELF.fetch(url("notes", "b"), { method: "DELETE", headers: { "if-match": '"1"' } })).status).toBe(204);
    expect((await deploy("9", [declaration("notes", 4_096)])).status).toBe(201);

    const response = await SELF.fetch(`${base}/v1/projects/${created.id}/memory?environment=development`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resources: [
        { id: "notes", provider: { kind: "document", maxBytes: 4_096 }, declared: true, documents: 1 },
        { id: "plan", provider: { kind: "document", maxBytes: 64 }, declared: false, documents: 1 },
      ],
    });
    // Production has no configuration yet: an empty inventory, not an error.
    const production = await SELF.fetch(`${base}/v1/projects/${created.id}/memory?environment=production`);
    expect(await production.json()).toEqual({ resources: [] });
    expect(await error(await SELF.fetch(`${base}/v1/projects/${created.id}/memory`))).toMatchObject({ status: 400, code: "invalid_request" });
    expect((await SELF.fetch(`${base}/v1/projects/${created.id}/memory?environment=development`, { method: "POST" })).status).toBe(405);
    expect((await SELF.fetch(`${base}/v1/projects/nope/memory?environment=development`)).status).toBe(404);
  });
});
