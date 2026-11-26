// Spike (Effect v4): GET/PATCH /settings declared once with HttpApi (src/http/api/routes.ts). The
// Worker serves the declaration, the api-edge scope table is read from it, and a client derived from
// it calls the Worker; the public error JSON is unchanged.

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { describe, expect, it, vi } from "vitest";

import type { Principal } from "../src/actor/principal.js";
import type { Sql } from "../src/actor/sql.js";
import { ActorSql, inTransaction } from "../src/actor/in-transaction.js";
import { setSettings } from "../src/org/settings.js";
import { routeComputerApi, type ComputerApiStub } from "../src/computer/api-http.js";
import type { RequestIdentity } from "../src/edge/auth.js";
import { Forbidden } from "../src/contract/errors.js";
import { ComputerApi, scopeTable } from "../src/contract/api.js";

const ORG = "org_1";
const MEMBER = "usr_01jabcdefghjkmnpqrstvwxyz0";
const admin: Principal = {
  org: ORG, subject: MEMBER, kind: "member", via: "dashboard",
  scopes: ["sessions:read", "sessions:write"], audiences: ["org"], admin: true, credential: { id: "login:u", expiresAt: null },
};
const identity = { kind: "user", userId: "user_1", accountId: ORG, organizationId: ORG, ocPrincipal: admin } as RequestIdentity;

function worker(org: Record<string, unknown>) {
  const env = { ORGS: { getByName: vi.fn(() => org) } };
  const stub: ComputerApiStub = { computerApi: vi.fn() };
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    return routeComputerApi(request, env as never, identity, ORG, stub, new URL(request.url).pathname.slice("/v1/computer".length));
  };
}

const realOrg = () => {
  let value: "owner" | "org" = "owner";
  return {
    settings: vi.fn(async () => ({ apiAccessDefault: value })),
    setSettings: vi.fn(async (_p: Principal, patch: { apiAccessDefault?: "owner" | "org" }) => {
      value = patch.apiAccessDefault ?? value;
      return { ok: true, settings: { apiAccessDefault: value } };
    }),
  };
};

describe("the declared API (Effect HttpApi)", () => {
  it("the api-edge's scope table is read from the declaration", () => {
    expect(scopeTable()).toEqual([
      { method: "GET", path: "/settings", scope: null },
      { method: "PATCH", path: "/settings", scope: "sessions:write" },
    ]);
  });

  it("a client derived from the declaration calls the Worker and decodes typed errors", async () => {
    const fetch = worker(realOrg());
    const program = Effect.gen(function* () {
      const client = yield* HttpApiClient.make(ComputerApi, { baseUrl: "https://blue.test/v1/computer" });
      const before = yield* client.settings.get();
      const after = yield* client.settings.patch({ payload: { apiAccessDefault: "org" } });
      return { before, after };
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch));
    expect(await Effect.runPromise(program)).toEqual({ before: { settings: { apiAccessDefault: "owner" } }, after: { settings: { apiAccessDefault: "org" } } });

    const refused = worker({ setSettings: vi.fn(async () => ({ ok: false, code: "admin_required", status: 403, message: "Only an organization admin can change these settings." })) });
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(HttpApiClient.make(ComputerApi, { baseUrl: "https://blue.test/v1/computer" }), (c) => c.settings.patch({ payload: { apiAccessDefault: "org" } })).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, refused as typeof globalThis.fetch),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail")?.error : undefined;
    expect(error).toBeInstanceOf(Forbidden);
    expect(error).toMatchObject({ error: { code: "admin_required", retryable: false } });
  });

  it("a body that fails the schema is the public invalid_request, with its field, before Org is called", async () => {
    const org = realOrg();
    const fetch = worker(org);
    const patch = async (body: unknown) => {
      const res = await fetch("https://blue.test/v1/computer/settings", { method: "PATCH", headers: { "content-type": "application/json", "x-request-id": "req_aaaaaaaaaaaaaaaaaaaa" }, body: JSON.stringify(body) });
      return { status: res.status, headers: Object.fromEntries(res.headers), body: (await res.json()) as { error: Record<string, unknown> } };
    };
    const bad = await patch({ apiAccessDefault: "everyone" });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: { code: "invalid_request", message: "apiAccessDefault is owner or org.", field: "apiAccessDefault", requestId: "req_aaaaaaaaaaaaaaaaaaaa", retryable: false } });
    expect(bad.headers).toMatchObject({ "x-request-id": "req_aaaaaaaaaaaaaaaaaaaa", "cache-control": "no-store" });
    expect((await patch({ colour: "red" })).body.error).toMatchObject({ code: "invalid_request", field: "colour", message: "Unknown field colour." });
    expect((await patch({})).body.error).toMatchObject({ code: "invalid_request", message: "The body names nothing to change." });
    const notJson = await fetch("https://blue.test/v1/computer/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{" });
    expect(((await notJson.json()) as { error: unknown }).error).toMatchObject({ code: "invalid_request", message: "The body is not JSON." });
    expect(org.setSettings).not.toHaveBeenCalled();
  });

  it("an Org that cannot answer is the public 503", async () => {
    const fetch = worker({ settings: vi.fn(async () => { throw new Error("overloaded"); }) });
    const res = await fetch("https://blue.test/v1/computer/settings");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({ code: "unavailable", retryable: true });
  });
});

describe("an actor program inside the synchronous transaction (org/settings.ts)", () => {
  /** A Sql whose transaction records commit or rollback, as transactionSync does. */
  const fakeSql = () => {
    const log: string[] = [];
    const sql: Sql = {
      exec: <T>(query: string) => {
        log.push(query.split(" ")[0]!);
        return [{ api_access_default: "owner" }] as T[];
      },
      transaction: <T>(fn: () => T) => {
        log.push("BEGIN");
        try {
          const out = fn();
          log.push("COMMIT");
          return out;
        } catch (e) {
          log.push("ROLLBACK");
          throw e;
        }
      },
      arm: () => {},
    };
    return { sql, log };
  };
  const boss = { ...admin, kind: "member" } as Principal;

  it("commits a success, rolls back a typed failure and returns it as the refusal", () => {
    const ok = fakeSql();
    expect(setSettings(ok.sql, boss, { apiAccessDefault: "org" })).toMatchObject({ ok: true });
    expect(ok.log).toEqual(["BEGIN", "UPDATE", "SELECT", "COMMIT"]);
    const bad = fakeSql();
    expect(setSettings(bad.sql, boss, { colour: "red" })).toMatchObject({ ok: false, code: "invalid_request", field: "colour" });
    expect(bad.log).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("an async step cannot run inside it: the program dies, the transaction rolls back, nothing runs later", async () => {
    const { sql, log } = fakeSql();
    const sneaky = Effect.gen(function* () {
      const s = yield* ActorSql;
      s.exec("UPDATE first");
      yield* Effect.promise(() => Promise.resolve());
      s.exec("UPDATE after-await");
    });
    const exit = inTransaction(sql, sneaky);
    expect(Exit.isFailure(exit)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(["BEGIN", "UPDATE", "ROLLBACK"]);
  });

  it("costs microseconds per call (runSyncExit per RPC, no layer built)", () => {
    const { sql } = fakeSql();
    const n = 20_000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) setSettings(sql, boss, { apiAccessDefault: "org" });
    const perCallUs = ((performance.now() - t0) / n) * 1000;
    console.log(`setSettings as an Effect program: ${perCallUs.toFixed(1)} µs per call`);
    expect(perCallUs).toBeLessThan(200);
  });
});
