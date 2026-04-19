import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker, { type Env } from "./index";

const SECRET = (env as unknown as Env).EVENT_SECRET;

async function sign(secret: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeEvent(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    type: "usage_tick",
    sandbox_id: "sb-test",
    worker_id: "w-test",
    cell_id: "dev-cell-a",
    payload: { memory_mb: 512 },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = await sign(SECRET, ts, raw);
  const req = new Request("https://ingest.test/ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cell-Id": "dev-cell-a",
      "X-Timestamp": ts,
      "X-Signature": sig,
      ...headers,
    },
    body: raw,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env as unknown as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("events-ingest /ingest", () => {
  beforeEach(async () => {
    // Wipe events table so dedup + row counts are deterministic.
    await (env as unknown as Env).OPENCOMPUTER_DB.exec("DELETE FROM events");
  });

  it("accepts a valid batch and writes to D1", async () => {
    const res = await post({ events: [makeEvent("evt-1"), makeEvent("evt-2")] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: number; deduped: number };
    expect(body.accepted).toBe(2);
    expect(body.deduped).toBe(0);

    const { results } = await (env as unknown as Env).OPENCOMPUTER_DB.prepare(
      "SELECT id, cell_id, type FROM events ORDER BY id",
    ).all();
    expect(results).toHaveLength(2);
    expect(results[0].cell_id).toBe("dev-cell-a");
    expect(results[0].type).toBe("usage_tick");
  });

  it("dedups events that were already ingested", async () => {
    await post({ events: [makeEvent("evt-same")] });
    const res = await post({ events: [makeEvent("evt-same")] });
    const body = (await res.json()) as { accepted: number; deduped: number };
    expect(body.deduped).toBe(1);
    expect(body.accepted).toBe(0);
  });

  it("rejects bad HMAC signature", async () => {
    const res = await post(
      { events: [makeEvent("evt-bad-sig")] },
      { "X-Signature": "deadbeef" },
    );
    expect(res.status).toBe(401);
  });

  it("rejects stale timestamps", async () => {
    const body = JSON.stringify({ events: [makeEvent("evt-stale")] });
    const ts = (Math.floor(Date.now() / 1000) - 3600).toString(); // 1h ago
    const sig = await sign(SECRET, ts, body);
    const req = new Request("https://ingest.test/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cell-Id": "dev-cell-a",
        "X-Timestamp": ts,
        "X-Signature": sig,
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 on malformed JSON", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const body = "not json";
    const sig = await sign(SECRET, ts, body);
    const req = new Request("https://ingest.test/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cell-Id": "dev-cell-a",
        "X-Timestamp": ts,
        "X-Signature": sig,
      },
      body,
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});
