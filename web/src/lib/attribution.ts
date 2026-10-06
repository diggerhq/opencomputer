// Sign-up attribution capture (design C1/C2, `oc_attr` cookie).
//
// The marketing site and the dashboard both write the same first-party cookie
// on `.opencomputer.dev`, so the API edge can read first- and last-touch
// source when the account is created. The contract is shared with the site
// script and the edge: field names, limits, merge and size rules here must
// produce byte-for-byte the cookie value that
// `cloudflare-workers/api-edge/src/attribution.ts` (canonical) produces.

export const COOKIE_NAME = 'oc_attr'
export const COOKIE_MAX_AGE = 7_776_000 // 90 days
// Cookie ≤ 2 KB: the whole `oc_attr=<value>` pair, URL-encoded.
export const COOKIE_MAX_BYTES = 2048
const SITE_DOMAIN = 'opencomputer.dev'
const UTM_LIMIT = 100
const URL_LIMIT = 200

export type Touch = {
  t: number
  src: string | null
  med: string | null
  cmp: string | null
  term: string | null
  cnt: string | null
  ref: string | null
  lp: string | null
  gclid: string | null
  fbclid: string | null
}

export type Attribution = {
  v: 1
  ft: Touch | null
  lt: Touch | null
}

function utm(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)
  if (value === null) return null
  const clean = value.trim().toLowerCase().slice(0, UTM_LIMIT)
  return clean === '' ? null : clean
}

function clickID(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)
  if (value === null) return null
  const clean = value.trim().slice(0, UTM_LIMIT)
  return clean === '' ? null : clean
}

function parseURL(value: string): URL | null {
  if (!value) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** host + pathname, no query/fragment, ≤ 200 chars; null when unparseable. */
function hostAndPath(url: URL | null): string | null {
  if (!url || url.host === '') return null
  return (url.host + url.pathname).slice(0, URL_LIMIT)
}

function isInternalHost(host: string): boolean {
  return host.toLowerCase().endsWith(SITE_DOMAIN)
}

/** External referrer as host + path; null when absent, unparseable or internal. */
function externalReferrer(referrer: string): string | null {
  const ref = parseURL(referrer)
  if (!ref || ref.hostname === '' || isInternalHost(ref.hostname)) return null
  return hostAndPath(ref)
}

/**
 * The touch this page view represents, or null when it carries none: no
 * `utm_*` key (an empty value still counts), no non-empty `gclid`/`fbclid`
 * and no external referrer (internal navigation records nothing).
 */
export function computeTouch(
  url: string,
  referrer: string,
  now: Date,
): Touch | null {
  const landing = parseURL(url)
  if (!landing) return null
  const params = landing.searchParams
  const hasUTM = [...params.keys()].some((key) => key.startsWith('utm_'))
  const gclid = clickID(params, 'gclid')
  const fbclid = clickID(params, 'fbclid')
  const ref = externalReferrer(referrer)
  if (!hasUTM && !gclid && !fbclid && !ref) return null

  return {
    t: Math.floor(now.getTime() / 1000),
    src: utm(params, 'utm_source'),
    med: utm(params, 'utm_medium'),
    cmp: utm(params, 'utm_campaign'),
    term: utm(params, 'utm_term'),
    cnt: utm(params, 'utm_content'),
    ref,
    lp: hostAndPath(landing),
    gclid,
    fbclid,
  }
}

function capped(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.slice(0, max)
  return clean === '' ? null : clean
}

/** A stored touch with string fields cut to their caps and unknown keys dropped. */
function readTouch(value: unknown): Touch | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.t !== 'number' || !Number.isFinite(record.t)) return null
  return {
    t: Math.floor(record.t),
    src: capped(record.src, UTM_LIMIT),
    med: capped(record.med, UTM_LIMIT),
    cmp: capped(record.cmp, UTM_LIMIT),
    term: capped(record.term, UTM_LIMIT),
    cnt: capped(record.cnt, UTM_LIMIT),
    ref: capped(record.ref, URL_LIMIT),
    lp: capped(record.lp, URL_LIMIT),
    gclid: capped(record.gclid, UTM_LIMIT),
    fbclid: capped(record.fbclid, UTM_LIMIT),
  }
}

/**
 * Parse a raw (URL-encoded) `oc_attr` value; null when absent or malformed
 * (undecodable, invalid JSON, `v !== 1`, or no usable touch).
 */
export function parseCookie(raw: string | null): Attribution | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null
    }
    const record = parsed as Record<string, unknown>
    if (record.v !== 1) return null
    const ft = readTouch(record.ft)
    const lt = readTouch(record.lt)
    if (!ft && !lt) return null
    return { v: 1, ft, lt }
  } catch {
    return null
  }
}

function encode(attribution: Attribution): string {
  return encodeURIComponent(JSON.stringify(attribution))
}

function fits(value: string): boolean {
  return COOKIE_NAME.length + 1 + value.length <= COOKIE_MAX_BYTES
}

/** Drop the long free text; keep what the classifier and report use. */
function slim(touch: Touch): Touch {
  return {
    ...touch,
    term: null,
    cnt: null,
    lp: null,
    ref: touch.ref ? touch.ref.split('/', 1)[0] : null,
  }
}

/**
 * Merge a touch into the existing raw cookie value and return the new raw
 * (URL-encoded JSON) value. `ft` is kept once written; `lt` is always
 * replaced. A malformed cookie is replaced as if absent. The result always
 * fits the 2 KB cap: when it would not, `lt` is slimmed, then `ft`, then
 * `lt` is dropped; `ft` keeps `t/src/med/cmp` either way.
 */
export function mergeCookie(existing: string | null, touch: Touch): string {
  const ft = parseCookie(existing)?.ft ?? touch
  const candidates: Attribution[] = [
    { v: 1, ft, lt: touch },
    { v: 1, ft, lt: slim(touch) },
    { v: 1, ft: slim(ft), lt: slim(touch) },
    { v: 1, ft: slim(ft), lt: null },
  ]
  for (const candidate of candidates) {
    const value = encode(candidate)
    if (fits(value)) return value
  }
  // Unreachable with the field caps above (a slimmed touch is < 1 KB encoded).
  return encode({
    v: 1,
    ft: { ...slim(ft), ref: null, gclid: null, fbclid: null },
    lt: null,
  })
}

function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/** The `document.cookie` assignment for a raw value on this host. */
export function cookieString(
  value: string,
  location: Pick<Location, 'hostname' | 'protocol'>,
): string {
  const parts = [`${COOKIE_NAME}=${value}`]
  if (location.hostname.toLowerCase().endsWith(SITE_DOMAIN)) {
    parts.push(`Domain=.${SITE_DOMAIN}`)
  }
  parts.push('Path=/', `Max-Age=${COOKIE_MAX_AGE}`, 'SameSite=Lax')
  if (location.protocol !== 'http:') parts.push('Secure')
  return parts.join('; ')
}

/**
 * Record this page view's touch, if any, into the `oc_attr` cookie. Called
 * once on first load, before PostHog init.
 */
export function recordTouch(
  location: Pick<Location, 'href' | 'hostname' | 'protocol'> = window.location,
  referrer: string = document.referrer,
  now: Date = new Date(),
  doc: { cookie: string } = document,
): void {
  const touch = computeTouch(location.href, referrer, now)
  if (!touch) return
  const value = mergeCookie(readCookie(doc.cookie, COOKIE_NAME), touch)
  doc.cookie = cookieString(value, location)
}
