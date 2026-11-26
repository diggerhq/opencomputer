// The credit gate in front of the computer (work 052): before a turn wakes
// or is delivered to the computer, the organization passes the same admission
// bluecode runs for autonomous serverless agent sessions
// (src/edge/billing-admission.ts, the public edge's billing projection through
// the OPENCOMPUTER_BILLING binding). A computer session spends runtime and
// model credits exactly like one, so it is admitted exactly like one.
//
//   - denied (a halted free organization: insufficient credits) or allowed
//     with `modelAccess: "fallback"` (a halted paid organization): the
//     message is not delivered; its thread is owed the paywall (Slack's
//     billing-notices.ts). Serverless agents move a halted paid organization's model
//     calls to the open-weight fallback model; Claude Code on the computer
//     cannot, and its capped key would only fail the turn, so every
//     organization out of credits hits the same paywall
//     (2026-10-15: "when you run out it should make you hit a paywall in
//     slack");
//   - no binding (development): allowed;
//   - billing unavailable: throws, and the owed drain retries the message.

import {
  AutonomousBillingAdmissionError,
  type AutonomousBillingEnv,
  autonomousBillingAdmission,
} from "../../edge/billing-admission.js";

/** The warning standing when billing last answered: its reason, and when the run of warnings it belongs to began. */
export type BillingWarning = { reason: string; since: number | null };

/** Refused: `onPro` when the organization is on the $200 plan ("max"); `haltReason` as billing says. Admitted: `warning` when a limit is near. */
export type DeliveryAdmission = { deliver: boolean; onPro?: boolean; haltReason?: string | null; warning?: BillingWarning };

export async function admitDelivery(env: AutonomousBillingEnv, organizationId: string): Promise<DeliveryAdmission> {
  try {
    const admission = await autonomousBillingAdmission(env, organizationId);
    if (admission?.modelAccess === "fallback") {
      console.log(JSON.stringify({ level: "warn", event: "computer.admission_denied_halted_paid", orgId: organizationId }));
      return { deliver: false, onPro: admission.usagePlan === "max", haltReason: admission.haltReason ?? null };
    }
    return admission?.warning ? { deliver: true, warning: { reason: admission.warning, since: admission.warningSince ?? null } } : { deliver: true };
  } catch (error) {
    if (error instanceof AutonomousBillingAdmissionError && error.code === "insufficient_credits") {
      return { deliver: false, haltReason: error.haltReason };
    }
    throw error;
  }
}

/** On the $200 plan ("max"), for the notice. Billing refusing or unavailable reads as free. */
export async function onProPlan(env: AutonomousBillingEnv, organizationId: string): Promise<boolean> {
  return (await refusal(env, organizationId)).onPro === true;
}

/** What a turn refused mid-flight tells the thread: the plan and why billing halted it, when it says. */
export async function refusal(env: AutonomousBillingEnv, organizationId: string): Promise<{ onPro: boolean; haltReason: string | null }> {
  try {
    const admission = await autonomousBillingAdmission(env, organizationId);
    return { onPro: admission?.usagePlan === "max", haltReason: admission?.haltReason ?? null };
  } catch (error) {
    return { onPro: false, haltReason: error instanceof AutonomousBillingAdmissionError ? error.haltReason : null };
  }
}
