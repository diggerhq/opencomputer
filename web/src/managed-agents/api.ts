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
  activeAlias: z.string(),
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

const sessionCreateSchema = z.object({
  session: z.object({ id: z.string() }),
  deployment: deploymentSchema.optional(),
})

const eventSchema = z.object({
  seq: z.number(),
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

export type ManagedAgentTemplate = z.infer<typeof templateSchema>
export type ManagedAgentSummary = z.infer<typeof agentSchema>
export type ManagedAgentDeployment = z.infer<typeof deploymentSchema>

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
