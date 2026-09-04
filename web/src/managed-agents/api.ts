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
  projectDeployment: z
    .object({
      id: z.string(),
      digest: z.string(),
      localAgentId: z.string(),
      resources: z.object({
        channels: z.array(
          z.object({
            id: z.string(),
            type: z.literal('slack'),
            displayName: z.string().optional(),
            destinations: z.record(
              z.string(),
              z.object({
                type: z.literal('conversation'),
                visibility: z.enum(['public', 'private']),
              }),
            ),
          }),
        ),
        schedules: z
          .array(
            z.object({
              id: z.string(),
              agentId: z.string(),
              cron: z.string(),
              timezone: z.string(),
              enabled: z.array(z.enum(['development', 'production'])),
              overlap: z.enum(['skip', 'allow']),
              dispatch: z.object({
                text: z.string().optional(),
                payload: z.unknown().optional(),
              }),
            }),
          )
          .optional()
          .default([]),
      }),
    })
    .optional(),
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

const templateInspectionSchema = z.object({
  id: z.string(),
  repository: z.object({
    url: z.string().url(),
    fullName: z.string(),
    defaultBranch: z.literal('main'),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  template: z.object({
    name: z.string(),
    description: z.string(),
    documentation: z.string().url().optional(),
    defaultProjectName: z.string().optional(),
    firstRun: z.object({ agent: z.string(), prompt: z.string() }).optional(),
  }),
  agents: z.array(z.object({ id: z.string(), name: z.string() })),
  requirements: z.object({
    secrets: z.array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        documentation: z.string().url().optional(),
        required: z.boolean().default(true),
        agentId: z.string().optional(),
        allowedOrigins: z.array(z.string().url()),
      }),
    ),
    runtimeVariables: z.array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        documentation: z.string().url().optional(),
        required: z.boolean(),
        example: z.string().optional(),
        agentId: z.string().optional(),
      }),
    ),
    connections: z.array(
      z.object({
        id: z.string(),
        description: z.string().optional(),
        provider: z.string(),
        permissions: z.array(z.string()),
      }),
    ),
  }),
  expiresAt: z.string(),
})

const templateInspectionPreparingSchema = z.object({
  id: z.string(),
  status: z.literal('preparing'),
  repositoryUrl: z.string().url(),
  retryAfterMs: z.number().positive(),
})

const templateInstallationSchema = z.object({
  id: z.string(),
  inspectionId: z.string(),
  projectId: z.string(),
  projectAgentId: z.string(),
  projectUrl: z.string(),
  state: z.enum([
    'awaiting_configuration',
    'creating_project',
    'building',
    'deploying',
    'ready',
    'failed',
  ]),
  error: z.object({ stage: z.string(), message: z.string() }).optional(),
})

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

const modelAccessConnectionSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  connectedByUserId: z.string().optional(),
  provider: z.enum(['anthropic', 'openai']),
  kind: z.enum(['claude_subscription', 'codex_subscription']),
  label: z.string(),
  externalAccountHint: z.string().nullish(),
  status: z.enum([
    'connecting',
    'connected',
    'reauth_required',
    'provider_limited',
    'plan_ineligible',
    'revoked',
    'unavailable',
  ]),
  checkedAt: z.string().nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
})

const modelAccessConnectionsResponseSchema = z.object({
  data: z.array(modelAccessConnectionSchema),
})

const modelAccessConnectResponseSchema = z.object({
  connection: modelAccessConnectionSchema,
  status: z.literal('pending'),
  authorize_url: z.string().url(),
  expires_at: z.string(),
})

