import posthog from 'posthog-js'
import { z } from 'zod'
import * as S from './schemas'
import { ApiError } from './errors'

export { ApiError } from './errors'

// Re-export the inferred response types (schemas are the single source of
// truth) so existing `import { type APIKey } from '@/api/client'` keeps working.
export type {
  OrgInfo,
  MeResponse,
  Org,
  APIKey,
  OrgMember,
  OrgInvitation,
  Credits,
  BillingState,
  AutumnAutoTopup,
  AutumnBilling,
  AgentSessionUsage,
  AgentSessionUsageRow,
  StripeInvoice,
  BrowserSession,
  BrowserProfile,
} from './schemas'

const API_BASE = '/api/dashboard'

// Validate a response against its schema. Always surfaces a mismatch; throws in
// dev (catches schema/backend drift during dev + against the preview mock), but
// in prod falls back to the raw data so a slightly-off schema can't take a
// screen down. Tighten to always-throw once the schemas are proven in prod.
export function validate<T>(
  schema: z.ZodType<T> | undefined,
  data: unknown,
  path: string,
): T {
  if (!schema) return data as T
  const result = schema.safeParse(data)
  if (result.success) return result.data
  console.error(
    `[api] ${path} response failed validation:`,
    result.error.issues,
  )
  if (import.meta.env.DEV) {
    throw new Error(`${path}: response did not match the expected shape`)
  }
  return data as T
}

// Extract a human message from an error body of unknown shape. OC dashboard
// returns {error: "string"}; sessions-api returns {error: {type, message}}.
function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.error === 'string') return b.error
    if (b.error && typeof b.error === 'object') {
      const inner = (b.error as Record<string, unknown>).message
      if (typeof inner === 'string') return inner
    }
    if (typeof b.message === 'string') return b.message
  }
  return `Request failed: ${status}`
}

// The typed discriminator APIs put on `{error:{type,…}}` or
// `{error:{code,…}}`, so callers can branch on the reason, not the status alone.
function errorType(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const err = (body as Record<string, unknown>).error
    if (err && typeof err === 'object') {
      const structured = err as Record<string, unknown>
      if (typeof structured.type === 'string') return structured.type
      if (typeof structured.code === 'string') return structured.code
    }
  }
  return undefined
}

function errorDetails(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined
  const error = (body as Record<string, unknown>).error
  return error && typeof error === 'object' && !Array.isArray(error)
    ? (error as Record<string, unknown>)
    : undefined
}

// The authenticated request with error normalization, returning the raw
// Response for callers that need headers (a memory document's ETag) as well
// as the body. `apiFetch` is the JSON-and-schema layer over it.
// `base` is `/api` for the public API's routes a dashboard session may also
// call, such as the computer's secrets (work 095).
export async function apiFetchResponse(
  path: string,
  options: RequestInit = {},
  base: '/api' | typeof API_BASE = API_BASE,
): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (res.status === 401) {
    // Don't auto-redirect — let ProtectedRoute handle auth flow.
    // This prevents a redirect loop on the login page.
    throw new ApiError('Unauthorized', 401)
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    throw new ApiError(
      errorMessage(body, res.status),
      res.status,
      errorType(body),
      errorDetails(body),
    )
  }
  return res
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  schema?: z.ZodType<T>,
  base: '/api' | typeof API_BASE = API_BASE,
): Promise<T> {
  // Opt-in, dev-only preview mode: serve canned data with no backend/auth so
  // the dashboard can be rendered locally (VITE_PREVIEW=1 npm run dev). Require
  // the exact value '1' so VITE_PREVIEW=0 / false don't accidentally serve
  // mocks; the dynamic import keeps the mock out of normal builds.
  if (import.meta.env.VITE_PREVIEW === '1') {
    const { mockFetch } = await import('./mock')
    return validate(schema, await mockFetch<unknown>(path, options), path)
  }

  const res = await apiFetchResponse(path, options, base)

  if (res.status === 204) {
    return undefined as T
  }

  return validate(schema, await res.json(), path)
}

