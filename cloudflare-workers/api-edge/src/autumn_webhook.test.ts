import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autumnPurchase,
  autumnWebhook,
  autumnSetAutoTopup,
  autumnUsagePlanPurchase,
  billingWebhookEvents,
  haltReason,
  planChangeKind,
  syncAutumnToD1,
  summarizeAutumnCreditBalance,
  type AutumnApiEnv,
  type AutumnEnv,
} from "./autumn_webhook";

describe("Autumn credit balance summary", () => {
  it("separates monthly plan credits from persistent top-ups", () => {
    expect(
      summarizeAutumnCreditBalance(
        {
          id: "org_1",
          balances: {
            credits: {
              remaining: 225,
              breakdown: [
                {
                  plan_id: "pro",
                  remaining: 200,
                  reset: {
                    interval: "month",
                    resets_at: 1_787_472_000_000,
                  },
                },
                { plan_id: "top_up", remaining: 25, reset: null },
              ],
            },
          },
        },
        "pro",
      ),
    ).toEqual({
      available: true,
      planRemaining: 200,
      topupRemaining: 25,
      otherRemaining: 0,
      planResetsAt: 1_787_472_000_000,
    });
  });

  it("keeps carried credits separate even when Autumn folds them into the plan row", () => {
    const summary = summarizeAutumnCreditBalance(
      {
        id: "org_1",
        balances: {
          credits: {
            remaining: 229.9,
            rollovers: [{ balance: 4.9, expires_at: 1_787_472_000_000 }],
            breakdown: [
              {
                plan_id: "pro",
                remaining: 204.9,
                reset: {
                  interval: "month",
                  resets_at: 1_787_472_000_000,
                },
              },
              { plan_id: "top_up", remaining: 25 },
            ],
          },
        },
      },
      "pro",
    );

    expect(summary).toMatchObject({
      available: true,
      planRemaining: 200,
      topupRemaining: 25,
    });
    expect(summary.otherRemaining).toBeCloseTo(4.9);
  });

  it("does not invent a split when Autumn omits its balance breakdown", () => {
    expect(
      summarizeAutumnCreditBalance(
        {
          id: "org_1",
          balances: { credits: { remaining: 12.5 } },
        },
        "base",
      ),
    ).toEqual({
      available: false,
      planRemaining: 0,
      topupRemaining: 0,
      otherRemaining: 12.5,
      planResetsAt: null,
    });
  });
});

const env: AutumnApiEnv = {
  AUTUMN_SECRET_KEY: "autumn-secret",
  AUTUMN_BASE_URL: "https://autumn.test/v1",
};

describe("Autumn auto top-up", () => {
  afterEach(() => vi.restoreAllMocks());

  it("converts the dollar budget to an exact monthly purchase limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({}));

    await autumnSetAutoTopup(env, "org_1", {
      enabled: true,
      threshold: 10,
      quantity: 25,
      budget: 100,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://autumn.test/v1/customers/org_1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          billing_controls: {
            auto_topups: [
              {
                feature_id: "credits",
                enabled: true,
                threshold: 10,
                quantity: 25,
                purchase_limit: {
                  interval: "month",
                  interval_count: 1,
                  limit: 4,
                },
              },
            ],
          },
        }),
      }),
    );
  });

  it("rejects a budget that cannot be represented as a hard purchase limit", async () => {
    await expect(
      autumnSetAutoTopup(env, "org_1", {
        enabled: true,
        threshold: 10,
        quantity: 25,
        budget: 90,
      }),
    ).rejects.toThrow("monthly budget divisible by quantity");
  });
});

describe("Autumn recurring plan purchases", () => {
  afterEach(() => vi.restoreAllMocks());

  it("switches an existing paid subscriber directly through attach", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        id: "org_1",
        subscriptions: [{ plan_id: "pro", add_on: false, status: "active" }],
        purchases: [],
      }))
      .mockResolvedValueOnce(Response.json({}));

    await expect(autumnPurchase(env, {
      customerId: "org_1",
      productId: "max",
      successUrl: "https://example.test/billing",
    })).resolves.toEqual({ url: null });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://autumn.test/v1/attach",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ customer_id: "org_1", product_id: "max" }),
      }),
    );
  });

  it("starts hosted checkout when the customer has no payment history", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "org_1", subscriptions: [], purchases: [] }))
      .mockResolvedValueOnce(Response.json({ url: "https://checkout.stripe.test/session" }));

    await expect(autumnPurchase(env, {
      customerId: "org_1",
      productId: "pro",
      successUrl: "https://example.test/billing",
    })).resolves.toEqual({ url: "https://checkout.stripe.test/session" });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://autumn.test/v1/checkout",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          customer_id: "org_1",
          product_id: "pro",
          success_url: "https://example.test/billing",
        }),
      }),
    );
  });
});

