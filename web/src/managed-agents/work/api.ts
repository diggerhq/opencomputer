import { useContext } from 'react'
import { z } from 'zod'
import { AuthContext } from '@/hooks/useAuth'
import { ApiError } from '@/api/errors'
import { apiFetch, apiFetchResponse, validate } from '@/api/client'

// The Work API (serverless-agents-ws product/work-tracking/tech-design.md,
// 3.10): the organization's tracked items, read from its knowledge
// repository, each composed with the attention of its sessions for the
// caller. Called with the dashboard's session cookie on the public `/api`
// base, like the sessions routes. The screens render these fields as they
// come: stage, readiness, attention and `mine` are the server's answers.

const PREFIX = '/managed-agents/computer/work'

// Objects are loose: the API may add fields.
const PersonSchema = z.looseObject({
  email: z.string(),
  name: z.string().nullable(),
  id: z.string().nullable(),
})
export type Person = z.infer<typeof PersonSchema>

// Who owns an item: the doc's `owner:` (declared), or else the author of its
// latest change that was not a bulk edit (derived, from recent commits).
const OwnerSchema = z.looseObject({
  email: z.string(),
  name: z.string().nullable(),
  id: z.string().nullable(),
  source: z.enum(['declared', 'derived']),
})
export type Owner = z.infer<typeof OwnerSchema>

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

export const PullStateSchema = z
  .enum(['open', 'draft', 'merged', 'closed'])
  .nullable()
export type PullState = z.infer<typeof PullStateSchema>

const PullRequestSchema = z.looseObject({
  url: z.string(),
  state: PullStateSchema,
  title: z.string().nullable(),
})
export type PullRequest = z.infer<typeof PullRequestSchema>

export const AttentionSchema = z.looseObject({
  state: z.enum(['needs_you', 'waiting_on', 'working']),
  name: z.string().nullable(),
  since: z.string(),
})
export type Attention = z.infer<typeof AttentionSchema>

export const SessionStatusSchema = z.enum([
  'starting',
  'running',
  'waiting',
  'idle',
  'suspended',
])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

const ItemSessionSchema = z.looseObject({
  id: z.string(),
  title: z.string().nullable(),
  ownerName: z.string().nullable(),
  // The session's lifecycle status, as the sessions API names it.
  status: SessionStatusSchema,
})
export type ItemSession = z.infer<typeof ItemSessionSchema>

export const ItemSchema = z.looseObject({
  number: z.number(),
  stage: z.enum(['open', 'closed']),
  path: z.string(),
  url: z.string(),
  title: z.string(),
  stateLine: z.string().nullable(),
  tags: z.array(z.string()),
  owner: OwnerSchema.nullable(),
  author: PersonSchema.nullable(),
  mine: z.boolean(),
  left: z.number().nullable(),
  readyToClose: z.boolean(),
  warnings: z.array(z.string()),
  pullRequests: z.array(PullRequestSchema),
  attention: AttentionSchema.nullable(),
  sessions: z.array(ItemSessionSchema),
  unpublished: z.boolean(),
  // Null while the index has not read the doc's last commit yet.
  updatedAt: z.string().nullable(),
  // The doc's latest commit that was not a bulk edit (one touching more than
  // five items); null when the index has read none.
  lastActivityAt: z.string().nullable(),
  // Changed in the last 14 days, or a linked session is running or waiting:
  // the board shows active items and folds the rest under "Dormant".
  active: z.boolean(),
  createdAt: z.string().nullable(),
  // Both may be null on a closed item, when not known yet.
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
})
export type Item = z.infer<typeof ItemSchema>

const OpenItemsSchema = z.looseObject({
  repository: RepositorySchema.nullable(),
  head: z.string().nullable(),
  asOf: z.string().nullable(),
  building: z.boolean(),
  items: z.array(ItemSchema),
})
export type OpenItems = z.infer<typeof OpenItemsSchema>

const ClosedItemsSchema = z.looseObject({
  items: z.array(ItemSchema),
  nextCursor: z.string().nullable(),
})
export type ClosedItems = z.infer<typeof ClosedItemsSchema>

const ItemResultSchema = z.looseObject({
  item: ItemSchema,
  body: z.string(),
})
export type ItemResult = z.infer<typeof ItemResultSchema>

const SessionItemsSchema = z.looseObject({
  items: z.array(ItemSchema),
})

const RevisionSchema = z.looseObject({
  sha: z.string(),
  url: z.string(),
  at: z.string(),
  authorName: z.string(),
  summary: z.string(),
  sessionId: z.string().nullable(),
})
export type Revision = z.infer<typeof RevisionSchema>

