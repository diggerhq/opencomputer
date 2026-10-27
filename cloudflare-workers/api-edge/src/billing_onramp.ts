// Billing on-ramp surface shared by the CLI / SDK error paths and the
// `GET /api/billing/credits` status endpoint. Everything an agent-driven client
// (Claude / Codex running the CLI) needs to steer the human to payment lives
// here: a stable error code, a checkout deep link, and a low-balance signal
// that fires before the hard stop.

import {
  activeUsagePlan,
  type AutumnSyncEnv,
  type HaltReason,
  syncAutumnToD1,
  type UsagePlan,
  WORK_MINUTES_FEATURE_ID,
} from "./autumn_webhook";
import { emitBillingEvent, type BillingEventsEnv } from "./billing_events";
import { coloGet, coloPut } from "./colo_cache";

export { activeUsagePlan, type UsagePlan };

// Mirror of PLAN_CREDIT_GRANTS in autumn_webhook.ts (dollars). The base grant is
// the signup credit; low-balance fires at LOW_CREDIT_FRACTION of the plan grant.
const PLAN_GRANT_CENTS: Record<UsagePlan, number> = {
  base: 1_000,
  pro: 20_000,
  max: 200_000,
};
const LOW_CREDIT_FRACTION = 0.3;

export function lowCreditThresholdCents(plan: UsagePlan): number {
  return Math.round(PLAN_GRANT_CENTS[plan] * LOW_CREDIT_FRACTION);
}

export interface BillingLinks {
  billingUrl: string;
  upgradeUrl: string;
}

// The one plan new customers can buy. Its Autumn id stays `max` (no Stripe
// migration); it is displayed as "Pro". The old $20/mo plan (Autumn id `pro`)
// is retired for new customers and shown as "Pro (legacy)" to its existing
// subscribers only, so nothing here ever links to it. Top-ups are no longer
// sold either.
export const UPGRADE_PLAN = "max" as const;
export const UPGRADE_PLAN_PRICE_USD = 200;
export const PLAN_DISPLAY_NAMES: Record<UsagePlan, string> = {
  base: "Free",
  pro: "Pro (legacy)",
  max: "Pro",
};

// The free-tier paywall copy, shared by every surface. It does not state the
// grant amount: that is still $5 today and changes in a later step.
export const FREE_CREDITS_PAYWALL =
  `You've used your free credits. Upgrade to Pro ($${UPGRADE_PLAN_PRICE_USD}/mo) to keep going.`;

export function billingLinks(request: Request): BillingLinks {
  const origin = new URL(request.url).origin;
  return {
    billingUrl: `${origin}/billing`,
    upgradeUrl: `${origin}/billing?plan=${UPGRADE_PLAN}`,
  };
}

// Agent-facing paywall by orgs.halt_reason (serverless-agents-ws 086). Every
// work-minute halt points at the Billing page with no plan forced: the trial
// and lapsed orgs pick a plan there, a paid org buys credits or upgrades, and a
// failed payment updates its card. Wording follows blue's Slack paywall
// (src/computer/admission.ts outOfCreditsNotice).
const WORK_MINUTE_PAYWALL: Record<Exclude<HaltReason, "credits_exhausted">, (billingUrl: string) => string> = {
  trial_days: (u) => `Your 7-day trial has ended. Ask the user to pick a plan at ${u} to keep going`,
  trial_minutes: (u) => `You've used your trial's 600 work minutes. Ask the user to pick a plan at ${u} to keep going`,
  trial_tokens: (u) => `You've used your trial's model credit. Ask the user to pick a plan at ${u} to keep going`,
  credits_empty: (u) =>
    `You've used this month's work minutes and your credits. Ask the user to buy credits or upgrade at ${u} to keep going`,
  payment: (u) => `The last payment didn't go through. Ask the user to update their payment method at ${u}`,
  lapsed: (u) => `Your plan has ended. Ask the user to pick a plan at ${u} to keep going`,
};

/** A known work-minute halt reason, or null (the credit rule, or unknown). */
export function workMinuteHaltReason(reason: string | null | undefined): Exclude<HaltReason, "credits_exhausted"> | null {
  return reason && Object.hasOwn(WORK_MINUTE_PAYWALL, reason)
    ? (reason as Exclude<HaltReason, "credits_exhausted">)
    : null;
}

