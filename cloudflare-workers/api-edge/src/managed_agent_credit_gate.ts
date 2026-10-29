import { haltKeepsFallback, isPaidUsagePlan, TRIAL_DAYS } from "./autumn_webhook";
import type { BillingEventsEnv } from "./billing_events";
import { emitPaywallShown, insufficientCreditsResponse, type PaywallContext } from "./billing_onramp";

export interface ManagedAgentCreditGateEnv extends BillingEventsEnv {
  OPENCOMPUTER_DB: D1Database;
}

interface ManagedAgentCreditRow {
  is_halted: number;
  billing_provider: string | null;
  halted_at: number | null;
  usage_plan: string | null;
  plan: string | null;
  halt_reason: string | null;
  billing_warning?: string | null;
  billing_warning_at?: number | null;
  trial_started_at?: number | null;
}

// "full": the org's selected models. "fallback": credits are exhausted on a
// paid plan, so model calls run on the open-weight fallback model. null: the
// org is denied (base plan out of credits).
export type ManagedAgentModelAccess = "full" | "fallback";

// The Autumn usage plan: "max" ($200), "pro" ($20, being retired), "base"
// (free). null: no org row, or a value this edge does not know.
export type ManagedAgentUsagePlan = "base" | "pro" | "max";

export interface ManagedAgentBillingAdmission {
  allowed: boolean;
  isHalted: boolean;
  haltedAt: number | null;
  reason: "insufficient_credits" | null;
  paid: boolean;
  modelAccess: ManagedAgentModelAccess | null;
  /**
   * Additive (work 052): the computer sizes by it, and only "max" gets the
   * bigger VM. Same legacy rule as `paid`: a plan='pro' org still on the
   * 'base' default reads as "pro".
   */
  usagePlan: ManagedAgentUsagePlan | null;
  /**
   * Additive: why the org is halted (orgs.halt_reason, e.g. "trial_days",
   * "credits_empty", "payment"), so a paywall can say which limit was hit.
   * null when not halted.
   */
  haltReason: string | null;
  /**
   * Additive (086): the limit the org is about to hit (orgs.billing_warning:
   * "trial_minutes", "trial_days", "trial_tokens", "allowance_80",
   * "credits_low", "payment_failed"), so a surface can warn before the stop.
   * null when nothing is near or the org is halted.
   */
  warning: string | null;
  /**
   * When the current run of warnings began (orgs.billing_warning_at, unix
   * seconds). It holds while any warning stands, so (warning, warningSince)
   * names one warning to tell once.
   */
  warningSince: number | null;
  /**
   * Additive (serverless-agents-ws 092): when a free org's trial ends (unix
   * seconds, orgs.trial_started_at + TRIAL_DAYS), so its computer stays on
   * until then. null for a paid org or one with no trial; the time may be
   * past, and the halt rules decide whether the trial is over by minutes or
   * tokens sooner.
   */
  trialEndsAt: number | null;
}

function normalizedUsagePlan(
  row: ManagedAgentCreditRow | null,
): ManagedAgentUsagePlan | null {
  if (!row) return null;
  if (row.usage_plan === "pro" || row.usage_plan === "max") {
    return row.usage_plan;
  }
  if (row.plan === "pro") return "pro";
  return row.usage_plan === "base" || row.usage_plan === null ? "base" : null;
}

export function isManagedAgentBillableRequest(
  method: string,
  path: string,
): boolean {
  if (method.toUpperCase() !== "POST") return false;
  if (path === "/api/managed-agents/sessions") return true;
  return (
    /^\/api\/managed-agents\/sessions\/[^/]+\/(turns|resume)$/.test(path) ||
    /^\/api\/managed-agents\/schedules\/[^/]+\/run$/.test(path)
  );
}

// Re-checks Autumn's authoritative balance and re-projects D1 (selfHealHalt).
// Resolves to whether the org is still halted.
export type ManagedAgentSelfHeal = (orgID: string) => Promise<boolean>;