// Logout: the backend clears cookies and returns WorkOS's hosted logout URL,
// which ends the WorkOS session and redirects to the dashboard-configured
// Sign-out redirect (so we're not instantly re-logged-in). Navigate there.
// Fall back to /auth/login only when there was no WorkOS session to end.
export async function logout(): Promise<void> {
  let dest = '/auth/login'
  try {
    const res = await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
    const body: unknown = await res.json().catch(() => ({}))
    if (body && typeof body === 'object') {
      const url = (body as Record<string, unknown>).logoutUrl
      if (typeof url === 'string' && url) dest = url
    }
  } catch {
    // ignore — fall back to /auth/login
  }
  posthog.reset()
  window.location.replace(dest)
}

// Rotate the session cookie so an open tab keeps a sliding expiry instead of
// hitting the fixed TTL mid-page. Best-effort: not every backend serves the
// route, and a failure here just means the next 401 sends the user through
// the normal login round-trip.
export async function refreshSession(): Promise<void> {
  if (import.meta.env.VITE_PREVIEW === '1') return
  try {
    await fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
  } catch {
    // ignore
  }
}

// API functions
export const getMe = () => apiFetch('/me', {}, S.MeResponseSchema)

export const getAPIKeys = () =>
  apiFetch('/api-keys', {}, z.array(S.APIKeySchema))

export const createAPIKey = (name: string, expiresAt?: string) =>
  apiFetch(
    '/api-keys',
    { method: 'POST', body: JSON.stringify({ name, expiresAt }) },
    S.CreatedAPIKeySchema,
  )

export const renameAPIKey = (keyId: string, name: string) =>
  apiFetch(
    `/api-keys/${keyId}`,
    { method: 'PATCH', body: JSON.stringify({ name }) },
    S.APIKeySchema,
  )

export const deleteAPIKey = (keyId: string) =>
  apiFetch<void>(`/api-keys/${keyId}`, { method: 'DELETE' })

export const getOrg = () => apiFetch('/org', {}, S.OrgSchema)

export type OrgUpdate = {
  name?: string
}

export const updateOrg = (updates: OrgUpdate) =>
  apiFetch(
    '/org',
    { method: 'PUT', body: JSON.stringify(updates) },
    S.OrgSchema,
  )

export type NavigationPreferenceUpdate = {
  infrastructureEnabled?: boolean
}

export const updateNavigationPreferences = (
  updates: NavigationPreferenceUpdate,
) =>
  apiFetch(
    '/me/preferences',
    { method: 'PUT', body: JSON.stringify(updates) },
    S.MeResponseSchema,
  )

export const setCustomDomain = (domain: string) =>
  apiFetch(
    '/org/custom-domain',
    { method: 'PUT', body: JSON.stringify({ domain }) },
    S.OrgSchema,
  )

export const deleteCustomDomain = () =>
  apiFetch('/org/custom-domain', { method: 'DELETE' }, S.OrgSchema)

export const refreshCustomDomain = () =>
  apiFetch('/org/custom-domain/refresh', { method: 'POST' }, S.OrgSchema)

// Organization members
export const getOrgMembers = () =>
  apiFetch('/org/members', {}, z.array(S.OrgMemberSchema))

export const removeMember = (membershipId: string) =>
  apiFetch<void>(`/org/members/${membershipId}`, { method: 'DELETE' })

// Invitations
export const sendInvitation = (email: string, role = 'member') =>
  apiFetch(
    '/org/invitations',
    { method: 'POST', body: JSON.stringify({ email, role }) },
    S.OrgInvitationSchema,
  )

export const getInvitations = () =>
  apiFetch('/org/invitations', {}, z.array(S.OrgInvitationSchema))

export const revokeInvitation = (id: string) =>
  apiFetch<void>(`/org/invitations/${id}`, { method: 'DELETE' })

// Org switching
export const listOrgs = () => apiFetch('/orgs', {}, z.array(S.OrgInfoSchema))

export const switchOrg = (orgId: string) =>
  apiFetch(
    '/org/switch',
    { method: 'POST', body: JSON.stringify({ orgId }) },
    S.OrgSchema,
  )

