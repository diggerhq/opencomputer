import { z } from 'zod'
import { apiFetch } from '@/api/client'
import { ApiError } from '@/api/errors'

// The organization's computer (serverless-agents-ws work 052, "API
// contract"). The edge proxies these dashboard routes to the backend's
// `/v1/computer…` and rebuilds each body from exactly these fields.

export const computerStateSchema = z.enum([
  'provisioning',
  'ready',
  'parked',
  'waking',
  'failed',
  'deleting',
])

export const computerSchema = z.object({
  state: computerStateSchema,
  // `ready` means the machine exists; `connected` that it is online.
  connected: z.boolean(),
  vcpus: z.number(),
  memoryGiB: z.number(),
  diskGiB: z.number(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

// The person's coding agent (serverless-agents-ws work 081, "API"): what
// they chose at setup step 1 and the health of the subscription they
// connected. Health only: usage figures stay in `!claude status`.
export const agentChoiceSchema = z.enum(['claude', 'codex', 'credits'])

export const agentSubscriptionHealthSchema = z.enum([
  'ok',
  'unchecked',
  'paused',
  'limited',
  'invalid',
])

export const subscriptionProviderSchema = z.enum(['claude', 'codex'])

const agentSubscriptionSchema = z.object({
  // `codex` is a ChatGPT plan running Codex (work 082).
  provider: subscriptionProviderSchema,
  health: agentSubscriptionHealthSchema,
  limitedUntil: z.string().optional(),
  setAt: z.string(),
  /** ChatGPT only: the plan from the login ("plus", "pro"…). */
  plan: z.string().optional(),
})

export const computerAgentSchema = z.object({
  choice: agentChoiceSchema.nullable(),
  /** This dashboard user is linked to a Slack user (through the install). */
  linked: z.boolean(),
  linkedSlackUser: z
    .object({ id: z.string(), name: z.string(), teamName: z.string() })
    .optional(),
  /** The one that runs threads: the chosen provider's, else the other's. */
  subscription: agentSubscriptionSchema.nullable(),
  /**
   * Every provider's, connected or not (work 083), so each gets a row.
   * Absent from an older backend: only `subscription` is known.
   */
  subscriptions: z
    .object({
      claude: agentSubscriptionSchema.nullable(),
      codex: agentSubscriptionSchema.nullable(),
    })
    .optional(),
  /** The model free credits run, e.g. "Claude Opus 5.5". */
  managedModel: z.string(),
  /**
   * The harnesses this computer can run, e.g. ["claude", "codex"] (work 082
   * rollout gate and kill switch). Absent from an older backend: Claude only.
   */
  harnesses: z.array(z.string()).optional(),
})

export const computerStatusSchema = z.object({
  computer: computerSchema.nullable(),
  slack: z.object({
    installed: z.boolean(),
    teamId: z.string().optional(),
    teamName: z.string().optional(),
    /** The app's bot user, to open a DM with it. */
    botUserId: z.string().optional(),
  }),
  github: z.object({
    connected: z.boolean(),
    installations: z.array(
      z.object({ id: z.string(), accountLogin: z.string() }),
    ),
  }),
  plan: z.enum(['free', 'paid']),
  // Optional: an edge or backend without work 081 sends none, and setup then
  // starts at Slack as before.
  agent: computerAgentSchema.optional(),
})

export const computerSessionStatusSchema = z.enum([
  'starting',
  'busy',
  'idle',
  'ended',
  'error',
])

export const computerSessionSchema = z.object({
  key: z.string(),
  title: z.string(),
  channelId: z.string(),
  threadTs: z.string(),
  ownerSlackUserId: z.string().nullable(),
  status: computerSessionStatusSchema,
  updatedAt: z.string(),
  slackUrl: z.string().nullable(),
})

export const computerSessionsSchema = z.object({
  sessions: z.array(computerSessionSchema),
})

export const computerSlackInstallSchema = z.object({ url: z.url() })

export const computerAgentConnectSchema = z.object({
  agent: computerAgentSchema,
  verified: z.boolean(),
  /** Where the token was checked: the org's computer, a spare one, or not. */
  via: z.enum(['own', 'pool', 'none']),
})

export const computerAgentResultSchema = z.object({
  agent: computerAgentSchema,
})

/**
 * A one-command connect code (work 082): ten minutes, single use, good for
 * storing one subscription for this person; minting one replaces the last.
 */
export const computerConnectCodeSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.string(),
})

export type ComputerState = z.infer<typeof computerStateSchema>
export type Computer = z.infer<typeof computerSchema>
export type ComputerStatus = z.infer<typeof computerStatusSchema>
export type ComputerAgent = z.infer<typeof computerAgentSchema>
export type AgentSubscription = z.infer<typeof agentSubscriptionSchema>
export type AgentChoice = z.infer<typeof agentChoiceSchema>
export type SubscriptionProvider = z.infer<typeof subscriptionProviderSchema>
export type ComputerConnectCode = z.infer<typeof computerConnectCodeSchema>
export type ConnectCodePurpose = 'connect' | 'link'
export type AgentSubscriptionHealth = z.infer<
  typeof agentSubscriptionHealthSchema
>
export type ComputerAgentConnect = z.infer<typeof computerAgentConnectSchema>
export type ComputerSession = z.infer<typeof computerSessionSchema>
export type ComputerSessionStatus = z.infer<typeof computerSessionStatusSchema>

export const computerQueryKey = ['managed-computer'] as const
export const computerConnectCodeQueryKey = [
  'managed-computer',
  'connect-code',
] as const
export const computerSessionsQueryKey = [
  'managed-computer',
  'sessions',
] as const

export function getComputer() {
  return apiFetch('/managed-agents/computer', undefined, computerStatusSchema)
}

/** Creates the organization's computer, or wakes a sleeping one. Idempotent. */
export function createComputer() {
  return apiFetch(
    '/managed-agents/computer',
    { method: 'POST', body: '{}' },
    computerStatusSchema,
  )
}

export async function getComputerSessions() {
  return (
    await apiFetch(
      '/managed-agents/computer/sessions',
      undefined,
      computerSessionsSchema,
    )
  ).sessions
}

// A cold computer takes a few minutes to boot; past this, starting gives up.
const START_TIMEOUT_MS = 5 * 60_000

const startedSessionSchema = z.looseObject({
  session: z.looseObject({ id: z.string() }),
})

/**
 * Starts a session (the Computer API's `POST /sessions`, with the dashboard's
 * cookie on the public `/api` base). While the computer is starting (the
 * first session of an organization with no computer creates it), the API
 * answers 503 `computer_unavailable`: wait as it asks and try again, telling
 * the caller so it can say why the wait.
 */
export async function createSession(
  input: string,
  onComputerStarting?: () => void,
) {
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    try {
      const result = await apiFetch(
        '/managed-agents/computer/sessions',
        { method: 'POST', body: JSON.stringify({ input }) },
        startedSessionSchema,
        '/api',
      )
      return result.session
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.type !== 'computer_unavailable' ||
        Date.now() > deadline
      ) {
        throw error
      }
      onComputerStarting?.()
      const wait = error.details?.retryAfterMs
      await new Promise((resolve) =>
        setTimeout(resolve, typeof wait === 'number' ? wait : 5_000),
      )
    }
  }
}

