// Signup attribution (serverless-agents-ws 087): where each signup came from.
//
// The site worker (opencomputer-site-v1 `worker/first-touch.ts`) sets `oc_ft`
// on `.opencomputer.dev` on a visitor's first page view; this edge sets the
// same cookie for visitors who land on the app first. The value is base64url
// compact JSON of the campaign parameters, the external referrer, the landing
// path and the first-seen time: no personal data, never overwritten.
//
// At a browser signup the callback reads the cookie defensively (a bad or
// missing cookie never blocks login), stores one `signup_attribution` row with
// its channel, and sends PostHog a `signed_up` event with the same non-PII
// properties. Keep the encoding in step with the site's copy.

import type { BillingEventsEnv } from "./billing_events";

export const FIRST_TOUCH_COOKIE = "oc_ft";
export const FIRST_TOUCH_MAX_AGE_SEC = 90 * 24 * 60 * 60;
const FIRST_TOUCH_MAX_COOKIE_CHARS = 3072;
const PARAM_MAX_CHARS = 100;
const URL_MAX_CHARS = 200;

export const FIRST_TOUCH_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "li_fat_id",
  "ref",
] as const;

type FirstTouchParam = (typeof FIRST_TOUCH_PARAMS)[number];

export type FirstTouch = Partial<Record<FirstTouchParam | "referrer" | "landing", string>> & {
  /** First-seen time, unix seconds. */
  ts?: number;
};

function clean(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const out = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return out || undefined;
}

function isOwnHost(host: string, requestHost: string): boolean {
  return host === requestHost || host === "opencomputer.dev" || host.endsWith(".opencomputer.dev");
}

/** The first touch a request represents: its campaign parameters, external referrer and path. */
export function firstTouchFromRequest(req: Request, now = Date.now()): FirstTouch {
  const url = new URL(req.url);
  const ft: FirstTouch = {};
  for (const key of FIRST_TOUCH_PARAMS) {
    const value = clean(url.searchParams.get(key), PARAM_MAX_CHARS);
    if (value) ft[key] = value;
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const ref = new URL(referer);
      // Origin and path only: a query string can carry anything.
      if ((ref.protocol === "https:" || ref.protocol === "http:") && !isOwnHost(ref.hostname, url.hostname)) {
        ft.referrer = clean(`${ref.origin}${ref.pathname}`, URL_MAX_CHARS);
      }
    } catch {
      // Unparseable referrer: leave it out.
    }
  }
  ft.landing = clean(url.pathname, URL_MAX_CHARS);
  ft.ts = Math.floor(now / 1000);
  return ft;
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeFirstTouch(ft: FirstTouch): string {
  return toBase64Url(JSON.stringify(ft));
}

