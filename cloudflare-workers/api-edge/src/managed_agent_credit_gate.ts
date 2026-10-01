import { isPaidUsagePlan } from "./autumn_webhook";
import { insufficientCreditsResponse } from "./billing_onramp";

export interface ManagedAgentCreditGateEnv {
  OPENCOMPUTER_DB: D1Database;
}

interface ManagedAgentCreditRow {
  is_halted: number;
  halted_at: number | null;
  usage_plan: string | null;
  plan: string | null;
}

// "full": the org's selected models. "fallback": credits are exhausted on a
// paid plan, so model calls run on the open-weight fallback model. null: the
// org is denied (base plan out of credits).
export type ManagedAgentModelAccess = "full" | "fallback";

export interface ManagedAgentBillingAdmission {
  allowed: boolean;
  isHalted: boolean;
  haltedAt: number | null;
  reason: "insufficient_credits" | null;
  paid: boolean;
  modelAccess: ManagedAgentModelAccess | null;
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

export async function isManagedAgentCreditHalted(
  env: ManagedAgentCreditGateEnv,
  orgID: string,
): Promise<boolean> {
  return (await getManagedAgentBillingAdmission(env, orgID)).isHalted;
}

export async function getManagedAgentBillingAdmission(
  env: ManagedAgentCreditGateEnv,
  orgID: string,
): Promise<ManagedAgentBillingAdmission> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT is_halted, halted_at, usage_plan, plan FROM orgs WHERE id = ?1",
  )
    .bind(orgID)
    .first<ManagedAgentCreditRow>();
  const isHalted = row?.is_halted === 1;
  // Existing paid orgs predate usage_plan and initially carry its conservative
  // 'base' default. Keep their established Pro entitlement effective until an
  // Autumn projection refines usage_plan to the authoritative pro/max value.
  const paid = isPaidUsagePlan(row?.usage_plan) || row?.plan === "pro";
  const allowed = !isHalted || paid;
  return {
    allowed,
    isHalted,
    haltedAt: row?.halted_at ?? null,
    reason: allowed ? null : "insufficient_credits",
    paid,
    modelAccess: !isHalted ? "full" : paid ? "fallback" : null,
  };
}

export function insufficientManagedAgentCredits(request: Request): Response {
  return insufficientCreditsResponse(request);
}

export async function enforceManagedAgentCreditGate(
  request: Request,
  env: ManagedAgentCreditGateEnv,
  orgID: string,
): Promise<Response | null> {
  if (!isManagedAgentBillableRequest(request.method, new URL(request.url).pathname)) {
    return null;
  }
  try {
    return (await getManagedAgentBillingAdmission(env, orgID)).allowed
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
