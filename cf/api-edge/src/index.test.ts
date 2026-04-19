import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

const E = env as unknown as Env;

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function callWorker(req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, E);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("api-edge /internal/halt-list", () => {
  beforeEach(async () => {
    await E.OPENCOMPUTER_DB.exec("DELETE FROM sandboxes_index");
    const now = Date.now();
    // Two orgs, one has a hibernated sandbox in the target cell
    await E.OPENCOMPUTER_DB.prepare(
      `INSERT INTO sandboxes_index (id, org_id, cell_id, status, created_at) VALUES
       (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
    )
      .bind(
        "sb-1", "org-halted", "dev-cell-a", "hibernated", now,
        "sb-2", "org-running", "dev-cell-a", "running", now,
        "sb-3", "org-other-cell", "other-cell", "hibernated", now,
      )
      .run();
  });

  it("returns org_ids with hibernated sandboxes in the requested cell", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = await hmacHex(E.CF_ADMIN_SECRET, `${ts}.`);
    const res = await callWorker(
      new Request("https://api.test/internal/halt-list?cell=dev-cell-a", {
        headers: { "X-Timestamp": ts, "X-Signature": sig },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { org_ids: string[] };
    expect(body.org_ids).toEqual(["org-halted"]);
  });

  it("rejects unsigned requests", async () => {
    const res = await callWorker(
      new Request("https://api.test/internal/halt-list?cell=dev-cell-a"),
    );
    expect(res.status).toBe(401);
  });

  it("rejects stale timestamps", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 3600).toString();
    const sig = await hmacHex(E.CF_ADMIN_SECRET, `${ts}.`);
    const res = await callWorker(
      new Request("https://api.test/internal/halt-list?cell=dev-cell-a", {
        headers: { "X-Timestamp": ts, "X-Signature": sig },
      }),
    );
    expect(res.status).toBe(401);
  });
});
