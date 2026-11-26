import { useContext } from 'react'
import { z } from 'zod'
import { AuthContext } from '@/hooks/useAuth'
import { ApiError } from '@/api/errors'
import { apiFetch } from '@/api/client'

// The Work API's repository setting: which GitHub repository is the
// organization's knowledge repository, and what its GitHub installations
// grant. Called with the dashboard's session cookie on the public `/api`
// base, like the sessions routes.

const PREFIX = '/managed-agents/computer/work'

// Objects are loose: the API may add fields.
export const RepositorySchema = z.looseObject({
  installationId: z.union([z.string(), z.number()]),
  owner: z.string(),
  name: z.string(),
  branch: z.string(),
  // Set when the repository can no longer be read (installation removed,
  // repository deleted, renamed or no longer granted; tech design 3.6): a
  // stable code such as `access_denied` or `repository_not_found`, and the
  // server's sentence for a person. See `repositoryProblem` in board.ts.
  problem: z.string().nullable().optional(),
  problemMessage: z.string().nullable().optional(),
})
export type Repository = z.infer<typeof RepositorySchema>

const RepositoryResultSchema = z.looseObject({
  repository: RepositorySchema.nullable(),
})

const GrantedRepositorySchema = z.looseObject({
  id: z.number(),
  owner: z.string(),
  name: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  // Null for a repository never pushed to.
  pushedAt: z.string().nullable(),
})
export type GrantedRepository = z.infer<typeof GrantedRepositorySchema>

// One of the organization's GitHub installations and a page of the
// repositories it grants; `nextPage` is the page holding more, or null on the
// last. `settingsUrl` is the installation's page on GitHub, where a person
// grants it more.
const GrantingInstallationSchema = z.looseObject({
  id: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  settingsUrl: z.string(),
  repositories: z.array(GrantedRepositorySchema),
  nextPage: z.number().int().positive().nullable().optional(),
  truncated: z.boolean(),
  problem: z.string().nullable(),
  problemMessage: z.string().nullable(),
})
export type GrantingInstallation = z.infer<typeof GrantingInstallationSchema>

const RepositoriesSchema = z.looseObject({
  installations: z.array(GrantingInstallationSchema),
})

export type RepositoryChoice = {
  installationId: string | number
  owner: string
  name: string
  branch: string
}

export function getRepository() {
  return apiFetch(
    `${PREFIX}/repository`,
    undefined,
    RepositoryResultSchema,
    '/api',
  ).then((r) => r.repository)
}

export function putRepository(choice: RepositoryChoice) {
  return apiFetch(
    `${PREFIX}/repository`,
    {
      method: 'PUT',
      body: JSON.stringify(choice),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    },
    RepositoryResultSchema,
    '/api',
  ).then((r) => r.repository)
}

function getRepositoriesPage(installation?: string, page = 1) {
  const query = installation
    ? `?${new URLSearchParams({ installation, page: String(page) })}`
    : ''
  return apiFetch(
    `${PREFIX}/repositories${query}`,
    undefined,
    RepositoriesSchema,
    '/api',
  ).then((r) => r.installations)
}

/**
 * What each of the organization's GitHub installations grants, for the
 * picker: every page, read up front so a search covers them all. Most
 * recently pushed first, never pushed last.
 */
export async function getRepositories() {
  const installations = await getRepositoriesPage()
  return Promise.all(
    installations.map(async (installation) => {
      const repositories = [...installation.repositories]
      let next = installation.nextPage ?? null
      let truncated = installation.truncated
      while (next !== null) {
        const [more] = await getRepositoriesPage(installation.id, next)
        if (!more) break
        repositories.push(...more.repositories)
        next = more.nextPage ?? null
        truncated = more.truncated
      }
      return {
        ...installation,
        repositories: repositories.sort(byPushed),
        nextPage: null,
        truncated,
      }
    }),
  )
}

function byPushed(a: GrantedRepository, b: GrantedRepository) {
  if (a.pushedAt !== b.pushedAt) {
    if (a.pushedAt === null) return 1
    if (b.pushedAt === null) return -1
    return Date.parse(b.pushedAt) - Date.parse(a.pushedAt)
  }
  return a.name.localeCompare(b.name)
}

// Retries wait as the server asks: a 503 `unavailable` carries `retryAfterMs`
// (the Work service is starting), kept between
// 1 s and 60 s. Anything else backs off as React Query does by default.
const MIN_RETRY_MS = 1_000
const MAX_RETRY_MS = 60_000

/** The delay before retry `attempt` (0 first) of a work query. */
export function workRetryDelay(attempt: number, error: Error): number {
  const asked =
    error instanceof ApiError ? error.details?.retryAfterMs : undefined
  if (typeof asked === 'number' && Number.isFinite(asked))
    return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, asked))
  return Math.min(1_000 * 2 ** attempt, 30_000)
}

// Every key starts with the organization so a switch never shows another
// organization's repository.
export const workKeys = {
  all: ['work'] as const,
  repository: (org: string) => ['work', org, 'repository'] as const,
  repositories: (org: string) => ['work', org, 'repositories'] as const,
}

/** The organization the keys are scoped to; '' before the user is known. */
export function useOrg(): string {
  return useContext(AuthContext)?.user?.orgId ?? ''
}
