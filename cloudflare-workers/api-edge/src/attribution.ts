// Sign-up attribution (design .agents/design/signup-attribution.md, C1/C3/C4/C5).
//
// One first-party cookie `oc_attr` on `.opencomputer.dev` carries first-touch
// (`ft`, written once) and last-touch (`lt`, overwritten on every touch). The
// marketing site and the dashboard SPA write it; `/auth/login` writes it too
// for deep links that never render the SPA. On a genuinely created user the
// WorkOS callback persists one `signup_attribution` row and emits a
// server-side PostHog `signed_up` and Plausible `Signup`.
//
// Everything here except recordSignupAttribution is pure. That one function
// never throws: attribution must never break login.

export const ATTRIBUTION_COOKIE = "oc_attr";
export const ATTRIBUTION_MAX_AGE_SEC = 7_776_000; // 90 days
// Cookie ≤ 2 KB: the whole `oc_attr=<value>` pair, URL-encoded.
export const ATTRIBUTION_COOKIE_MAX_BYTES = 2048;

const UTM_MAX = 100;
const URL_MAX = 200;
const INTERNAL_HOST_SUFFIX = "opencomputer.dev";
const PLAUSIBLE_EVENT_URL = "https://app.opencomputer.dev/auth/callback";
const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";

export interface Touch {
  t: number;
  src: string | null;
  med: string | null;
  cmp: string | null;
  term: string | null;
  cnt: string | null;
  ref: string | null;
  lp: string | null;
  gclid: string | null;
  fbclid: string | null;
}

export interface Attribution {
  v: 1;
  ft: Touch | null;
  lt: Touch | null;
}

export type Channel =
  | "direct"
  | "organic_search"
  | "paid_search"
  | "social"
  | "referral"
  | "email"
  | "invite"
  | "cli"
  | "other";

export type SignupEntry = "browser" | "cli" | "invite";

export interface AttributionEnv {
  // Server-side PostHog `signed_up` capture. Unset → skipped (D1 row only).
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string; // default https://us.i.posthog.com
  // Plausible site domain for the server-side `Signup` goal (e.g.
  // "opencomputer.dev"). Unset → skipped.
  PLAUSIBLE_DOMAIN?: string;
}

// ---------------------------------------------------------------------------
// C1 field rules
// ---------------------------------------------------------------------------

function utmValue(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase().slice(0, UTM_MAX);
  return v ? v : null;
}

function clickID(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().slice(0, UTM_MAX);
  return v ? v : null;
}

/** host + path, no query/fragment, ≤ 200 chars. Null when unparseable. */
export function hostPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    if (!u.host) return null;
    return (u.host + u.pathname).slice(0, URL_MAX);
  } catch {
    return null;
  }
}

export function isInternalHost(host: string): boolean {
  return host.toLowerCase().endsWith(INTERNAL_HOST_SUFFIX);
}

/** External referrer as host + path, or null when absent / internal / bad. */
function externalReferrer(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    if (!u.hostname || isInternalHost(u.hostname)) return null;
  } catch {
    return null;
  }
  return hostPath(raw);
}

/**
 * C1 applied to a landing URL + referrer. Returns null when the page carries
 * no touch (no utm_*, gclid, fbclid, or external referrer).
 */
export function computeTouch(url: string, referrer: string | null, nowSec: number): Touch | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const q = u.searchParams;
  const hasUTM = [...q.keys()].some((k) => k.startsWith("utm_"));
  const gclid = clickID(q.get("gclid"));
  const fbclid = clickID(q.get("fbclid"));
  const ref = externalReferrer(referrer);
  if (!hasUTM && !gclid && !fbclid && !ref) return null;
  return {
    t: Math.floor(nowSec),
    src: utmValue(q.get("utm_source")),
    med: utmValue(q.get("utm_medium")),
    cmp: utmValue(q.get("utm_campaign")),
    term: utmValue(q.get("utm_term")),
    cnt: utmValue(q.get("utm_content")),
    ref,
    lp: hostPath(url),
    gclid,
    fbclid,
  };
}

