// Computer keys (work 080): a typed principal and session on the assertion,
// and no route that creates, attaches or grants a credential.
import { afterEach, describe, expect, it, vi } from "vitest";

import { isGrantRoute, mintManagedAgentsAssertion, proxyManagedAgents } from "./managed_agents";

const SESSION = "T06GJFPHY5R:C0C9F5SV47Q:1792176058.240229";
const COMPUTER = { orgID: "org_test", userID: "computer", principal: "computer" as const, sessionKey: SESSION };
const ENV = { MANAGED_AGENTS_API_URL: "https://managedagents.test", OC_MANAGED_AGENTS_SECRET: "test-secret" };

function claims(token: string): Record<string, unknown> {
  return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
}

describe("computer principal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts the principal and session on the assertion", async () => {
    expect(claims(await mintManagedAgentsAssertion("s", COMPUTER))).toMatchObject({
      user_id: "computer",
      principal: "computer",
      session_key: SESSION,
    });
  });

  it("puts neither on a person's assertion", async () => {
    const payload = claims(await mintManagedAgentsAssertion("s", { orgID: "o", userID: "user_1", sessionKey: SESSION }));
    expect(payload.principal).toBeUndefined();
    expect(payload.session_key).toBeUndefined();
  });

  it.each([
    ["POST", "/connections"],
    ["PUT", "/connections/c1"],
    ["DELETE", "/connections/c1"],
    ["POST", "/connections/linear/link"],
    ["DELETE", "/connections/linear"],
    ["POST", "/connections/channel-identity/link"],
    ["POST", "/projects/p1/service-connections"],
    ["DELETE", "/projects/p1/service-connections"],
    ["POST", "/computer/service-connections"],
    ["DELETE", "/computer/service-connections"],
    ["POST", "/model-access/connections"],
    ["POST", "/model-access/connections/m1/complete"],
    ["PUT", "/projects/p1/model-access/bindings/openai/production"],
    ["POST", "/projects/p1/linear/connections"],
    ["PUT", "/linear/connections/l1/credentials"],
    ["POST", "/channels/slack/setups"],
    ["POST", "/channel-connections/claim"],
    ["POST", "/github/connect"],
    ["POST", "/projects/p1/github/connect"],
    ["POST", "/projects/p1/github/attach"],
    ["DELETE", "/projects/p1/github"],
  ])("refuses %s %s", (method, suffix) => {
    expect(isGrantRoute(method, suffix)).toBe(true);
  });

  it.each([
    ["GET", "/connections"],
    ["POST", "/connections/linear/fetch"],
    ["POST", "/connections/google/fetch"],
    ["GET", "/projects/p1/service-connections"],
    ["GET", "/computer/service-connections"],
    ["GET", "/projects/p1/secrets"],
    ["PUT", "/projects/p1/secrets/API_KEY"],
    ["POST", "/projects"],
    ["POST", "/deployments"],
    ["POST", "/sessions"],
    ["POST", "/automations/repository/credentials"],
  ])("allows %s %s", (method, suffix) => {
    expect(isGrantRoute(method, suffix)).toBe(false);
  });

  it("answers 403 to a computer key on a grant route and never reaches managed agents", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/connections/linear/link", { method: "POST" }),
      ENV,
      COMPUTER,
      "/api/managed-agents",
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("computer_key_forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a person's key through the same route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/connections/linear/link", { method: "POST" }),
      ENV,
      { orgID: "org_test", userID: "user_1" },
      "/api/managed-agents",
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards a computer key's fetch with its session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/connections/linear/fetch", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      ENV,
      COMPUTER,
      "/api/managed-agents",
    );
    expect(res.status).toBe(200);
    const sent = fetchMock.mock.calls[0][1] as RequestInit;
    const token = new Headers(sent.headers).get("x-opencomputer-agent-token") ?? "";
    expect(claims(token)).toMatchObject({ principal: "computer", session_key: SESSION });
  });
});
