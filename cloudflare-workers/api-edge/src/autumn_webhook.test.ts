import { afterEach, describe, expect, it, vi } from "vitest";
import { autumnPurchase, autumnSetAutoTopup, type AutumnApiEnv } from "./autumn_webhook";

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
