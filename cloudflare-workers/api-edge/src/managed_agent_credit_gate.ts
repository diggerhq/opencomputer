export interface ManagedAgentCreditGateEnv {
  OPENCOMPUTER_DB: D1Database;
}

interface ManagedAgentCreditRow {
  is_halted: number;
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
  const row = await env.OPENCOMPUTER_DB.prepare(
    "SELECT is_halted FROM orgs WHERE id = ?1",
  )
    .bind(orgID)
    .first<ManagedAgentCreditRow>();
  return row?.is_halted === 1;
}

export function insufficientManagedAgentCredits(request: Request): Response {
  const billingURL = new URL("/billing", request.url).toString();
  return Response.json(
    {
      error: {
        code: "insufficient_credits",
        message:
          `Insufficient prepaid credits. Top up or enable automatic top-up: ${billingURL}`,
        actionUrl: billingURL,
      },
    },
    { status: 402 },
  );
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
    return (await isManagedAgentCreditHalted(env, orgID))
      ? insufficientManagedAgentCredits(request)
      : null;
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
