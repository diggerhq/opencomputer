import { z } from 'zod'
import { apiFetch } from '@/api/client'

const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  integrations: z.array(z.string()),
  suggestedPrompts: z.array(z.string()),
})

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  activeAlias: z.string(),
  activeDeploymentId: z.string().nullish(),
  deploymentCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const deploymentSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  alias: z.string(),
  channels: z.array(z.string()),
  connections: z.array(z.string()),
  createdAt: z.string(),
})

const templatesResponseSchema = z.object({
  templates: z.array(templateSchema),
})

const agentsResponseSchema = z.object({
  agents: z.array(agentSchema),
})

const connectionSchema = z.object({
  id: z.string(),
  kind: z.enum(['tool', 'channel']),
  provider: z.string(),
  label: z.string(),
  agentId: z.string().optional().default(''),
  alias: z.string().optional().default(''),
  displayName: z.string().nullish(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const channelSchema = z.object({
  id: z.string(),
  channel: z.string(),
  agentId: z.string(),
  alias: z.string(),
  teamName: z.string().nullish(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const connectionsResponseSchema = z.object({
  connections: z.array(connectionSchema),
})

const channelsResponseSchema = z.object({
  channels: z.array(channelSchema),
})

const sessionCreateSchema = z.object({
  session: z.object({ id: z.string() }),
  deployment: deploymentSchema.optional(),
})

const eventSchema = z.object({
  id: z.string().optional(),
  seq: z.number(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
})

const eventsResponseSchema = z.object({
  events: z.array(eventSchema),
})

const turnSchema = z.object({
  turnId: z.string(),
  duplicate: z.boolean(),
})

const sessionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  deploymentId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  turns: z
    .array(
      z.object({
        id: z.string(),
        input: z.string(),
        status: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    )
    .default([]),
})

const sessionsResponseSchema = z.object({ sessions: z.array(sessionSchema) })

export type ManagedAgentTemplate = z.infer<typeof templateSchema>
export type ManagedAgentSummary = z.infer<typeof agentSchema>
export type ManagedAgentDeployment = z.infer<typeof deploymentSchema>
export type ManagedAgentEvent = z.infer<typeof eventSchema>
export type ManagedAgentSession = z.infer<typeof sessionSchema>
export type ManagedAgentConnection = z.infer<typeof connectionSchema>
export type ManagedAgentChannel = z.infer<typeof channelSchema>

const UUID_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function displayManagedAgentName(
  agent: Pick<ManagedAgentSummary, 'id' | 'name'>,
) {
  const name = agent.name.trim()
  return !name || UUID_NAME.test(name) ? 'Untitled agent' : name
}

export async function getManagedAgentTemplates() {
  return (
    await apiFetch(
      '/managed-agents/templates',
      undefined,
      templatesResponseSchema,
    )
  ).templates
}

export async function getManagedAgents() {
  return (
    await apiFetch('/managed-agents/agents', undefined, agentsResponseSchema)
  ).agents
}

export async function getManagedAgentConnections() {
  return (
    await apiFetch(
      '/managed-agents/connections',
      undefined,
      connectionsResponseSchema,
    )
  ).connections.filter((connection) => connection.kind === 'tool')
}

export async function getManagedAgentChannels() {
  return (
    await apiFetch(
      '/managed-agents/channels',
      undefined,
      channelsResponseSchema,
    )
  ).channels
}

export async function getManagedAgentDeployment(deploymentId: string) {
  return apiFetch(
    `/managed-agents/deployments/${encodeURIComponent(deploymentId)}`,
    undefined,
    deploymentSchema,
  )
}

export async function getManagedAgentSessions(agentId?: string) {
  const { sessions } = await apiFetch(
    '/managed-agents/sessions',
    undefined,
    sessionsResponseSchema,
  )
  return agentId
    ? sessions.filter((session) => session.agentId === agentId)
    : sessions
}

export async function getManagedAgentSessionEvents(sessionId: string) {
  return (
    await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/events?after=0`,
      undefined,
      eventsResponseSchema,
    )
  ).events
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForAgentEvent(
  sessionId: string,
  after: number,
  terminal: (event: z.infer<typeof eventSchema>) => boolean,
  onEvent: (event: z.infer<typeof eventSchema>) => void,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  let cursor = after
  while (Date.now() < deadline) {
    const { events } = await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/events?after=${cursor}`,
      undefined,
      eventsResponseSchema,
    )
    for (const event of events) {
      cursor = Math.max(cursor, event.seq)
      onEvent(event)
      if (
        event.type === 'runtime.disconnected' ||
        event.type === 'session.failed'
      ) {
        throw new Error(
          typeof event.data.reason === 'string'
            ? event.data.reason
            : typeof event.data.message === 'string'
              ? event.data.message
              : 'The agent runtime disconnected.',
        )
      }
      if (terminal(event)) return { event, cursor }
    }
    await sleep(600)
  }
  throw new Error('Timed out waiting for the agent.')
}

export async function runManagedAgent(
  agentId: string,
  input: string,
  onEvent: (event: ManagedAgentEvent) => void,
) {
  const created = await apiFetch(
    '/managed-agents/sessions',
    {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    },
    sessionCreateSchema,
  )
  const sessionId = created.session.id
  try {
    const connected = await waitForAgentEvent(
      sessionId,
      0,
      (event) => event.type === 'runtime.connected',
      onEvent,
      90_000,
    )
    const turn = await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: 'POST',
        body: JSON.stringify({
          input,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
      turnSchema,
    )
    const completed = await waitForAgentEvent(
      sessionId,
      connected.cursor,
      (event) =>
        event.type === 'turn.completed' || event.type === 'turn.failed',
      onEvent,
      180_000,
    )
    if (completed.event.type === 'turn.failed') {
      throw new Error(
        typeof completed.event.data.message === 'string'
          ? completed.event.data.message
          : 'The agent could not complete this request.',
      )
    }
    return { sessionId, turnId: turn.turnId }
  } finally {
    await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/suspend`,
      { method: 'POST' },
    ).catch(() => undefined)
  }
}

export async function invokeManagedAgent(agentId: string, input: string) {
  const created = await apiFetch(
    '/managed-agents/sessions',
    {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    },
    sessionCreateSchema,
  )
  const sessionId = created.session.id
  try {
    const connected = await waitForAgentEvent(
      sessionId,
      0,
      (event) => event.type === 'runtime.connected',
      () => undefined,
      90_000,
    )
    const turn = await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: 'POST',
        body: JSON.stringify({
          input,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
      turnSchema,
    )
    let streamedText = ''
    let completedText = ''
    const completed = await waitForAgentEvent(
      sessionId,
      connected.cursor,
      (event) =>
        event.type === 'turn.completed' || event.type === 'turn.failed',
      (event) => {
        if (event.type === 'message.delta') {
          streamedText +=
            typeof event.data.text === 'string' ? event.data.text : ''
        } else if (
          event.type === 'message.completed' &&
          typeof event.data.text === 'string'
        ) {
          completedText = event.data.text
        }
      },
      180_000,
    )
    if (completed.event.type === 'turn.failed') {
      throw new Error(
        typeof completed.event.data.message === 'string'
          ? completed.event.data.message
          : 'The agent could not complete this request.',
      )
    }
    return {
      sessionId,
      turnId: turn.turnId,
      output: streamedText || completedText || 'Done.',
    }
  } finally {
    await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/suspend`,
      { method: 'POST' },
    ).catch(() => undefined)
  }
}
