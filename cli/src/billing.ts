import type { CreditsStatus, OpenComputerClient } from "./api.js";

// Cents of usage per credit (1 credit = $1 in the Autumn catalog today).
const CENTS_PER_CREDIT = 100;

/** Credit count for display; balances are shown as credits, never dollars. */
export function formatCreditCount(cents: number): string {
  return (cents / CENTS_PER_CREDIT).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// The plan on sale is Pro ($200/mo); its billing id stays `max`. The old $20
// plan (id `pro`) is shown as "Pro (legacy)" only to orgs already on it.
export const UPGRADE_PLAN = "max" as const;
export const UPGRADE_PLAN_LABEL = "Pro ($200/mo)";

const PLAN_LABEL: Record<CreditsStatus["usagePlan"], string> = {
  base: "Free",
  pro: "Pro (legacy, $20/mo)",
  max: UPGRADE_PLAN_LABEL,
};

const PLAN_NAME: Record<"pro" | "max", string> = {
  pro: "Pro (legacy)",
  max: "Pro",
};

// Work-minute pricing (serverless-agents-ws 086): why an org is halted, by the
// edge's halt_reason, and what to do, always on the Billing page. The credit
// rule ("credits_exhausted", or an older API with no reason) keeps the copy
// below.
const PAYWALL: Record<string, { why: string; action: string }> = {
  trial_days: { why: "Your 7-day trial has ended.", action: "Pick a plan to keep going" },
  trial_minutes: { why: "You've used your trial's 600 work minutes.", action: "Pick a plan to keep going" },
  trial_tokens: { why: "You've used your trial's model credit.", action: "Pick a plan to keep going" },
  credits_empty: {
    why: "You've used this month's work minutes and your credits.",
    action: "Buy credits or upgrade to keep going",
  },
  payment: { why: "Your last payment didn't go through.", action: "Update your payment method to keep going" },
  lapsed: { why: "Your plan has ended.", action: "Pick a plan to keep going" },
};

/** The paywall for a work-minute halt reason; undefined for the credit rule. */
export function paywallFor(reason: string | null | undefined): { why: string; action: string } | undefined {
  return reason && Object.hasOwn(PAYWALL, reason) ? PAYWALL[reason] : undefined;
}

// Before the stop: orgs.billing_warning, by reason.
const WARNINGS: Record<string, string> = {
  trial_minutes: "Your trial is almost out of work minutes. Pick a plan to keep going",
  trial_days: "Your 7-day trial ends soon. Pick a plan to keep going",
  trial_tokens: "Your trial's model credit is almost used. Pick a plan to keep going",
  allowance_80: "You've used 80% of this month's work minutes. Buy credits or upgrade so work doesn't stop",
  credits_low: "Your credits are running low. Buy credits so work doesn't stop",
  payment_failed: "Your last payment didn't go through. Update your payment method so work doesn't stop",
};

export function billingWarningText(reason: string | null | undefined): string | undefined {
  return reason && Object.hasOwn(WARNINGS, reason) ? WARNINGS[reason] : undefined;
}

/** Human-readable summary for `opencomputer billing`. */
export function formatBilling(status: CreditsStatus): string {
  const paywall = status.isHalted ? paywallFor(status.haltReason) : undefined;
  const warning = status.isHalted ? undefined : billingWarningText(status.billingWarning);
  const lines = [
    ...(paywall ? [`${paywall.why} ${paywall.action}: ${status.billingUrl}`, ""] : []),
    ...(warning ? [`${warning}: ${status.billingUrl}`, ""] : []),
    `Plan          ${PLAN_LABEL[status.usagePlan]}`,
    `Credits left  ${formatCreditCount(status.creditsRemainingCents)}${
      status.isHalted ? " (exhausted — sessions paused)" : status.isLow ? " (running low)" : ""
    }`,
    "",
    "Plans:",
    ...status.plans.map(
      (p) =>
        `  ${(p.name ?? PLAN_NAME[p.id]).padEnd(12)} $${p.priceUsd}/mo — ${p.creditsUsd.toLocaleString("en-US")} credits every month` +
        (p.id === status.usagePlan ? "  (current)" : ""),
    ),
    "",
    ...(status.usagePlan === UPGRADE_PLAN
      ? [`Billing:      ${status.billingUrl}`]
      : [`Upgrade:      ${status.upgradeUrl}`]),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * One-line footer after a `run`. Empty when the org is on a paid plan with a
 * healthy balance so paying customers aren't nagged.
 */
export function creditsFooter(status: CreditsStatus | null): string {
  if (!status) return "";
  if (status.isHalted) {
    const paywall = paywallFor(status.haltReason);
    if (paywall) return `\n${paywall.why} ${paywall.action}: ${status.billingUrl}\n`;
  } else {
    const warning = billingWarningText(status.billingWarning);
    if (warning) return `\n${warning}: ${status.billingUrl}\n`;
  }
  // Work-minute orgs hear from billing only through the warnings above.
  if (status.workMinutes) return "";
  const left = formatCreditCount(status.creditsRemainingCents);
  const onPro = status.usagePlan === UPGRADE_PLAN;
  if (status.isHalted) {
    if (onPro) {
      return `\nThis month's Pro credits are used up; they renew next billing period: ${status.billingUrl}\n`;
    }
    return (
      `\n${status.usagePlan === "base" ? "You've used your free credits." : "You've used this month's credits."} ` +
      `Upgrade to ${UPGRADE_PLAN_LABEL} to keep going: ${status.upgradeUrl}\n`
    );
  }
  if (status.isLow) {
    if (onPro) return `\n${left} credits left this month (running low).\n`;
    return `\n${left} credits left (running low). Upgrade to ${UPGRADE_PLAN_LABEL}: ${status.upgradeUrl}\n`;
  }
  if (status.usagePlan === "base") {
    return `\n${left} free credits left · upgrade to ${UPGRADE_PLAN_LABEL}: ${status.upgradeUrl}\n`;
  }
  return "";
}

/** Machine-readable `credits` block appended to `--json` results. */
export interface CreditsSummary {
  plan: CreditsStatus["usagePlan"];
  remainingCents: number;
  warning?: "insufficient_credits" | "low_credits";
  /** Why the org is halted, on work-minute pricing (orgs.halt_reason). */
  haltReason?: string;
  /** The pre-halt warning (trial_minutes, allowance_80, credits_low, ...). */
  billingWarning?: string;
  upgradeUrl: string;
  billingUrl: string;
}

export function creditsSummary(
  status: CreditsStatus | null,
): CreditsSummary | undefined {
  if (!status) return undefined;
  const warning = status.isHalted
    ? "insufficient_credits"
    : status.isLow && !status.workMinutes
      ? "low_credits"
      : undefined;
  return {
    plan: status.usagePlan,
    remainingCents: status.creditsRemainingCents,
    ...(warning ? { warning } : {}),
    ...(status.isHalted && status.haltReason ? { haltReason: status.haltReason } : {}),
    ...(!status.isHalted && status.billingWarning ? { billingWarning: status.billingWarning } : {}),
    upgradeUrl: status.upgradeUrl,
    billingUrl: status.billingUrl,
  };
}

/** Best-effort fetch: billing must never fail an otherwise successful command. */
export async function fetchCredits(
  client: OpenComputerClient,
): Promise<CreditsStatus | null> {
  try {
    return await client.credits();
  } catch {
    return null;
  }
}

export function upgradeUrlFor(
  status: CreditsStatus | null,
  apiUrl: string,
  plan: typeof UPGRADE_PLAN = UPGRADE_PLAN,
): string {
  const base = status?.billingUrl ?? `${apiUrl.replace(/\/$/, "")}/billing`;
  return `${base}?plan=${plan}`;
}
