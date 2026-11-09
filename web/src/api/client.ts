import posthog from 'posthog-js'
import { z } from 'zod'
import * as S from './schemas'
import { ApiError } from './errors'

export { ApiError } from './errors'

// Re-export the inferred response types (schemas are the single source of
// truth) so existing `import { type Sandbox } from '@/api/client'` keeps working.
export type {
  OrgInfo,
  MeResponse,
  Sandbox,
  PreviewURL,
  SandboxDetail,
  SandboxStats,
  CheckpointItem,
  CheckpointsResponse,
  ImageCacheItem,
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
  SandboxUsageRow,
  SandboxUsage,
  BrowserSession,
  BrowserProfile,
  SandboxWebhook,
  SandboxWebhookDelivery,
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

export const getSandboxes = (status?: string) =>
  apiFetch(
    `/sessions${status ? `?status=${status}` : ''}`,
    {},
    S.SandboxListSchema,
  )

// Create a sandbox from the dashboard. Proxied by the edge to the org's home
// cell (POST /api/dashboard/sandboxes → cell /internal/sandboxes/create with a
// cap-token), so the box is owned by + billed to the logged-in org. Returns the
// new sandbox id so the caller can navigate straight into its live terminal.
export const createSandbox = (body: {
  memoryMB?: number
  cpuCount?: number
  networkEnabled?: boolean
  image?: string
}) =>
  apiFetch<{ sandboxID: string; status?: string }>('/sandboxes', {
    method: 'POST',
    body: JSON.stringify(body),
  })

// Expose a port on a running sandbox → a public preview URL (proxied edge→cell
// to the cap-token-authed /api/sandboxes/:id/preview). Returns the registered
// row incl. hostname; the sandbox detail page renders it in Preview URLs.
export const createPreviewUrl = (sandboxId: string, port: number) =>
  apiFetch<{ id: string; sandboxId: string; hostname: string; port: number }>(
    `/sandboxes/${sandboxId}/preview`,
    { method: 'POST', body: JSON.stringify({ port }) },
  )

export const deletePreviewUrl = (sandboxId: string, port: number) =>
  apiFetch<void>(`/sandboxes/${sandboxId}/preview/${port}`, {
    method: 'DELETE',
  })

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

export const getCheckpoints = (page = 1, perPage = 20) =>
  apiFetch(
    `/checkpoints?page=${page}&per_page=${perPage}`,
    {},
    S.CheckpointsResponseSchema,
  )

export const deleteCheckpointDashboard = (id: string) =>
  apiFetch<void>(`/checkpoints/${id}`, { method: 'DELETE' })

export const getImages = (all = false) =>
  apiFetch(
    `/images${all ? '?all=true' : ''}`,
    {},
    z.array(S.ImageCacheItemSchema),
  )

export const deleteImage = (id: string) =>
  apiFetch<void>(`/images/${id}`, { method: 'DELETE' })

export const deleteSnapshot = (name: string) =>
  apiFetch<void>(`/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' })

export const getSandboxDetail = (sandboxId: string) =>
  apiFetch(`/sessions/${sandboxId}`, {}, S.SandboxDetailSchema)

export const getSandboxStats = (sandboxId: string) =>
  apiFetch(`/sessions/${sandboxId}/stats`, {}, S.SandboxStatsSchema)

export const deleteSandbox = (sandboxId: string) =>
  apiFetch<void>(`/sessions/${sandboxId}`, { method: 'DELETE' })

// Soft restart: guest kernel reboots, QEMU process + workspace stay.
export const rebootSandbox = (sandboxId: string) =>
  apiFetch<void>(`/sessions/${sandboxId}/reboot`, { method: 'POST' })

// Hard restart: QEMU process recreated, workspace data preserved.
export const powerCycleSandbox = (sandboxId: string) =>
  apiFetch<void>(`/sessions/${sandboxId}/power-cycle`, { method: 'POST' })

// Sandbox session logs: SSE stream of /var/log + exec stdout/stderr.
// The server proxies queries through to Axiom; the read token never
// reaches the browser. The returned EventSource emits one `message`
// event per log line (event.data = JSON-stringified LogEvent).
export interface LogEvent {
  _time: string
  source: 'var_log' | 'exec_stdout' | 'exec_stderr' | 'agent'
  line: string
  sandbox_id?: string
  path?: string
  exec_id?: string
  command?: string
  argv?: string[]
  exit_code?: number
  // Client-assigned monotonic ingest order. Not from the API — set on parse so
  // the live list has a stable React key under filtering + cap trimming.
  _seq?: number
}

export interface LogStreamOptions {
  tail?: boolean // default true; if false, returns historical batch then closes
  q?: string // free-text search (server applies "line contains")
  source?: string // comma-separated subset of source values
  since?: string // RFC3339; default = sandbox.startedAt
  limit?: number // historical batch cap; default 1000, max 10000
}

export function streamSandboxLogs(
  sandboxId: string,
  opts: LogStreamOptions = {},
): EventSource {
  const url = new URL(
    `${API_BASE}/sessions/${encodeURIComponent(sandboxId)}/logs`,
    window.location.origin,
  )
  if (opts.tail !== undefined) url.searchParams.set('tail', String(opts.tail))
  if (opts.q) url.searchParams.set('q', opts.q)
  if (opts.source) url.searchParams.set('source', opts.source)
  if (opts.since) url.searchParams.set('since', opts.since)
  if (opts.limit !== undefined)
    url.searchParams.set('limit', String(opts.limit))
  return new EventSource(url.toString(), { withCredentials: true })
}

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

// Per-sandbox usage breakdown (compute cost over a recent window)
export const getSandboxUsage = (days = 30) =>
  apiFetch(`/usage/sandboxes?days=${days}`, {}, S.SandboxUsageSchema)

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

// ── Sandbox lifecycle webhooks (org-scoped, Svix-backed at the edge) ─────────
// Reached via /api/dashboard/webhooks* (cookie auth → org), mirroring the public
// /api/webhooks API.
export const getSandboxWebhooks = () =>
  apiFetch('/webhooks', {}, S.SandboxWebhookListSchema).then((r) => r.data)

// No BYO secret: Svix generates the signing secret (a user-typed value isn't
// valid Svix whsec_ base64). Reveal it afterward via getSandboxWebhookSecret.
export const createSandboxWebhook = (body: {
  url: string
  eventTypes?: string[]
  name?: string
}) =>
  apiFetch(
    '/webhooks',
    { method: 'POST', body: JSON.stringify(body) },
    S.SandboxWebhookSchema,
  )

export const deleteSandboxWebhook = (id: string) =>
  apiFetch<void>(`/webhooks/${id}`, { method: 'DELETE' })

export const testSandboxWebhook = (id: string) =>
  apiFetch<void>(`/webhooks/${id}/test`, { method: 'POST' })

export const getSandboxWebhookDeliveries = (id: string) =>
  apiFetch(
    `/webhooks/${id}/deliveries`,
    {},
    S.SandboxWebhookDeliveryListSchema,
  ).then((r) => r.data)

export const getSandboxWebhookSecret = (id: string) =>
  apiFetch(`/webhooks/${id}/secret`, {}, z.object({ secret: z.string() })).then(
    (r) => r.secret,
  )

export const redeliverSandboxWebhook = (id: string, deliveryId: string) =>
  apiFetch<void>(`/webhooks/${id}/deliveries/${deliveryId}/redeliver`, {
    method: 'POST',
  })
