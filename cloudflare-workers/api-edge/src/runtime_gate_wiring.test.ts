import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { SDK_VERSION_HEADER } from "./runtime_gate";

// runtime_gate.test.ts covers the decision. This covers the WIRING, which is
// where the equivalent work has failed before: a rule that is correct in
// isolation and simply never consulted on the path that matters. The assertion
// is deliberately made on the capability token the cell actually reads its
// backend off, not on any intermediate value.

// A fresh org per case. loadCreateContext memoises the org row in a
// module-level isolate cache that outlives a single test, so reusing one id
// would have the second case read the first case's runtime.
let seq = 0;
let orgID = "org-0";
let apiKey = "osb_test_0";
function freshOrg(runtime: string | null): void {
  seq += 1;
  orgID = `org-${seq}`;
  apiKey = `osb_test_${seq}`;
  orgRuntime = runtime;
}

const cellID = "azure-us-east-2-a";
const cellURL = "https://cp-us-east-2.opencomputer.dev";

let orgRuntime: string | null = null;

class FakeStatement {
  constructor(private sql: string) {}
  bind(..._args: unknown[]) {
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM api_keys")) {
      return { org_id: orgID, created_by: "user-1", expires_at: null } as T;
    }
    if (this.sql.includes("FROM cells WHERE cell_id")) return cellRow<T>();
    if (this.sql.includes("SELECT home_cell, plan, runtime FROM orgs")) {
      return { home_cell: cellID, plan: "pro", runtime: orgRuntime } as T;
    }
    if (this.sql.includes("SELECT home_cell, plan, is_halted")) {
      return {
        home_cell: cellID,
        plan: "pro",
        is_halted: 0,
        max_concurrent_sandboxes: 10,
        max_disk_mb: 262144,
        runtime: orgRuntime,
      } as T;
    }
    if (this.sql.includes("COUNT(*) AS n FROM sandboxes_index")) return { n: 0 } as T;
    return null;
  }
  async all<T>() {
    if (this.sql.includes("FROM cells WHERE status = 'active'")) {
      return { results: [await cellRow<T>()] } as { results: T[] };
    }
    return { results: [] as T[] };
  }
  async run() {
    return {};
  }
  async batchResult<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("WHERE status = 'active'")) return (await this.all<T>()) as { results: T[] };
    const row = await this.first<T>();
    return { results: row ? [row] : [] };
  }
}

function cellRow<T>(): T {
  return {
    cell_id: cellID,
    cloud: "azure",
    region: "us-east-2",
    base_url: cellURL,
    status: "active",
    available_workers: 1,
    capacity_updated_at: Math.floor(Date.now() / 1000),
  } as T;
}

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    OPENCOMPUTER_DB: {
      prepare: (sql: string) => new FakeStatement(sql),
      batch: async (stmts: FakeStatement[]) => Promise.all(stmts.map((s) => s.batchResult())),
    },
    SESSION_JWT_SECRET: "test-secret",
    WORKER_ENV: "test",
    // No POOL_STOCK binding: edge-claim is structurally unavailable, so the
    // create takes the CP-fallback path and mints the cap token we assert on.
    ...extra,
  } as unknown as Env;
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

/** The `runtime` claim from the Bearer token the edge sent the cell. */
function runtimeClaim(headers: HeadersInit | undefined): string {
  const auth = new Headers(headers).get("authorization") ?? "";
  const payload = auth.replace(/^Bearer /, "").split(".")[1];
  if (!payload) throw new Error(`no JWT in authorization header: ${auth}`);
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  return (JSON.parse(json).runtime as string) ?? "";
}

async function createWith(
  sdkVersion: string | null,
  opts: { runtime?: string | null; env?: Env } = {},
): Promise<string> {
  freshOrg(opts.runtime ?? null);
  const env = opts.env ?? makeEnv();
  const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ sandboxID: "sb-1" }), { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  const headers: Record<string, string> = { "X-API-Key": apiKey, "content-type": "application/json" };
  if (sdkVersion) headers[SDK_VERSION_HEADER] = sdkVersion;
  const resp = await worker.fetch(
    new Request("https://app.opencomputer.dev/api/sandboxes", { method: "POST", headers, body: "{}" }),
    env,
    ctx,
  );
  expect(resp.status, `create failed: ${await resp.clone().text()}`).toBe(201);
  expect(fetchSpy).toHaveBeenCalled();
  return runtimeClaim(fetchSpy.mock.calls[0][1]?.headers);
}

describe("create routes by SDK version", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    orgRuntime = null;
  });

  it("sends an unpinned org's v2 create to microvm", async () => {
    expect(await createWith("1.0.0")).toBe("microvm");
  });

  it("leaves an unpinned org's older create on the fleet", async () => {
    expect(await createWith("0.15.7")).toBe("");
    expect(await createWith(null)).toBe("");
  });

  it("honours both pins over the calling SDK", async () => {
    expect(await createWith("0.15.7", { runtime: "microvm" })).toBe("microvm");
    expect(await createWith("1.0.0", { runtime: "qemu" })).toBe("qemu");
  });

  it("SDK_RUNTIME_GATE=0 holds every unpinned create on the fleet", async () => {
    expect(await createWith("1.0.0", { env: makeEnv({ SDK_RUNTIME_GATE: "0" } as Partial<Env>) })).toBe("");
  });
});

// A template is built differently per runtime, so the snapshot path has to make
// the same decision the create path does. It did not: it minted a blank runtime
// unconditionally, which would have let a customer migrate their sandboxes and
// then build every template as a checkpoint the new runtime cannot restore.
describe("snapshot builds route by SDK version", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    orgRuntime = null;
  });

  async function snapshotWith(sdkVersion: string | null, runtime: string | null = null): Promise<string> {
    freshOrg(runtime);
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const headers: Record<string, string> = { "X-API-Key": apiKey, "content-type": "application/json" };
    if (sdkVersion) headers[SDK_VERSION_HEADER] = sdkVersion;
    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/api/snapshots", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "tools", image: {} }),
      }),
      makeEnv(),
      ctx,
    );
    expect(resp.status, `snapshot create failed: ${await resp.clone().text()}`).toBe(200);
    return runtimeClaim(fetchSpy.mock.calls[0][1]?.headers);
  }

  it("builds a v2 caller's template on microvm", async () => {
    expect(await snapshotWith("1.0.0")).toBe("microvm");
  });

  it("leaves an older caller's template on the fleet", async () => {
    expect(await snapshotWith("0.15.7")).toBe("");
  });

  it("honours the org pin", async () => {
    expect(await snapshotWith("1.0.0", "qemu")).toBe("qemu");
  });
});