describe("Autumn shared-credit plan purchases", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries the remaining signup balance into the first paid plan", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        id: "org_1",
        subscriptions: [{ plan_id: "base", add_on: false, status: "active" }],
        purchases: [],
      }))
      .mockResolvedValueOnce(Response.json({ payment_url: "https://checkout.stripe.test/session" }));

    await expect(autumnUsagePlanPurchase(env, {
      customerId: "org_1",
      planId: "pro",
      successUrl: "https://example.test/billing?usage-plan=pro",
    })).resolves.toEqual({ url: "https://checkout.stripe.test/session" });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://autumn.test/v1/billing.attach",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          customer_id: "org_1",
          plan_id: "pro",
          success_url: "https://example.test/billing?usage-plan=pro",
          plan_schedule: "immediate",
          carry_over_balances: {
            enabled: true,
            feature_ids: ["credits"],
          },
        }),
      }),
    );
  });

  it("does not roll paid monthly grants into another paid plan", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({
        id: "org_1",
        subscriptions: [{ plan_id: "pro", add_on: false, status: "active" }],
        purchases: [],
      }))
      .mockResolvedValueOnce(Response.json({ payment_url: null }));

    await expect(autumnUsagePlanPurchase(env, {
      customerId: "org_1",
      planId: "max",
      successUrl: "https://example.test/billing?usage-plan=max",
    })).resolves.toEqual({ url: null });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://autumn.test/v1/billing.attach",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          customer_id: "org_1",
          plan_id: "max",
          success_url: "https://example.test/billing?usage-plan=max",
          plan_schedule: "immediate",
        }),
      }),
    );
  });
});

