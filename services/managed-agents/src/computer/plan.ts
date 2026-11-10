// An organization's plan, for the computer (work 052, decision 10): "paid"
// computers stay on, "free" ones park when idle, except during their trial
// (work 092), which `trialEndsAt` bounds.
//
// Source: the public edge's billing service (OPENCOMPUTER_BILLING binding,
// `checkAdmission(orgId).paid`, "Pro/Max"), the same projection managed
// inference uses to pick a paid organization's model. When it cannot answer
// (no binding in development, a billing service that predates `paid`, or an
// error) the plan is "paid": a wrongly parked computer costs a customer a
// cold start, a wrongly running one costs us a few hours of VM.

import type { ManagedAgentBillingService } from "../edge/billing-admission.js";

//
// The VM size follows the usage plan, not `paid` (2026-10-13): only
// the $200 plan ("max") gets the bigger size (COMPUTER_MAX_SIZE); Pro and
// free get the default. `usagePlan` is null when the billing service does
// not say (one that predates the field, or no answer): the computer is never
// resized on that.

export type ComputerPlan = "free" | "paid";
export type UsagePlan = "base" | "pro" | "max";
export type SizeTier = "max" | "default";

export interface ResolvedPlan {
  plan: ComputerPlan;
  /** Whether billing said `paid`. */
  known: boolean;
  /** The usage plan, or null when billing did not say (never resize then). */
  usagePlan: UsagePlan | null;
  /**
   * Since when billing refuses the organization (epoch ms): halted and not on
   * the fallback model (work 086, unpaid computers). Null when admitted, or
   * when billing did not say.
   */
  haltedAt: number | null;
  /** When a free organization's trial ends (epoch ms, may be past); null when paid, no trial, or billing did not say. */
  trialEndsAt: number | null;
}

/** The size tier a usage plan gets; null when the usage plan is unknown. */
export function sizeTier(usagePlan: UsagePlan | null): SizeTier | null {
  if (usagePlan === null) return null;
  return usagePlan === "max" ? "max" : "default";
}

function usagePlanOf(value: unknown): UsagePlan | null {
  return value === "base" || value === "pro" || value === "max" ? value : null;
}

export async function resolvePlan(
  billing: ManagedAgentBillingService | undefined,
  organizationId: string,
): Promise<ResolvedPlan> {
  if (!billing) return { plan: "paid", known: false, usagePlan: null, haltedAt: null, trialEndsAt: null };
  try {
    const admission = await billing.checkAdmission(organizationId);
    // `usagePlan: null` from a service that knows the field: no plan, the free size.
    const usagePlan = admission.usagePlan === null ? "base" : usagePlanOf(admission.usagePlan);
    // The edge's orgs.halted_at is in seconds.
    const haltedAt = !admission.allowed && typeof admission.haltedAt === "number" ? admission.haltedAt * 1000 : null;
    // The edge's trial end is in seconds too.
    const trialEndsAt = typeof admission.trialEndsAt === "number" ? admission.trialEndsAt * 1000 : null;
    if (typeof admission.paid !== "boolean") return { plan: "paid", known: false, usagePlan, haltedAt, trialEndsAt };
    return { plan: admission.paid ? "paid" : "free", known: true, usagePlan, haltedAt, trialEndsAt };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "computer.plan_unavailable",
        orgId: organizationId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { plan: "paid", known: false, usagePlan: null, haltedAt: null, trialEndsAt: null };
  }
}
