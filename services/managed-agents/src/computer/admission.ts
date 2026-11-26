// The credit gate in front of the computer (work 052): before a Slack message
// is delivered to the computer, the organization passes the same admission
// bluecode runs for autonomous serverless agent sessions
// (src/edge/billing-admission.ts, the public edge's billing projection through
// the OPENCOMPUTER_BILLING binding). A computer session spends runtime and
// model credits exactly like one, so it is admitted exactly like one.
//
//   - denied (a halted free organization: insufficient credits) or allowed
//     with `modelAccess: "fallback"` (a halted paid organization): the
//     message is not delivered; the thread is told once. Free (and the
//     retired $20 Pro) is told to upgrade to Pro, the $200 plan, at its
//     checkout; Pro is told its month's credits are used (work 070: free
//     users see a paywall; no top-ups). Serverless agents move a halted paid organization's model
//     calls to the open-weight fallback model; Claude Code on the computer
//     cannot, and its capped key would only fail the turn, so every
//     organization out of credits hits the same paywall
//     (2026-10-15: "when you run out it should make you hit a paywall in
//     slack");
//   - no binding (development): allowed;
//   - billing unavailable: throws, and the Slack queue retries the message.

import {
  AutonomousBillingAdmissionError,
  type AutonomousBillingEnv,
  autonomousBillingAdmission,
} from "../edge/billing-admission.js";
import type { SlackResult } from "./slack.js";

/** A Slack message whose link is a button (086: "Links are buttons, not raw URLs"); `text` keeps the URL for notifications and clients without blocks. */
export interface SlackNotice {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

/** `lead`, then `verb` as a button to `url`; `rest` ends the sentence `verb` starts. */
function notice(emoji: string, lead: string, verb: string, url: string, rest: string): SlackNotice {
  return {
    text: `${emoji} ${lead} ${verb} at ${url}${rest}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${emoji} ${lead} ${verb}${rest}` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: verb }, url, action_id: "billing_link" }] },
    ],
  };
}

/**
 * The paywall, by why the organization is halted (`haltReason`, the edge's
 * orgs.halt_reason). Work-minute halts (work 086) name the
 * limit hit; the credit rule keeps its wording.
 */
export function outOfCreditsMessage(origin: string, onPro = false, haltReason: string | null = null): SlackNotice {
  const billing = `${origin}/billing`;
  const say = (lead: string, verb: string, rest: string, url = billing) => notice(":information_source:", lead, verb, url, rest);
  const again = " to keep going, then mention me again.";
  switch (haltReason) {
    case "trial_days":
      return say("Your 3-day trial has ended, so I can't take this on.", "Pick a plan", again);
    case "trial_minutes":
      return say("You've used your trial's 600 work minutes, so I can't take this on.", "Pick a plan", again);
    case "trial_tokens":
      return say("You've used your trial's model credit, so I can't take this on.", "Pick a plan", again);
    case "credits_empty":
      return say("You've used this month's work minutes and your credits, so I can't take this on.", "Buy credits or upgrade", ", then mention me again.");
    case "payment":
      return say("Your last payment didn't go through, so I can't take this on.", "Update your payment method", ", then mention me again.");
    case "lapsed":
      return say("Your plan has ended, so I can't take this on.", "Pick a plan", again);
  }
  if (onPro) {
    return say("You've used this month's Pro credits, so I can't take this on until they renew.", "See your renewal date", ".");
  }
  return say("You've used your free credits, so I can't take this on.", "Upgrade to Pro ($200/mo)", again, `${billing}?plan=max`);
}

/** The paywall's text alone (outOfCreditsMessage). */
export function outOfCreditsNotice(origin: string, onPro = false, haltReason: string | null = null): string {
  return outOfCreditsMessage(origin, onPro, haltReason).text;
}

/**
 * The warning before the stop (086), by the limit the organization is about
 * to hit (`warning`, the edge's orgs.billing_warning). null for a reason
 * this gateway does not know.
 */
export function billingWarningMessage(origin: string, reason: string): SlackNotice | null {
  const billing = `${origin}/billing`;
  const say = (lead: string, verb: string, rest: string) => notice(":warning:", lead, verb, billing, rest);
  switch (reason) {
    case "trial_minutes":
      return say("Your trial has under 120 of its 600 work minutes left.", "Pick a plan", " to keep going after it.");
    case "trial_days":
      return say("Your trial ends within 2 days.", "Pick a plan", " to keep going after it.");
    case "trial_tokens":
      return say("Your trial has under $2 of its $10 model credit left.", "Pick a plan", " to keep going after it.");
    case "allowance_80":
      return say("You've used 80% of this month's work minutes; past them, each minute is $0.01 from your credits.", "See your usage", ".");
    case "credits_low":
      return say("Your credits are under $5 and this month's work minutes are nearly used; when both run out, I stop.", "Buy credits", ".");
    case "payment_failed":
      return say("Your last payment didn't go through; I stop in 3 days unless it does.", "Update your payment method", ".");
  }
  return null;
}

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

/**
 * A refused message: the thread hears it once (the `notices` row, kind
 * `credits`), and Slack's working status is cleared as a failed delivery
 * clears it. Returns whether the notice was posted now.
 */
export async function refuseForCredits(input: {
  sql: SqlStorage;
  slack: (method: string, body: Record<string, unknown>) => Promise<SlackResult>;
  channelId: string;
  threadTs: string;
  origin: string;
  onPro?: boolean;
  haltReason?: string | null;
}): Promise<boolean> {
  const inserted = input.sql.exec(
    "INSERT OR IGNORE INTO notices (thread_key, kind) VALUES (?, 'credits')",
    `${input.channelId}:${input.threadTs}`,
  );
  const first = inserted.rowsWritten > 0;
  if (first) {
    await input.slack("chat.postMessage", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      ...outOfCreditsMessage(input.origin, input.onPro, input.haltReason ?? null),
    });
  }
  await input.slack("agents.sessions.setStatus", { channel_id: input.channelId, thread_ts: input.threadTs, status: "active" });
  return first;
}

/** Admitted again: a later refusal in this thread is news, so it is told again. */
export function forgetCreditsNotice(sql: SqlStorage, channelId: string, threadTs: string): void {
  sql.exec("DELETE FROM notices WHERE thread_key = ? AND kind = 'credits'", `${channelId}:${threadTs}`);
}