describe("billing funnel events from Autumn", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names plan transitions", () => {
    expect(planChangeKind("base", "pro", false)).toBe("trial_converted");
    expect(planChangeKind("pro", "max", false)).toBe("upgrade");
    expect(planChangeKind("max", "pro", false)).toBe("downgrade");
    expect(planChangeKind("pro", "base", false)).toBe("cancel");
    expect(planChangeKind("pro", "base", true)).toBe("lapsed");
  });

  it("maps payment and top-up webhooks to events", () => {
    expect(
      billingWebhookEvents({
        type: "billing.updated",
        data: {
          plan_changes: [
            { action: "updated", subscription: { plan_id: "pro", past_due: true }, previous_attributes: { past_due: false } },
            { action: "updated", subscription: { plan_id: "max", past_due: false }, previous_attributes: { past_due: true } },
            { action: "activated", subscription: { plan_id: "pro", past_due: false }, previous_attributes: null },
          ],
        },
      }),
    ).toEqual([
      { name: "billing.payment_failed", data: { plan: "pro" } },
      { name: "billing.payment_recovered", data: { plan: "max" } },
    ]);
    expect(billingWebhookEvents({ type: "billing.auto_topup_succeeded", data: { quantity_granted: 50 } })).toEqual([
      { name: "billing.credits_purchased", data: { amount: 50, auto: true } },
    ]);
    expect(billingWebhookEvents({ type: "billing.auto_topup_failed", data: { reason: "charge_failed" } })).toEqual([
      { name: "billing.payment_failed", data: { plan: "top_up", reason: "charge_failed" } },
    ]);
    expect(billingWebhookEvents({ type: "balances.limit_reached", data: {} })).toEqual([]);
  });

  function fakeDb(usagePlan: string, pastDueAt: number | null = null) {
    const org: Record<string, unknown> = {
      is_halted: 0,
      autumn_concurrency_override: null,
      usage_plan: usagePlan,
      payment_past_due_at: pastDueAt,
    };
    const deliveries = new Set<string>();
    const db = {
      org,
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first: async () => (sql.includes("FROM sandboxes_index") ? null : { ...org }),
              run: async () => {
                if (sql.includes("INSERT OR IGNORE INTO autumn_webhook_deliveries")) {
                  if (deliveries.has(args[0] as string)) return { meta: { changes: 0 } };
                  deliveries.add(args[0] as string);
                } else if (sql.includes("SET payment_past_due_at")) {
                  org.payment_past_due_at = args[0] ? (org.payment_past_due_at ?? args[1]) : null;
                } else if (sql.includes("AND usage_plan = ?3")) {
                  if (org.usage_plan !== args[2]) return { meta: { changes: 0 } };
                  org.usage_plan = args[0];
                  if (args[0] === "base") org.payment_past_due_at = null;
                } else if (sql.includes("SET is_halted")) {
                  org.usage_plan = args[3];
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    };
    return db as typeof db & D1Database;
  }

  function mockAutumn(subscriptions: Array<{ plan_id: string }>) {
    const posted: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith("https://autumn.test/v1/customers/")) {
        return Response.json({
          id: "org_1",
          subscriptions: subscriptions.map((s) => ({ ...s, add_on: false, status: "active" })),
          balances: { credits: { remaining: 10 } },
        });
      }
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    return posted;
  }

  it("emits plan_changed once when the projection moves the plan", async () => {
    const posted = mockAutumn([{ plan_id: "pro" }]);
    const syncEnv = { ...env, OPENCOMPUTER_DB: fakeDb("base"), POSTHOG_PROJECT_TOKEN: "phc_test" };

    expect((await syncAutumnToD1(syncEnv, "org_1"))?.usagePlan).toBe("pro");
    await syncAutumnToD1(syncEnv, "org_1");

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      event: "billing.plan_changed",
      properties: { from: "base", to: "pro", kind: "trial_converted" },
    });
  });

  it("calls a plan that ends while past due lapsed, whoever projects it", async () => {
    const posted = mockAutumn([]);
    const db = fakeDb("pro", 1_700_000_000);

    await syncAutumnToD1({ ...env, OPENCOMPUTER_DB: db, POSTHOG_PROJECT_TOKEN: "phc_test" }, "org_1");

    expect(posted[0]).toMatchObject({ properties: { from: "pro", to: "base", kind: "lapsed" } });
    expect(db.org.payment_past_due_at).toBeNull();
  });

  async function svixPost(webhookEnv: AutumnEnv, svixID: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const secret = btoa("webhook-key");
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${svixID}.${ts}.${body}`)));
    const sig = btoa(String.fromCharCode(...mac));
    return autumnWebhook(
      new Request("https://api.test/webhooks/autumn", {
        method: "POST",
        headers: { "svix-id": svixID, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
        body,
      }),
      { ...webhookEnv, AUTUMN_WEBHOOK_SECRET: `whsec_${secret}` },
    );
  }

  it("marks the org past due and sends a redelivered webhook's events once", async () => {
    const posted = mockAutumn([{ plan_id: "pro" }]);
    const db = fakeDb("pro");
    const webhookEnv = {
      ...env,
      OPENCOMPUTER_DB: db,
      POSTHOG_PROJECT_TOKEN: "phc_test",
      EVENT_SECRET: "event-secret",
      CF_ADMIN_SECRET: "admin-secret",
      AUTUMN_WEBHOOK_SECRET: "",
    } as unknown as AutumnEnv;
    const payload = {
      type: "billing.updated",
      data: {
        customer_id: "org_1",
        plan_changes: [
          { action: "updated", subscription: { plan_id: "pro", past_due: true }, previous_attributes: { past_due: false } },
        ],
      },
    };

    expect((await svixPost(webhookEnv, "msg_1", payload)).status).toBe(200);
    expect((await svixPost(webhookEnv, "msg_1", payload)).status).toBe(200);

    expect(db.org.payment_past_due_at).not.toBeNull();
    expect(posted.map((p) => p.event)).toEqual(["billing.payment_failed"]);
  });
});

describe("halt rules", () => {
  const now = 1_800_000_000;
  const day = 86_400;
  const customer = (
    plans: string[],
    balances: { minutes?: number; credits?: number },
  ): Parameters<typeof haltReason>[0] => ({
    id: "org_1",
    subscriptions: plans.map((plan_id) => ({ plan_id, add_on: false, status: "active" })),
    balances: {
      ...(balances.minutes === undefined ? {} : { work_minutes: { remaining: balances.minutes } }),
      credits: { remaining: balances.credits ?? 0 },
    },
  });
  const fresh = { trialStartedAt: now - day, paymentPastDueAt: null };

  it("keeps credit-only orgs on the credit rule", () => {
    const org = { trialStartedAt: null, paymentPastDueAt: null };
    expect(haltReason(customer(["base"], { credits: 3 }), org, now)).toBeNull();
    expect(haltReason(customer(["base"], { credits: 0 }), org, now)).toBe("credits_exhausted");
    expect(haltReason(customer(["max"], { credits: 0 }), org, now)).toBe("credits_exhausted");
  });

  it("ends the trial at day 7, 600 minutes or the token credit", () => {
    expect(haltReason(customer(["trial"], { minutes: 100, credits: 5 }), fresh, now)).toBeNull();
    expect(
      haltReason(customer(["trial"], { minutes: 100, credits: 5 }), { ...fresh, trialStartedAt: now - 7 * day }, now),
    ).toBe("trial_days");
    expect(haltReason(customer(["trial"], { minutes: 0, credits: 5 }), fresh, now)).toBe("trial_minutes");
    expect(haltReason(customer(["trial"], { minutes: 100, credits: 0 }), fresh, now)).toBe("trial_tokens");
  });

  it("halts a paid org only when minutes and credits are both used", () => {
    expect(haltReason(customer(["pro"], { minutes: 0, credits: 4 }), fresh, now)).toBeNull();
    expect(haltReason(customer(["pro"], { minutes: 12, credits: 0 }), fresh, now)).toBeNull();
    expect(haltReason(customer(["max"], { minutes: 0, credits: 0 }), fresh, now)).toBe("credits_empty");
  });

  it("halts a paid org once its payment is 3 days past due", () => {
    const pastDue = (days: number) => ({ ...fresh, paymentPastDueAt: now - days * day });
    expect(haltReason(customer(["pro"], { minutes: 500 }), pastDue(2), now)).toBeNull();
    expect(haltReason(customer(["pro"], { minutes: 500 }), pastDue(3), now)).toBe("payment");
  });

  it("calls a work-minute org with no plan lapsed, and gives no second trial", () => {
    expect(haltReason(customer([], { minutes: 0, credits: 0 }), fresh, now)).toBe("lapsed");
    expect(
      haltReason(customer(["trial"], { minutes: 600, credits: 10 }), { ...fresh, trialStartedAt: now - 40 * day }, now),
    ).toBe("trial_days");
  });
});
