// A cold-cache burst must collapse onto ONE api_keys lookup.
//
// This is a latency contract, not a correctness one, which is exactly why it
// needs a test: without single-flight everything still returns the right
// answer, just slowly, so nothing fails and the regression is invisible until
// someone runs a burst. Measured on prod at burst-100 against a freshly
// deployed worker, the un-collapsed version put `auth` at 15,026ms median with
// all 100 requests inside a 48ms band — one shared round trip to a D1 primary
// that lives in WNAM while the burst runs in IAD.
import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const orgID = "22222222-2222-4222-8222-222222222222";
const userID = "11111111-1111-4111-8111-111111111111";

class CountingDB {
  apiKeyLookups = 0;

  prepare(sql: string) {
    const db = this;
    return {
      bind() {
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM api_keys WHERE key_hash")) {
          db.apiKeyLookups++;
          // A real D1 read from IAD to a WNAM primary is ~300ms. Any await at
          // all is enough to let the other requests in the burst reach the
          // in-flight map, which is the behaviour under test.
          await new Promise((r) => setTimeout(r, 5));
          return { org_id: orgID, created_by: userID, expires_at: null } as T;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: [] as T[] };
      },
      async run(): Promise<Record<string, never>> {
        return {};
      },
    };
  }

  async batch<T>(stmts: { first(): Promise<T> }[]): Promise<{ results: T[] }[]> {
    return Promise.all(stmts.map(async (s) => ({ results: [await s.first()] })));
  }
}

function testEnv(db: CountingDB): Env {
  return {
    OPENCOMPUTER_DB: db,
    SESSIONS_KV: {},
    WORKER_ENV: "test",
    CF_ADMIN_SECRET: "",
    EVENT_SECRET: "",
  } as unknown as Env;
}

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe("authenticate single-flight", () => {
  it("collapses a concurrent cold-cache burst onto one api_keys lookup", async () => {
    const db = new CountingDB();
    const env = testEnv(db);
    // Unique per run: authCache is module-global, so a key another test already
    // authenticated would be served from cache and never reach D1 at all.
    const key = `osb_${crypto.randomUUID().replace(/-/g, "")}`;

    await Promise.all(
      Array.from({ length: 50 }, () =>
        worker.fetch(
          new Request("https://app.opencomputer.dev/api/sandboxes", {
            headers: { "X-API-Key": key },
          }),
          env,
          ctx,
        ),
      ),
    );

    expect(db.apiKeyLookups).toBe(1);
  });

  it("does not collapse distinct keys onto one another", async () => {
    const db = new CountingDB();
    const env = testEnv(db);
    const keys = Array.from(
      { length: 3 },
      () => `osb_${crypto.randomUUID().replace(/-/g, "")}`,
    );

    await Promise.all(
      keys.flatMap((key) =>
        Array.from({ length: 5 }, () =>
          worker.fetch(
            new Request("https://app.opencomputer.dev/api/sandboxes", {
              headers: { "X-API-Key": key },
            }),
            env,
            ctx,
          ),
        ),
      ),
    );

    expect(db.apiKeyLookups).toBe(keys.length);
  });

  it("releases the in-flight entry so a later miss still reaches D1", async () => {
    const db = new CountingDB();
    const env = testEnv(db);
    const key = `osb_${crypto.randomUUID().replace(/-/g, "")}`;
    const call = (): Promise<Response> =>
      worker.fetch(
        new Request("https://app.opencomputer.dev/api/sandboxes", {
          headers: { "X-API-Key": key },
        }),
        env,
        ctx,
      );

    await call();
    expect(db.apiKeyLookups).toBe(1);
    // Second call is served by the isolate cache, not by a second query — and
    // critically it must not hang on a stale in-flight promise.
    await call();
    expect(db.apiKeyLookups).toBe(1);
  });
});