/** Slack's authorize URL, with a short-lived state bound to this organization. */
export async function startComputerSlackInstall() {
  return (
    await apiFetch(
      '/managed-agents/computer/slack/install',
      { method: 'POST', body: '{}' },
      computerSlackInstallSchema,
    )
  ).url
}

export async function unlinkComputerSlack() {
  await apiFetch('/managed-agents/computer/slack', { method: 'DELETE' })
}

/**
 * Connects the person's Claude subscription. The server checks the token
 * (about 9 s at worst) and answers in every branch, so this is never aborted:
 * an abort could cancel the save and make "Saved" untrue.
 */
export function connectClaudeSubscription(token: string) {
  return apiFetch(
    '/managed-agents/computer/agent/claude',
    { method: 'PUT', body: JSON.stringify({ token }) },
    computerAgentConnectSchema,
  )
}

export async function disconnectClaudeSubscription() {
  await apiFetch('/managed-agents/computer/agent/claude', { method: 'DELETE' })
}

export async function resumeClaudeSubscription() {
  return (
    await apiFetch(
      '/managed-agents/computer/agent/claude/resume',
      { method: 'POST', body: '{}' },
      computerAgentResultSchema,
    )
  ).agent
}

export async function setAgentChoice(choice: AgentChoice) {
  return (
    await apiFetch(
      '/managed-agents/computer/agent/choice',
      { method: 'PUT', body: JSON.stringify({ choice }) },
      computerAgentResultSchema,
    )
  ).agent
}

/**
 * Mints this person's code: `connect` for the CLI (work 082), `link` for
 * `!link` in Slack, which links them to the Slack user who sends it (083).
 */
export function createConnectCode(purpose: ConnectCodePurpose = 'connect') {
  return apiFetch(
    '/managed-agents/computer/agent/connect-code',
    {
      method: 'POST',
      body: JSON.stringify(purpose === 'link' ? { purpose } : {}),
    },
    computerConnectCodeSchema,
  )
}

/** What an older backend that names no harnesses can run: today's Claude. */
const DEFAULT_HARNESSES: readonly string[] = ['claude']

/**
 * Whether this computer can run a harness; a card for one it cannot shows
 * as coming.
 */
export function isHarnessAvailable(
  agent: Pick<ComputerAgent, 'harnesses'>,
  harness: SubscriptionProvider,
): boolean {
  return (agent.harnesses ?? DEFAULT_HARNESSES).includes(harness)
}

/** The one command a person runs to connect a subscription with a code. */
export function connectCommand(provider: SubscriptionProvider, code: string) {
  return `npx -y @opencomputer/cli model connect ${provider} --code ${code}`
}

export async function disconnectCodexSubscription() {
  await apiFetch('/managed-agents/computer/agent/codex', { method: 'DELETE' })
}
