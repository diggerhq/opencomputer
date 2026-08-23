import { afterEach, describe, expect, it, vi } from "vitest";
import { autumnSetAutoTopup, type AutumnApiEnv } from "./autumn_webhook";

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