export async function isManagedAgentCreditHalted(
  env: ManagedAgentCreditGateEnv,
  orgID: string,
): Promise<boolean> {
  return (await getManagedAgentBillingAdmission(env, orgID)).isHalted;
}

export async function getManagedAgentBillingAdmission(
  env: ManagedAgentCreditGateEnv,
  orgID: string,
  selfHeal?: ManagedAgentSelfHeal,
): Promise<ManagedAgentBillingAdmission> {
  const readRow = () =>
    env.OPENCOMPUTER_DB.prepare(
      `SELECT is_halted, halted_at, usage_plan, plan, billing_provider, halt_reason, billing_warning, billing_warning_at, trial_started_at
         FROM orgs WHERE id = ?1`,
    )
      .bind(orgID)
      .first<ManagedAgentCreditRow>();
  let row = await readRow();
  let isHalted = row?.is_halted === 1;
  // Like the sandbox create/wake gates: a halted Autumn org re-checks the
  // authoritative balance, so a user who just topped up isn't denied until
  // the webhook/reconciler catches up.
  if (isHalted && row?.billing_provider === "autumn" && selfHeal) {
    isHalted = await selfHeal(orgID);
    // The re-check re-projects halt_reason/usage_plan; a still-halted org's
    // 402 must name the current reason, not the pre-heal one.
    if (isHalted) row = (await readRow()) ?? row;
  }
  // Existing paid orgs predate usage_plan and initially carry its conservative
  // 'base' default. Keep their established Pro entitlement effective until an
  // Autumn projection refines usage_plan to the authoritative pro/max value.
  const paid = isPaidUsagePlan(row?.usage_plan) || row?.plan === "pro";
  // Only a credit-rule halt keeps a paid org on the fallback model; a
  // work-minute halt (trial over, allowance and credits used, payment, lapsed)
  // stops it like any other org.
  const fallback = paid && haltKeepsFallback(row?.halt_reason);
  const allowed = !isHalted || fallback;
  return {
    allowed,
    isHalted,
    haltedAt: isHalted ? row?.halted_at ?? null : null,
    reason: allowed ? null : "insufficient_credits",
    paid,
    modelAccess: !isHalted ? "full" : fallback ? "fallback" : null,
    usagePlan: normalizedUsagePlan(row),
    haltReason: isHalted ? row?.halt_reason ?? "credits_exhausted" : null,
    warning: isHalted ? null : row?.billing_warning ?? null,
    warningSince: isHalted || !row?.billing_warning ? null : row.billing_warning_at ?? null,
    trialEndsAt: !paid && row?.trial_started_at != null ? row.trial_started_at + TRIAL_DAYS * 86_400 : null,
  };
}

export function insufficientManagedAgentCredits(request: Request, paywall: PaywallContext = {}): Response {
  return insufficientCreditsResponse(request, paywall);
}

export async function enforceManagedAgentCreditGate(
  request: Request,
  env: ManagedAgentCreditGateEnv,
  orgID: string,
  selfHeal?: ManagedAgentSelfHeal,
  waitUntil: (p: Promise<unknown>) => void = () => {},
): Promise<Response | null> {
  if (!isManagedAgentBillableRequest(request.method, new URL(request.url).pathname)) {
    return null;
  }
  try {
    const admission = await getManagedAgentBillingAdmission(env, orgID, selfHeal);
    if (admission.allowed) return null;
    waitUntil(emitPaywallShown(env, orgID, admission.haltReason));
    return insufficientManagedAgentCredits(request, {
      plan: admission.usagePlan,
      haltReason: admission.haltReason,
    });
  } catch (error) {
    // D1 is the low-latency projection, not the financial authority. Preserve
    // availability and rely on the provider key limit as the hard backstop.
    console.error(
      `managed-agents: credit admission unavailable org=${orgID}`,
      error,
    );
    return null;
  }
}
