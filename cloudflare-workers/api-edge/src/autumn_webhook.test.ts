import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autumnPurchase,
  autumnSetAutoTopup,
  autumnUsagePlanPurchase,
  summarizeAutumnCreditBalance,
  syncAutumnToD1,
  type AutumnApiEnv,
  type AutumnSyncEnv,
} from "./autumn_webhook";

interface ProjectedOrgState {
  isHalted: number;
  haltedAt: number | null;
  maxConcurrent: number;
  updatedAt: number;
}

function autumnSyncEnv(state: ProjectedOrgState): AutumnSyncEnv {
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings = values;
          return statement;
        },
        async first() {
          expect(sql).toContain("SELECT is_halted, autumn_concurrency_override");
          return {
            is_halted: state.isHalted,
            autumn_concurrency_override: null,
          };
        },
        async run() {
          expect(sql).toContain("WHEN ?1 = 0 THEN NULL");
          expect(sql).toContain("WHEN is_halted = 0 OR halted_at IS NULL THEN ?2");
          expect(sql).toContain("ELSE halted_at");

          const [isHalted, nowSec, maxConcurrent, updatedAt] = bindings as number[];
          if (isHalted === 0) {
            state.haltedAt = null;
          } else if (state.isHalted === 0 || state.haltedAt === null) {
            state.haltedAt = nowSec;
          }
          state.isHalted = isHalted;
          state.maxConcurrent = maxConcurrent;
          state.updatedAt = updatedAt;
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  return {
    AUTUMN_SECRET_KEY: "autumn-secret",
    AUTUMN_BASE_URL: "https://autumn.test/v1",
    OPENCOMPUTER_DB: db,
  };
}

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

describe("Autumn halted-at projection", () => {
  let creditsRemaining = 0;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockAutumnCustomer() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        id: "org_1",
        balances: { credits: { remaining: creditsRemaining } },
      }),
    );
  }

  it("preserves the first halt timestamp until the org resumes", async () => {
    vi.useFakeTimers();
    const state: ProjectedOrgState = {
      isHalted: 0,
      haltedAt: null,
      maxConcurrent: 50,
      updatedAt: 0,
    };
    mockAutumnCustomer();

    vi.setSystemTime(new Date("2026-09-17T15:00:00Z"));
    await syncAutumnToD1(autumnSyncEnv(state), "org_1");
    const firstHaltedAt = state.haltedAt;
    expect(firstHaltedAt).toBe(1_789_657_200);

    vi.setSystemTime(new Date("2026-09-17T16:00:00Z"));
    await syncAutumnToD1(autumnSyncEnv(state), "org_1");
    expect(state.haltedAt).toBe(firstHaltedAt);

    creditsRemaining = 4;
    vi.setSystemTime(new Date("2026-09-17T17:00:00Z"));
    await syncAutumnToD1(autumnSyncEnv(state), "org_1");
    expect(state).toMatchObject({ isHalted: 0, haltedAt: null });

    creditsRemaining = 0;
    vi.setSystemTime(new Date("2026-09-17T18:00:00Z"));
    await syncAutumnToD1(autumnSyncEnv(state), "org_1");
    expect(state).toMatchObject({
      isHalted: 1,
      haltedAt: 1_789_668_000,
    });
  });

  it("repairs a halted projection whose timestamp is missing", async () => {
    vi.useFakeTimers();
    const state: ProjectedOrgState = {
      isHalted: 1,
      haltedAt: null,
      maxConcurrent: 50,
      updatedAt: 0,
    };
    mockAutumnCustomer();

    vi.setSystemTime(new Date("2026-09-17T15:00:00Z"));
    await syncAutumnToD1(autumnSyncEnv(state), "org_1");

    expect(state).toMatchObject({
      isHalted: 1,
      haltedAt: 1_789_657_200,
    });
  });
});

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
