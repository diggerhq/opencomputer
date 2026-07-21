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
  AgentRevision,
  AgentSkills,
  SkillItem,
  AgentDeploy,
  AgentDeployment,
  AgentDeploymentLog,
  DeployApp,
  RepositoryAccess,
  RepositoryAccessPolicy,
  RepositoryAccessRepository,
  RepositorySourceInspection,
  ManagedSlackAuthorizeResponse,
  ManagedSlackConnection,
  ManagedSlackWorkspaceConnection,
  ManagedSlackDisconnectResponse,
  Session,
  SessionSource,
  AgentSnapshot,
  SessionEvent,
  Turn,
  SessionResult,
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

// The typed discriminator sessions-api puts on `{error:{type,…}}` (e.g.
// "insufficient_credits"), so callers can branch on the reason, not the status alone.
function errorType(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const err = (body as Record<string, unknown>).error
    if (
      err &&
      typeof err === 'object' &&
      typeof (err as Record<string, unknown>).type === 'string'
    ) {
      return (err as Record<string, unknown>).type as string
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

/** An error carrying the HTTP status + the API's typed reason, so callers can branch
 *  (e.g. 404 = not-found; 402 `insufficient_credits` = out of credits → top-up CTA). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
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

// Open Autumn's Stripe-hosted billing portal to manage the saved card + invoices.
export const autumnBillingPortal = () =>
  apiFetch<{ url: string }>('/billing/autumn/portal', { method: 'POST' })

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

export const getBrowserUsage = () =>
  apiFetch('/browser-usage', {}, S.BrowserUsageSchema)

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

// Agent Revisions (design 009) — the deploy history of an agent's behavior. List
// endpoints wrap rows in { data: [...] }; callers want the array. Rollback = activate
// an earlier revision (by id or number); it moves the production pointer.
export const getAgentRevisions = (agentId: string) =>
  apiFetch(
    `/v3/agents/${agentId}/revisions`,
    {},
    S.AgentRevisionListSchema,
  ).then((r) => r.data)

export const getAgentDeploys = (agentId: string) =>
  apiFetch(`/v3/agents/${agentId}/deploys`, {}, S.AgentDeployListSchema).then(
    (r) => r.data,
  )

export const activateRevision = (agentId: string, rev: string | number) =>
  apiFetch(
    `/v3/agents/${agentId}/revisions/${rev}/activate`,
    { method: 'POST', body: JSON.stringify({}) },
    S.ActivateRevisionSchema,
  )

// Schedules sub-resource (design 015) — cron for agents. A schedule fires an agent on a cron;
// each firing starts one session on the active revision. Reached via the /v3 passthrough.
export type ScheduleOverlap = 'skip' | 'allow'
export type ScheduleState = 'active' | 'paused' | 'auto_paused'
export type ScheduleRunOutcome = 'enacted' | 'skipped' | 'failed'

export interface Schedule {
  id: string
  agent_id: string
  name: string
  cron: string
  tz: string | null
  input: string
  overlap: ScheduleOverlap
  state: ScheduleState
  next_fire_at: string
  last_fired_at: string | null
  consecutive_failures: number
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface ScheduleRun {
  id: string
  schedule_id: string
  scheduled_for: string | null
  fired_at: string
  outcome: ScheduleRunOutcome
  session_id: string | null
  error: string | null
}

export const getSchedules = (agentId: string) =>
  apiFetch<{ schedules: Schedule[] }>(`/v3/agents/${agentId}/schedules`).then(
    (r) => r.schedules,
  )

export const createSchedule = (
  agentId: string,
  body: {
    name: string
    cron: string
    tz?: string | null
    input: string
    overlap?: ScheduleOverlap
  },
) =>
  apiFetch<{ schedule: Schedule }>(`/v3/agents/${agentId}/schedules`, {
    method: 'POST',
    body: JSON.stringify(body),
  }).then((r) => r.schedule)

// PATCH accepts any of { cron, tz, input, overlap, paused }. `paused` toggles pause/resume.
export const updateSchedule = (
  agentId: string,
  scheduleId: string,
  body: Partial<{
    cron: string
    tz: string | null
    input: string
    overlap: ScheduleOverlap
    paused: boolean
  }>,
) =>
  apiFetch<{ schedule: Schedule }>(
    `/v3/agents/${agentId}/schedules/${scheduleId}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  ).then((r) => r.schedule)

export const deleteSchedule = (agentId: string, scheduleId: string) =>
  apiFetch<void>(`/v3/agents/${agentId}/schedules/${scheduleId}`, {
    method: 'DELETE',
  })

// Test-fire now — enacts synchronously (a failed fire still returns a run with outcome:"failed").
export const fireSchedule = (agentId: string, scheduleId: string) =>
  apiFetch<{ run: ScheduleRun }>(
    `/v3/agents/${agentId}/schedules/${scheduleId}/fire`,
    { method: 'POST', body: JSON.stringify({}) },
  ).then((r) => r.run)

export const getScheduleRuns = (
  agentId: string,
  scheduleId: string,
  limit = 10,
) =>
  apiFetch<{ runs: ScheduleRun[]; next_cursor: string | null }>(
    `/v3/agents/${agentId}/schedules/${scheduleId}/runs?limit=${limit}`,
  ).then((r) => r.runs)

// Skills sub-resource (design 009 §8) — the API owns zip → validate → bundle, so the
// dashboard is a thin consumer: read the file list, upload a .zip, or clear.
export const getAgentSkills = (agentId: string) =>
  apiFetch(`/v3/agents/${agentId}/skills`, {}, S.AgentSkillsSchema)

// Upload a .zip of skills → the API unzips + deploys a new revision (active behavior with
// skills replaced). The raw file is the body; no client-side parsing.
export const putAgentSkills = (agentId: string, zip: File | Blob) =>
  apiFetch(
    `/v3/agents/${agentId}/skills`,
    {
      method: 'PUT',
      body: zip,
      headers: { 'Content-Type': 'application/zip' },
    },
    S.DeployResultSchema,
  )

// Remove all skills → deploys a revision from the active behavior with no skills.
export const deleteAgentSkills = (agentId: string) =>
  apiFetch(
    `/v3/agents/${agentId}/skills`,
    { method: 'DELETE' },
    S.DeployResultSchema,
  )

// The OC GitHub App (deploy) install-state + pickable repos — org-scoped admin read.
export const getDeployApp = () =>
  apiFetch('/v3/github/deploy-app', {}, S.DeployAppSchema)

export const getRepositoryAccess = (agentId: string) =>
  apiFetch(
    `/v3/agents/${encodeURIComponent(agentId)}/repository-access`,
    {},
    S.RepositoryAccessSchema,
  )

export const updateRepositoryAccess = (
  agentId: string,
  policy: S.RepositoryAccessPolicy,
) =>
  apiFetch(
    `/v3/agents/${encodeURIComponent(agentId)}/repository-access`,
    { method: 'PUT', body: JSON.stringify(policy) },
    S.RepositoryAccessSchema,
  )

export const reviewRepositoryAgent = (body: {
  repo: string
  path: string
  production_ref: string
}) =>
  apiFetch(
    '/v3/github/deploy-app/inspect',
    { method: 'POST', body: JSON.stringify(body) },
    S.RepositorySourceInspectionSchema,
  )

export const importAgentFromGithub = (
  body: {
    name: string
    source: {
      type: 'github'
      repo: string
      path: string
      production_ref: string
    }
    review: {
      sha: string
      source_profile: 'flue-app-v1'
      fingerprint: string
    }
    credential: 'managed'
  },
  idempotencyKey: string,
) =>
  apiFetch(
    '/v3/agents/import',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Idempotency-Key': idempotencyKey },
    },
    S.ImportAgentResponseSchema,
  )

// Deployment source — link an agent to a repo dir for push-to-deploy (deploy-from-github).
export const getDeploymentSource = (agentId: string) =>
  apiFetch(
    `/v3/agents/${agentId}/deployment-source`,
    {},
    S.DeploymentSourceResponseSchema,
  )

export const linkDeploymentSource = (
  agentId: string,
  body: {
    repo: string
    path: string
    production_ref?: string
    deploy_now?: boolean
  },
) =>
  apiFetch(
    `/v3/agents/${agentId}/deployment-source`,
    { method: 'POST', body: JSON.stringify(body) },
    S.LinkResultSchema,
  )

export const unlinkDeploymentSource = (agentId: string) =>
  apiFetch<void>(`/v3/agents/${agentId}/deployment-source`, {
    method: 'DELETE',
  })

// Deploy the linked repo's current production-branch HEAD now (no git push needed).
export const deployFromGithub = (agentId: string, idempotencyKey: string) =>
  apiFetch(
    `/v3/agents/${encodeURIComponent(agentId)}/deployments`,
    {
      method: 'POST',
      body: JSON.stringify({ input: { type: 'github' } }),
      headers: { 'Idempotency-Key': idempotencyKey },
    },
    S.AgentDeploymentCommandResponseSchema,
  )

export const getAgentDeployments = (
  agentId: string,
  options: { before?: string; limit?: number } = {},
) => {
  const query = new URLSearchParams()
  if (options.before) query.set('before', options.before)
  if (options.limit) query.set('limit', String(options.limit))
  const qs = query.toString()
  return apiFetch(
    `/v3/agents/${encodeURIComponent(agentId)}/deployments${qs ? `?${qs}` : ''}`,
    {},
    S.AgentDeploymentListSchema,
  )
}

export const getAgentDeployment = (agentId: string, deploymentId: string) =>
  apiFetch(
    `/v3/agents/${encodeURIComponent(agentId)}/deployments/${encodeURIComponent(deploymentId)}`,
    {},
    S.AgentDeploymentSchema,
  )

export const getAgentDeploymentLogs = (
  agentId: string,
  deploymentId: string,
  options: { after?: string; limit?: number } = {},
) => {
  const query = new URLSearchParams()
  if (options.after) query.set('after', options.after)
  if (options.limit) query.set('limit', String(options.limit))
  const qs = query.toString()
  return apiFetch(
    `/v3/agents/${encodeURIComponent(agentId)}/deployments/${encodeURIComponent(deploymentId)}/logs${qs ? `?${qs}` : ''}`,
    {},
    S.AgentDeploymentLogsSchema,
  )
}

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

// Managed Slack is the OpenComputer-operated onboarding app. It is a separate
// resource from the builder-owned app above so both may coexist during an
// explicit handoff.
export const authorizeManagedSlack = (
  agentId: string,
  returnDeploymentId?: string,
) =>
  apiFetch(
    `/v3/agents/${encodeURIComponent(agentId)}/slack/managed/authorize`,
    {
      method: 'POST',
      body: JSON.stringify(
        returnDeploymentId ? { return_deployment_id: returnDeploymentId } : {},
      ),
    },
    S.ManagedSlackAuthorizeResponseSchema,
  )

export async function getManagedSlackConnection(agentId: string) {
  try {
    return await apiFetch(
      `/v3/agents/${encodeURIComponent(agentId)}/slack/managed`,
      {},
      S.ManagedSlackConnectionSchema,
    )
  } catch (error) {
    if (
      (error instanceof ApiError ||
        (error instanceof Error && 'status' in error)) &&
      (error as { status: unknown }).status === 404
    )
      return null
    throw error
  }
}

export const getManagedSlackConnections = () =>
  apiFetch(
    '/v3/slack/managed/connections',
    {},
    S.ManagedSlackWorkspaceConnectionListSchema,
  ).then((result) => result.data)

export const disconnectManagedSlack = (agentId: string) =>
  apiFetch(
    `/v3/agents/${encodeURIComponent(agentId)}/slack/managed`,
    { method: 'DELETE' },
    S.ManagedSlackDisconnectResponseSchema,
  )

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
  params: {
    agent?: string
    status?: string
    after?: string
    limit?: number
    cursor?: string
  } = {},
) => {
  const q = new URLSearchParams()
  if (params.agent) q.set('agent', params.agent)
  if (params.status) q.set('status', params.status)
  if (params.after) q.set('after', params.after)
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

export const getSessionSources = (id: string) =>
  apiFetch(
    `/v3/sessions/${encodeURIComponent(id)}/sources`,
    {},
    S.SessionSourceListSchema,
  )

// The API wants { agent: <id>, input } (input required). An optional `sources[]` attaches
// a WORKING repo the agent checks out + opens PRs from — the control plane pins the ref's
// HEAD when `sha` is omitted (design 010 §24.0). The response is an envelope
// { session, client_token } — return the session.
export const createSession = (
  body: {
    agent: string
    input: string
    // Optional per-session model override — runs this model instead of the agent's.
    // Omit to inherit the agent's model. Not supported for flue agents.
    model?: string
    sources?: { repo: string; ref: string; name?: string }[]
  },
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

// Turns — the per-submission execution records behind a session (state, timing,
// usage, error). Read-only; powers the submission-health panel. Newest first.
export const getSessionTurns = (id: string) =>
  apiFetch(`/v3/sessions/${id}/turns`, {}, S.SessionTurnListSchema).then(
    (r) => r.data,
  )

// The latest turn + its result event (if the turn produced one).
export const getSessionResult = (id: string) =>
  apiFetch(`/v3/sessions/${id}/result`, {}, S.SessionResultSchema)

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