/** C3: the touch carried by an edge request (query `utm_*` + `Referer`). */
export function touchFromRequest(req: Request, nowSec: number): Touch | null {
  return computeTouch(req.url, req.headers.get("referer"), nowSec);
}

// ---------------------------------------------------------------------------
// Cookie parse / merge
// ---------------------------------------------------------------------------

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.slice(0, max);
  return s ? s : null;
}

function normalizeTouch(raw: unknown): Touch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.t !== "number" || !Number.isFinite(o.t)) return null;
  return {
    t: Math.floor(o.t),
    src: str(o.src, UTM_MAX),
    med: str(o.med, UTM_MAX),
    cmp: str(o.cmp, UTM_MAX),
    term: str(o.term, UTM_MAX),
    cnt: str(o.cnt, UTM_MAX),
    ref: str(o.ref, URL_MAX),
    lp: str(o.lp, URL_MAX),
    gclid: str(o.gclid, UTM_MAX),
    fbclid: str(o.fbclid, UTM_MAX),
  };
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Tolerant parse of the `oc_attr` cookie out of a Cookie header. Anything
 * malformed (bad encoding, bad JSON, wrong version, no usable touch) → null,
 * which every writer treats as "absent".
 */
export function parseAttributionCookie(cookieHeader: string | null | undefined): Attribution | null {
  const raw = cookieValue(cookieHeader, ATTRIBUTION_COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1) return null;
    const ft = normalizeTouch(o.ft);
    const lt = normalizeTouch(o.lt);
    if (!ft && !lt) return null;
    return { v: 1, ft, lt };
  } catch {
    return null;
  }
}

function encodeAttribution(a: Attribution): string {
  return encodeURIComponent(JSON.stringify(a));
}

function fits(value: string): boolean {
  return ATTRIBUTION_COOKIE.length + 1 + value.length <= ATTRIBUTION_COOKIE_MAX_BYTES;
}

function slim(t: Touch): Touch {
  // Keep the fields the classifier and report use; drop the long free text.
  return { ...t, term: null, cnt: null, lp: null, ref: t.ref ? t.ref.split("/", 1)[0] : null };
}

/**
 * C1 merge: `ft` is written once and never overwritten, `lt` is replaced by
 * `touch`. A malformed existing cookie is replaced as if absent. Returns the
 * URL-encoded cookie VALUE, guaranteed to fit the 2 KB cap — when it would
 * not, `lt` and then `ft` are slimmed (term/content/landing dropped, referrer
 * cut to its host); `ft` keeps its source/medium/campaign/time either way.
 */
export function mergeAttributionCookie(cookieHeader: string | null | undefined, touch: Touch): string {
  const existing = parseAttributionCookie(cookieHeader);
  const ft = existing?.ft ?? touch;
  const candidates: Attribution[] = [
    { v: 1, ft, lt: touch },
    { v: 1, ft, lt: slim(touch) },
    { v: 1, ft: slim(ft), lt: slim(touch) },
    { v: 1, ft: slim(ft), lt: null },
  ];
  for (const c of candidates) {
    const value = encodeAttribution(c);
    if (fits(value)) return value;
  }
  // Unreachable with the field caps above (a slimmed touch is < 1 KB encoded).
  return encodeAttribution({ v: 1, ft: { ...slim(ft), ref: null, gclid: null, fbclid: null }, lt: null });
}

/** Set-Cookie header for `oc_attr` on the given request host (C1). */
export function attributionSetCookie(value: string, reqURL: URL): string {
  const parts = [`${ATTRIBUTION_COOKIE}=${value}`];
  if (isInternalHost(reqURL.hostname)) parts.push(`Domain=.${INTERNAL_HOST_SUFFIX}`);
  parts.push("Path=/", `Max-Age=${ATTRIBUTION_MAX_AGE_SEC}`, "SameSite=Lax");
  if (reqURL.protocol === "https:") parts.push("Secure");
  return parts.join("; ");
}

/**
 * C3: the `Set-Cookie` that `/auth/login` appends when its own request carries
 * a touch, or null when it carries none (the cookie is then left alone).
 */
