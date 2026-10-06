import type { CreditsStatus, OpenComputerClient } from "./api.js";

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const PLAN_LABEL: Record<CreditsStatus["usagePlan"], string> = {
  base: "Usage (prepaid)",
  pro: "Pro ($20/mo)",
  max: "Max ($200/mo)",
};

/** Human-readable summary for `opencomputer billing`. */
export function formatBilling(status: CreditsStatus): string {
  const lines = [
    `Plan          ${PLAN_LABEL[status.usagePlan]}`,
    `Credits left  ${formatUsd(status.creditsRemainingCents)}${
      status.isHalted ? " (exhausted — sessions paused)" : status.isLow ? " (running low)" : ""
    }`,
    "",
    "Plans:",
    ...status.plans.map(
      (p) =>
        `  ${p.id.padEnd(5)} $${p.priceUsd}/mo — $${p.creditsUsd.toLocaleString("en-US")} in credits every month` +
        (p.id === status.usagePlan ? "  (current)" : ""),
    ),
    "",
    `Upgrade:      ${status.upgradeUrl}`,
    `Top up:       ${status.billingUrl}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * One-line footer after a `run`. Empty when the org is on a paid plan with a
 * healthy balance so paying customers aren't nagged.
 */
export function creditsFooter(status: CreditsStatus | null): string {
  if (!status) return "";
  const left = formatUsd(status.creditsRemainingCents);
  if (status.isHalted) {
    return `\nCredits exhausted — upgrade to keep running: ${status.upgradeUrl}\n`;
  }
  if (status.isLow) {
    return (
      `\n${left} credits left (running low). Pro is $20/mo for $200 in credits: ${status.upgradeUrl}\n`
    );
  }
  if (status.usagePlan === "base") {
    return `\n${left} free credits left · upgrade to Pro ($20/mo, $200 credits): ${status.upgradeUrl}\n`;
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
  plan: "pro" | "max",
): string {
  const base = status?.billingUrl ?? `${apiUrl.replace(/\/$/, "")}/billing`;
  return `${base}?plan=${plan}`;
}
