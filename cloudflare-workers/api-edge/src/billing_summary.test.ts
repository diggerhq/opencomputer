import { describe, expect, it } from "vitest";
import type { AutumnCustomer } from "./autumn_webhook";
import { planSchedule, summarizeWorkMinutePlan, trialEndsAt } from "./billing_summary";

const customer = (c: Partial<AutumnCustomer>) => ({ id: "org_1", ...c }) as AutumnCustomer;

describe("summarizeWorkMinutePlan", () => {
  it("names the trial, which activeUsagePlan reads as base", () => {
    const s = summarizeWorkMinutePlan(
      customer({
        subscriptions: [{ plan_id: "trial", add_on: false, status: "active" }],
        balances: { work_minutes: { granted: 600, remaining: 411.6, next_reset_at: null } },
      }),
    );
    expect(s.usagePlan).toBe("trial");
    expect(s.workMinutes).toEqual({ granted: 600, remaining: 411, resetsAt: null });
    expect(s.periodEndsAt).toBeNull();
    expect(s.scheduledChange).toBeNull();
  });

  it("keeps base for a pre-launch free org", () => {
    const s = summarizeWorkMinutePlan(customer({ subscriptions: [{ plan_id: "base", add_on: false, status: "active" }] }));
    expect(s.usagePlan).toBe("base");
    expect(s.workMinutes).toBeNull();
  });

  it("reports the minute pool and its reset, never below zero", () => {
    const s = summarizeWorkMinutePlan(
      customer({
        subscriptions: [{ plan_id: "pro", add_on: false, status: "active", current_period_end: 1_793_000_000_000 }],
        balances: { work_minutes: { granted: 2_000, remaining: -30, next_reset_at: 1_793_000_000_000 } },
      }),
    );
    expect(s.usagePlan).toBe("pro");
    expect(s.workMinutes).toEqual({ granted: 2_000, remaining: 0, resetsAt: new Date(1_793_000_000_000).toISOString() });
    expect(s.periodEndsAt).toBe(new Date(1_793_000_000_000).toISOString());
  });

  it("shows a scheduled $200 → $20 downgrade with the period end", () => {
    const s = summarizeWorkMinutePlan(
      customer({
        subscriptions: [
          { plan_id: "max", add_on: false, status: "active", current_period_end: 1_793_000_000 },
          { plan_id: "pro", add_on: false, status: "scheduled" },
        ],
      }),
    );
    expect(s.usagePlan).toBe("max");
    expect(s.scheduledChange).toEqual({ to: "pro", at: new Date(1_793_000_000_000).toISOString() });
  });

  it("shows a cancellation at the period end", () => {
    const s = summarizeWorkMinutePlan(
      customer({
        subscriptions: [
          { plan_id: "pro", add_on: false, status: "active", canceled_at: 1_792_000_000_000, current_period_end: 1_793_000_000_000 },
        ],
      }),
    );
    expect(s.scheduledChange).toEqual({ to: "cancel", at: new Date(1_793_000_000_000).toISOString() });
  });
});

describe("plan changes", () => {
  it("downgrades $200 → $20 at the period end and applies everything else now", () => {
    expect(planSchedule("max", "pro")).toBe("end_of_cycle");
    expect(planSchedule("pro", "max")).toBe("immediate");
    expect(planSchedule("trial", "pro")).toBe("immediate");
    expect(planSchedule("trial", "max")).toBe("immediate");
  });

  it("ends the trial three days after it starts", () => {
    expect(trialEndsAt(1_790_000_000)).toBe(new Date((1_790_000_000 + 3 * 86_400) * 1_000).toISOString());
    expect(trialEndsAt(null)).toBeNull();
  });
});
