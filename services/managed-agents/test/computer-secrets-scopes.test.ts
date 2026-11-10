import { describe, expect, it, vi } from "vitest";

import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import { apiScopes } from "../src/computer/keys.js";
import type { RequestIdentity } from "../src/edge/auth.js";

/** Work 095 step 1: only people set secrets. A wildcard key lacks `secrets:write`; a session's key is refused. */

describe("apiScopes", () => {
  it("a wildcard or legacy key gets every scope but secrets:write", () => {
    for (const raw of [undefined, [], ["*"], ["sandbox:*"]]) {
      expect(apiScopes(raw)).toEqual(["sessions:read", "sessions:write", "asks:answer", "terminals"]);
    }
  });

  it("secrets:write only when the key names it", () => {
    expect(apiScopes(["sessions:read", "secrets:write"])).toEqual(["sessions:read", "secrets:write"]);
    expect(apiScopes(["sandbox:*", "secrets:write"])).toContain("secrets:write");
    expect(apiScopes(["sessions:read"])).toEqual(["sessions:read"]);
  });
});

describe("secrets routes", () => {
  const person: RequestIdentity = { kind: "user", organizationId: "org_1", userId: "user_1", role: "member" } as RequestIdentity;
  const key = { id: "key_1", hash: "a".repeat(64), name: "laptop", kind: "user" as const, expiresAt: null, createdAt: null };
  const put = () => new Request("https://blue.test/v1/computer/sessions/cs_1/secrets/API_KEY", { method: "PUT", body: "{}" });
  const route = (identity: RequestIdentity, request = put()) => {
    const stub: ComputerApiStub = { computerApi: vi.fn() };
    return routeComputerApi(request, {} as never, identity, "org_1", stub, new URL(request.url).pathname.slice("/v1/computer".length));
  };
  const code = async (res: Response) => ((await res.json()) as { error: { reason?: string; code: string } }).error;

  it("refuses a session's key whatever scopes it names", async () => {
    const session = { ...person, principal: "computer", apiKey: { ...key, scopes: ["secrets:write"] } } as RequestIdentity;
    const res = await route(session);
    expect(res.status).toBe(403);
    expect(await code(res)).toMatchObject({ reason: "computer_principal" });
    const list = await route(session, new Request("https://blue.test/v1/computer/secrets"));
    expect(await code(list)).toMatchObject({ reason: "computer_principal" });
  });

  it("refuses a wildcard key, lets a named one and the dashboard through", async () => {
    const wildcard = await route({ ...person, apiKey: { ...key, scopes: ["sandbox:*"] } });
    expect(wildcard.status).toBe(403);
    expect(await code(wildcard)).toMatchObject({ reason: "missing_scope", scope: "secrets:write" });
    expect((await route({ ...person, apiKey: { ...key, scopes: ["secrets:write"] } })).status).toBe(409);
    expect((await route(person)).status).toBe(409);
  });

  it("routes organization secrets to the Computer, needing secrets:write to change one", async () => {
    const seen: unknown[] = [];
    const stub: ComputerApiStub = { computerApi: vi.fn(async (_a, _c, op) => (seen.push(op), { status: 204 })) };
    const go = (identity: RequestIdentity, method: string, path: string, body?: string) =>
      routeComputerApi(new Request(`https://blue.test/v1/computer${path}`, { method, ...(body ? { body } : {}) }), {} as never, identity, "org_1", stub, path);
    const wildcard = { ...person, apiKey: { ...key, scopes: ["sandbox:*"] } } as RequestIdentity;
    expect((await go(wildcard, "GET", "/secrets")).status).toBe(204);
    expect((await go(wildcard, "GET", "/secrets/API_KEY/events")).status).toBe(204);
    expect((await go(wildcard, "PUT", "/organization/secrets/API_KEY", '{"value":"v"}')).status).toBe(403);
    expect((await go(person, "PUT", "/organization/secrets/API_KEY", '{"value":"v"}')).status).toBe(204);
    expect((await go(person, "DELETE", "/organization/secrets/API_KEY")).status).toBe(204);
    expect((await go(person, "PUT", "/organization/secrets/9BAD", "{}")).status).toBe(400);
    expect((await go(person, "PUT", "/me/secrets/API_KEY", "{}")).status).toBe(409);
    expect(seen).toEqual([
      { op: "secrets.list" },
      { op: "secrets.events", name: "API_KEY" },
      { op: "secrets.put", name: "API_KEY", body: { value: "v" } },
      { op: "secrets.delete", name: "API_KEY" },
    ]);
  });
});
