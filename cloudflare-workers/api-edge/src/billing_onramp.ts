// Billing on-ramp surface shared by the CLI / SDK error paths and the
// `GET /api/billing/credits` status endpoint. Everything an agent-driven client
// (Claude / Codex running the CLI) needs to steer the human to payment lives
// here: a stable error code, a checkout deep link, and a low-balance signal
// that fires before the hard stop.

import {
  type AutumnCustomer,
  type AutumnSyncEnv,
  syncAutumnToD1,
} from "./autumn_webhook";

export type UsagePlan = "base" | "pro" | "max";

// Mirror of PLAN_CREDIT_GRANTS in autumn_webhook.ts (dollars). The base grant is
// the signup credit; low-balance fires at LOW_CREDIT_FRACTION of the plan grant.
const PLAN_GRANT_CENTS: Record<UsagePlan, number> = {
  base: 500,
  pro: 20_000,
  max: 200_000,
};
const LOW_CREDIT_FRACTION = 0.3;

const USAGE_PLAN_RANK: Record<string, number> = { base: 0, pro: 1, max: 2 };

export function lowCreditThresholdCents(plan: UsagePlan): number {
  return Math.round(PLAN_GRANT_CENTS[plan] * LOW_CREDIT_FRACTION);
}

export function activeUsagePlan(customer: AutumnCustomer): UsagePlan {
  let plan: UsagePlan = "base";
  let rank = 0;
  for (const s of customer.subscriptions ?? []) {
    if (s.status && s.status !== "active") continue;
    const r = USAGE_PLAN_RANK[s.plan_id];
    if (r !== undefined && r >= rank) {
      rank = r;
      plan = s.plan_id as UsagePlan;
    }
  }
  return plan;
}

export interface BillingLinks {
  billingUrl: string;
  upgradeUrl: string;
}

export function billingLinks(request: Request, plan: "pro" | "max" = "pro"): BillingLinks {
  const origin = new URL(request.url).origin;
  return {
    billingUrl: `${origin}/billing`,
    upgradeUrl: `${origin}/billing?plan=${plan}`,
  };
}

// The 402 body every credit gate returns. `error` is an object (code/message)
// for the managed-agents API; sandbox routes historically used a string
// `error`, so callers there spread `legacyStringError()` instead.
export function insufficientCreditsError(request: Request) {
  const links = billingLinks(request);
  return {
    code: "insufficient_credits" as const,
    message:
      `Out of prepaid credits. Ask the user to upgrade to Pro ($20/mo, $200 credits) at ${links.upgradeUrl} ` +
      `or top up at ${links.billingUrl}; do not retry until they have.`,
    actionUrl: links.billingUrl,
    ...links,
  };
}

export function insufficientCreditsResponse(request: Request): Response {
  return Response.json({ error: insufficientCreditsError(request) }, { status: 402 });
}

// Sandbox-route flavour: keeps `error` a string (the `oc` Go CLI prints it
// verbatim) while adding the structured fields alongside for newer clients.
export function insufficientCreditsLegacyResponse(
  request: Request,
  extra: Record<string, unknown> = {},
): Response {
  const e = insufficientCreditsError(request);
  return Response.json(
    {
      error: e.message,
      code: e.code,
      actionUrl: e.actionUrl,
      billingUrl: e.billingUrl,
      upgradeUrl: e.upgradeUrl,
      ...extra,
    },
    { status: 402 },
  );
}

export interface CreditsStatus {
  usagePlan: UsagePlan;
  creditsRemainingCents: number;
  lowCreditThresholdCents: number;
  isLow: boolean;
  isHalted: boolean;
  billingUrl: string;
  upgradeUrl: string;
  plans: Array<{ id: "pro" | "max"; priceUsd: number; creditsUsd: number }>;
}

export const USAGE_PLAN_OFFERS: CreditsStatus["plans"] = [
  { id: "pro", priceUsd: 20, creditsUsd: 200 },
  { id: "max", priceUsd: 200, creditsUsd: 2_000 },
];

// GET /api/billing/credits — API-key authenticated credit status for the CLI.
// Re-syncs Autumn → D1 like the dashboard endpoint so a fresh top-up clears a
// halt on the next CLI call too. Legacy (Stripe) orgs have no Autumn customer
// and get a 404 — clients treat that as "no credit meter".
export async function handleCreditsStatus(
  req: Request,
  env: AutumnSyncEnv & { AUTUMN_SECRET_KEY?: string },
  caller: { orgID: string },
): Promise<Response> {
  if (!env.AUTUMN_SECRET_KEY) {
    return Response.json({ error: "autumn billing not configured" }, { status: 503 });
  }
  let r;
  try {
    r = await syncAutumnToD1(env as AutumnSyncEnv, caller.orgID);
  } catch (e) {
    console.error("billing/credits sync:", e);
    return Response.json({ error: "autumn unavailable" }, { status: 502 });
  }
  if (!r) return Response.json({ error: "no autumn customer for org" }, { status: 404 });
  const usagePlan = activeUsagePlan(r.customer);
  const creditsRemainingCents = Math.max(0, Math.round(r.creditsRemaining * 100));
  const threshold = lowCreditThresholdCents(usagePlan);
  const links = billingLinks(req, usagePlan === "pro" ? "max" : "pro");
  const status: CreditsStatus = {
    usagePlan,
    creditsRemainingCents,
    lowCreditThresholdCents: threshold,
    isLow: !r.halted && creditsRemainingCents <= threshold,
    isHalted: r.halted,
    ...links,
    plans: USAGE_PLAN_OFFERS,
  };
  return Response.json(status);
}
