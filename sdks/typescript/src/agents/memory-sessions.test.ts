import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "./errors.js";
import { sessionIdempotencyKey, startSessionOnDocument } from "./memory-sessions.js";

interface Call { method: string; url: string; headers: Record<string, string>; body?: Record<string, unknown> }

const document = (id: string, revision: string) => ({
  id, title: "Workshop", text: "", summary: "", agentWrites: "enabled", revision,
  bytes: 0, maxBytes: 8192, updatedAt: "2026-09-10T12:00:00.000Z", writer: { kind: "owner" },
});

// The two routes the helper touches, with a switchable document state and a
// session store keyed by Idempotency-Key.
function fakeApi(state: { document: "absent" | "present" | "deleted"; sessions?: Map<string, string> }) {
  const calls: Call[] = [];
  const sessions = state.sessions ?? new Map<string, string>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const call: Call = { method: init?.method ?? "GET", url: `${url.pathname}${url.search}`, headers };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(call);
    if (url.pathname.endsWith("/documents/workshop")) {
      if (call.method === "PUT") {
        if (state.document === "absent") { state.document = "present"; return Response.json(document("workshop", "r1"), { status: 201 }); }
        return Response.json({ error: { code: "precondition_failed", message: "id already used" } }, { status: 412 });
      }
      if (state.document === "present") return Response.json(document("workshop", "r7"));
      return Response.json({ error: { code: "not_found", message: "deleted" } }, { status: 404 });
    }
    if (url.pathname === "/api/managed-agents/sessions" && call.method === "POST") {
      const key = headers["idempotency-key"];
      const existing = sessions.get(key);
      if (existing === "other-bindings") {
        return Response.json({ error: { code: "idempotency_conflict", message: "Idempotency-Key was already used with different session input" } }, { status: 409 });
      }
      if (existing) return Response.json({ session: { id: existing, status: "idle", executionMode: "workerd" } }, { status: 200 });
      const id = `ses-${sessions.size + 1}`;
      sessions.set(key, id);
      return Response.json({ session: { id, status: "connecting", executionMode: "workerd" } }, { status: 201 });
    }
    return Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 });
  };
  return { calls, fetch, sessions };
}

const params = {
  apiKey: "osb_test", projectId: "prj_1", environment: "development" as const, agent: "openmuse-dev--topic-worker",
  resource: "topics", documentId: "workshop", document: { title: "Workshop" }, idempotencyKey: "topic/workshop/1",
};

describe("startSessionOnDocument", () => {
  it("creates the document, then the session bound to it, under derived keys", async () => {
    const api = fakeApi({ document: "absent" });
    const result = await startSessionOnDocument({ ...params, fetch: api.fetch });

    expect(result).toEqual({
      document: { id: "workshop", created: true, revision: "r1", title: "Workshop" },
      session: { id: "ses-1", created: true, status: "connecting", executionMode: "workerd" },
    });
    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "PUT /api/managed-agents/projects/prj_1/memory/topics/documents/workshop?environment=development",
      "POST /api/managed-agents/sessions",
    ]);
    const [create, session] = api.calls;
    expect(create.headers["if-none-match"]).toBe("*");
    expect(create.headers["x-api-key"]).toBe("osb_test");
    expect(create.body).toEqual({ title: "Workshop", text: "" });
    expect(session.headers["idempotency-key"]).toBe(await sessionIdempotencyKey("topic/workshop/1"));
    expect(session.body).toEqual({
      agentId: "openmuse-dev--topic-worker@development",
      source: "api",
      memory: { topics: { scope: "document", id: "workshop", access: "read-write" } },
    });
  });

  it("converges on a retry: the document and the session both already exist", async () => {
    const api = fakeApi({ document: "absent" });
    await startSessionOnDocument({ ...params, fetch: api.fetch });
    const retry = await startSessionOnDocument({ ...params, fetch: api.fetch });

    expect(retry.document).toEqual({ id: "workshop", created: false, revision: "r7", title: "Workshop" });
    expect(retry.session).toMatchObject({ id: "ses-1", created: false });
    // The retry read the existing document after its conditional create was refused.
    expect(api.calls.slice(2).map((call) => `${call.method} ${call.url.split("?")[0]}`)).toEqual([
      "PUT /api/managed-agents/projects/prj_1/memory/topics/documents/workshop",
      "GET /api/managed-agents/projects/prj_1/memory/topics/documents/workshop",
      "POST /api/managed-agents/sessions",
    ]);
  });

  it("keeps different keys apart and carries extra bindings, access and source", async () => {
    const api = fakeApi({ document: "present" });
    const first = await startSessionOnDocument({ ...params, fetch: api.fetch, idempotencyKey: "a" });
    const second = await startSessionOnDocument({
      ...params, fetch: api.fetch, idempotencyKey: "b", access: "read", source: "openmuse",
      memory: { profile: { scope: "document", id: "owner", access: "read" } },
    });
    expect(first.session.id).not.toBe(second.session.id);
    expect(api.calls.at(-1)?.body).toEqual({
      agentId: "openmuse-dev--topic-worker@development",
      source: "openmuse",
      memory: {
        profile: { scope: "document", id: "owner", access: "read" },
        topics: { scope: "document", id: "workshop", access: "read" },
      },
    });
    expect(await sessionIdempotencyKey("a")).not.toBe(await sessionIdempotencyKey("b"));
    expect(await sessionIdempotencyKey("a")).toBe(await sessionIdempotencyKey("a"));
  });

  it("reports a reused key with different bindings as a conflict", async () => {
    const sessions = new Map([[await sessionIdempotencyKey("topic/workshop/1"), "other-bindings"]]);
    const api = fakeApi({ document: "present", sessions });
    await expect(startSessionOnDocument({ ...params, fetch: api.fetch })).rejects.toThrow(ConflictError);
    await expect(startSessionOnDocument({ ...params, fetch: api.fetch })).rejects.toThrow(/different agent, deployment, environment or memory bindings/);
  });

  it("refuses a deleted document id instead of creating a session that cannot bind it", async () => {
    const api = fakeApi({ document: "deleted" });
    await expect(startSessionOnDocument({ ...params, fetch: api.fetch })).rejects.toThrow(NotFoundError);
    expect(api.calls.some((call) => call.url === "/api/managed-agents/sessions")).toBe(false);
  });
});
