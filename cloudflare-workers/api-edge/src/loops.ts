// Lifecycle email through Loops (serverless-agents-ws 088). The edge only
// creates contacts and sends events; copy, delays, conditions, unsubscribes
// and the sending domain live in Loops, editable without a deploy.
//
// Events: `signed_up` (new org), `trial_low` (a trial limit is near) and
// `trial_ended` (the trial halted the org), each with `reason` = days |
// minutes | tokens. The contact's `plan` property follows plan changes so a
// loop can stop once the org pays.
//
// Off unless LOOPS_API_KEY is set. Never throws, one bounded attempt, so a
// login or billing path can await it. Internal accounts are skipped: our own
// domains, plus LOOPS_EXCLUDE_EMAILS (comma-separated addresses or @domains;
// Gmail addresses match ignoring dots and +tags).

export interface LoopsEnv {
  LOOPS_API_KEY?: string;
  LOOPS_EXCLUDE_EMAILS?: string;
}

export type LoopsEvent = "signed_up" | "trial_low" | "trial_ended";

export interface LoopsContact {
  email: string;
  userId: string;
}

const LOOPS_API = "https://app.loops.so/api/v1";
const POST_TIMEOUT_MS = 2_000;
const INTERNAL_DOMAINS = ["digger.dev", "opencomputer.dev"];
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function normalizeEmail(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 0) return lower;
  let local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) local = local.replace(/\+.*$/, "").replaceAll(".", "");
  return `${local}@${domain}`;
}

/** Whether an address belongs to us and must not get lifecycle email. */
export function isExcludedEmail(email: string, extra = ""): boolean {
  const addr = normalizeEmail(email);
  const domain = addr.slice(addr.lastIndexOf("@") + 1);
  const entries = [...INTERNAL_DOMAINS.map((d) => `@${d}`), ...extra.split(",")]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return entries.some((e) => (e.startsWith("@") ? domain === e.slice(1) : addr === normalizeEmail(e)));
}

/** The reason a trial billing_warning or halt_reason carries, or null for any other kind. */
export function trialReason(kind: string | null | undefined): "days" | "minutes" | "tokens" | null {
  if (kind === "trial_days") return "days";
  if (kind === "trial_minutes") return "minutes";
  if (kind === "trial_tokens") return "tokens";
  return null;
}

/**
 * Sends one event for a contact, creating the contact if it is new. Contact
 * properties ride along at the top level. Returns whether Loops accepted it.
 */
export async function sendLoopsEvent(
  env: LoopsEnv,
  contact: LoopsContact,
  eventName: LoopsEvent,
  opts: {
    idempotencyKey: string;
    eventProperties?: Record<string, string | number | boolean>;
    contactProperties?: Record<string, string | number | boolean>;
  },
): Promise<boolean> {
  const key = env.LOOPS_API_KEY?.trim();
  if (!key || isExcludedEmail(contact.email, env.LOOPS_EXCLUDE_EMAILS)) return false;
  return post(key, "/events/send", "POST", {
    ...opts.contactProperties,
    email: contact.email,
    userId: contact.userId,
    eventName,
    ...(opts.eventProperties ? { eventProperties: opts.eventProperties } : {}),
  }, { "idempotency-key": opts.idempotencyKey });
}

/** Updates (or creates) a contact's properties without sending an event. */
export async function updateLoopsContact(
  env: LoopsEnv,
  contact: LoopsContact,
  properties: Record<string, string | number | boolean>,
): Promise<boolean> {
  const key = env.LOOPS_API_KEY?.trim();
  if (!key || isExcludedEmail(contact.email, env.LOOPS_EXCLUDE_EMAILS)) return false;
  return post(key, "/contacts/update", "PUT", { ...properties, email: contact.email, userId: contact.userId });
}

async function post(
  key: string,
  path: string,
  method: "POST" | "PUT",
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<boolean> {
  try {
    const res = await fetch(`${LOOPS_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    // 409: the idempotency key was already used, so the event went out before.
    if (res.ok || res.status === 409) return true;
    // The response can echo the contact's email; log the status only.
    console.error(`loops: ${path} failed: ${res.status}`);
    return false;
  } catch (err) {
    console.error(`loops: ${path} failed: ${err instanceof Error ? err.name : "error"}`);
    return false;
  }
}

interface LoopsDBEnv extends LoopsEnv {
  OPENCOMPUTER_DB: D1Database;
}

/** The org owner as a Loops contact, or null for legacy billing or an unknown owner. */
async function orgOwner(env: LoopsDBEnv, orgID: string): Promise<LoopsContact | null> {
  const row = await env.OPENCOMPUTER_DB.prepare(
    `SELECT u.id AS user_id, u.email FROM orgs o JOIN users u ON u.id = o.owner_user_id
      WHERE o.id = ?1 AND o.billing_provider = 'autumn'`,
  )
    .bind(orgID)
    .first<{ user_id: string; email: string }>();
  return row?.email ? { email: row.email, userId: row.user_id } : null;
}

/**
 * Sends a trial event to the org owner at most once per org: the
 * lifecycle_emails row is claimed first, so retries and concurrent
 * projections that see the same transition do not resend. Never throws.
 */
export async function notifyTrialEvent(
  env: LoopsDBEnv,
  orgID: string,
  eventName: "trial_low" | "trial_ended",
  reason: "days" | "minutes" | "tokens",
): Promise<void> {
  if (!env.LOOPS_API_KEY?.trim()) return;
  try {
    const owner = await orgOwner(env, orgID);
    if (!owner || isExcludedEmail(owner.email, env.LOOPS_EXCLUDE_EMAILS)) return;
    const claimed = await env.OPENCOMPUTER_DB.prepare(
      `INSERT OR IGNORE INTO lifecycle_emails (org_id, event, sent_at) VALUES (?1, ?2, ?3)`,
    )
      .bind(orgID, eventName, Math.floor(Date.now() / 1000))
      .run();
    if (claimed.meta?.changes !== 1) return;
    await sendLoopsEvent(env, owner, eventName, {
      idempotencyKey: `${orgID}:${eventName}`,
      eventProperties: { reason },
    });
  } catch {
    console.error(`loops: ${eventName} for ${orgID} failed`);
  }
}

/** Mirrors the org's plan onto the owner's contact, so loops can stop once it pays. Never throws. */
export async function syncLoopsPlan(env: LoopsDBEnv, orgID: string, plan: string): Promise<void> {
  if (!env.LOOPS_API_KEY?.trim()) return;
  try {
    const owner = await orgOwner(env, orgID);
    if (owner) await updateLoopsContact(env, owner, { plan });
  } catch {
    console.error(`loops: plan sync for ${orgID} failed`);
  }
}
