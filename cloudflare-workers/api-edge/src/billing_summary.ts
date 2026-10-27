// What the dashboard shows of an org's work-minute plan (serverless-agents-ws
// 086, "Surfaces"): the plan by name (the trial included), the minute pool, and
// a plan change Autumn has scheduled for the end of the period. Read from the
// Autumn customer the Billing endpoint already loads; no extra calls.

import { activeUsagePlan, TRIAL_DAYS, type AutumnCustomer } from "./autumn_webhook";

const WORK_MINUTES_FEATURE_ID = "work_minutes";
const DAY_MS = 86_400_000;

// `base` stays until every pre-launch free org is migrated to the trial (step 8).
export type DashboardUsagePlan = "trial" | "base" | "pro" | "max";

export interface WorkMinutes {
  granted: number;
  remaining: number;
  resetsAt: string | null;
}

// A change that takes effect at the end of the paid period: the $200 → $20
// downgrade, or a cancellation.
export interface ScheduledPlanChange {
  to: "pro" | "cancel";
  at: string | null;
}

export interface WorkMinutePlanSummary {
  usagePlan: DashboardUsagePlan;
  workMinutes: WorkMinutes | null;
  periodEndsAt: string | null;
  scheduledChange: ScheduledPlanChange | null;
}

function isLive(status: string | undefined): boolean {
  return !status || status === "active";
}

// Autumn reports times in milliseconds; older payloads used seconds.
function iso(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value < 1e12 ? value * 1_000 : value).toISOString();
}

export function summarizeWorkMinutePlan(customer: AutumnCustomer): WorkMinutePlanSummary {
  const subs = customer.subscriptions ?? [];
  const paid = activeUsagePlan(customer);
  const onTrial = subs.some((s) => s.plan_id === "trial" && isLive(s.status));
  const usagePlan: DashboardUsagePlan = paid === "base" && onTrial ? "trial" : paid;

  const balance = customer.balances?.[WORK_MINUTES_FEATURE_ID];
  const workMinutes = balance
    ? {
        granted: Math.max(0, Math.round(balance.granted ?? 0)),
        // Shown as whole minutes; overage draws credits, so never below zero.
        remaining: Math.max(0, Math.floor(balance.remaining ?? 0)),
        resetsAt: iso(balance.next_reset_at),
      }
    : null;

  const current = subs.find((s) => s.plan_id === paid && isLive(s.status));
  const periodEndsAt = paid === "base" ? null : iso(current?.current_period_end);
  let scheduledChange: ScheduledPlanChange | null = null;
  if (current?.canceled_at != null) {
    scheduledChange = { to: "cancel", at: periodEndsAt };
  } else if (paid === "max" && subs.some((s) => s.plan_id === "pro" && s.status === "scheduled")) {
    scheduledChange = { to: "pro", at: periodEndsAt };
  }

  return { usagePlan, workMinutes, periodEndsAt, scheduledChange };
}

// The day the trial ends, from orgs.trial_started_at (seconds).
export function trialEndsAt(trialStartedAtSec: number | null | undefined): string | null {
  if (trialStartedAtSec == null) return null;
  return new Date(trialStartedAtSec * 1_000 + TRIAL_DAYS * DAY_MS).toISOString();
}

// Upgrades apply now (086 "Plan changes"); $200 → $20 waits for the period end.
export function planSchedule(
  current: DashboardUsagePlan,
  target: "pro" | "max",
): "immediate" | "end_of_cycle" {
  return current === "max" && target === "pro" ? "end_of_cycle" : "immediate";
}
