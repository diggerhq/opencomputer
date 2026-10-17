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

/** Human-readable summary for `opencomputer billing`. */
export function formatBilling(status: CreditsStatus): string {
  const lines = [
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
  upgradeUrl: string;
}

export function creditsSummary(
  status: CreditsStatus | null,
): CreditsSummary | undefined {
  if (!status) return undefined;
  const warning = status.isHalted
    ? "insufficient_credits"
    : status.isLow
      ? "low_credits"
      : undefined;
  return {
    plan: status.usagePlan,
    remainingCents: status.creditsRemainingCents,
    ...(warning ? { warning } : {}),
    upgradeUrl: status.upgradeUrl,
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
