// The warmed auth entry must be readable by authenticate().
//
// This is a shape contract between two files, and the failure mode if it drifts
// is silence: authenticate() simply misses, falls through to D1, and everything
// still returns the right answer. Nothing throws, no test fails, and the only
// symptom is that the first request from a cold isolate goes back to costing
// what it cost before — measured on prod from IAD, 16,723ms.
//
// So the assertion here is the round trip, not the written bytes: warm, then
// authenticate, then require that D1 was never touched.
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { warmCreateContextColo } from "./create_context_cache";

const orgID = "22222222-2222-4222-8222-222222222222";
const userID = "11111111-1111-4111-8111-111111111111";

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Minimal stand-in for caches.default — vitest has no Cache API, and without one
// coloPut/coloGet no-op and this test would pass vacuously.
function installCacheStub(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      async match(url: string): Promise<Response | undefined> {
        const v = store.get(String(url));
        return v === undefined ? undefined : new Response(v);
      },
      async put(url: string, res: Response): Promise<void> {
        store.set(String(url), await res.text());
      },
    },
  };
  return store;
}

class WarmDB {
  apiKeyLookups = 0;
  constructor(private readonly keys: { key_hash: string; expires_at: number | null }[]) {}

  prepare(sql: string) {
    const db = this;
    const stmt = {
      bind() {
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM api_keys WHERE key_hash")) db.apiKeyLookups++;
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: [] as T[] };
      },
      async run(): Promise<Record<string, never>> {
        return {};
      },
      _sql: sql,
    };
    return stmt;
  }

  async batch(stmts: { _sql: string }[]): Promise<{ results: unknown[] }[]> {
    return stmts.map((s) => {
      if (s._sql.includes("FROM api_keys WHERE org_id")) {
        return {
          results: this.keys.map((k) => ({
            key_hash: k.key_hash,
            org_id: orgID,
            created_by: userID,
            expires_at: k.expires_at,
          })),
        };
      }
      if (s._sql.includes("FROM cells")) {
        return {
          results: [
            {
              cell_id: "azure-us-east-2-a",
              cloud: "azure",
              region: "us-east-2",
              base_url: "https://cell.example",
              status: "active",
              available_workers: 4,
              capacity_updated_at: null,
            },
          ],
        };
      }
      if (s._sql.includes("FROM orgs")) {
        return {
          results: [
            {
              home_cell: "azure-us-east-2-a",
              plan: "pro",
              is_halted: 0,
              max_concurrent_sandboxes: 100,
              max_disk_mb: 100000,
              billing_provider: "autumn",
              runtime: "microvm",
            },
          ],
        };
      }
      return { results: [{ n: 0 }] };
    });
  }
}

function testEnv(db: WarmDB): Env {
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

describe("warmed auth entries", () => {
  beforeEach(() => {
    installCacheStub();
  });

  it("are accepted by authenticate without touching D1", async () => {
    const key = `osb_${crypto.randomUUID().replace(/-/g, "")}`;
    const db = new WarmDB([{ key_hash: await sha256Hex(key), expires_at: null }]);

    await warmCreateContextColo(db as unknown as D1Database, [orgID]);

    const res = await worker.fetch(
      new Request("https://app.opencomputer.dev/api/sandboxes", {
        headers: { "X-API-Key": key },
      }),
      testEnv(db),
      ctx,
    );

    expect(res.status).not.toBe(401);
    expect(db.apiKeyLookups).toBe(0);
  });

  it("skips expired keys rather than publishing them as valid", async () => {
    const key = `osb_${crypto.randomUUID().replace(/-/g, "")}`;
    const expired = Math.floor(Date.now() / 1000) - 60;
    const db = new WarmDB([{ key_hash: await sha256Hex(key), expires_at: expired }]);

    await warmCreateContextColo(db as unknown as D1Database, [orgID]);

    await worker.fetch(
      new Request("https://app.opencomputer.dev/api/sandboxes", {
        headers: { "X-API-Key": key },
      }),
      testEnv(db),
      ctx,
    );

    // No warmed entry to hit, so the request must fall through to D1 — which is
    // the safe direction: an expired key gets re-checked, never served warm.
    expect(db.apiKeyLookups).toBe(1);
  });
});
