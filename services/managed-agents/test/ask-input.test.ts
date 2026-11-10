import { describe, expect, it } from "vitest";

import { answerFor, parseAskInput } from "../src/ask.js";
import { unavailableLinearConnectionStore, type LinearConnectionStore } from "../src/edge/linear-contract.js";
import { linearServiceRequest, parseLinearServiceRequest } from "../src/edge/linear-service.js";

describe("ask input bounds", () => {
  it("accepts text 1–4000 and up to six options of 1–80 characters", () => {
    expect(parseAskInput({ text: "Go?" })).toEqual({ ok: true, input: { text: "Go?", options: [] } });
    const six = Array.from({ length: 6 }, (_, index) => ({ label: `L${index}`, value: `v${index}` }));
    expect(parseAskInput({ text: "x".repeat(4000), options: six })).toMatchObject({ ok: true });
    expect(parseAskInput({ text: "q", options: [{ label: "a".repeat(80), value: "b".repeat(80) }] })).toMatchObject({ ok: true });
  });

  it("accepts context up to 4000 characters, keeps it as written, and drops blank context", () => {
    expect(parseAskInput({ text: "Go?", context: "Found *two* callers." })).toEqual({
      ok: true,
      input: { text: "Go?", options: [], context: "Found *two* callers." },
    });
    expect(parseAskInput({ text: "Go?", context: "x".repeat(4000) })).toMatchObject({ ok: true });
    for (const blank of ["", "  \n "]) {
      expect(parseAskInput({ text: "Go?", context: blank })).toEqual({ ok: true, input: { text: "Go?", options: [] } });
    }
  });

  it("refuses everything outside the bounds with a message for the model", () => {
    for (const input of [
      null,
      {},
      { text: "" },
      { text: "   " },
      { text: "x".repeat(4001) },
      { text: "q", options: Array.from({ length: 7 }, (_, index) => ({ label: `L${index}`, value: `v${index}` })) },
      { text: "q", options: [{ label: "", value: "v" }] },
      { text: "q", options: [{ label: "l", value: "v".repeat(81) }] },
      { text: "q", options: [{ label: "l", value: "v", extra: 1 }] },
      { text: "q", options: [{ label: "a", value: "v" }, { label: "b", value: "v" }] },
      { text: "q", options: "go" },
      { text: "q", other: true },
      { text: "q", context: "x".repeat(4001) },
      { text: "q", context: 42 },
      { text: "q", context: null },
    ]) {
      const parsed = parseAskInput(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(/ask/);
    }
  });

  it("matches an answer to an option by value first, then by label, case-insensitively", () => {
    const question = {
      id: "q1",
      options: [
        { label: "Ship it", value: "go" },
        { label: "go", value: "other" },
      ],
    };
    expect(answerFor(question, "go")).toEqual({ questionId: "q1", text: "go", value: "go" });
    expect(answerFor(question, " SHIP IT ")).toEqual({ questionId: "q1", text: " SHIP IT ", value: "go" });
    expect(answerFor(question, "maybe")).toEqual({ questionId: "q1", text: "maybe" });
  });
});

describe("Linear service requests for a connection-owned session", () => {
  const connection = {
    id: "c1",
    projectId: "proj_1",
    environment: "production" as const,
    agentId: "agent_1",
    name: "Example Agent",
    status: "connected" as const,
    revision: 1,
    createdAt: "2026-10-02T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
  };
  const session = { projectId: "proj_1", environment: "production", agentId: "agent_1" };
  const store = (graphql: LinearConnectionStore["graphql"]): LinearConnectionStore => ({
    ...unavailableLinearConnectionStore(),
    get: (id) => (id === connection.id ? connection : null),
    graphql,
  });
  const body = JSON.stringify({ query: "query { viewer { id } }" });

  it("allows only POST /graphql with a query", () => {
    expect(parseLinearServiceRequest({ method: "POST", path: "/graphql", body })).toMatchObject({ ok: true });
    expect(parseLinearServiceRequest({ path: "/graphql", body })).toMatchObject({ ok: true });
    for (const [request, code] of [
      [{ method: "GET", path: "/graphql" }, "linear_method_not_allowed"],
      [{ method: "POST", path: "/graphql?x=1", body }, "linear_path_not_allowed"],
      [{ method: "POST", path: "https://evil.example/graphql", body }, "linear_path_not_allowed"],
      [{ method: "POST", path: "/oauth/token", body }, "linear_path_not_allowed"],
      [{ method: "POST", path: "/graphql", body: "nope" }, "invalid_linear_request"],
      [{ method: "POST", path: "/graphql", body: JSON.stringify({ variables: {} }) }, "invalid_linear_request"],
      [{ method: "POST", path: "/graphql", body: JSON.stringify({ query: "q", variables: [1] }) }, "invalid_linear_request"],
    ] as const) {
      const parsed = parseLinearServiceRequest(request);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.result).toMatchObject({ outcome: "refused", code });
    }
  });

  it("maps the store's outcomes onto the proxy envelope", async () => {
    const request = { method: "POST", path: "/graphql", body, session };
    expect(
      await linearServiceRequest(
        store(async () => ({ outcome: "ok", data: { a: 1 }, errors: [{ message: "partial" }] })),
        "c1",
        request,
      ),
    ).toEqual({
      outcome: "response",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { a: 1 }, errors: [{ message: "partial" }] }),
      },
    });
    expect(
      await linearServiceRequest(store(async () => ({ outcome: "permanent", status: 400, message: "bad" })), "c1", request),
    ).toMatchObject({ outcome: "response", response: { status: 400 } });
    expect(
      await linearServiceRequest(
        store(async () => ({ outcome: "transient", status: 429, message: "slow", retryAfterSeconds: 7 })),
        "c1",
        request,
      ),
    ).toMatchObject({ outcome: "response", response: { status: 429, headers: { "retry-after": "7" } } });
    expect(
      await linearServiceRequest(store(async () => ({ outcome: "transient", message: "reset" })), "c1", request),
    ).toMatchObject({ outcome: "refused", status: 502, code: "linear_request_failed" });
    expect(
      await linearServiceRequest(unavailableLinearConnectionStore(), "c1", request),
    ).toMatchObject({ outcome: "refused", status: 409, code: "linear_connection_unavailable" });
  });

  it("refuses with 403 before using the token when the connection is bound elsewhere than the session", async () => {
    const calls: string[] = [];
    const recording = store(async (id) => {
      calls.push(id);
      return { outcome: "ok", data: {} };
    });
    for (const other of [
      { ...session, projectId: "proj_2" },
      { ...session, environment: "development" },
      { projectId: session.projectId, agentId: session.agentId },
      { ...session, agentId: "agent_2" },
    ]) {
      expect(
        await linearServiceRequest(recording, "c1", { method: "POST", path: "/graphql", body, session: other }),
      ).toEqual({
        outcome: "refused",
        status: 403,
        code: "linear_connection_mismatch",
        message: expect.any(String),
      });
    }
    expect(calls).toEqual([]);
    expect(
      await linearServiceRequest(recording, "c1", { method: "POST", path: "/graphql", body, session }),
    ).toMatchObject({ outcome: "response", response: { status: 200 } });
    expect(calls).toEqual(["c1"]);
  });
});