export function loginAttributionSetCookie(req: Request, nowSec: number): string | null {
  const touch = touchFromRequest(req, nowSec);
  if (!touch) return null;
  return attributionSetCookie(mergeAttributionCookie(req.headers.get("cookie"), touch), new URL(req.url));
}

// ---------------------------------------------------------------------------
// C4 classifier
// ---------------------------------------------------------------------------

const SEARCH_ENGINES = ["google", "bing", "duckduckgo", "yahoo"];
const SOCIAL_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "linkedin.com",
  "news.ycombinator.com",
  "reddit.com",
  "facebook.com",
  "youtube.com",
  "github.com",
];

function stripWWW(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

// A referrer host: matches a search engine when any DNS label is the engine
// name (www.google.co.uk, search.yahoo.com); a social host when equal to or a
// subdomain of a table entry (mobile.twitter.com, old.reddit.com).
function classifyHost(rawHost: string): Channel | null {
  const host = stripWWW(rawHost.toLowerCase());
  if (!host) return null;
  const labels = host.split(".");
  if (SEARCH_ENGINES.some((e) => labels.includes(e))) return "organic_search";
  if (SOCIAL_HOSTS.some((h) => host === h || host.endsWith("." + h))) return "social";
  return null;
}

// A utm_source: matches a table entry by name ("google", "twitter", "x",
// "reddit", "news.ycombinator") or by full host ("twitter.com").
function classifySource(src: string): Channel | null {
  const s = stripWWW(src.toLowerCase());
  if (SEARCH_ENGINES.includes(s)) return "organic_search";
  if (SOCIAL_HOSTS.some((h) => s === h || s + ".com" === h)) return "social";
  return classifyHost(s.includes(".") ? s : "");
}

/**
 * C4 channel rules, in order. `touch` is the first touch (falling back to the
 * last when the cookie only carries one) — first touch decides the channel.
 */
export function classifyChannel(touch: Touch | null, entry: SignupEntry): Channel {
  if (entry === "invite") return "invite";
  if (entry === "cli") return "cli";
  if (!touch) return "direct";
  const med = touch.med?.toLowerCase() ?? null;
  if (touch.gclid || (med !== null && ["cpc", "ppc", "paid"].includes(med))) return "paid_search";
  if (med !== null && ["email", "newsletter"].includes(med)) return "email";
  const fromSrc = touch.src ? classifySource(touch.src) : null;
  if (fromSrc) return fromSrc;
  const refHost = touch.ref ? touch.ref.split("/", 1)[0] : "";
  const fromRef = refHost ? classifyHost(refHost) : null;
  if (fromRef) return fromRef;
  if (touch.ref) return "referral";
  return "other";
}

// ---------------------------------------------------------------------------
// C4 persistence + C5 emits
// ---------------------------------------------------------------------------

export interface SignupAttributionInput {
  userID: string;
  entry: SignupEntry;
  cookie: string | null;
  req: Request;
  nowSec: number;
}

export interface SignupAttributionRecord {
  channel: Channel;
  attribution: Attribution | null;
}

/** Pure: the row values, in the column order of the INSERT below. */
export function signupAttributionRow(input: SignupAttributionInput): {
  channel: Channel;
  attribution: Attribution | null;
  values: (string | number | null)[];
} {
  const attribution = input.entry === "cli" ? null : parseAttributionCookie(input.cookie);
  const ft = attribution?.ft ?? null;
  const lt = attribution?.lt ?? null;
  const decider = ft ?? lt;
  const channel = classifyChannel(decider, input.entry);
  const values = [
    input.userID,
    input.entry,
    channel,
    ft?.src ?? null, ft?.med ?? null, ft?.cmp ?? null, ft?.term ?? null, ft?.cnt ?? null,
    ft?.ref ?? null, ft?.lp ?? null, ft?.t ?? null,
    lt?.src ?? null, lt?.med ?? null, lt?.cmp ?? null, lt?.term ?? null, lt?.cnt ?? null,
    lt?.ref ?? null, lt?.lp ?? null, lt?.t ?? null,
    decider?.gclid ?? lt?.gclid ?? null,
    decider?.fbclid ?? lt?.fbclid ?? null,
    input.nowSec,
  ];
  return { channel, attribution, values };
}

const INSERT_SIGNUP_ATTRIBUTION = `INSERT INTO signup_attribution (
   user_id, entry, channel,
   first_source, first_medium, first_campaign, first_term, first_content,
   first_referrer, first_landing, first_touch_at,
   last_source, last_medium, last_campaign, last_term, last_content,
   last_referrer, last_landing, last_touch_at,
   gclid, fbclid, created_at
 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
 ON CONFLICT(user_id) DO NOTHING`;

/** Pure: the PostHog capture body (C5). */
export function posthogCaptureBody(
  token: string,
  userID: string,
  entry: SignupEntry,
  channel: Channel,
  touch: Touch | null,
): Record<string, unknown> {
  return {
    api_key: token,
    event: "signed_up",
    distinct_id: userID,
    properties: {
      channel,
      entry,
      source: touch?.src ?? null,
      medium: touch?.med ?? null,
      campaign: touch?.cmp ?? null,
      referrer: touch?.ref ?? null,
      landing: touch?.lp ?? null,
      $set_once: {
        signup_channel: channel,
        signup_source: touch?.src ?? null,
        signup_medium: touch?.med ?? null,
        signup_campaign: touch?.cmp ?? null,
        signup_referrer: touch?.ref ?? null,
      },
    },
  };
}

/** Pure: the Plausible event body (C5). */
export function plausibleEventBody(domain: string, channel: Channel, touch: Touch | null): Record<string, unknown> {
  return {
    name: "Signup",
    url: PLAUSIBLE_EVENT_URL,
    domain,
    props: { channel, source: touch?.src ?? null, campaign: touch?.cmp ?? null },
  };
}

async function postJSON(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.error(`signup attribution: ${new URL(url).host} returned ${resp.status}`);
  } catch {
    console.error(`signup attribution: ${new URL(url).host} request failed`);
  }
}

