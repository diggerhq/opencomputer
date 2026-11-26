// What Slack tells an organization about its billing (work 052, 070, 086): the paywall in a refused
// session's thread, the warning before the stop, and forgetting both when the organization is
// admitted again. Computer owes them (Slack.billing); the texts and the once-only rules live here.

import type { BillingNotice, BillingNoticeResult } from "./contract.js";
import type { SlackResult } from "../../slack-api/web-api.js";
import { parseSessionKey } from "../../host-protocol/protocol.js";
import type { Sql } from "../../durable/sql.js";

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
 * limit hit; the credit rule keeps its wording. Free (and the retired $20
 * Pro) is told to upgrade to Pro, the $200 plan; Pro is told its month's
 * credits are used (work 070: no top-ups).
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

export interface BillingNoticeInput {
  sql: Sql;
  slack: (method: string, body: Record<string, unknown>) => Promise<SlackResult>;
  /** The app's public origin: the billing links. */
  origin: string;
  teamId: string;
  /** Who installed the app, when known: the warning's DM goes to them. */
  installer: string | undefined;
  /** The Slack thread of a session, when it has one. */
  threadOf: (sessionId: string) => string | undefined;
}

/**
 * A billing notice told in Slack.
 *   - paywall: once per thread (the `notices` row of kind `credits`) until the organization is
 *     admitted again;
 *   - warning: once per reason per run of warnings (`since`), to the installer in a DM; a DM that
 *     cannot be sent (no installer kept, or Slack refuses it) goes to the session's thread, once.
 *     Kept in `billing_warnings` by recipient, so a new installer hears a standing warning, and
 *     released when nothing was shown, so the next owed warning tries again;
 *   - admitted: the `credits` notices and the warnings told are forgotten, so a later halt is news.
 */
export async function tellBilling(input: BillingNoticeInput, n: BillingNotice): Promise<BillingNoticeResult> {
  const { sql } = input;
  if (n.kind === "admitted") {
    sql.exec("DELETE FROM notices WHERE kind = 'credits'");
    sql.exec("DELETE FROM billing_warnings");
    return "shown";
  }
  if (n.kind === "paywall") {
    const key = input.threadOf(n.sessionId);
    const where = key ? parseSessionKey(key) : null;
    if (!key || !where) return "known";
    if (sql.exec("INSERT OR IGNORE INTO notices (thread_key, kind) VALUES (?, 'credits') RETURNING 1", key).length === 0) return "known";
    const posted = await input.slack("chat.postMessage", { channel: where.channelId, thread_ts: where.threadTs, ...outOfCreditsMessage(input.origin, n.onPro, n.haltReason) });
    if (posted.ok) return "shown";
    sql.exec("DELETE FROM notices WHERE thread_key = ? AND kind = 'credits'", key);
    return "missed";
  }
  const message = billingWarningMessage(input.origin, n.reason);
  if (!message) return "known";
  const kind = `${n.reason}:${n.since ?? 0}`;
  const claim = (recipient: string) => sql.exec("INSERT OR IGNORE INTO billing_warnings (recipient, kind) VALUES (?, ?) RETURNING 1", recipient, kind).length > 0;
  const release = (recipient: string) => sql.exec("DELETE FROM billing_warnings WHERE recipient = ? AND kind = ?", recipient, kind);
  const dm = input.installer ? `dm:${input.teamId}:${input.installer}` : null;
  if (dm) {
    if (!claim(dm)) return "known";
    const opened = await input.slack("conversations.open", { users: input.installer });
    const channel = opened.ok ? opened.channel?.id : undefined;
    if (channel && (await input.slack("chat.postMessage", { channel, ...message })).ok) return "shown";
    release(dm);
  }
  const key = n.sessionId ? input.threadOf(n.sessionId) : undefined;
  const where = key ? parseSessionKey(key) : null;
  if (!key || !where) return "missed";
  const thread = `thread:${where.channelId}:${where.threadTs}`;
  if (!claim(thread)) return "known";
  if ((await input.slack("chat.postMessage", { channel: where.channelId, thread_ts: where.threadTs, ...message })).ok) return "shown";
  release(thread);
  return "missed";
}
