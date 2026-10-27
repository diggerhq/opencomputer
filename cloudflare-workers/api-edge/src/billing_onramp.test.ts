import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeUsagePlan,
  billingLinks,
  billingWarningOf,
  emitPaywallShown,
  FREE_CREDITS_PAYWALL,
  insufficientCreditsLegacyResponse,
  insufficientCreditsResponse,
  lowCreditThresholdCents,
  USAGE_PLAN_OFFERS,
  usagePlanOffers,
} from "./billing_onramp";
import type { AutumnCustomer } from "./autumn_webhook";

const req = new Request("https://app.opencomputer.dev/api/v3/sessions");

describe("billing_onramp", () => {
  afterEach(() => vi.restoreAllMocks());

  it("low-credit threshold is 30% of the plan grant", () => {
    expect(lowCreditThresholdCents("base")).toBe(300);
    expect(lowCreditThresholdCents("pro")).toBe(6_000);
    expect(lowCreditThresholdCents("max")).toBe(60_000);
  });

  it("picks the highest active usage plan", () => {
    const customer = {
      subscriptions: [
        { plan_id: "pro", status: "active" },
        { plan_id: "max", status: "canceled" },
      ],
    } as unknown as AutumnCustomer;
    expect(activeUsagePlan(customer)).toBe("pro");
    expect(activeUsagePlan({} as AutumnCustomer)).toBe("base");
  });

  it("builds deep links off the request origin", () => {
    expect(billingLinks(req)).toEqual({
      billingUrl: "https://app.opencomputer.dev/billing",
      upgradeUrl: "https://app.opencomputer.dev/billing?plan=max",
    });
  });

  it("402 body carries a stable code, do-not-retry hint and upgrade url", async () => {
    const res = insufficientCreditsResponse(req);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.code).toBe("insufficient_credits");
    expect(body.error.message).toMatch(/do not retry/);
    expect(body.error.message).toContain("You've used your free credits.");
    expect(body.error.message).toContain(
      "upgrade to Pro ($200/mo) at https://app.opencomputer.dev/billing?plan=max",
    );
    expect(body.error.upgradeUrl).toBe("https://app.opencomputer.dev/billing?plan=max");
    expect(body.error.actionUrl).toBe("https://app.opencomputer.dev/billing?plan=max");
  });

  it("never offers top-ups or the retired $20 plan in any 402", async () => {
    for (const plan of [undefined, "base", "pro", "max"] as const) {
      const body = (await insufficientCreditsResponse(req, { plan }).json()) as {
        error: Record<string, string>;
      };
      expect(body.error.message).not.toMatch(/top.?up|\$20\b|plan=pro/i);
      expect(body.error.upgradeUrl).not.toContain("plan=pro");
    }
  });

  it("points a legacy $20 Pro org at the $200 Pro, and does not upsell a $200 Pro org", async () => {
    const legacy = (await insufficientCreditsResponse(req, { plan: "pro" }).json()) as {
      error: Record<string, string>;
    };
    expect(legacy.error.message).toContain("upgrade to Pro ($200/mo) at https://app.opencomputer.dev/billing?plan=max");
    const max = (await insufficientCreditsResponse(req, { plan: "max" }).json()) as {
      error: Record<string, string>;
    };
    expect(max.error.message).not.toMatch(/upgrade/i);
    expect(max.error.actionUrl).toBe("https://app.opencomputer.dev/billing");
  });

  it("offers only the $200 Pro, listing legacy Pro to its own subscribers", () => {
    expect(USAGE_PLAN_OFFERS).toEqual([{ id: "max", name: "Pro", priceUsd: 200, creditsUsd: 2_000 }]);
    expect(usagePlanOffers("base").map((p) => p.id)).toEqual(["max"]);
    expect(usagePlanOffers("max").map((p) => p.id)).toEqual(["max"]);
    expect(usagePlanOffers("pro").map((p) => [p.id, p.name])).toEqual([
      ["pro", "Pro (legacy)"],
      ["max", "Pro"],
    ]);
  });

  it("paywall copy names Pro and BYO subscriptions but not the grant amount", () => {
    expect(FREE_CREDITS_PAYWALL).toBe(
      "You've used your free credits. Upgrade to Pro ($200/mo) to keep going.",
    );
  });

  it("legacy sandbox 402 keeps `error` a string and adds structured fields", async () => {
    const res = insufficientCreditsLegacyResponse(req, { creditsRemainingCents: 0 });
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(body.code).toBe("insufficient_credits");
    expect(body.upgradeUrl).toBe("https://app.opencomputer.dev/billing?plan=max");
    expect(body.creditsRemainingCents).toBe(0);
  });

  it("402 names the work-minute halt reason, links Billing with no plan forced", async () => {
    const cases = {
      trial_days: "Your 7-day trial has ended. Ask the user to pick a plan",
      trial_minutes: "You've used your trial's 600 work minutes.",
      trial_tokens: "You've used your trial's model credit.",
      credits_empty: "buy credits or upgrade",
      payment: "update their payment method",
      lapsed: "Your plan has ended.",
    };
    for (const [haltReason, copy] of Object.entries(cases)) {
      for (const plan of ["base", "pro", "max"] as const) {
        const body = (await insufficientCreditsResponse(req, { plan, haltReason }).json()) as {
          error: Record<string, string>;
        };
        expect(body.error.code).toBe("insufficient_credits");
        expect(body.error.haltReason).toBe(haltReason);
        expect(body.error.message).toContain(copy);
        expect(body.error.message).toMatch(/at https:\/\/app\.opencomputer\.dev\/billing[ ;]/);
        expect(body.error.message).toMatch(/do not retry/);
        expect(body.error.message).not.toMatch(/top.?up|plan=/i);
        expect(body.error.actionUrl).toBe("https://app.opencomputer.dev/billing");
        // Old clients still find the upgrade link where they looked for it.
        expect(body.error.upgradeUrl).toBe("https://app.opencomputer.dev/billing?plan=max");
      }
    }
  });

  it("keeps the credit-rule copy for credits_exhausted and an unknown reason", async () => {
    const exhausted = (await insufficientCreditsResponse(req, { haltReason: "credits_exhausted" }).json()) as {
      error: Record<string, unknown>;
    };
    expect(exhausted.error.haltReason).toBe("credits_exhausted");
    expect(exhausted.error.message).toContain("You've used your free credits.");
    const unknown = (await insufficientCreditsResponse(req, { haltReason: "gold" }).json()) as {
      error: Record<string, unknown>;
    };
    expect(unknown.error.haltReason).toBeNull();
    expect(unknown.error.actionUrl).toBe("https://app.opencomputer.dev/billing?plan=max");
  });

  it("legacy sandbox 402 carries the halt reason flat", async () => {
    const body = (await insufficientCreditsLegacyResponse(req, {}, { haltReason: "payment" }).json()) as Record<
      string,
      unknown
    >;
    expect(body.haltReason).toBe("payment");
    expect(body.error).toContain("update their payment method at https://app.opencomputer.dev/billing");
    expect(body.actionUrl).toBe("https://app.opencomputer.dev/billing");
  });

  it("counts billing.paywall_shown once per org and reason within the hour", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const env = { POSTHOG_PROJECT_TOKEN: "phc_test" };
    await emitPaywallShown(env, "org_dedupe", "trial_minutes");
    await emitPaywallShown(env, "org_dedupe", "trial_minutes");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      event: "billing.paywall_shown",
      properties: { reason: "trial_minutes", surface: "api", org_id: "org_dedupe" },
    });
    await emitPaywallShown(env, "org_dedupe", "trial_days");
    await emitPaywallShown(env, "org_dedupe_2", null);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)).properties.reason).toBe("credits_exhausted");
  });

  it("reads only known billing warnings", () => {
    expect(billingWarningOf("allowance_80")).toBe("allowance_80");
    expect(billingWarningOf("payment_failed")).toBe("payment_failed");
    expect(billingWarningOf("soon")).toBeNull();
    expect(billingWarningOf(null)).toBeNull();
  });
});