/**
 * Inserts the `signup_attribution` row, then hands the analytics emits to
 * `ctx.waitUntil`. Never throws; every failure is logged without PII.
 */
export async function recordSignupAttribution(
  env: AttributionEnv & { OPENCOMPUTER_DB: D1Database },
  ctx: Pick<ExecutionContext, "waitUntil"> | null | undefined,
  input: SignupAttributionInput,
): Promise<SignupAttributionRecord | null> {
  let record: SignupAttributionRecord;
  try {
    const row = signupAttributionRow(input);
    record = { channel: row.channel, attribution: row.attribution };
    await env.OPENCOMPUTER_DB.prepare(INSERT_SIGNUP_ATTRIBUTION).bind(...row.values).run();
  } catch {
    console.error(`signup attribution: insert failed for ${input.userID}`);
    return null;
  }

  try {
    const touch = record.attribution?.ft ?? record.attribution?.lt ?? null;
    const emits: Promise<void>[] = [];
    if (env.POSTHOG_PROJECT_TOKEN) {
      const host = (env.POSTHOG_HOST || POSTHOG_DEFAULT_HOST).replace(/\/+$/, "");
      emits.push(
        postJSON(
          `${host}/capture/`,
          posthogCaptureBody(env.POSTHOG_PROJECT_TOKEN, input.userID, input.entry, record.channel, touch),
        ),
      );
    }
    if (env.PLAUSIBLE_DOMAIN) {
      const headers: Record<string, string> = {};
      const ua = input.req.headers.get("user-agent");
      const xff = input.req.headers.get("x-forwarded-for") ?? input.req.headers.get("cf-connecting-ip");
      if (ua) headers["user-agent"] = ua;
      if (xff) headers["x-forwarded-for"] = xff;
      emits.push(
        postJSON("https://plausible.io/api/event", plausibleEventBody(env.PLAUSIBLE_DOMAIN, record.channel, touch), headers),
      );
    }
    if (emits.length > 0) {
      const all = Promise.all(emits).then(() => undefined);
      if (ctx) ctx.waitUntil(all);
      else await all;
    }
  } catch {
    console.error(`signup attribution: emit scheduling failed for ${input.userID}`);
  }
  return record;
}
