import { describe, expect, it } from "vitest";
import { OpenComputer } from "./client.js";
import { OpenComputerError } from "./errors.js";
import type { SessionResultRecord } from "./types.js";

interface Call { method: string; path: string; headers: Record<string, string>; body?: unknown }

function fakeApi(routes: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const call: Call = { method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, headers };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body) as unknown;
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (route) return route(call);
    return Response.json({ error: { code: "not_found", message: `no route ${call.method} ${url.pathname}` } }, { status: 404 });
  };
  return { calls, fetch, last: () => calls[calls.length - 1] };
}

const oc = (api: ReturnType<typeof fakeApi>) => new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });

const record = (resultId: string, turnId: string): SessionResultRecord => ({
  resultId,
  projectId: "prj_1",
  environment: "development",
  agentId: "worker",
  deploymentId: "dep_1",
  sessionId: "ses_1",
  turnId,
  messageId: null,
  toolCallId: `call_${resultId}`,
  resultTool: "submit_result",
  schemaId: "example.result/v1",
  schemaDigest: "sha256:aa",
  dataDigest: "sha256:bb",
  data: { finding: resultId },
  createdAt: "t",
});

describe("structured input and result history", () => {
  it("sends sessionData on create and reads the digest and revision back (05)", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/sessions": () =>
        Response.json(
          { session: { id: "ses_1", status: "new", createdAt: "t", sessionDataDigest: "sha256:cc", sessionDataRevision: 1 } },
          { status: 201 },
        ),
      "GET /api/managed-agents/sessions/ses_1": () =>
        Response.json({
          id: "ses_1", agentId: "worker", deploymentId: "dep_1", status: "idle", source: "api", turns: [],
          sessionDataDigest: "sha256:cc", sessionDataRevision: 1, createdAt: "t", updatedAt: "t",
        }),
    });
    const sessionData = { schema: "example.session-context/v1", externalReference: "ref-1", mode: "authorised-testing" };
    const created = await oc(api).sessions.create({ agentId: "worker@development", sessionData }, { idempotencyKey: "k1" });
    expect(api.last().body).toEqual({ agentId: "worker@development", sessionData });
    expect(created.session).toMatchObject({ sessionDataDigest: "sha256:cc", sessionDataRevision: 1 });
    const session = await oc(api).sessions.get("ses_1");
    expect(session.sessionDataDigest).toBe("sha256:cc");
    expect(session.sessionDataRevision).toBe(1);
  });

  it("sends a payload-only turn without an input field (05)", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/sessions/ses_1/turns": () =>
        Response.json({ turnId: "turn_1", status: "queued", duplicate: false }, { status: 202 }),
    });
    const payload = { schema: "example.execution-envelope/v1", generation: 3, inputs: {} };
    await oc(api).sessions.turns.send("ses_1", { payload, idempotencyKey: "turn-1" });
    expect(api.last().body).toEqual({ payload });
    expect(Object.keys(api.last().body as object)).not.toContain("input");
  });

  it("lists results by session and by turn with paging, and normalizes a missing cursor (06)", async () => {
    const page1 = [record("result_1", "turn_1"), record("result_2", "turn_2")];
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1/results": (call) =>
        Response.json(call.path.includes("cursor=c1") ? { results: [record("result_3", "turn_3")] } : { results: page1, nextCursor: "c1" }),
      "GET /api/managed-agents/sessions/ses_1/turns/turn_2/results": () => Response.json({ results: [page1[1]], nextCursor: null }),
      "GET /api/managed-agents/sessions/ses_1/turns/turn_9/results": () => Response.json({ results: [] }),
    });
    const client = oc(api);
    const first = await client.sessions.results.list("ses_1", { limit: 2 });
    expect(first).toEqual({ results: page1, nextCursor: "c1" });
    expect(api.last().path).toBe("/api/managed-agents/sessions/ses_1/results?limit=2");
    const second = await client.sessions.results.list("ses_1", { cursor: first.nextCursor!, limit: 2 });
    expect(second).toEqual({ results: [record("result_3", "turn_3")], nextCursor: null });
    expect(api.last().path).toBe("/api/managed-agents/sessions/ses_1/results?cursor=c1&limit=2");

    const byTurn = await client.sessions.results.list("ses_1", { turnId: "turn_2" });
    expect(byTurn.results.map((r) => r.resultId)).toEqual(["result_2"]);
    expect(api.last().path).toBe("/api/managed-agents/sessions/ses_1/turns/turn_2/results");
    expect(await client.sessions.results.list("ses_1", { turnId: "turn_9" })).toEqual({ results: [], nextCursor: null });
  });

  it("gets one result, fills absent nullable provenance with null, and surfaces result_not_found (06)", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1/results/result_1": () =>
        Response.json({
          resultId: "result_1", projectId: "prj_1", agentId: "worker", deploymentId: "dep_1", sessionId: "ses_1",
          turnId: "turn_1", toolCallId: "call_1", resultTool: "submit_result", dataDigest: "sha256:bb", data: 7, createdAt: "t",
        }),
      "GET /api/managed-agents/sessions/ses_1/results/result_x": () =>
        Response.json({ error: { code: "result_not_found", message: "no such result" } }, { status: 404 }),
    });
    const client = oc(api);
    const result = await client.sessions.results.get("ses_1", "result_1");
    expect(result).toMatchObject({ resultId: "result_1", environment: null, messageId: null, schemaId: null, schemaDigest: null, data: 7 });
    await expect(client.sessions.results.get("ses_1", "result_x")).rejects.toMatchObject({ code: "result_not_found", status: 404 });
    await expect(client.sessions.results.get("ses_1", "result_x")).rejects.toBeInstanceOf(OpenComputerError);
  });
});
