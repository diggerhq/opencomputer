// Customer alerts in our own Slack (serverless-agents-ws 090): trial starts,
// first agent session, conversions, trial ends, payment trouble, plan moves,
// large credit purchases and teammate invites, one line each in #signups.
//
// Posted by the OpenComputer Slack app (089's SLACK_CONNECT_TOKEN, with
// chat:write and a member of the channel). SIGNUPS_SLACK_CHANNEL is the default
// destination; SLACK_ALERT_CHANNELS overrides it per alert kind
// (`payment_failed=C123,converted=C123`), so revenue alerts can move to their
// own channel without a deploy. Dormant unless the token and a channel are set.
//
// Unlike the billing events (work 054) the message carries the owner's email:
// it is looked up here, for Slack only. Internal accounts never alert; the
// list is slack_connect.ts's, shared with 089.
//
// Each alert is claimed once in slack_alerts before it is posted. One bounded
// attempt; never throws, so a billing or login path can await it.

import { isInternalEmail } from "./slack_connect";

// The settings; OPENCOMPUTER_DB comes from the caller's env (AlertsDBEnv), kept
// out of here so env interfaces that require it can still extend this one.
export interface SlackAlertsEnv {
  // The managed-agent session index (blue's session_creations), read-only.
  SERVERLESS_AGENTS_DB?: D1Database;
  SLACK_CONNECT_TOKEN?: string;
  SIGNUPS_SLACK_CHANNEL?: string;
  SLACK_ALERT_CHANNELS?: string;
  SLACK_ALERT_CREDITS_MIN?: string; // dollars (1 credit = $1); default 100
}

type AlertsDBEnv = SlackAlertsEnv & { OPENCOMPUTER_DB?: D1Database };

export type AlertKind =
  | "trial_started"
  | "activated"
  | "converted"
  | "upgraded"
  | "downgraded"
  | "trial_ended"
  | "payment_failed"
  | "payment_recovered"
  | "credits_purchased"
  | "teammate_invited";

export interface Alert {
  kind: AlertKind;
  orgId: string;
  // Tells repeated alerts of one kind apart; '' for once per org.
  key: string;
  // What happened, after the email: "started a trial".
  what: string;
  // Extra context parts, after the org's own.
  extra?: string[];
}

// One emoji per kind, so the channel scans by color.
const EMOJI: Record<AlertKind, string> = {
  trial_started: "🟢",
  activated: "🚀",
  converted: "💰",
  upgraded: "📈",
  downgraded: "📉",
  trial_ended: "⏹️",
  payment_failed: "🔴",
  payment_recovered: "✅",
  credits_purchased: "💳",
  teammate_invited: "👥",
};

const POST_TIMEOUT_MS = 2_000;
const DEFAULT_CREDITS_MIN = 100;
// Activation looks back this far each */5 tick, so a failed post or a missed
// tick is retried; the slack_alerts claim keeps it to one post.
const ACTIVATION_LOOKBACK_SEC = 3_600;
const MAX_ACTIVATIONS_PER_RUN = 20;

const PLAN_LABEL: Record<string, string> = { base: "trial", pro: "Pro", max: "Max", top_up: "auto top-up" };
const CHANNEL_LABEL: Record<string, string> = {
  google_ads: "Google Ads",
  other_paid: "Paid ads",
  organic_search: "Organic search",
  social: "Social",
  referral: "Referral",
  direct: "Direct",
};
const AUTH_LABEL: Record<string, string> = {
  GoogleOAuth: "Google login",
  GitHubOAuth: "GitHub login",
  MicrosoftOAuth: "Microsoft login",
  Password: "password login",
  MagicAuth: "magic link",
  SSO: "SSO",
};
const TRIAL_END_REASON: Record<string, string> = {
  days: "3 days up",
  minutes: "out of work minutes",
  tokens: "out of model tokens",
};

function planLabel(plan: unknown): string {
  return PLAN_LABEL[String(plan)] ?? String(plan);
}