// Out-of-credits message for an org halted on the credit rule (no halt_reason
// yet, or "credits_exhausted"). Free (and unknown/legacy) orgs get the
// paywall; a legacy $20 Pro org is pointed at the same Pro upgrade; a $200 Pro
// org keeps its current halt but is never offered a top-up.
export function insufficientCreditsMessage(
  links: BillingLinks,
  plan?: UsagePlan | null,
  reason?: string | null,
): string {
  const minuteReason = workMinuteHaltReason(reason);
  if (minuteReason) {
    return `${WORK_MINUTE_PAYWALL[minuteReason](links.billingUrl)}; do not retry until they have.`;
  }
  if (plan === "max") {
    return (
      "You've used this month's Pro credits. They renew at the start of the next billing period; " +
      `the user can review billing at ${links.billingUrl}. Do not retry until credits renew.`
    );
  }
  if (plan === "pro") {
    return (
      `You've used this month's credits. Ask the user to upgrade to Pro ($${UPGRADE_PLAN_PRICE_USD}/mo) at ${links.upgradeUrl} ` +
      "to keep going; do not retry until they have."
    );
  }
  return (
    `You've used your free credits. Ask the user to upgrade to Pro ($${UPGRADE_PLAN_PRICE_USD}/mo) at ${links.upgradeUrl} ` +
    "to keep going; do not retry until they have."
  );
}

/** What a 402 needs to know about the org: its plan and why it is halted. */
export interface PaywallContext {
  plan?: UsagePlan | null;
  // orgs.halt_reason. null/undefined: halted before halt_reason existed, or a
  // legacy (non-Autumn) org; the 402 keeps the credit-rule copy.
  haltReason?: string | null;
}

// The 402 body every credit gate returns. `error` is an object (code/message)
// for the managed-agents API; sandbox routes historically used a string
// `error`, so callers there spread `legacyStringError()` instead. `haltReason`
// is additive: clients that know it render the paywall by reason; older ones
// keep reading `code`, `message` and `actionUrl`.
export function insufficientCreditsError(request: Request, paywall: PaywallContext = {}) {
  const links = billingLinks(request);
  const { plan, haltReason } = paywall;
  const minuteReason = workMinuteHaltReason(haltReason);
  return {
    code: "insufficient_credits" as const,
    message: insufficientCreditsMessage(links, plan, haltReason),
    haltReason: minuteReason ?? (haltReason === "credits_exhausted" ? haltReason : null),
    actionUrl: minuteReason || plan === "max" ? links.billingUrl : links.upgradeUrl,
    ...links,
  };
}

export function insufficientCreditsResponse(request: Request, paywall: PaywallContext = {}): Response {
  return Response.json({ error: insufficientCreditsError(request, paywall) }, { status: 402 });
}

// Sandbox-route flavour: keeps `error` a string (the `oc` Go CLI prints it
// verbatim) while adding the structured fields alongside for newer clients.
export function insufficientCreditsLegacyResponse(
  request: Request,
  extra: Record<string, unknown> = {},
  paywall: PaywallContext = {},
): Response {
  const e = insufficientCreditsError(request, paywall);
  return Response.json(
    {
      error: e.message,
      code: e.code,
      haltReason: e.haltReason,
      actionUrl: e.actionUrl,
      billingUrl: e.billingUrl,
      upgradeUrl: e.upgradeUrl,
      ...extra,
    },
    { status: 402 },
  );
}

// Reads the org's plan and halt reason for a 402. After a self-heal the D1
// projection is fresh, so this reflects the reason Autumn just confirmed.
export async function paywallContext(db: D1Database, orgID: string): Promise<PaywallContext> {
  try {
    const row = await db
      .prepare("SELECT usage_plan, halt_reason FROM orgs WHERE id = ?1")
      .bind(orgID)
      .first<{ usage_plan: string | null; halt_reason: string | null }>();
    return { plan: usagePlanOf(row?.usage_plan), haltReason: row?.halt_reason ?? null };
  } catch {
    return { plan: "base", haltReason: null };
  }
}

export function usagePlanOf(value: string | null | undefined): UsagePlan {
  return value === "pro" || value === "max" ? value : "base";
}

// Funnel events for a paywall or warning a client may hit in a loop (a retry
// loop, or the CLI after every run) are counted at most once per org and
// reason per EVENT_DEDUPE_SEC: per isolate in memory, and across a colo's
// isolates through the Cache API. Best-effort: an isolate in another colo may
// count the same one again.
const EVENT_DEDUPE_SEC = 3_600;
const eventSeen = new Map<string, number>();

export async function onceAnHour(key: string, emit: () => Promise<void>, nowMs = Date.now()): Promise<void> {
  const until = eventSeen.get(key);
  if (until !== undefined && until > nowMs) return;
  eventSeen.set(key, nowMs + EVENT_DEDUPE_SEC * 1000);
  if (eventSeen.size > 10_000) {
    for (const [k, v] of eventSeen) if (v <= nowMs) eventSeen.delete(k);
  }
  if (await coloGet<boolean>("billing-event", key)) return;
  await coloPut("billing-event", key, true, EVENT_DEDUPE_SEC);
  await emit();
}

// billing.paywall_shown {reason, surface: "api"}, for every 402 a halt produces.
export function emitPaywallShown(
  env: BillingEventsEnv,
  orgID: string,
  haltReason: string | null | undefined,
): Promise<void> {
  const reason = haltReason || "credits_exhausted";
  return onceAnHour(`paywall:${orgID}:${reason}`, () =>
    emitBillingEvent(env, "billing.paywall_shown", { orgId: orgID, data: { reason, surface: "api" } }),
  );
}

