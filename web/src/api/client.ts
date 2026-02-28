const API_BASE = '/api/dashboard'

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed: ${res.status}`)
  }

  if (res.status === 204) {
    return undefined as T
  }

  return res.json()
}

// Logout: clears server session, then navigates to login
export async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
  // Navigate to login page — use replace to prevent back-button loop
  window.location.replace('/login')
}

// API functions
export const getMe = () => apiFetch<{ id: string; email: string; orgId: string }>('/me')

export const getSessions = (status?: string) =>
  apiFetch<Session[]>(`/sessions${status ? `?status=${status}` : ''}`)

export const getAPIKeys = () => apiFetch<APIKey[]>('/api-keys')

export const createAPIKey = (name: string) =>
  apiFetch<{ id: string; name: string; key: string; keyPrefix: string; createdAt: string }>(
    '/api-keys',
    { method: 'POST', body: JSON.stringify({ name }) },
  )

export const deleteAPIKey = (keyId: string) =>
  apiFetch<void>(`/api-keys/${keyId}`, { method: 'DELETE' })

export const getTemplates = () => apiFetch<Template[]>('/templates')

export const buildTemplate = (name: string, dockerfile: string) =>
  apiFetch<Template>('/templates', {
    method: 'POST',
    body: JSON.stringify({ name, dockerfile }),
  })

export const deleteTemplate = (id: string) =>
  apiFetch<void>(`/templates/${id}`, { method: 'DELETE' })

export const getSessionDetail = (sandboxId: string) =>
  apiFetch<SessionDetail>(`/sessions/${sandboxId}`)

export const getSessionStats = (sandboxId: string) =>
  apiFetch<SandboxStats>(`/sessions/${sandboxId}/stats`)

export const getOrg = () => apiFetch<Org>('/org')

export const updateOrg = (name: string) =>
  apiFetch<Org>('/org', { method: 'PUT', body: JSON.stringify({ name }) })

export const setCustomDomain = (domain: string) =>
  apiFetch<Org>('/org/custom-domain', { method: 'PUT', body: JSON.stringify({ domain }) })

export const deleteCustomDomain = () =>
  apiFetch<Org>('/org/custom-domain', { method: 'DELETE' })

export const refreshCustomDomain = () =>
  apiFetch<Org>('/org/custom-domain/refresh', { method: 'POST' })

// Types
export interface Session {
  id: string
  sandboxId: string
  orgId: string
  template: string
  region: string
  workerId: string
  status: string
  startedAt: string
  stoppedAt?: string
  errorMsg?: string
}

export interface APIKey {
  id: string
  orgId: string
  keyPrefix: string
  name: string
  scopes: string[]
  lastUsed?: string
  expiresAt?: string
  createdAt: string
}

export interface Template {
  id: string
  orgId?: string
  name: string
  tag: string
  dockerfile?: string
  isPublic: boolean
  status?: string
  createdAt: string
}

export interface PreviewURL {
  id: string
  sandboxId: string
  orgId: string
  hostname: string
  customHostname?: string
  port: number
  cfHostnameId?: string
  sslStatus: string
  authConfig: Record<string, unknown>
  createdAt: string
}

export interface SessionDetail {
  id: string
  sandboxId: string
  template: string
  status: string
  startedAt: string
  stoppedAt?: string
  errorMsg?: string
  config?: {
    timeout?: number
    cpuCount?: number
    memoryMB?: number
    networkEnabled?: boolean
    envs?: Record<string, string>
  }
  checkpoint?: {
    checkpointKey: string
    sizeBytes: number
    hibernatedAt: string
  }
  previewUrls?: PreviewURL[]
}

export interface SandboxStats {
  cpuPercent: number
  memUsage: number
  memLimit: number
  netInput: number
  netOutput: number
  pids: number
}

export interface Org {
  id: string
  name: string
  slug: string
  plan: string
  maxConcurrentSandboxes: number
  maxSandboxTimeoutSec: number
  createdAt: string
  updatedAt: string
  customDomain?: string
  cfHostnameId?: string
  domainVerificationStatus: string
  domainSslStatus: string
  verificationTxtName?: string
  verificationTxtValue?: string
  sslTxtName?: string
  sslTxtValue?: string
}

// Secrets types
export interface Secret {
  id: string
  orgId: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface SecretGroup {
  id: string
  orgId: string
  name: string
  description: string
  createdAt: string
}

export interface SecretGroupDetail extends SecretGroup {
  allowedHosts?: string[]
  entries: Array<{
    id: string
    secretId: string
    secretName: string
    envVarName: string
  }>
}

// Secrets API
export const getSecrets = () => apiFetch<Secret[]>('/secrets')

export const createSecret = (name: string, description: string, value: string) =>
  apiFetch<Secret>('/secrets', {
    method: 'POST',
    body: JSON.stringify({ name, description, value }),
  })

export const updateSecret = (id: string, data: { name?: string; description?: string; value?: string }) =>
  apiFetch<Secret>(`/secrets/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })

export const deleteSecret = (id: string) =>
  apiFetch<void>(`/secrets/${id}`, { method: 'DELETE' })

// Secret Groups API
export const getSecretGroups = () => apiFetch<SecretGroup[]>('/secret-groups')

export const getSecretGroup = (id: string) =>
  apiFetch<SecretGroupDetail>(`/secret-groups/${id}`)

export const createSecretGroup = (
  name: string,
  description: string,
  allowedHosts: string[],
  entries: Array<{ secretId: string; envVarName: string }>,
) =>
  apiFetch<SecretGroup>('/secret-groups', {
    method: 'POST',
    body: JSON.stringify({ name, description, allowedHosts, entries }),
  })

export const updateSecretGroup = (
  id: string,
  data: { name?: string; description?: string; allowedHosts?: string[]; entries?: Array<{ secretId: string; envVarName: string }> },
) =>
  apiFetch<SecretGroup>(`/secret-groups/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })

export const deleteSecretGroup = (id: string) =>
  apiFetch<void>(`/secret-groups/${id}`, { method: 'DELETE' })
