import { describe, expect, it } from "vitest";
import {
  activeUsagePlan,
  billingLinks,
  insufficientCreditsLegacyResponse,
  insufficientCreditsResponse,
  lowCreditThresholdCents,
} from "./billing_onramp";
import type { AutumnCustomer } from "./autumn_webhook";

const req = new Request("https://app.opencomputer.dev/api/v3/sessions");

describe("billing_onramp", () => {
  it("low-credit threshold is 30% of the plan grant", () => {
    expect(lowCreditThresholdCents("base")).toBe(150);
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
    expect(billingLinks(req, "max")).toEqual({
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
    expect(body.error.upgradeUrl).toBe("https://app.opencomputer.dev/billing?plan=pro");
    expect(body.error.actionUrl).toBe("https://app.opencomputer.dev/billing");
  });

  it("legacy sandbox 402 keeps `error` a string and adds structured fields", async () => {
    const res = insufficientCreditsLegacyResponse(req, { creditsRemainingCents: 0 });
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(body.code).toBe("insufficient_credits");
    expect(body.upgradeUrl).toBe("https://app.opencomputer.dev/billing?plan=pro");
    expect(body.creditsRemainingCents).toBe(0);
  });
});