export interface CreditsStatus {
  usagePlan: UsagePlan;
  creditsRemainingCents: number;
  lowCreditThresholdCents: number;
  isLow: boolean;
  isHalted: boolean;
  // Additive (086). Why the org is halted (orgs.halt_reason), null when not.
  haltReason: string | null;
  // The pre-halt warning to show (orgs.billing_warning), null when none.
  billingWarning: BillingWarning | null;
  // On work-minute pricing (trial, or the v2 plans); false: the credit rule.
  workMinutes: boolean;
  billingUrl: string;
  upgradeUrl: string;
  // Plans shown to this org. `name` is the display name (`max` is "Pro").
  // The retired $20 plan is listed only for orgs already on it.
  plans: Array<{ id: "pro" | "max"; name: string; priceUsd: number; creditsUsd: number }>;
}

// orgs.billing_warning: set by the billing clock before an org halts.
export const BILLING_WARNINGS = [
  "trial_minutes",
  "trial_days",
  "trial_tokens",
  "allowance_80",
  "credits_low",
  "payment_failed",
] as const;
export type BillingWarning = (typeof BILLING_WARNINGS)[number];

export function billingWarningOf(value: unknown): BillingWarning | null {
  return (BILLING_WARNINGS as readonly unknown[]).includes(value) ? (value as BillingWarning) : null;
}

const PRO_OFFER = { id: "max", name: PLAN_DISPLAY_NAMES.max, priceUsd: UPGRADE_PLAN_PRICE_USD, creditsUsd: 2_000 } as const;
const LEGACY_PRO_OFFER = { id: "pro", name: PLAN_DISPLAY_NAMES.pro, priceUsd: 20, creditsUsd: 200 } as const;

// Kept for callers that list offers without an org: only the plan on sale.
export const USAGE_PLAN_OFFERS: CreditsStatus["plans"] = [PRO_OFFER];

export function usagePlanOffers(current: UsagePlan): CreditsStatus["plans"] {
  return current === "pro" ? [LEGACY_PRO_OFFER, PRO_OFFER] : [PRO_OFFER];
}

// GET /api/billing/credits — API-key authenticated credit status for the CLI.
// Re-syncs Autumn → D1 like the dashboard endpoint so a fresh upgrade clears a
// halt on the next CLI call too. Legacy (Stripe) orgs have no Autumn customer
// and get a 404 — clients treat that as "no credit meter". billing.warning_shown
// is counted here (deduped like the paywall event) only when the caller says it
// displays the warning (?display=1): a lookup that doesn't show it (e.g.
// `opencomputer upgrade`) must not count it or consume the dedupe key.
export async function handleCreditsStatus(
  req: Request,
  env: AutumnSyncEnv & { AUTUMN_SECRET_KEY?: string },
  caller: { orgID: string },
  waitUntil: (p: Promise<unknown>) => void = () => {},
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
  const links = billingLinks(req);
  const org = await billingOrgState(env.OPENCOMPUTER_DB, caller.orgID);
  const billingWarning = r.halted ? null : org.billingWarning;
  const status: CreditsStatus = {
    usagePlan,
    creditsRemainingCents,
    lowCreditThresholdCents: threshold,
    isLow: !r.halted && creditsRemainingCents <= threshold,
    isHalted: r.halted,
    haltReason: r.haltReason,
    billingWarning,
    workMinutes: r.customer.balances?.[WORK_MINUTES_FEATURE_ID] !== undefined || org.trialStartedAt != null,
    ...links,
    plans: usagePlanOffers(usagePlan),
  };
  if (billingWarning && new URL(req.url).searchParams.get("display") === "1") {
    waitUntil(
      onceAnHour(`warning:${caller.orgID}:${billingWarning}`, () =>
        emitBillingEvent(env, "billing.warning_shown", {
          orgId: caller.orgID,
          data: { reason: billingWarning, surface: "cli" },
        }),
      ),
    );
  }
  return Response.json(status);
}

// billing_warning arrives in migration 0015; until it is applied the column
// read fails and the status carries no warning.
async function billingOrgState(
  db: D1Database,
  orgID: string,
): Promise<{ billingWarning: BillingWarning | null; trialStartedAt: number | null }> {
  try {
    const row = await db
      .prepare("SELECT billing_warning, trial_started_at FROM orgs WHERE id = ?1")
      .bind(orgID)
      .first<{ billing_warning: string | null; trial_started_at: number | null }>();
    return { billingWarning: billingWarningOf(row?.billing_warning), trialStartedAt: row?.trial_started_at ?? null };
  } catch {
    const row = await db
      .prepare("SELECT trial_started_at FROM orgs WHERE id = ?1")
      .bind(orgID)
      .first<{ trial_started_at: number | null }>()
      .catch(() => null);
    return { billingWarning: null, trialStartedAt: row?.trial_started_at ?? null };
  }
}
