import { afterEach, describe, expect, it, vi } from "vitest";
import { browserUsageInternal, type AutumnEnv } from "./autumn_webhook";

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function env(db: D1Database = {} as D1Database): AutumnEnv {
  return {
    AUTUMN_SECRET_KEY: "autumn-secret",
    AUTUMN_BASE_URL: "https://autumn.test/v1",
    AUTUMN_WEBHOOK_SECRET: "whsec_test",
    EVENT_SECRET: "event-secret",
    BROWSER_USAGE_HMAC_SECRET: "browser-usage-secret",
    CF_ADMIN_SECRET: "admin-secret",
    OPENCOMPUTER_DB: db,
  };
}

async function postUsage(e: AutumnEnv) {
  const body = JSON.stringify({ org_id: "org_1", browser_id: "br_2", value: 60, idempotency_key: "browser_runtime:br_2" });
  const ts = String(Math.floor(Date.now() / 1000));
  const path = "/internal/browser-usage";
  const sig = await hmacHex("browser-usage-secret", `${ts}.${path}.${body}`);
  return browserUsageInternal(
    new Request(`https://api.test${path}`, { method: "POST", headers: { "X-Timestamp": ts, "X-Signature": sig }, body }),
    e,
  );
}

describe("browser usage billing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stores the credit warning when browser spend crosses it", async () => {
    const writes: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () =>
            sql.startsWith("SELECT trial_started_at") || sql.startsWith("SELECT is_halted")
              ? { is_halted: 0, usage_plan: "base", trial_started_at: null, payment_past_due_at: null, billing_warning: null }
              : null,
          run: async () => {
            writes.push(sql);
            return { meta: { changes: 1 } };
          },
        }),
      }),
    } as unknown as D1Database;
    const trial = Response.json({
      id: "org_1",
      subscriptions: [{ plan_id: "trial", add_on: false, status: "active" }],
      balances: { work_minutes: { remaining: 300 }, credits: { remaining: 1.5 } },
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ balance: { remaining: 1.5 } }))
      .mockResolvedValueOnce(trial.clone())
      .mockResolvedValueOnce(trial)
      .mockResolvedValue(new Response(null, { status: 200 }));

    expect((await postUsage(env(db))).status).toBe(200);
    expect(writes.some((sql) => sql.includes("billing_warning = ?8"))).toBe(true);
  });

  it("tracks browser runtime into Autumn with the signed usage payload", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ balance: { remaining: 10 } }));
    const body = JSON.stringify({
      org_id: "org_1",
      browser_id: "br_1",
      provider_session_id: "kernel_1",
      seconds: 60,
      value: 60,
      usage_micro: 8000,
      idempotency_key: "browser_runtime:br_1",
      feature_id: "browser_runtime",
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const path = "/internal/browser-usage";
    const sig = await hmacHex("browser-usage-secret", `${ts}.${path}.${body}`);

    const resp = await browserUsageInternal(
      new Request(`https://api.test${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Timestamp": ts,
          "X-Signature": sig,
        },
        body,
      }),
      env(),
    );

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      ok: true,
      billed: true,
      org_id: "org_1",
      browser_id: "br_1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://autumn.test/v1/track",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer autumn-secret",
          "content-type": "application/json",
          "Idempotency-Key": "browser_runtime:br_1",
        },
        body: JSON.stringify({
          customer_id: "org_1",
          feature_id: "browser_runtime",
          value: 60,
          idempotency_key: "browser_runtime:br_1",
        }),
      }),
    );
  });
});