// Credits
export const getCredits = () => apiFetch('/org/credits', {}, S.CreditsSchema)

// Billing API
export const getBilling = () => apiFetch('/billing', {}, S.BillingStateSchema)

export const billingSetup = () =>
  apiFetch<{ url: string }>('/billing/setup', { method: 'POST' })

export const billingPortal = () =>
  apiFetch<{ url: string }>('/billing/portal', { method: 'POST' })

export const getBillingInvoices = (limit = 10) =>
  apiFetch(`/billing/invoices?limit=${limit}`, {}, S.InvoicesResponseSchema)

export const redeemPromoCode = (code: string) =>
  apiFetch<{ creditAppliedCents: number }>('/billing/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })

// Autumn prepaid billing API
export const getAutumnBilling = () =>
  apiFetch('/billing/autumn', {}, S.AutumnBillingSchema)

export const getAgentSessionUsage = (limit = 50) =>
  apiFetch(
    `/managed-agents/billing/sessions?limit=${limit}`,
    {},
    S.AgentSessionUsageSchema,
  )

// url is non-null → redirect to a hosted Stripe flow (no card yet); null → the
// existing card was charged server-side, so just refresh the balance.
export const autumnTopup = (credits: number) =>
  apiFetch<{ url: string | null }>('/billing/autumn/topup', {
    method: 'POST',
    body: JSON.stringify({ credits }),
  })

export const autumnSubscribeConcurrency = (plan: string) =>
  apiFetch<{ url: string | null }>('/billing/autumn/concurrency', {
    method: 'POST',
    body: JSON.stringify({ plan }),
  })

// Where a checkout was opened from; the edge records it on
// billing.checkout_opened.
export type CheckoutFrom = 'paywall' | 'warning' | 'billing_page' | 'signup'

export const autumnSubscribeUsagePlan = (
  plan: 'pro' | 'max',
  from: CheckoutFrom = 'billing_page',
) =>
  apiFetch<{ url: string | null }>('/billing/autumn/plan', {
    method: 'POST',
    body: JSON.stringify({ plan, from }),
  })

// Cancel the paid plan at the end of the period, or undo that (undo also
// drops a scheduled $200 → $20 downgrade).
export const autumnCancelPlan = (plan: 'pro' | 'max', undo = false) =>
  apiFetch<{ ok: boolean }>('/billing/autumn/cancel', {
    method: 'POST',
    body: JSON.stringify({ plan, undo }),
  })

// Open Autumn's Stripe-hosted billing portal to manage the saved card + invoices.
export const autumnBillingPortal = () =>
  apiFetch<{ url: string }>('/billing/autumn/portal', { method: 'POST' })

// url is non-null when enabling auto-recharge requires capturing an off-session
// card first — the caller redirects there (a no-charge Stripe setup session).
export const setAutumnAutoTopup = (cfg: {
  enabled: boolean
  threshold: number
  quantity: number
  budget: number
}) =>
  apiFetch<{ ok: boolean; url?: string | null }>('/billing/autumn/auto-topup', {
    method: 'POST',
    body: JSON.stringify(cfg),
  })

export const getBrowsers = (
  params: { status?: string; limit?: number } = {},
) => {
  const q = new URLSearchParams()
  if (params.status) q.set('status', params.status)
  if (params.limit) q.set('limit', String(params.limit))
  const qs = q.toString()
  return apiFetch(
    `/browsers${qs ? `?${qs}` : ''}`,
    {},
    S.BrowserSessionListSchema,
  ).then((r) => r.browsers)
}

export const getBrowser = (id: string) =>
  apiFetch(`/browsers/${encodeURIComponent(id)}`, {}, S.BrowserSessionSchema)

export const getBrowserUsage = () =>
  apiFetch('/browser-usage', {}, S.BrowserUsageSchema)

export const deleteBrowser = (id: string) =>
  apiFetch<void>(`/browsers/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const getBrowserProfiles = () =>
  apiFetch('/browser-profiles', {}, S.BrowserProfileListSchema).then(
    (r) => r.profiles,
  )