/** Parses a cookie value; anything malformed is null, unknown keys are dropped. */
export function decodeFirstTouch(raw: string | null | undefined): FirstTouch | null {
  if (!raw || raw.length > FIRST_TOUCH_MAX_COOKIE_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const ft: FirstTouch = {};
  for (const key of FIRST_TOUCH_PARAMS) {
    const value = clean(obj[key] as string | undefined, PARAM_MAX_CHARS);
    if (value) ft[key] = value;
  }
  const referrer = clean(obj.referrer as string | undefined, URL_MAX_CHARS);
  if (referrer) ft.referrer = referrer;
  const landing = clean(obj.landing as string | undefined, URL_MAX_CHARS);
  if (landing) ft.landing = landing;
  if (typeof obj.ts === "number" && Number.isFinite(obj.ts) && obj.ts > 0) ft.ts = Math.floor(obj.ts);
  return ft;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function isPageNavigation(req: Request): boolean {
  if (req.method !== "GET") return false;
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (req.headers.get("accept") ?? "").includes("text/html");
}

/**
 * The Set-Cookie header for a visitor's first page view, or null when the
 * request already carries `oc_ft` or is not a page navigation.
 */
export function firstTouchSetCookie(req: Request, now = Date.now()): string | null {
  if (!isPageNavigation(req)) return null;
  if (readCookie(req.headers.get("cookie"), FIRST_TOUCH_COOKIE) !== null) return null;
  const host = new URL(req.url).hostname;
  const domain = host === "opencomputer.dev" || host.endsWith(".opencomputer.dev") ? "; Domain=.opencomputer.dev" : "";
  const value = encodeFirstTouch(firstTouchFromRequest(req, now));
  return `${FIRST_TOUCH_COOKIE}=${value}${domain}; Path=/; Max-Age=${FIRST_TOUCH_MAX_AGE_SEC}; Secure; SameSite=Lax`;
}

/** Adds the first-touch cookie to a page response when the visitor has none. */
export function withFirstTouchCookie(req: Request, res: Response, now = Date.now()): Response {
  const cookie = firstTouchSetCookie(req, now);
  if (!cookie) return res;
  const out = new Response(res.body, res);
  out.headers.append("set-cookie", cookie);
  return out;
}

export type SignupChannel =
  | "google_ads"
  | "other_paid"
  | "organic_search"
  | "social"
  | "referral"
  | "direct"
  | "unknown";

const PAID_MEDIUM = /^(cpc|ppc|cpm|cpv|cpa|paid|display|banner|retargeting|ads?)$|paid/;
const GOOGLE_SOURCE = /^(google|adwords|googleads|google_ads|google-ads)$/;
const SOCIAL_SOURCE =
  /^(x|twitter|t\.co|linkedin|lnkd\.in|reddit|hn|hackernews|hacker_news|hacker-news|ycombinator|news\.ycombinator\.com|facebook|fb|instagram|threads|bluesky|bsky|mastodon|youtube)$/;
const SOCIAL_HOST =
  /(^|\.)(x\.com|twitter\.com|t\.co|linkedin\.com|lnkd\.in|reddit\.com|news\.ycombinator\.com|facebook\.com|instagram\.com|threads\.net|bsky\.app|youtube\.com)$/;
const SEARCH_SOURCE = /^(google|bing|duckduckgo|ddg|yahoo|baidu|yandex|ecosia|brave|kagi|startpage)$/;
const SEARCH_HOST =
  /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|baidu\.com|yandex\.[a-z.]+|ecosia\.org|search\.brave\.com|kagi\.com|startpage\.com)$/;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The channel of one signup. `null` (no row, or a signup that arrived without
 * a first-touch cookie) is unknown; a cookie with no campaign or referrer is
 * direct.
 */
export function signupChannel(ft: FirstTouch | null): SignupChannel {
  if (!ft) return "unknown";
  const source = ft.utm_source?.toLowerCase() ?? "";
  const medium = ft.utm_medium?.toLowerCase() ?? "";
  const ref = ft.ref?.toLowerCase() ?? "";
  const referrerHost = hostOf(ft.referrer);
  const paid = medium !== "" && PAID_MEDIUM.test(medium);

  if (ft.gclid || (paid && GOOGLE_SOURCE.test(source))) return "google_ads";
  if (paid || ft.li_fat_id) return "other_paid";
  if (SOCIAL_SOURCE.test(source) || medium === "social" || SOCIAL_SOURCE.test(ref) || ft.fbclid) return "social";
  if (SEARCH_SOURCE.test(source) && (medium === "" || medium === "organic")) return "organic_search";
  if (!source && !ref && referrerHost) {
    if (SOCIAL_HOST.test(referrerHost)) return "social";
    if (SEARCH_HOST.test(referrerHost)) return "organic_search";
  }
  if (source || ref || referrerHost) return "referral";
  return "direct";
}

export interface SignupAttributionInput {
  userId: string;
  orgId: string;
  client: "web" | "cli";
  /** WorkOS `authentication_method` (GoogleOAuth, GitHubOAuth, MagicAuth, …). */
  authMethod: unknown;
  planIntent: string | null;
  /** The raw `oc_ft` cookie value; null when the signup carried none. */
  cookie: string | null;
}

export interface SignupAttributionEnv extends BillingEventsEnv {
  OPENCOMPUTER_DB: D1Database;
}

const POSTHOG_TIMEOUT_MS = 2_000;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** The stored row for one signup. */
export function signupAttributionRow(input: SignupAttributionInput, nowSec: number) {
  const ft = decodeFirstTouch(input.cookie);
  return {
    user_id: input.userId,
    utm_source: ft?.utm_source ?? null,
    utm_medium: ft?.utm_medium ?? null,
    utm_campaign: ft?.utm_campaign ?? null,
    utm_term: ft?.utm_term ?? null,
    utm_content: ft?.utm_content ?? null,
    gclid: ft?.gclid ?? null,
    fbclid: ft?.fbclid ?? null,
    li_fat_id: ft?.li_fat_id ?? null,
    ref: ft?.ref ?? null,
    referrer: ft?.referrer ?? null,
    landing_path: ft?.landing ?? null,
    first_seen_at: ft?.ts ?? null,
    channel: signupChannel(ft),
    client: input.client,
    auth_method: clean(typeof input.authMethod === "string" ? input.authMethod : null, 40) ?? null,
    plan_intent: input.planIntent,
    created_at: nowSec,
  };
}

export type SignupAttributionRow = ReturnType<typeof signupAttributionRow>;

/** The PostHog `signed_up` capture: the row minus click ids, which become booleans. */
export function signupPostHogEvent(token: string, row: SignupAttributionRow, orgId: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    channel: row.channel,
    client: row.client,
    has_gclid: row.gclid !== null,
    has_fbclid: row.fbclid !== null,
    has_li_fat_id: row.li_fat_id !== null,
    org_id: orgId,
    $groups: { organization: orgId },
  };
  for (const key of [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "ref", "referrer", "landing_path", "auth_method", "plan_intent",
  ] as const) {
    if (row[key] !== null) properties[key] = row[key];
  }
  if (row.first_seen_at !== null) properties.first_seen_at = new Date(row.first_seen_at * 1000).toISOString();
  return {
    api_key: token,
    event: "signed_up",
    distinct_id: row.user_id,
    timestamp: new Date(row.created_at * 1000).toISOString(),
    properties,
  };
}

