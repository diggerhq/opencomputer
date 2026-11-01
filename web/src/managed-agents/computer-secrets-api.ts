import { z } from 'zod'
import { apiFetch } from '@/api/client'

// The computer's organization secrets (serverless-agents-ws work 095, v1):
// the public Computer API's routes (docs/api/http/secrets.mdx), which a
// dashboard session may call as it is. Values go in and never come back;
// only a variable's value is listed.

const actorSchema = z.union([
  z.object({ member: z.string(), name: z.string().nullable() }),
  z.object({ slackUserId: z.string() }),
  z.object({ system: z.literal(true) }),
])

export const orgSecretSchema = z.object({
  name: z.string(),
  layer: z.literal('organization'),
  kind: z.enum(['secret', 'variable']),
  file: z.boolean(),
  /** Variables only; null when it could not be opened. */
  value: z.string().nullable().optional(),
  createdAt: z.string().nullable(),
  createdBy: actorSchema.nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: actorSchema.nullable(),
  /** Null until a session gets it after it was last set. */
  lastUsedAt: z.string().nullable(),
  /** Narrower copies of the name that win where they apply (counts only). */
  overriddenIn: z.object({ threads: z.number(), people: z.number() }),
})

export const secretEventSchema = z.object({
  at: z.string().nullable(),
  action: z.string(),
  kind: z.enum(['secret', 'variable']),
  actor: actorSchema.nullable(),
  via: z.string(),
})

export type SecretActor = z.infer<typeof actorSchema>
export type OrgSecret = z.infer<typeof orgSecretSchema>
export type SecretEvent = z.infer<typeof secretEventSchema>

export const orgSecretsQueryKey = ['managed-computer', 'secrets'] as const
export const secretEventsQueryKey = (name: string) =>
  ['managed-computer', 'secrets', name, 'events'] as const

const PREFIX = '/managed-agents/computer'

export async function getOrgSecrets() {
  return (
    await apiFetch(
      `${PREFIX}/secrets`,
      undefined,
      z.object({ secrets: z.array(orgSecretSchema) }),
      '/api',
    )
  ).secrets
}

export async function getSecretEvents(name: string) {
  return (
    await apiFetch(
      `${PREFIX}/secrets/${encodeURIComponent(name)}/events`,
      undefined,
      z.object({ events: z.array(secretEventSchema) }),
      '/api',
    )
  ).events
}

/** Sets or replaces an organization secret or variable. */
export async function putOrgSecret(input: {
  name: string
  value: string
  file: boolean
  variable: boolean
}) {
  const { name, ...body } = input
  return (
    await apiFetch(
      `${PREFIX}/organization/secrets/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify(body) },
      z.object({ secret: orgSecretSchema }),
      '/api',
    )
  ).secret
}

export async function deleteOrgSecret(name: string) {
  await apiFetch(
    `${PREFIX}/organization/secrets/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
    undefined,
    '/api',
  )
}

/** The name the server checks too; this only catches typos early. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