function today(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The alert for one billing event, or null when it is not one we post. Plan
 * moves are claimed per transition and day: the projection's compare-and-set
 * already emits each move once, the key only absorbs a replay.
 */
export function alertForBillingEvent(
  env: SlackAlertsEnv,
  name: string,
  orgId: string,
  data: Record<string, string | number | boolean | null>,
  nowMs = Date.now(),
): Alert | null {
  const day = today(nowMs);
  switch (name) {
    case "billing.trial_started":
      return { kind: "trial_started", orgId, key: "", what: "started a trial" };
    case "billing.plan_changed": {
      const from = planLabel(data.from);
      const to = planLabel(data.to);
      const key = `${data.from}:${data.to}:${day}`;
      switch (data.kind) {
        case "trial_converted":
          return { kind: "converted", orgId, key, what: `converted to ${to}` };
        case "upgrade":
          return { kind: "upgraded", orgId, key, what: `upgraded ${from} → ${to}` };
        case "downgrade":
          return { kind: "downgraded", orgId, key, what: `downgraded ${from} → ${to}` };
        case "cancel":
          return { kind: "downgraded", orgId, key, what: `cancelled ${from}` };
        case "lapsed":
          return { kind: "downgraded", orgId, key, what: `lapsed off ${from} after a failed payment` };
        default:
          return null;
      }
    }
    case "billing.payment_failed":
      return {
        kind: "payment_failed",
        orgId,
        key: `${data.plan}:${day}`,
        what: data.plan === "top_up" ? "had an auto top-up payment fail" : "had a payment fail",
        extra: data.reason ? [String(data.reason)] : [],
      };
    case "billing.payment_recovered":
      return { kind: "payment_recovered", orgId, key: `${data.plan}:${day}`, what: "recovered a failed payment" };
    case "billing.credits_purchased": {
      const amount = Number(data.amount);
      const min = Number(env.SLACK_ALERT_CREDITS_MIN) || DEFAULT_CREDITS_MIN;
      if (!Number.isFinite(amount) || amount < min) return null;
      return {
        kind: "credits_purchased",
        orgId,
        key: `${amount}:${data.auto ? "auto" : "manual"}:${Math.floor(nowMs / 60_000)}`,
        what: `bought $${amount} of credits${data.auto ? " (auto top-up)" : ""}`,
      };
    }
    default:
      return null;
  }
}

export function trialEndedAlert(orgId: string, reason: "days" | "minutes" | "tokens"): Alert {
  return { kind: "trial_ended", orgId, key: "", what: "ended their trial unpaid", extra: [TRIAL_END_REASON[reason]] };
}

// Keyed by the invitee, so a revoke and re-invite does not post twice.
export function teammateInvitedAlert(orgId: string, inviteeEmail: string): Alert {
  return { kind: "teammate_invited", orgId, key: inviteeEmail, what: `invited ${inviteeEmail}` };
}

/** The channel an alert kind posts to, or null when alerts are off. */
export function alertChannel(env: SlackAlertsEnv, kind: AlertKind): string | null {
  for (const entry of (env.SLACK_ALERT_CHANNELS ?? "").split(",")) {
    const [k, channel] = entry.split("=").map((s) => s.trim());
    if (k === kind && channel) return channel;
  }
  return env.SIGNUPS_SLACK_CHANNEL?.trim() || null;
}

interface OrgContext {
  email: string;
  org_name: string;
  usage_plan: string | null;
  channel: string | null;
  utm_campaign: string | null;
  referrer: string | null;
  client: string | null;
  auth_method: string | null;
  plan_intent: string | null;
}

async function orgContext(db: D1Database, orgId: string): Promise<OrgContext | null> {
  return db
    .prepare(
      `SELECT u.email, o.name AS org_name, o.usage_plan, a.channel, a.utm_campaign, a.referrer,
              a.client, a.auth_method, a.plan_intent
         FROM orgs o
         JOIN users u ON u.id = o.owner_user_id
         LEFT JOIN signup_attribution a ON a.user_id = u.id
        WHERE o.id = ?1`,
    )
    .bind(orgId)
    .first<OrgContext>();
}

/** The Slack line: `🟢 jane@acme.com started a trial · Acme · Google Ads / launch-oct · …`. */
export function alertText(alert: Alert, c: OrgContext): string {
  const parts: string[] = [];
  // A personal org keeps the signup default, which only repeats the email.
  if (c.org_name && c.org_name !== `${c.email}'s workspace`) parts.push(c.org_name);
  if (alert.kind !== "trial_started" && c.usage_plan) parts.push(planLabel(c.usage_plan));
  const source = sourceLabel(c);
  if (source) parts.push(source);
  if (alert.kind === "trial_started") {
    if (c.client === "cli") parts.push("CLI");
    if (c.auth_method) parts.push(AUTH_LABEL[c.auth_method] ?? c.auth_method);
    if (c.plan_intent) parts.push(`clicked ${planLabel(c.plan_intent)}`);
  }
  parts.push(...(alert.extra ?? []));
  return [`${EMOJI[alert.kind]} ${c.email} ${alert.what}`, ...parts].join(" · ");
}

function sourceLabel(c: OrgContext): string | null {
  if (!c.channel || c.channel === "unknown") return null;
  let label = CHANNEL_LABEL[c.channel] ?? c.channel;
  if (c.channel === "referral" && c.referrer) {
    try {
      label += ` (${new URL(c.referrer.includes("://") ? c.referrer : `https://${c.referrer}`).hostname})`;
    } catch {
      // A referrer that is not a URL adds nothing.
    }
  }
  return c.utm_campaign ? `${label} / ${c.utm_campaign}` : label;
}

/**
 * Posts one alert unless it is filtered or already sent. Returns whether it
 * posted. Never throws.
 */
export async function sendSlackAlert(
  env: AlertsDBEnv,
  alert: Alert,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<boolean> {
  const db = env.OPENCOMPUTER_DB;
  const token = env.SLACK_CONNECT_TOKEN?.trim();
  const channel = alertChannel(env, alert.kind);
  if (!db || !token || !channel) return false;
  try {
    const c = await orgContext(db, alert.orgId);
    if (!c?.email || isInternalEmail(c.email)) return false;

    const claimed = await db
      .prepare(`INSERT OR IGNORE INTO slack_alerts (org_id, event, key, sent_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(alert.orgId, alert.kind, alert.key, Math.floor(nowMs / 1000))
      .run();
    if (claimed.meta?.changes !== 1) return false;

    let error: string | null = null;
    try {
      const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel, text: alertText(alert, c), unfurl_links: false, unfurl_media: false }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      const body = res.ok ? ((await res.json()) as { ok?: boolean; error?: string }) : null;
      if (!body?.ok) error = body?.error ?? `http_${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.name : "error";
    }
    if (error) {
      // Release the claim: the cron retries activation; a webhook-driven alert
      // is posted by a later replay, if any.
      await db
        .prepare(`DELETE FROM slack_alerts WHERE org_id = ?1 AND event = ?2 AND key = ?3`)
        .bind(alert.orgId, alert.kind, alert.key)
        .run();
      console.error(`slack-alerts: ${alert.kind} for ${alert.orgId} failed: ${error}`);
      return false;
    }
    return true;
  } catch {
    console.error(`slack-alerts: ${alert.kind} for ${alert.orgId} failed`);
    return false;
  }
}

/** The billing-event sink: called from emitBillingEvent for every event. Never throws. */
export async function slackAlertForBillingEvent(
  env: AlertsDBEnv,
  name: string,
  orgId: string,
  data: Record<string, string | number | boolean | null>,
): Promise<void> {
  if (!env.SLACK_CONNECT_TOKEN) return;
  const alert = alertForBillingEvent(env, name, orgId, data);
  if (alert) await sendSlackAlert(env, alert);
}

/**
 * Activation: an org's first countable managed-agent session. session_creations
 * has no emit point the edge sees, so the 5-minute cron finds orgs whose first
 * session falls inside the lookback; an org with an older session never
 * matches, so the first deploy does not alert on existing customers.
 */
export async function runActivationAlerts(
  env: AlertsDBEnv,
  nowMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const sessions = env.SERVERLESS_AGENTS_DB;
  const db = env.OPENCOMPUTER_DB;
  if (!sessions || !db || !env.SLACK_CONNECT_TOKEN || !alertChannel(env, "activated")) return 0;
  const sinceSec = Math.floor(nowMs / 1000) - ACTIVATION_LOOKBACK_SEC;
  const since = new Date(sinceSec * 1000).toISOString();
  // SQLite returns the bare `source` from the row that holds the MIN.
  const { results } = await sessions
    .prepare(
      `SELECT account_id, source, MIN(created_at) AS first_at
         FROM session_creations
        WHERE COALESCE(countable, 1) = 1
          AND account_id IN (
            SELECT DISTINCT account_id FROM session_creations
             WHERE created_at >= ?1 AND COALESCE(countable, 1) = 1)
        GROUP BY account_id
       HAVING MIN(created_at) >= ?1
        ORDER BY first_at`,
    )
    .bind(since)
    .all<{ account_id: string; source: string; first_at: string }>();
  // Orgs already announced inside the window (sessions cannot be joined across
  // databases), so the batch goes to new ones.
  const sent = await db
    .prepare(`SELECT org_id FROM slack_alerts WHERE event = 'activated' AND sent_at >= ?1`)
    .bind(sinceSec)
    .all<{ org_id: string }>();
  const done = new Set((sent.results ?? []).map((r) => r.org_id));
  let posted = 0;
  for (const r of (results ?? []).filter((r) => !done.has(r.account_id)).slice(0, MAX_ACTIVATIONS_PER_RUN)) {
    const alert: Alert = {
      kind: "activated",
      orgId: r.account_id,
      key: "",
      what: "ran their first agent session",
      extra: r.source ? [`via ${r.source}`] : [],
    };
    if (await sendSlackAlert(env, alert, fetchImpl, nowMs)) posted++;
  }
  return posted;
}
