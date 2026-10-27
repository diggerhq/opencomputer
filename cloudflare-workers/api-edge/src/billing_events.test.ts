import { afterEach, describe, expect, it, vi } from "vitest";
import { emitBillingEvent } from "./billing_events";
import { planIntentOf } from "./index";

describe("billing funnel events", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends one event to Tinybird and PostHog under the same name", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await emitBillingEvent(
      {
        TINYBIRD_API_URL: "https://tb.test/",
        TINYBIRD_APPEND_TOKEN: "tb-token",
        POSTHOG_PROJECT_TOKEN: "phc_test",
      },
      "billing.trial_started",
      { orgId: "org_1", userId: "user_1", data: { plan_intent: null, via: "browser" } },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tbURL, tbInit] = fetchMock.mock.calls[0]!;
    expect(String(tbURL)).toBe("https://tb.test/v0/events?name=calvin_events&wait=false");
    const line = JSON.parse(String(tbInit?.body));
    expect(line).toMatchObject({ event_name: "billing.trial_started", service_name: "edge", org_id: "org_1" });
    expect(JSON.parse(line.data)).toEqual({ via: "browser" });
    const [phURL, phInit] = fetchMock.mock.calls[1]!;
    expect(String(phURL)).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(JSON.parse(String(phInit?.body))).toMatchObject({
      api_key: "phc_test",
      event: "billing.trial_started",
      distinct_id: "user_1",
      properties: { via: "browser", org_id: "org_1", $groups: { organization: "org_1" } },
    });
  });

  it("sends nothing unconfigured, and never throws", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    await emitBillingEvent({}, "billing.checkout_opened", { orgId: "org_1", data: {} });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      emitBillingEvent({ POSTHOG_PROJECT_TOKEN: "phc_test" }, "billing.checkout_opened", { orgId: "org_1", data: {} }),
    ).resolves.toBeUndefined();
  });

  it("reads the signup's plan intent from returnTo", () => {
    expect(planIntentOf("/?plan=pro")).toBe("pro");
    expect(planIntentOf("/billing?plan=max&x=1")).toBe("max");
    expect(planIntentOf("/?plan=gold")).toBeNull();
    expect(planIntentOf(null)).toBeNull();
  });
});