const modelAccessBindingSchema = z.object({
  projectId: z.string(),
  environment: z.enum(['development', 'production']),
  provider: z.enum(['anthropic', 'openai']),
  connectionId: z.string(),
  enabled: z.boolean(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
})

const modelAccessBindingsResponseSchema = z.object({
  data: z.array(modelAccessBindingSchema),
})

const runtimeVariableSchema = z.object({
  name: z.string(),
  projectId: z.string(),
  environment: z.enum(['development', 'production']),
  agentId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const runtimeVariablesResponseSchema = z.object({
  variables: z.array(runtimeVariableSchema),
})

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
  channelId: z.string().optional().default('slack'),
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
  destinations: z
    .array(
      z.object({
        name: z.string(),
        conversationId: z.string(),
        displayName: z.string(),
        verifiedAt: z.string(),
      }),
    )
    .optional()
    .default([]),
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

const outboxItemSchema = z.object({
  id: z.string(),
  outboxId: z.string(),
  eventType: z.string(),
  sessionId: z.string().optional(),
  contentPreview: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
    url: z.string().optional(),
  }),
  status: z.string(),
  destination: z.string().optional(),
  attemptCount: z.number(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const outboxSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  destination: z.string(),
  readiness: z.enum([
    'ready',
    'channel_not_connected',
    'destination_not_bound',
  ]),
  targetDisplayName: z.string().optional(),
  items: z.array(outboxItemSchema),
})

const outboxesResponseSchema = z.object({
  agentId: z.string(),
  environment: z.enum(['development', 'production']),
  deploymentId: z.string(),
  outboxes: z.array(outboxSchema),
})

const scheduleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environment: z.enum(['development', 'production']),
  agentId: z.string(),
  deploymentId: z.string(),
  cron: z.string(),
  timezone: z.string(),
  overlap: z.enum(['skip', 'allow']),
  dispatch: z.object({
    text: z.string().optional(),
    payload: z.unknown().optional(),
  }),
  nextRunAt: z.string(),
  lastRunAt: z.string().optional(),
  status: z.enum(['active', 'manual', 'paused']),
})

const scheduleRunSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  projectId: z.string(),
  environment: z.enum(['development', 'production']),
  deploymentId: z.string(),
  scheduledAt: z.string(),
  manual: z.boolean(),
  attempt: z.number(),
  outcome: z.enum(['pending', 'enacted', 'skipped', 'failed']),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
})

const schedulesResponseSchema = z.object({ schedules: z.array(scheduleSchema) })
const scheduleRunsResponseSchema = z.object({
  runs: z.array(scheduleRunSchema),
})
const scheduleRunResponseSchema = z.object({ run: scheduleRunSchema })

const webhookSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  environment: z.enum(['development', 'production']),
  agentId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  invocationUrl: z.string().url(),
  token: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastInvokedAt: z.string().optional(),
})

const webhooksResponseSchema = z.object({ webhooks: z.array(webhookSchema) })
const webhookResponseSchema = z.object({ webhook: webhookSchema })

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

const modelRouteSchema = z.object({
  requested: z
    .object({ provider: z.string(), model: z.string() })
    .nullable()
    .optional(),
  effective: z
    .object({ provider: z.string(), model: z.string() })
    .nullable()
    .optional(),
  runtime: z.string(),
  access: z.object({
    type: z.enum(['managed', 'external_subscription']),
    connectionId: z.string().optional(),
    connectionKind: z.string().optional(),
  }),
  openComputerModelChargeUsd: z.number().nullable(),
})

const eventsResponseSchema = z.object({
  events: z.array(eventSchema),
})

const turnSchema = z.object({
  turnId: z.string(),
  status: z.string(),
  duplicate: z.boolean(),
})

export type ManagedAgentInputMode = 'queue' | 'steer' | 'interrupt'

const sessionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  deploymentId: z.string(),
  status: z.string(),
  source: z
    .enum(['api', 'channel', 'playground', 'schedule', 'webhook'])
    .optional()
    .default('api'),
  microvmState: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  turns: z
    .array(
      z.object({
        id: z.string(),
        input: z.string(),
        mode: z
          .enum(['queue', 'steer', 'interrupt'])
          .optional()
          .default('queue'),
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
  templateSource: z
    .object({
      repositoryUrl: z.string().url(),
      commitSha: z.string().regex(/^[0-9a-f]{40}$/),
      cloneReady: z.boolean().optional().default(false),
    })
    .optional(),
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
export type ManagedAgentModelRoute = z.infer<typeof modelRouteSchema>
export type ManagedAgentSession = z.infer<typeof sessionSchema>
export type ManagedAgentConnection = z.infer<typeof connectionSchema>
export type ManagedAgentChannel = z.infer<typeof channelSchema>
export type ManagedAgentOutbox = z.infer<typeof outboxSchema>
export type ManagedAgentOutboxItem = z.infer<typeof outboxItemSchema>
export type ManagedAgentSchedule = z.infer<typeof scheduleSchema>
export type ManagedAgentScheduleRun = z.infer<typeof scheduleRunSchema>
export type ManagedAgentWebhook = z.infer<typeof webhookSchema>
export type ManagedSlackManifest = z.infer<typeof slackManifestResponseSchema>
export type ManagedProjectSecret = z.infer<typeof secretSchema>
export type ManagedModelAccessConnection = z.infer<
  typeof modelAccessConnectionSchema
>
export type ManagedModelAccessBinding = z.infer<typeof modelAccessBindingSchema>
export type TemplateInspection = z.infer<typeof templateInspectionSchema>
export type TemplateInstallation = z.infer<typeof templateInstallationSchema>

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

export async function inspectManagedTemplate(
  repositoryUrl: string,
): Promise<z.infer<typeof templateInspectionSchema>> {
  const deadline = Date.now() + 10 * 60_000
  for (;;) {
    const result = await apiFetch(
      '/managed-agents/template-inspections',
      { method: 'POST', body: JSON.stringify({ repositoryUrl }) },
      z.union([templateInspectionSchema, templateInspectionPreparingSchema]),
    )
    if ((result as { status?: string }).status !== 'preparing') {
      return result as z.infer<typeof templateInspectionSchema>
    }
    const preparing = result as z.infer<
      typeof templateInspectionPreparingSchema
    >
    if (Date.now() >= deadline) {
      throw new Error(
        'Template preparation is still running; try again shortly',
      )
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(500, preparing.retryAfterMs)),
    )
  }
}

export async function createManagedTemplateInstallation(input: {
  inspectionId: string
  projectName: string
  idempotencyKey: string
}) {
  return apiFetch(
    '/managed-agents/template-installations',
    { method: 'POST', body: JSON.stringify(input) },
    templateInstallationSchema,
  )
}

export async function finalizeManagedTemplateInstallation(id: string) {
  return apiFetch(
    `/managed-agents/template-installations/${encodeURIComponent(id)}/finalize`,
    { method: 'POST' },
    templateInstallationSchema,
  )
}

export async function getManagedTemplateInstallation(id: string) {
  return apiFetch(
    `/managed-agents/template-installations/${encodeURIComponent(id)}`,
    undefined,
    templateInstallationSchema,
  )
}

export async function getManagedProject(projectId: string) {
  return apiFetch(
    `/managed-agents/projects/${encodeURIComponent(projectId)}`,
    undefined,
    projectOverviewSchema,
  )
}

export async function deleteManagedProject(projectId: string) {
  await apiFetch(`/managed-agents/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  })
}

export async function getManagedModelAccessConnections() {
  return (
    await apiFetch(
      '/managed-agents/model-access/connections',
      undefined,
      modelAccessConnectionsResponseSchema,
    )
  ).data
}

export async function connectManagedModelAccess() {
  return apiFetch(
    '/managed-agents/model-access/connections',
    { method: 'POST', body: JSON.stringify({ provider: 'openai' }) },
    modelAccessConnectResponseSchema,
  )
}

export async function completeManagedModelAccess(
  id: string,
  code: string,
  state: string,
) {
  return apiFetch(
    `/managed-agents/model-access/connections/${encodeURIComponent(id)}/complete`,
    { method: 'POST', body: JSON.stringify({ code, state }) },
    modelAccessConnectionSchema,
  )
}

export async function validateManagedModelAccessConnection(id: string) {
  return apiFetch(
    `/managed-agents/model-access/connections/${encodeURIComponent(id)}/validate`,
    { method: 'POST' },
    modelAccessConnectionSchema,
  )
}

export async function disconnectManagedModelAccessConnection(id: string) {
  return apiFetch(
    `/managed-agents/model-access/connections/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    modelAccessConnectionSchema,
  )
}

export async function getManagedModelAccessBindings(projectId: string) {
  return (
    await apiFetch(
      `/managed-agents/projects/${encodeURIComponent(projectId)}/model-access/bindings`,
      undefined,
      modelAccessBindingsResponseSchema,
    )
  ).data
}

export async function putManagedModelAccessBinding(input: {
  projectId: string
  provider: 'anthropic' | 'openai'
  environment: 'development' | 'production'
  enabled: boolean
}) {
  return apiFetch(
    `/managed-agents/projects/${encodeURIComponent(input.projectId)}/model-access/bindings/${input.provider}/${input.environment}`,
    { method: 'PUT', body: JSON.stringify({ enabled: input.enabled }) },
    modelAccessBindingSchema,
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

export async function getAgentRuntimeVariables(
  projectId: string,
  environment: 'development' | 'production',
) {
  return (
    await apiFetch(
      `/managed-agents/projects/${encodeURIComponent(projectId)}/runtime-variables?environment=${encodeURIComponent(environment)}`,
      undefined,
      runtimeVariablesResponseSchema,
    )
  ).variables
}

export async function putAgentRuntimeVariable(input: {
  projectId: string
  environment: 'development' | 'production'
  agentId?: string
  name: string
  value: string
}) {
  return apiFetch(
    `/managed-agents/projects/${encodeURIComponent(input.projectId)}/runtime-variables/${encodeURIComponent(input.name)}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        environment: input.environment,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        value: input.value,
      }),
    },
    runtimeVariableSchema,
  )
}

export async function deleteAgentRuntimeVariable(input: {
  projectId: string
  environment: 'development' | 'production'
  agentId?: string
  name: string
}) {
  const query = new URLSearchParams({ environment: input.environment })
  if (input.agentId) query.set('agentId', input.agentId)
  return apiFetch<void>(
    `/managed-agents/projects/${encodeURIComponent(input.projectId)}/runtime-variables/${encodeURIComponent(input.name)}?${query.toString()}`,
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

export async function getManagedAgentOutboxes(
  agentId: string,
  environment: 'development' | 'production',
) {
  const query = new URLSearchParams({ agentId, environment })
  return apiFetch(
    `/managed-agents/outboxes?${query.toString()}`,
    undefined,
    outboxesResponseSchema,
  )
}

export async function getManagedAgentSchedules(
  projectId: string,
  agentId: string,
  environment: 'development' | 'production',
) {
  const query = new URLSearchParams({ projectId, agentId, environment })
  return (
    await apiFetch(
      `/managed-agents/schedules?${query.toString()}`,
      undefined,
      schedulesResponseSchema,
    )
  ).schedules
}

export async function getManagedAgentScheduleRuns(
  projectId: string,
  agentId: string,
  environment: 'development' | 'production',
) {
  const query = new URLSearchParams({ projectId, agentId, environment })
  return (
    await apiFetch(
      `/managed-agents/schedule-runs?${query.toString()}`,
      undefined,
      scheduleRunsResponseSchema,
    )
  ).runs
}

export async function runManagedAgentSchedule(
  projectId: string,
  agentId: string,
  environment: 'development' | 'production',
  scheduleId: string,
) {
  const query = new URLSearchParams({ projectId, agentId, environment })
  return (
    await apiFetch(
      `/managed-agents/schedules/${encodeURIComponent(scheduleId)}/run?${query.toString()}`,
      { method: 'POST' },
      scheduleRunResponseSchema,
    )
  ).run
}

export async function getManagedAgentWebhooks(
  projectId: string,
  agentId: string,
  environment: 'development' | 'production',
) {
  const query = new URLSearchParams({ agentId, environment })
  return (
    await apiFetch(
      `/managed-agents/projects/${encodeURIComponent(projectId)}/webhooks?${query.toString()}`,
      undefined,
      webhooksResponseSchema,
    )
  ).webhooks
}

export async function createManagedAgentWebhook(input: {
  projectId: string
  agentId: string
  environment: 'development' | 'production'
  name: string
}) {
  return (
    await apiFetch(
      `/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks`,
      {
        method: 'POST',
        body: JSON.stringify({
          agentId: input.agentId,
          environment: input.environment,
          name: input.name,
        }),
      },
      webhookResponseSchema,
    )
  ).webhook
}

export async function updateManagedAgentWebhook(input: {
  projectId: string
  webhookId: string
  enabled: boolean
}) {
  return (
    await apiFetch(
      `/managed-agents/projects/${encodeURIComponent(input.projectId)}/webhooks/${encodeURIComponent(input.webhookId)}`,
      { method: 'PATCH', body: JSON.stringify({ enabled: input.enabled }) },
      webhookResponseSchema,
    )
  ).webhook
}

export async function rotateManagedAgentWebhookToken(
  projectId: string,
  webhookId: string,
) {
  return (
    await apiFetch(
      `/managed-agents/projects/${encodeURIComponent(projectId)}/webhooks/${encodeURIComponent(webhookId)}/rotate-token`,
      { method: 'POST' },
      webhookResponseSchema,
    )
  ).webhook
}

export async function deleteManagedAgentWebhook(
  projectId: string,
  webhookId: string,
) {
  return apiFetch<void>(
    `/managed-agents/projects/${encodeURIComponent(projectId)}/webhooks/${encodeURIComponent(webhookId)}`,
    { method: 'DELETE' },
  )
}

export async function startManagedAgentSlack(
  agentId: string,
  name: string,
  reconnect = false,
  channelId?: string,
) {
  return apiFetch(
    '/managed-agents/channels/slack/connections',
    {
      method: 'POST',
      body: JSON.stringify({ agentId, name, reconnect, channelId }),
    },
    slackManifestResponseSchema,
  )
}

export async function bindManagedAgentSlackDestination(
  connectionId: string,
  destination: string,
  conversationId: string,
) {
  return apiFetch(
    `/managed-agents/channels/slack/connections/${encodeURIComponent(connectionId)}/destinations/${encodeURIComponent(destination)}`,
    { method: 'PUT', body: JSON.stringify({ conversationId }) },
    z.object({
      connectionId: z.string(),
      destination: z.string(),
      conversationId: z.string(),
      displayName: z.string(),
      verifiedAt: z.string(),
    }),
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

export async function collectManagedAgentEventPages(
  loadPage: (after: number) => Promise<ManagedAgentEvent[]>,
  after = 0,
) {
  const collected: ManagedAgentEvent[] = []
  let cursor = after
  for (;;) {
    const events = await loadPage(cursor)
    if (events.length === 0) return collected
    collected.push(...events)
    const nextCursor = Math.max(cursor, ...events.map((event) => event.seq))
    if (nextCursor === cursor) return collected
    cursor = nextCursor
  }
}

export async function getManagedAgentSessionEvents(
  sessionId: string,
  after = 0,
) {
  return collectManagedAgentEventPages(async (cursor) => {
    return (
      await apiFetch(
        `/managed-agents/sessions/${encodeURIComponent(sessionId)}/events?after=${cursor}`,
        undefined,
        eventsResponseSchema,
      )
    ).events
  }, after)
}

export async function admitManagedAgentInput(
  sessionId: string,
  input: string,
  mode: ManagedAgentInputMode,
  signal?: AbortSignal,
) {
  return apiFetch(
    `/managed-agents/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      method: 'POST',
      body: JSON.stringify({
        input,
        mode,
        idempotencyKey: crypto.randomUUID(),
      }),
      signal,
    },
    turnSchema,
  )
}

async function suspendManagedAgentIfIdle(sessionId: string) {
  const session = await getManagedAgentSession(sessionId).catch(() => undefined)
  if (session?.status !== 'idle') return
  await apiFetch(
    `/managed-agents/sessions/${encodeURIComponent(sessionId)}/suspend`,
    { method: 'POST' },
  ).catch(() => undefined)
}

export function managedAgentRenderDebug(event: ManagedAgentEvent) {
  if (event.type !== 'agent.rendered') return undefined
  const parsed = renderDebugSchema.safeParse(event.data)
  return parsed.success ? parsed.data : undefined
}

export function managedAgentModelRoute(event: ManagedAgentEvent) {
  if (event.type !== 'model.route_resolved') return undefined
  const parsed = modelRouteSchema.safeParse(event.data)
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

export function nextAgentEventDeadline(
  deadline: number,
  timeoutMs: number,
  receivedEvents: number,
  now = Date.now(),
) {
  return receivedEvents > 0 ? now + timeoutMs : deadline
}

async function waitForAgentEvent(
  sessionId: string,
  after: number,
  terminal: (event: z.infer<typeof eventSchema>) => boolean,
  onEvent: (event: z.infer<typeof eventSchema>) => void,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  let deadline = Date.now() + timeoutMs
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
    // Treat timeoutMs as an inactivity deadline. Multi-step agents can run for
    // longer than one fixed window while continuing to stream useful progress.
    deadline = nextAgentEventDeadline(deadline, timeoutMs, events.length)
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
    const turn = await admitManagedAgentInput(
      sessionId,
      input,
      'queue',
      options.signal,
    )
    const completed = await waitForAgentEvent(
      sessionId,
      connected.cursor,
      (event) =>
        event.turnId === turn.turnId &&
        (event.type === 'turn.completed' ||
          event.type === 'turn.failed' ||
          event.type === 'turn.cancelled'),
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
    await suspendManagedAgentIfIdle(sessionId)
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
    const turn = await admitManagedAgentInput(sessionId, input, 'queue', signal)
    const completed = await waitForAgentEvent(
      sessionId,
      cursor,
      (event) =>
        event.turnId === turn.turnId &&
        (event.type === 'turn.completed' ||
          event.type === 'turn.failed' ||
          event.type === 'turn.cancelled'),
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
    await suspendManagedAgentIfIdle(sessionId)
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
    const turn = await admitManagedAgentInput(sessionId, input, 'queue')
    let streamedText = ''
    let completedText = ''
    const completed = await waitForAgentEvent(
      sessionId,
      connected.cursor,
      (event) =>
        event.turnId === turn.turnId &&
        (event.type === 'turn.completed' ||
          event.type === 'turn.failed' ||
          event.type === 'turn.cancelled'),
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
    await suspendManagedAgentIfIdle(sessionId)
  }
}
