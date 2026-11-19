import { useContext } from 'react'
import { z } from 'zod'
import { AuthContext } from '@/hooks/useAuth'
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

export const RepositorySchema = z.looseObject({
  installationId: z.union([z.string(), z.number()]),
  owner: z.string(),
  name: z.string(),
  branch: z.string(),
  // Set when the repository can no longer be read (installation removed,
  // repository deleted, renamed or no longer granted; tech design 3.6).
  problem: z.string().nullable().optional(),
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

const ItemSessionSchema = z.looseObject({
  id: z.string(),
  title: z.string().nullable(),
  ownerName: z.string().nullable(),
  // Not in the contract (3.10 lists id, title, ownerName): the session's
  // lifecycle status, shown when the server sends it. See WORK_WEB_NOTES.md.
  status: z.string().nullable().optional(),
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
  owner: PersonSchema.nullable(),
  author: PersonSchema.nullable(),
  mine: z.boolean(),
  left: z.number().nullable(),
  readyToClose: z.boolean(),
  warnings: z.array(z.string()),
  pullRequests: z.array(PullRequestSchema),
  attention: AttentionSchema.nullable(),
  sessions: z.array(ItemSessionSchema),
  unpublished: z.boolean(),
  updatedAt: z.string(),
  createdAt: z.string().nullable(),
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

/** What the open-items poll keeps: the page and the ETag it came with. */
export type OpenItemsPoll = { etag: string | null; page: OpenItems }

/**
 * All open items. With the ETag of the last answer the server says 304 when
 * nothing changed (head and attention unchanged); that returns null, and the
 * caller keeps what it has.
 */
export async function getOpenItems(
  etag: string | null,
): Promise<OpenItemsPoll | null> {
  const path = `${PREFIX}/items?stage=open`
  if (import.meta.env.VITE_PREVIEW === '1') {
    return {
      etag: null,
      page: await apiFetch(path, undefined, OpenItemsSchema),
    }
  }
  const res = await apiFetchResponse(
    path,
    etag ? { headers: { 'If-None-Match': etag } } : {},
    '/api',
  )
  if (res.status === 304) return null
  return {
    etag: res.headers.get('ETag'),
    page: validate(OpenItemsSchema, await res.json(), path),
  }
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

// Every key starts with the organization so a switch never shows another
// organization's items.
export const workKeys = {
  all: ['work'] as const,
  repository: (org: string) => ['work', org, 'repository'] as const,
  open: (org: string) => ['work', org, 'items', 'open'] as const,
  closed: (org: string) => ['work', org, 'items', 'closed'] as const,
  item: (org: string, n: number) => ['work', org, 'item', n] as const,
  history: (org: string, n: number) => ['work', org, 'history', n] as const,
}

/** The organization the keys are scoped to; '' before the user is known. */
export function useOrg(): string {
  return useContext(AuthContext)?.user?.orgId ?? ''
}