/**
 * Stores the signup's attribution and tells PostHog, once per user: a repeat
 * (a retried signup's later login) writes nothing and sends nothing. Never throws.
 */
export async function recordSignupAttribution(env: SignupAttributionEnv, input: SignupAttributionInput): Promise<void> {
  let row: SignupAttributionRow;
  try {
    row = signupAttributionRow(input, Math.floor(Date.now() / 1000));
    const result = await env.OPENCOMPUTER_DB.prepare(
      `INSERT INTO signup_attribution (
         user_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
         gclid, fbclid, li_fat_id, ref, referrer, landing_path, first_seen_at,
         channel, client, auth_method, plan_intent, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
       ON CONFLICT(user_id) DO NOTHING`,
    )
      .bind(
        row.user_id, row.utm_source, row.utm_medium, row.utm_campaign, row.utm_term, row.utm_content,
        row.gclid, row.fbclid, row.li_fat_id, row.ref, row.referrer, row.landing_path, row.first_seen_at,
        row.channel, row.client, row.auth_method, row.plan_intent, row.created_at,
      )
      .run();
    if (!result.meta?.changes) return;
  } catch (err) {
    console.error(`signup attribution: insert failed for ${input.userId}`, err instanceof Error ? err.message : "");
    return;
  }
  const token = env.POSTHOG_PROJECT_TOKEN?.trim();
  if (!token) return;
  try {
    const res = await fetch(`${(env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "")}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signupPostHogEvent(token, row, input.orgId)),
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // Telemetry never fails the login.
  }
}
