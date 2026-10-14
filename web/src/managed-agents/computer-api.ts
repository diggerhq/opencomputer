import { z } from 'zod'
import { apiFetch } from '@/api/client'

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

export const computerStatusSchema = z.object({
  computer: computerSchema.nullable(),
  slack: z.object({
    installed: z.boolean(),
    teamId: z.string().optional(),
    teamName: z.string().optional(),
    /** The app's bot user, to open a DM with it. */
    botUserId: z.string().optional(),
    /**
     * The last install was refused: the workspace is another organization's.
     * `canMove`: this person linked it there and can move it here.
     */
    alreadyLinked: z
      .object({
        teamName: z.string(),
        notified: z.boolean(),
        canMove: z.boolean(),
      })
      .optional(),
  }),
  github: z.object({
    connected: z.boolean(),
    installations: z.array(
      z.object({ id: z.string(), accountLogin: z.string() }),
    ),
  }),
  plan: z.enum(['free', 'paid']),
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

export type ComputerState = z.infer<typeof computerStateSchema>
export type Computer = z.infer<typeof computerSchema>
export type ComputerStatus = z.infer<typeof computerStatusSchema>
export type ComputerSession = z.infer<typeof computerSessionSchema>
export type ComputerSessionStatus = z.infer<typeof computerSessionStatusSchema>

export const computerQueryKey = ['managed-computer'] as const
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

/** Moves a refused install's workspace here from the person's other organization. */
export async function moveComputerSlackHere() {
  return apiFetch(
    '/managed-agents/computer/slack/move',
    { method: 'POST', body: '{}' },
    computerStatusSchema,
  )
}

export async function dismissComputerSlackAlreadyLinked() {
  await apiFetch('/managed-agents/computer/slack/already-linked', {
    method: 'DELETE',
  })
}
