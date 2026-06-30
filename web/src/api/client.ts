import posthog from 'posthog-js'
import { z } from 'zod'
import * as S from './schemas'

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
  StripeInvoice,
  SandboxUsageRow,
  SandboxUsage,
  BrowserSession,
  BrowserProfile,
  Agent,
  Session,
  SessionEvent,
  Turn,
  Destination,
  Delivery,
  SandboxWebhook,
  SandboxWebhookDelivery,
  Credential,
} from './schemas'

const API_BASE = '/api/dashboard'

// Validate a response against its schema. Always surfaces a mismatch; throws in
// dev (catches schema/backend drift during dev + against the preview mock), but
// in prod falls back to the raw data so a slightly-off schema can't take a
// screen down. Tighten to always-throw once the schemas are proven in prod.
function validate<T>(
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

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  // Opt-in, dev-only preview mode: serve canned data with no backend/auth so
  // the dashboard can be rendered locally (VITE_PREVIEW=1 npm run dev). Require
  // the exact value '1' so VITE_PREVIEW=0 / false don't accidentally serve
  // mocks; the dynamic import keeps the mock out of normal builds.
  if (import.meta.env.VITE_PREVIEW === '1') {
    const { mockFetch } = await import('./mock')
    return validate(schema, await mockFetch<unknown>(path, options), path)
  }

  const res = await fetch(`${API_BASE}${path}`, {
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
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    throw new Error(errorMessage(body, res.status))
  }

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

// API functions
export const getMe = () => apiFetch('/me', {}, S.MeResponseSchema)

export const getSandboxes = (status?: string) =>
  apiFetch(
    `/sessions${status ? `?status=${status}` : ''}`,
    {},
    S.SandboxListSchema,
  )

export const getAPIKeys = () =>
  apiFetch('/api-keys', {}, z.array(S.APIKeySchema))

export const createAPIKey = (name: string) =>
  apiFetch(
    '/api-keys',
    { method: 'POST', body: JSON.stringify({ name }) },
    S.CreatedAPIKeySchema,
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

export const updateOrg = (name: string) =>
  apiFetch(
    '/org',
    { method: 'PUT', body: JSON.stringify({ name }) },
    S.OrgSchema,
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

// url is non-null when enabling auto-recharge requires capturing an off-session
// card first — the caller redirects there (a no-charge Stripe setup session).
export const setAutumnAutoTopup = (cfg: {
  enabled: boolean
  threshold: number
  quantity: number
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

export const deleteBrowser = (id: string) =>
  apiFetch<void>(`/browsers/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const getBrowserProfiles = () =>
  apiFetch('/browser-profiles', {}, S.BrowserProfileListSchema).then(
    (r) => r.profiles,
  )

// ── Durable Agent Sessions ───────────────────────────────────────────────────
// A separate service (sessions-api). Reached through the OC edge under
// `/api/dashboard/v3/*`, so these reuse apiFetch (cookie auth, validation, mock).
// Org-key management lives server-side at the edge; live event/steer can move to
// a browser-direct client-token path later without changing these signatures.

// Agents — the reusable definition (prompt, model, runtime, credential).
// List endpoints wrap rows in { data: [...] }; callers want the array.
export const getAgents = () =>
  apiFetch('/v3/agents', {}, S.AgentListSchema).then((r) => r.data)

export const getAgent = (id: string) =>
  apiFetch(`/v3/agents/${id}`, {}, S.AgentSchema)

export const createAgent = (body: {
  name: string
  prompt: string
  model: string
  runtime: string
  // The request field is `credential` (the response carries `credential_id`).
  credential?: string
  // `key` sugar: mints a model credential of the runtime's provider for this
  // agent (write-only). Without it (and no org default) sessions 422 no_credential.
  key?: string
}) =>
  apiFetch(
    '/v3/agents',
    { method: 'POST', body: JSON.stringify(body) },
    S.AgentSchema,
  )

// PATCH bumps revision; name is immutable (create idempotency key). `credential`
// switches which credential the agent runs on; `key` (legacy) rotates the pinned
// credential's value — rotation now lives on the Credentials page.
export const updateAgent = (
  id: string,
  body: Partial<{
    prompt: string
    model: string
    key: string
    credential: string | null // null clears the pin → org default resolves
  }>,
) =>
  apiFetch(
    `/v3/agents/${id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    S.AgentSchema,
  )

// Slack — an agent's BYO Slack app (1 app ⟷ 1 agent ⟷ 1 workspace). Two-step
// connect: START (manifest) returns the app manifest + guided steps; COMPLETE
// posts the three pasted values back. No secrets are ever returned.
// `getSlackConnection` maps the 404 "not connected" into null so callers can
// branch on absence without treating it as an error.
export async function getSlackConnection(agentId: string) {
  try {
    return await apiFetch(
      `/v3/agents/${agentId}/slack`,
      {},
      S.SlackConnectionSchema,
    )
  } catch (e) {
    if (e instanceof Error && /no slack connection/i.test(e.message))
      return null
    throw e
  }
}

// `reconnect: true` is required to replace an ALREADY-ACTIVE connection (the server
// refuses to tear down a live one otherwise). First connect / pending / error → false.
export const startSlackConnect = (agentId: string, reconnect = false) =>
  apiFetch(
    `/v3/agents/${agentId}/slack/manifest`,
    { method: 'POST', body: JSON.stringify({ reconnect }) },
    S.SlackManifestResponseSchema,
  )

export const completeSlackConnect = (
  agentId: string,
  body: { app_id: string; bot_token: string; signing_secret: string },
) =>
  apiFetch(
    `/v3/agents/${agentId}/slack`,
    { method: 'POST', body: JSON.stringify(body) },
    S.SlackConnectionSchema,
  )

export const disconnectSlack = (agentId: string) =>
  apiFetch<void>(`/v3/agents/${agentId}/slack`, { method: 'DELETE' })

// Credentials — reusable model-provider keys (the raw key is write-only). An
// agent pins one (credential_id); sessions resolve the agent's, else the org
// default for the provider.
export const getCredentials = () =>
  apiFetch('/v3/credentials', {}, S.CredentialListSchema).then((r) => r.data)

export const createCredential = (body: {
  key: string
  provider?: string
  name?: string
  is_default?: boolean
}) =>
  apiFetch(
    '/v3/credentials',
    { method: 'POST', body: JSON.stringify(body) },
    S.CredentialSchema,
  )

export const deleteCredential = (id: string) =>
  apiFetch<void>(`/v3/credentials/${id}`, { method: 'DELETE' })

// Set the org default credential for its provider (the one sessions fall back to).
export const setDefaultCredential = (id: string) =>
  apiFetch(
    '/v3/credentials/default',
    { method: 'PUT', body: JSON.stringify({ credential: id }) },
    S.CredentialSchema,
  )

// Rotate a credential's secret VALUE (versioned, write-only key). Returns updated
// metadata (new last4). Switching which credential an agent uses is updateAgent({ credential }).
export const rotateCredential = (id: string, key: string) =>
  apiFetch(
    `/v3/credentials/${id}`,
    { method: 'PATCH', body: JSON.stringify({ key }) },
    S.CredentialSchema,
  )

// Sessions — the durable runs.
export const getSessions = (
  params: { agent?: string; status?: string; limit?: number; cursor?: string } = {},
) => {
  const q = new URLSearchParams()
  if (params.agent) q.set('agent', params.agent)
  if (params.status) q.set('status', params.status)
  if (params.limit) q.set('limit', String(params.limit))
  if (params.cursor) q.set('cursor', params.cursor)
  const qs = q.toString()
  return apiFetch(
    `/v3/sessions${qs ? `?${qs}` : ''}`,
    {},
    S.SessionListSchema,
  ).then((r) => r.data)
}

export const getSession = (id: string) =>
  apiFetch(`/v3/sessions/${id}`, {}, S.SessionSchema)

// The API wants { agent: <id>, input } (input required). The response is an envelope
// { session, client_token } — return the session.
export const createSession = (
  body: { agent: string; input: string },
  idempotencyKey?: string,
) =>
  apiFetch(
    '/v3/sessions',
    {
      method: 'POST',
      body: JSON.stringify(body),
      // sessions-api dedups create on the Idempotency-Key header (the edge proxy
      // forwards it) so a retried start-session is safe.
      headers: idempotencyKey
        ? { 'Idempotency-Key': idempotencyKey }
        : undefined,
    },
    z.object({ session: S.SessionSchema, client_token: z.string().optional() }),
  ).then((r) => r.session)

export const cancelSession = (id: string) =>
  apiFetch<void>(`/v3/sessions/${id}/cancel`, { method: 'POST' })

export const archiveSession = (id: string) =>
  apiFetch<void>(`/v3/sessions/${id}/archive`, { method: 'POST' })

// Events — append-only session log. Plain GET today; an SSE (`?stream=sse`)
// browser-direct path replaces the fetch in the live view later.
export const getSessionEvents = (id: string, level?: string) =>
  apiFetch(
    `/v3/sessions/${id}/events${level ? `?level=${level}` : ''}`,
    {},
    S.SessionEventListSchema,
  ).then((r) => r.data)

// Steer — post a user message into a session.
export const sendMessage = (
  id: string,
  text: string,
  idempotencyKey?: string,
) =>
  apiFetch<{ event: { id: string; seq: number } }>(
    `/v3/sessions/${id}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ text, idempotency_key: idempotencyKey }),
    },
  )

// Webhooks — destinations are session-scoped.
export const getDestinations = (id: string) =>
  apiFetch(
    `/v3/sessions/${id}/destinations`,
    {},
    z.object({
      data: z.array(S.DestinationSchema),
      next_cursor: z.string().nullish(),
    }),
  ).then((r) => r.data)

export const createDestination = (
  id: string,
  body: {
    url: string
    secret?: string
    level?: string
    types?: string[]
  },
) =>
  apiFetch(
    `/v3/sessions/${id}/destinations`,
    { method: 'POST', body: JSON.stringify(body) },
    S.DestinationSchema,
  )

export const deleteDestination = (id: string, did: string) =>
  apiFetch<void>(`/v3/sessions/${id}/destinations/${did}`, { method: 'DELETE' })

// Deliveries — the send ledger for a session's destinations.
export const getDeliveries = (id: string) =>
  apiFetch(
    `/v3/sessions/${id}/deliveries`,
    {},
    z.object({
      data: z.array(S.DeliverySchema),
      next_cursor: z.string().nullish(),
    }),
  ).then((r) => r.data)

export const redeliver = (id: string, deliveryId: string) =>
  apiFetch<void>(`/v3/sessions/${id}/deliveries/${deliveryId}/redeliver`, {
    method: 'POST',
  })

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
