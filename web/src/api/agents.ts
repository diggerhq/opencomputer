// Dormant agent API client — the agent dashboard pages were removed (orphaned).
// Kept for reference; the upcoming Durable Sessions UI will build its own.
// Nothing imports this yet.

import { apiFetch } from './client'

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
