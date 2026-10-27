import { haltKeepsFallback, isPaidUsagePlan } from "./autumn_webhook";
import { insufficientCreditsResponse } from "./billing_onramp";

export interface ManagedAgentCreditGateEnv {
  OPENCOMPUTER_DB: D1Database;
}

interface ManagedAgentCreditRow {
  is_halted: number;
  billing_provider: string | null;
  halted_at: number | null;
  usage_plan: string | null;
  plan: string | null;
  halt_reason: string | null;
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
  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT is_halted, halted_at, usage_plan, plan, billing_provider, halt_reason FROM orgs WHERE id = ?1",
  )
    .bind(orgID)
    .first<ManagedAgentCreditRow>();
  let isHalted = row?.is_halted === 1;
  // Like the sandbox create/wake gates: a halted Autumn org re-checks the
  // authoritative balance, so a user who just topped up isn't denied until
  // the webhook/reconciler catches up.
  if (isHalted && row?.billing_provider === "autumn" && selfHeal) {
    isHalted = await selfHeal(orgID);
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
  };
}

export function insufficientManagedAgentCredits(request: Request): Response {
  return insufficientCreditsResponse(request);
}

export async function enforceManagedAgentCreditGate(
  request: Request,
  env: ManagedAgentCreditGateEnv,
  orgID: string,
  selfHeal?: ManagedAgentSelfHeal,
): Promise<Response | null> {
  if (!isManagedAgentBillableRequest(request.method, new URL(request.url).pathname)) {
    return null;
  }
  try {
    return (await getManagedAgentBillingAdmission(env, orgID, selfHeal)).allowed
      ? null
      : insufficientManagedAgentCredits(request);
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
