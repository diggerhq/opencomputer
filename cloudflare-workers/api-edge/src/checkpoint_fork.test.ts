import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

// POST /api/sandboxes/from-checkpoint/:id when checkpoints_index has no row
// yet (the checkpoint_ready event hasn't landed in D1). The edge must locate
// the owning cell by probing the cells instead of answering 404.

const orgID = "org-1";
const userID = "user-1";
const cpID = "0f3c2a4e-6d1b-4c8f-9a2e-1b3d5f7a9c0e";

const cellA = {
  cell_id: "cell-a",
  cloud: "azure",
  region: "us-east-2",
  base_url: "https://cp-a.opencomputer.dev",
  status: "active",
  available_workers: 1,
  capacity_updated_at: Math.floor(Date.now() / 1000),
};
const cellB = { ...cellA, cell_id: "cell-b", base_url: "https://cp-b.opencomputer.dev" };
const cells = [cellA, cellB];

let checkpointRow: { owner_cell_id: string; org_id: string } | null = null;
const sandboxIndexInserts: unknown[][] = [];

class FakeStatement {
  constructor(private sql: string) {}
  private args: unknown[] = [];
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM api_keys")) return { org_id: orgID, created_by: userID, expires_at: null } as T;
    if (this.sql.includes("FROM checkpoints_index")) return checkpointRow as T | null;
    if (this.sql.includes("FROM cells WHERE cell_id")) {
      const id = this.args[0];
      return (cells.find((c) => c.cell_id === id) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT home_cell, plan, is_halted")) {
      return {
        home_cell: cellA.cell_id,
        plan: "pro",
        is_halted: 0,
        max_concurrent_sandboxes: 10,
        max_disk_mb: 262144,
        billing_provider: "",
        runtime: null,
      } as T;
    }
    if (this.sql.includes("COUNT(*) AS n FROM sandboxes_index")) return { n: 0 } as T;
    return null;
  }
  async all<T>() {
    if (this.sql.includes("FROM cells WHERE status = 'active'")) return { results: cells as unknown as T[] };
    return { results: [] as T[] };
  }
  async run() {
    if (this.sql.includes("INSERT OR REPLACE INTO sandboxes_index")) sandboxIndexInserts.push(this.args);
    return {};
  }
  async batchResult<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("WHERE status = 'active'")) return (await this.all<T>()) as { results: T[] };
    const row = await this.first<T>();
    return { results: row ? [row] : [] };
  }
}

const env = {
  OPENCOMPUTER_DB: {
    prepare(sql: string) {
      return new FakeStatement(sql);
    },
    async batch(stmts: FakeStatement[]) {
      return Promise.all(stmts.map((s) => s.batchResult()));
    },
  },
  SESSIONS_KV: {},
  CREDIT_ACCOUNT: {},
  SESSION_JWT_SECRET: "test-secret",
  WORKER_ENV: "test",
} as unknown as Env;

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

const probePath = `/api/sandboxes/checkpoints/${cpID}/patches`;
const forkPath = `/api/sandboxes/from-checkpoint/${cpID}`;

// Cell fake: `owner` answers the probe 200 and the fork 201; `foreign` answers
// the probe 403 (row exists, other org); everyone else 404s.
function stubCells(opts: { owner?: string; foreign?: string }) {
  const calls: { origin: string; path: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const method = init?.method ?? (typeof input === "string" ? "GET" : input.method);
      calls.push({ origin: url.origin, path: url.pathname, method });
      if (url.pathname === probePath) {
        if (url.origin === opts.owner) return new Response("[]", { status: 200 });
        if (url.origin === opts.foreign) return new Response('{"error":"nope"}', { status: 403 });
        return new Response('{"error":"checkpoint not found"}', { status: 404 });
      }
      if (url.pathname === forkPath && url.origin === opts.owner) {
        return new Response(JSON.stringify({ sandboxID: "sb-fork1", workerID: "w-1", status: "running", memoryMB: 2048 }), { status: 201 });
      }
      return new Response('{"error":"unexpected"}', { status: 500 });
    }),
  );
  return calls;
}

function fork() {
  return worker.fetch(
    new Request(`https://app.opencomputer.dev${forkPath}`, {
      method: "POST",
      headers: { "X-API-Key": "osb_test", "Content-Type": "application/json" },
      body: JSON.stringify({ memoryMB: 2048 }),
    }),
    env,
    ctx,
  );
}

describe("POST /api/sandboxes/from-checkpoint — checkpoints_index miss", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    checkpointRow = null;
    sandboxIndexInserts.length = 0;
  });

  it("routes via checkpoints_index without probing when the row exists", async () => {
    checkpointRow = { owner_cell_id: cellB.cell_id, org_id: orgID };
    const calls = stubCells({ owner: cellB.base_url });
    const resp = await fork();
    expect(resp.status).toBe(201);
    expect(calls.filter((c) => c.path === probePath)).toHaveLength(0);
    expect(calls.filter((c) => c.path === forkPath)).toEqual([{ origin: cellB.base_url, path: forkPath, method: "POST" }]);
  });

  it("probes every active cell on a miss and forks on the one that owns the checkpoint", async () => {
    const calls = stubCells({ owner: cellB.base_url });
    const resp = await fork();
    expect(resp.status).toBe(201);
    expect(await resp.json()).toMatchObject({ sandboxID: "sb-fork1" });

    const probes = calls.filter((c) => c.path === probePath).map((c) => c.origin).sort();
    expect(probes).toEqual([cellA.base_url, cellB.base_url].sort());
    expect(calls.filter((c) => c.path === forkPath)).toEqual([{ origin: cellB.base_url, path: forkPath, method: "POST" }]);
    // The fork is still registered in sandboxes_index under the located cell.
    expect(sandboxIndexInserts).toHaveLength(1);
    expect(sandboxIndexInserts[0].slice(0, 4)).toEqual(["sb-fork1", orgID, userID, cellB.cell_id]);
  });

  it("returns 404 when no cell owns the checkpoint", async () => {
    const calls = stubCells({});
    const resp = await fork();
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: "checkpoint not found" });
    expect(calls.filter((c) => c.path === forkPath)).toHaveLength(0);
  });

  it("returns 403 when a cell owns the checkpoint for another org", async () => {
    const calls = stubCells({ foreign: cellA.base_url });
    const resp = await fork();
    expect(resp.status).toBe(403);
    expect(calls.filter((c) => c.path === forkPath)).toHaveLength(0);
  });

  it("does not probe cells for a non-UUID checkpoint id", async () => {
    const calls = stubCells({ owner: cellA.base_url });
    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/api/sandboxes/from-checkpoint/not-a-uuid", {
        method: "POST",
        headers: { "X-API-Key": "osb_test", "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(resp.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
