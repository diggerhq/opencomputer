import posthog from 'posthog-js'
import { z } from 'zod'
import * as S from './schemas'

// Re-export the inferred response types (schemas are the single source of
// truth) so existing `import { type Session } from '@/api/client'` keeps working.
export type {
  OrgInfo,
  MeResponse,
  Session,
  PreviewURL,
  SessionDetail,
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

export const getSessions = (status?: string) =>
  apiFetch(
    `/sessions${status ? `?status=${status}` : ''}`,
    {},
    S.SessionListSchema,
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

export const getSessionDetail = (sandboxId: string) =>
  apiFetch(`/sessions/${sandboxId}`, {}, S.SessionDetailSchema)

export const getSessionStats = (sandboxId: string) =>
  apiFetch(`/sessions/${sandboxId}/stats`, {}, S.SandboxStatsSchema)

export const deleteSession = (sandboxId: string) =>
  apiFetch<void>(`/sessions/${sandboxId}`, { method: 'DELETE' })

// Soft restart: guest kernel reboots, QEMU process + workspace stay.
export const rebootSession = (sandboxId: string) =>
  apiFetch<void>(`/sessions/${sandboxId}/reboot`, { method: 'POST' })

// Hard restart: QEMU process recreated, workspace data preserved.
export const powerCycleSession = (sandboxId: string) =>
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
}

export interface LogStreamOptions {
  tail?: boolean // default true; if false, returns historical batch then closes
  q?: string // free-text search (server applies "line contains")
  source?: string // comma-separated subset of source values
  since?: string // RFC3339; default = sandbox.startedAt
  limit?: number // historical batch cap; default 1000, max 10000
}

export function streamSessionLogs(
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

// ── Agents (proxied to sessions-api at /api/dashboard/agents/*) ──

export interface Agent {
  id: string
  display_name: string
  core: string | null
  model: string | null
  channels: Array<{
    name: string
    bot_username?: string | null
    connected_at?: string
  }>
  packages: Array<{ name: string; installed_at?: string }>
  secret_store: string | null
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface AgentDetail extends Agent {
  status: 'ready' | 'starting' | 'degraded' | 'error' | 'unknown'
  instance_id: string | null
  instance_status: string | null
  sandbox_id: string | null
  core_status: {
    status: string
    reason?: string
    message?: string
    updated_at?: string
  } | null
  channel_status: Record<
    string,
    { status: string; phase?: string; message?: string }
  >
  package_status: Record<
    string,
    { status: string; phase?: string; message?: string }
  >
  conditions: Array<{
    type: string
    status: string
    reason?: string
    message?: string
  }>
  current_operation: AgentOperation | null
  last_error: { phase: string; message: string; at: string } | null
}

export interface AgentOperation {
  id: string
  agent_id: string
  kind: string
  target_type?: string | null
  target_key?: string | null
  phase: string
  state: 'queued' | 'running' | 'success' | 'error' | 'canceled'
  message?: string | null
  created_at: string
  updated_at: string
}

export const listAgents = () => apiFetch<{ agents: Agent[] }>('/agents')

export const getAgent = (id: string) =>
  apiFetch<AgentDetail>(`/agents/${encodeURIComponent(id)}`)

export const createAgent = (input: {
  id: string
  display_name?: string
  core?: string
  model?: string
  config?: Record<string, unknown>
  secrets?: Record<string, string>
}) =>
  apiFetch<AgentDetail>('/agents', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const deleteAgent = (id: string) =>
  apiFetch<{ id: string; deleted: boolean }>(
    `/agents/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
  )

export const installGbrain = (agentId: string) =>
  apiFetch<{
    agent_id: string
    package: string
    status: string
    operation: AgentOperation
  }>(`/agents/${encodeURIComponent(agentId)}/packages/gbrain`, {
    method: 'POST',
  })

export const uninstallGbrain = (agentId: string) =>
  apiFetch<{ agent_id: string; package: string; status: string }>(
    `/agents/${encodeURIComponent(agentId)}/packages/gbrain`,
    { method: 'DELETE' },
  )

export const connectTelegram = (agentId: string, botToken: string) =>
  apiFetch<{
    agent_id: string
    channel: string
    status: string
    operation: AgentOperation
  }>(`/agents/${encodeURIComponent(agentId)}/channels/telegram`, {
    method: 'POST',
    body: JSON.stringify({ bot_token: botToken }),
  })

export const disconnectTelegram = (agentId: string) =>
  apiFetch<{ agent_id: string; channel: string; status: string }>(
    `/agents/${encodeURIComponent(agentId)}/channels/telegram`,
    { method: 'DELETE' },
  )

export interface AgentEvent {
  id: string
  agent_id: string
  type: 'info' | 'warning' | 'error'
  phase: string
  message: string
  at: string
}

export const getAgentEvents = (agentId: string, limit = 50) =>
  apiFetch<{ events: AgentEvent[]; next_before: string | null }>(
    `/agents/${encodeURIComponent(agentId)}/events?limit=${limit}`,
  )

export const getAgentOperations = (agentId: string, limit = 20) =>
  apiFetch<{ operations: AgentOperation[]; next_before: string | null }>(
    `/agents/${encodeURIComponent(agentId)}/operations?limit=${limit}`,
  )

export const restartAgent = (agentId: string) =>
  apiFetch<{ agent_id: string; status: string }>(
    `/agents/${encodeURIComponent(agentId)}/restart`,
    { method: 'POST' },
  )

export const getAgentLogs = (agentId: string, tail = 300) =>
  apiFetch<{
    agent_id: string
    sandbox_id: string
    source: string
    lines: number
    content: string
  }>(`/agents/${encodeURIComponent(agentId)}/logs?tail=${tail}`)

// ── Per-agent paywalled feature subscriptions (Telegram et al) ──

// Known values: 'ungated' | 'subscription_required'; typed as string so a new
// server reason never fails typing.
export type EntitlementReason = string

export interface AgentEntitlement {
  feature: string
  entitled: boolean
  reason?: EntitlementReason
  price_monthly_cents?: number
  status?: string
  current_period_end?: string
  cancel_at_period_end?: boolean
  stripe_subscription_id?: string
}

export const listAgentEntitlements = (agentId: string) =>
  apiFetch<{ agent_id: string; entitlements: AgentEntitlement[] }>(
    `/agents/${encodeURIComponent(agentId)}/entitlements`,
  )

export type SubscribeResult =
  | {
      status: 'active'
      feature: string
      agent_id: string
      subscription_id: string
      price_id: string
    }
  | {
      status: 'already_subscribed'
      feature: string
      agent_id: string
      subscription_id: string
    }
  | { status: 'ungated'; feature: string; agent_id: string }
  | {
      status: 'checkout_required'
      feature: string
      agent_id: string
      checkout_url: string
    }

export const subscribeAgentFeature = (agentId: string, feature: string) =>
  apiFetch<SubscribeResult>(
    `/agents/${encodeURIComponent(agentId)}/subscriptions/${encodeURIComponent(feature)}`,
    { method: 'POST' },
  )

export interface OrgAgentSubscription {
  agent_id: string
  feature: string
  status: string
  active: boolean
  price_monthly_cents: number
  current_period_end?: string
  cancel_at_period_end: boolean
  canceled_at?: string
  created_at: string
  stripe_subscription_id: string
}

export const listOrgAgentSubscriptions = () =>
  apiFetch<{ subscriptions: OrgAgentSubscription[] }>(
    '/billing/agent-subscriptions',
  )

export const cancelAgentFeature = (agentId: string, feature: string) =>
  apiFetch<{
    status: string
    feature: string
    agent_id: string
    cancel_at_period_end: boolean
    current_period_end?: string
  }>(
    `/agents/${encodeURIComponent(agentId)}/subscriptions/${encodeURIComponent(feature)}`,
    { method: 'DELETE' },
  )

/**
 * Streams a chat turn to an agent's instance and yields parsed SSE events
 * as they arrive. The upstream (sessions-api POST /v1/agents/:id/instances/:id/messages)
 * emits `data: {type:"text",content:"..."}` and `data: {type:"done"}`.
 *
 * Uses fetch + ReadableStream because EventSource is GET-only.
 */
export type ChatEvent =
  | { type: 'text'; content: string; conversation_id?: string }
  | { type: 'done' }
  | { type: 'raw'; data: string }

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export async function* streamAgentChat(
  agentId: string,
  instanceId: string,
  content: string,
  conversationId?: string,
  history?: ChatTurn[],
): AsyncGenerator<ChatEvent, void, unknown> {
  // OpenAI-style chat-completions is stateless: the gateway needs the
  // full conversation each turn to have any memory of prior messages.
  // Caller passes `history` (already including the new user turn).
  // For backwards compat with older callers, we still accept `content`
  // as a single-turn shortcut.
  const body: Record<string, unknown> = {}
  if (history && history.length > 0) {
    body.messages = history
  } else {
    body.content = content
  }
  if (conversationId) body.conversation_id = conversationId

  const res = await fetch(
    `/api/dashboard/agents/${encodeURIComponent(agentId)}/instances/${encodeURIComponent(instanceId)}/messages`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`chat ${res.status}: ${text || 'no body'}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      try {
        yield JSON.parse(data) as ChatEvent
      } catch {
        yield { type: 'raw', data }
      }
    }
  }
}
