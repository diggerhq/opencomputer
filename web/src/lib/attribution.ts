// Sign-up attribution capture (design C1/C2, `oc_attr` cookie).
//
// The marketing site and the dashboard both write the same first-party cookie
// on `.opencomputer.dev`, so the API edge can read first- and last-touch
// source when the account is created. The contract is shared with the site
// script: field names, limits and merge rules here must stay byte-for-byte
// identical to design C1.

export const COOKIE_NAME = 'oc_attr'
export const COOKIE_MAX_AGE = 7_776_000 // 90 days
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
  ft: Touch
  lt: Touch
}

const TOUCH_KEYS = [
  'src',
  'med',
  'cmp',
  'term',
  'cnt',
  'ref',
  'lp',
  'gclid',
  'fbclid',
] as const

function utm(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)
  if (value === null) return null
  const clean = value.trim().toLowerCase().slice(0, UTM_LIMIT)
  return clean === '' ? null : clean
}

function clickID(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)
  if (value === null) return null
  const clean = value.trim().slice(0, URL_LIMIT)
  return clean === '' ? null : clean
}

function hostAndPath(url: URL): string {
  return (url.host + url.pathname).slice(0, URL_LIMIT)
}

function parseURL(value: string): URL | null {
  if (!value) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isExternalHost(host: string): boolean {
  return !host.toLowerCase().endsWith(SITE_DOMAIN)
}

/**
 * The touch this page view represents, or null when it carries none: no
 * `utm_*`, `gclid` or `fbclid` parameter and no external referrer (internal
 * navigation records nothing).
 */
export function computeTouch(
  url: string,
  referrer: string,
  now: Date,
): Touch | null {
  const landing = parseURL(url)
  if (!landing) return null
  const params = landing.searchParams
  const ref = parseURL(referrer)

  let tagged = false
  for (const [key, value] of params) {
    if (
      (key.startsWith('utm_') || key === 'gclid' || key === 'fbclid') &&
      value.trim() !== ''
    ) {
      tagged = true
      break
    }
  }
  const external =
    ref !== null && ref.host !== '' && isExternalHost(ref.hostname)
  if (!tagged && !external) return null

  return {
    t: Math.floor(now.getTime() / 1000),
    src: utm(params, 'utm_source'),
    med: utm(params, 'utm_medium'),
    cmp: utm(params, 'utm_campaign'),
    term: utm(params, 'utm_term'),
    cnt: utm(params, 'utm_content'),
    ref: ref && ref.host !== '' ? hostAndPath(ref) : null,
    lp: hostAndPath(landing),
    gclid: clickID(params, 'gclid'),
    fbclid: clickID(params, 'fbclid'),
  }
}

function isTouch(value: unknown): value is Touch {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.t !== 'number' || !Number.isFinite(record.t)) return false
  return TOUCH_KEYS.every(
    (key) => record[key] === null || typeof record[key] === 'string',
  )
}

function normalizeTouch(touch: Touch): Touch {
  return {
    t: touch.t,
    src: touch.src,
    med: touch.med,
    cmp: touch.cmp,
    term: touch.term,
    cnt: touch.cnt,
    ref: touch.ref,
    lp: touch.lp,
    gclid: touch.gclid,
    fbclid: touch.fbclid,
  }
}

/** Parse a raw (URL-encoded) `oc_attr` value; null when absent or malformed. */
export function parseCookie(raw: string | null): Attribution | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.v !== 1 || !isTouch(record.ft) || !isTouch(record.lt)) {
      return null
    }
    return {
      v: 1,
      ft: normalizeTouch(record.ft),
      lt: normalizeTouch(record.lt),
    }
  } catch {
    return null
  }
}

/**
 * Merge a touch into the existing raw cookie value and return the new raw
 * (URL-encoded JSON) value. `ft` is kept once written; `lt` is always
 * replaced. A malformed cookie is replaced as if absent.
 */
export function mergeCookie(existing: string | null, touch: Touch): string {
  const current = parseCookie(existing)
  const next: Attribution = {
    v: 1,
    ft: current ? current.ft : normalizeTouch(touch),
    lt: normalizeTouch(touch),
  }
  return encodeURIComponent(JSON.stringify(next))
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