const HistorySchema = z.looseObject({
  revisions: z.array(RevisionSchema),
  nextCursor: z.string().nullable(),
})
export type History = z.infer<typeof HistorySchema>

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

// One of the organization's GitHub installations and the repositories it
// grants, most recently pushed first (the server's order). `settingsUrl` is
// the installation's page on GitHub, where a person grants it more.
const GrantingInstallationSchema = z.looseObject({
  id: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  settingsUrl: z.string(),
  repositories: z.array(GrantedRepositorySchema),
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

/** What each of the organization's GitHub installations grants, for the picker. */
export function getRepositories() {
  return apiFetch(
    `${PREFIX}/repositories`,
    undefined,
    RepositoriesSchema,
    '/api',
  ).then((r) => r.installations)
}

/** What the open-items poll keeps: the page and the ETag it came with. */
export type OpenItemsPoll = { etag: string | null; page: OpenItems }

/** A 304: the page is unchanged, but the index was read again at `asOf`. */
export type OpenItemsUnchanged = { notModified: true; asOf: string | null }

// The server sends how fresh its index is on every answer, 200 or 304, so a
// quiet board does not drift into "As of N ago" while nothing changes.
const AS_OF_HEADER = 'Work-As-Of'

/**
 * All open items. With the ETag of the last answer the server says 304 when
 * nothing changed; that returns only the new `asOf`, and the caller keeps the
 * page it has (`keepOpenItems`).
 */
export async function getOpenItems(
  etag: string | null,
): Promise<OpenItemsPoll | OpenItemsUnchanged> {
  const path = `${PREFIX}/items?stage=open`
  const init = etag ? { headers: { 'If-None-Match': etag } } : {}
  let res: Response
  if (import.meta.env.VITE_PREVIEW === '1') {
    const { workOpenItemsResponse } = await import('@/api/mock-work')
    res = workOpenItemsResponse(etag)
  } else {
    res = await apiFetchResponse(path, init, '/api')
  }
  const asOf = res.headers.get(AS_OF_HEADER)
  if (res.status === 304) return { notModified: true, asOf }
  const page = validate(OpenItemsSchema, await res.json(), path)
  return {
    etag: res.headers.get('ETag'),
    page: asOf ? { ...page, asOf } : page,
  }
}

/** The poll's next value: a new page, or the old one with the new `asOf`. */
export function keepOpenItems(
  prev: OpenItemsPoll,
  next: OpenItemsPoll | OpenItemsUnchanged,
): OpenItemsPoll {
  if (!('notModified' in next)) return next
  if (!next.asOf || next.asOf === prev.page.asOf) return prev
  return { ...prev, page: { ...prev.page, asOf: next.asOf } }
}

export function getClosedItems(cursor: string | undefined, limit = 50) {
  const params = new URLSearchParams({ stage: 'closed', limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  return apiFetch(
    `${PREFIX}/items?${params}`,
    undefined,
    ClosedItemsSchema,
    '/api',
  )
}

export function getItem(number: number) {
  return apiFetch(
    `${PREFIX}/items/${number}`,
    undefined,
    ItemResultSchema,
    '/api',
  )
}

export function getHistory(number: number, cursor: string | undefined) {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const query = params.size ? `?${params}` : ''
  return apiFetch(
    `${PREFIX}/items/${number}/history${query}`,
    undefined,
    HistorySchema,
    '/api',
  )
}

/** The items a session worked on (its commits' `Session:` trailers). */
export function getSessionItems(sessionId: string) {
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(sessionId)}/items`,
    undefined,
    SessionItemsSchema,
    '/api',
  ).then((r) => r.items)
}

// Retries wait as the server asks: a 503 `unavailable` carries `retryAfterMs`
// (the index is still reading, the Work service is starting), kept between
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
// organization's items.
export const workKeys = {
  all: ['work'] as const,
  repository: (org: string) => ['work', org, 'repository'] as const,
  repositories: (org: string) => ['work', org, 'repositories'] as const,
  open: (org: string) => ['work', org, 'items', 'open'] as const,
  closed: (org: string) => ['work', org, 'items', 'closed'] as const,
  item: (org: string, n: number) => ['work', org, 'item', n] as const,
  history: (org: string, n: number) => ['work', org, 'history', n] as const,
  session: (org: string, id: string) => ['work', org, 'session', id] as const,
}

/** The organization the keys are scoped to; '' before the user is known. */
export function useOrg(): string {
  return useContext(AuthContext)?.user?.orgId ?? ''
}
