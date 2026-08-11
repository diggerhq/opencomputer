import { z } from 'zod'
import { apiFetch } from '@/api/client'

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

const deploymentsResponseSchema = z.object({
  deployments: z.array(deploymentSchema),
})

const agentsResponseSchema = z.object({
  agents: z.array(agentSchema),
})

const projectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  environments: z.array(
    z.object({
      name: z.enum(['development', 'production']),
      agentId: z.string().optional(),
      activeDeploymentId: z.string().optional(),
      updatedAt: z.string(),
    }),
  ),
  agents: z.array(z.object({ id: z.string(), name: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const projectsResponseSchema = z.object({ projects: z.array(projectSchema) })

const secretSchema = z.object({
  name: z.string(),
  projectId: z.string(),
  environment: z.enum(['development', 'production']),
  agentId: z.string().optional(),
  allowedOrigins: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const secretsResponseSchema = z.object({ secrets: z.array(secretSchema) })

const connectionSchema = z.object({
  id: z.string(),
  kind: z.enum(['tool', 'channel']),
  provider: z.string(),
  label: z.string(),
  agentId: z.string().optional().default(''),
  alias: z.string().optional().default(''),
  displayName: z.string().nullish(),
  scopes: z.array(z.string()).optional().default([]),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const channelSchema = z.object({
  id: z.string(),
  channel: z.string(),
  agentId: z.string(),
  alias: z.string(),
  appName: z.string().nullish(),
  teamName: z.string().nullish(),
  appId: z.string().nullish(),
  teamId: z.string().nullish(),
  botUserId: z.string().nullish(),
  verifiedAt: z.string().nullish(),
  verificationError: z.enum(['signing_secret_mismatch']).nullish(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const connectionsResponseSchema = z.object({
  connections: z.array(connectionSchema),
})

const channelIdentityLinkSchema = z.object({ linked: z.literal(true) })

const connectionLinkSchema = z.object({
  connectionId: z.string(),
  service: z.string(),
  label: z.string(),
  status: z.enum(['connected', 'pending']),
  authorizationUrl: z.string().url().optional(),
})

const channelsResponseSchema = z.object({
  channels: z.array(channelSchema),
})

const slackManifestResponseSchema = z.object({
  connection: channelSchema,
  manifest: z.record(z.string(), z.unknown()),
  createUrl: z.string().url(),
  steps: z.array(z.string()),
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

const renderDebugSchema = z.object({
  renderId: z.string(),
  responseId: z.string(),
  providerTurn: z.number(),
  stateVersion: z.number(),
  instructionsHash: z.string(),
  instructions: z.string(),
  enabledTools: z.array(z.string()),
  enabledSubagents: z.array(z.string()),
  requiredConnections: z.array(z.string()),
  enabledMcpServers: z.array(z.string()),
  input: z.object({ source: z.string(), text: z.string().optional() }),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  model: z.object({ provider: z.string(), model: z.string() }).optional(),
  renderedAt: z.string(),
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
  source: z.enum(['api', 'channel', 'playground']).optional().default('api'),
  microvmState: z.string().optional(),
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

const projectOverviewSchema = z.object({
  project: projectSchema,
  sessions: z.array(sessionSchema),
  deployments: z.array(deploymentSchema),
  connections: z.array(connectionSchema),
  channels: z.array(channelSchema),
  schedules: z.array(z.record(z.string(), z.unknown())),
  files: z.array(z.record(z.string(), z.unknown())),
  schema: z.record(z.string(), z.unknown()),
})

export type ManagedAgentSummary = z.infer<typeof agentSchema>
export type ManagedProject = z.infer<typeof projectSchema>
export type ManagedProjectOverview = z.infer<typeof projectOverviewSchema>
export type ManagedAgentDeployment = z.infer<typeof deploymentSchema>
export type ManagedAgentEvent = z.infer<typeof eventSchema>
export type ManagedAgentRenderDebug = z.infer<typeof renderDebugSchema>
export type ManagedAgentSession = z.infer<typeof sessionSchema>
export type ManagedAgentConnection = z.infer<typeof connectionSchema>
export type ManagedAgentChannel = z.infer<typeof channelSchema>
export type ManagedSlackManifest = z.infer<typeof slackManifestResponseSchema>
export type ManagedProjectSecret = z.infer<typeof secretSchema>

const UUID_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function displayManagedAgentName(
  agent: Pick<ManagedAgentSummary, 'id' | 'name'>,
) {
  const name = agent.name.trim()
  return !name || UUID_NAME.test(name) ? 'Untitled agent' : name
}

export async function getManagedAgents() {
  return (
    await apiFetch('/managed-agents/agents', undefined, agentsResponseSchema)
  ).agents
}

export async function getManagedProjects() {
  return (
    await apiFetch(
      '/managed-agents/projects',
      undefined,
      projectsResponseSchema,
    )
  ).projects
}

export async function createManagedProject(name: string) {
  return apiFetch(
    '/managed-agents/projects',
    { method: 'POST', body: JSON.stringify({ name }) },
    projectSchema,
  )
}

export async function getManagedProject(projectId: string) {
  return apiFetch(
    `/managed-agents/projects/${encodeURIComponent(projectId)}`,
    undefined,
    projectOverviewSchema,
  )
}

export async function getManagedProjectSecrets(
  projectId: string,
  environment: 'development' | 'production',
) {
  return (
    await apiFetch(
      `/managed-agents/projects/${encodeURIComponent(projectId)}/secrets?environment=${encodeURIComponent(environment)}`,
      undefined,
      secretsResponseSchema,
    )
  ).secrets
}

export async function putManagedProjectSecret(input: {
  projectId: string
  environment: 'development' | 'production'
  agentId?: string
  name: string
  value: string
  allowedOrigins: string[]
}) {
  return apiFetch(
    `/managed-agents/projects/${encodeURIComponent(input.projectId)}/secrets/${encodeURIComponent(input.name)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        environment: input.environment,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        value: input.value,
        allowedOrigins: input.allowedOrigins,
      }),
    },
    secretSchema,
  )
}

export async function deleteManagedProjectSecret(input: {
  projectId: string
  environment: 'development' | 'production'
  agentId?: string
  name: string
}) {
  const query = new URLSearchParams({ environment: input.environment })
  if (input.agentId) query.set('agentId', input.agentId)
  return apiFetch<void>(
    `/managed-agents/projects/${encodeURIComponent(input.projectId)}/secrets/${encodeURIComponent(input.name)}?${query.toString()}`,
    { method: 'DELETE' },
  )
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

export async function claimManagedAgentChannelIdentity(token: string) {
  return apiFetch(
    '/managed-agents/connections/channel-identity/link',
    {
      method: 'POST',
      body: JSON.stringify({ token }),
    },
    channelIdentityLinkSchema,
  )
}

export async function linkManagedAgentConnection(
  service: string,
  label: string,
) {
  return apiFetch(
    '/managed-agents/connections/link',
    {
      method: 'POST',
      body: JSON.stringify({ service, label }),
    },
    connectionLinkSchema,
  )
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

export async function startManagedAgentSlack(
  agentId: string,
  name: string,
  reconnect = false,
) {
  return apiFetch(
    '/managed-agents/channels/slack/connections',
    {
      method: 'POST',
      body: JSON.stringify({ agentId, name, reconnect }),
    },
    slackManifestResponseSchema,
  )
}

export async function completeManagedAgentSlack(
  connectionId: string,
  input: { appId: string; signingSecret: string; botToken: string },
) {
  return apiFetch(
    `/managed-agents/channels/slack/connections/${encodeURIComponent(connectionId)}`,
    { method: 'PUT', body: JSON.stringify(input) },
    channelSchema,
  )
}

export async function disconnectManagedAgentSlack(connectionId: string) {
  return apiFetch(
    `/managed-agents/channels/slack/connections/${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' },
    channelSchema,
  )
}

export async function getManagedAgentDeployment(deploymentId: string) {
  return apiFetch(
    `/managed-agents/deployments/${encodeURIComponent(deploymentId)}`,
    undefined,
    deploymentSchema,
  )
}

export async function getManagedAgentDeployments(agentId: string) {
  return (
    await apiFetch(
      `/managed-agents/deployments?agentId=${encodeURIComponent(agentId)}`,
      undefined,
      deploymentsResponseSchema,
    )
  ).deployments
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

export function managedAgentRenderDebug(event: ManagedAgentEvent) {
  if (event.type !== 'agent.rendered') return undefined
  const parsed = renderDebugSchema.safeParse(event.data)
  return parsed.success ? parsed.data : undefined
}

export async function getManagedAgentSession(sessionId: string) {
  return apiFetch(
    `/managed-agents/sessions/${encodeURIComponent(sessionId)}`,
    undefined,
    sessionSchema,
  )
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
  signal?: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs
  let cursor = after
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const { events } = await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/events?after=${cursor}`,
      { signal },
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
  options: {
    onSession?: (sessionId: string) => void
    signal?: AbortSignal
  } = {},
) {
  const created = await apiFetch(
    '/managed-agents/sessions',
    {
      method: 'POST',
      body: JSON.stringify({ agentId, source: 'playground' }),
      signal: options.signal,
    },
    sessionCreateSchema,
  )
  const sessionId = created.session.id
  options.onSession?.(sessionId)
  try {
    const connected = await waitForAgentEvent(
      sessionId,
      0,
      (event) => event.type === 'runtime.connected',
      onEvent,
      90_000,
      options.signal,
    )
    const turn = await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: 'POST',
        body: JSON.stringify({
          input,
          idempotencyKey: crypto.randomUUID(),
        }),
        signal: options.signal,
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
      options.signal,
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

export async function continueManagedAgentSession(
  sessionId: string,
  input: string,
  onEvent: (event: ManagedAgentEvent) => void,
  signal?: AbortSignal,
) {
  const existing = await getManagedAgentSessionEvents(sessionId)
  let cursor = existing[existing.length - 1]?.seq ?? 0
  const session = await getManagedAgentSession(sessionId)
  if (session.microvmState === 'terminated' || session.status === 'ended') {
    throw new Error('This playground session has ended. Start a new session.')
  }
  if (session.microvmState === 'suspended') {
    await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/resume`,
      { method: 'POST', signal },
      sessionSchema,
    )
    const connected = await waitForAgentEvent(
      sessionId,
      cursor,
      (event) => event.type === 'runtime.connected',
      onEvent,
      90_000,
      signal,
    )
    cursor = connected.cursor
  }
  try {
    const turn = await apiFetch(
      `/managed-agents/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: 'POST',
        body: JSON.stringify({
          input,
          idempotencyKey: crypto.randomUUID(),
        }),
        signal,
      },
      turnSchema,
    )
    const completed = await waitForAgentEvent(
      sessionId,
      cursor,
      (event) =>
        event.type === 'turn.completed' || event.type === 'turn.failed',
      onEvent,
      180_000,
      signal,
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
