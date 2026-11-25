import { z } from 'zod'
import { apiFetch } from '@/api/client'
import { ApiError } from '@/api/errors'

// The Computer API v1 (computer/schema/computer-api.v1.json), called with the
// dashboard's session cookie on the public `/api` base: the api-edge accepts a
// cookie on these routes and the backend records the caller `via: dashboard`.
// Live updates long-poll `GET /events?waitMs`; a login's WebSocket ticket is
// read-only (work 113), or a terminal ticket for one session (terminal-wire.ts).

const PREFIX = '/managed-agents/computer'

// Objects are loose: the schema says every object may gain fields.
const PersonSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable().optional(),
})

const QuestionSchema = z.looseObject({
  id: z.string(),
  header: z.string(),
  text: z.string(),
  multiSelect: z.boolean(),
  options: z.array(
    z.looseObject({ label: z.string(), description: z.string().nullable() }),
  ),
})

export const AskSchema = z.looseObject({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  createdAt: z.string(),
  approval: z
    .looseObject({
      toolName: z.string(),
      title: z.string().nullable().optional(),
      input: z.unknown().optional(),
      alwaysAllows: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  question: z
    .looseObject({ questions: z.array(QuestionSchema) })
    .nullable()
    .optional(),
  secret: z
    .object({ name: z.string(), purpose: z.string(), file: z.boolean() })
    .nullable()
    .optional(),
})
export type Ask = z.infer<typeof AskSchema>

export const SessionSchema = z.looseObject({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  archived: z.boolean(),
  // Set aside by its owner in triage, until something newer needs them.
  aside: z.boolean().default(false),
  owner: PersonSchema.nullable(),
  origin: z.looseObject({
    type: z.string(),
    client: z.string().nullable().optional(),
    slack: z
      .looseObject({ url: z.string().nullable().optional() })
      .nullable()
      .optional(),
  }),
  settings: z.looseObject({
    model: z.string().nullable(),
    effort: z.string().nullable(),
    mode: z.string().nullable(),
    speed: z.string().nullable().optional(),
  }),
  activeTurnId: z.string().nullable(),
  asks: z.array(AskSchema),
  lastText: z.string().nullable(),
  lastSeq: z.number(),
  createdAt: z.string(),
  lastActiveAt: z.string().nullable(),
})
export type Session = z.infer<typeof SessionSchema>

const SessionPageSchema = z.looseObject({
  sessions: z.array(SessionSchema),
  nextCursor: z.string().nullable(),
})
export type SessionPage = z.infer<typeof SessionPageSchema>

const ActorSchema = z.looseObject({
  id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  via: z.string().nullable().optional(),
})

export const EventSchema = z.looseObject({
  id: z.string(),
  seq: z.number(),
  createdAt: z.string(),
  turnId: z.string().nullable(),
  actor: ActorSchema.nullable(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
})
export type SessionEvent = z.infer<typeof EventSchema>

const EventPageSchema = z.looseObject({
  events: z.array(EventSchema),
  lastSeq: z.number(),
  hasMore: z.boolean(),
  // With `tailTurns`: the turns before the tail, as one line each.
  earlierTurns: z.array(z.unknown()).nullable().optional(),
})
export type EventPage = z.infer<typeof EventPageSchema>

const CapabilitiesSchema = z.looseObject({
  models: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      efforts: z.array(z.string()),
      default: z.boolean(),
    }),
  ),
  modes: z.array(z.string()),
  features: z.looseObject({ steer: z.boolean() }),
})
export type Capabilities = z.infer<typeof CapabilitiesSchema>

const SessionResultSchema = z.looseObject({ session: SessionSchema })
const SendResultSchema = z.looseObject({
  turn: z.looseObject({ id: z.string(), status: z.string() }),
  delivery: z.string(),
})
const AskResultSchema = z.looseObject({ ask: AskSchema })

export type ListSessionsQuery = {
  owner?: 'me' | 'anyone'
  status?: string
  q?: string
  archived?: 'false' | 'true' | 'all'
  limit?: number
  cursor?: string
}

export function listSessions(query: ListSessionsQuery) {
  const params = new URLSearchParams({ owner: 'anyone', order: 'active' })
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, String(v))
  }
  return apiFetch(
    `${PREFIX}/sessions?${params}`,
    undefined,
    SessionPageSchema,
    '/api',
  )
}

export type SessionSettings = {
  model?: string
  effort?: string
  mode?: string
}

// A cold computer takes a few minutes to boot; past this, starting gives up.
const START_TIMEOUT_MS = 5 * 60_000

/**
 * Starts a session. While the computer is starting (the first session of an
 * organization with no computer creates it), the API answers 503
 * `computer_unavailable`: wait as it asks and try again, telling the caller
 * so it can say why the wait.
 */
export async function createSession(
  input: string,
  settings: SessionSettings = {},
  onComputerStarting?: () => void,
) {
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    try {
      const result = await apiFetch(
        `${PREFIX}/sessions`,
        { method: 'POST', body: JSON.stringify({ input, ...settings }) },
        SessionResultSchema,
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

export function getSession(id: string) {
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(id)}`,
    undefined,
    SessionResultSchema,
    '/api',
  ).then((r) => r.session)
}

export function updateSession(
  id: string,
  patch: SessionSettings & { title?: string; archived?: boolean },
) {
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
    SessionResultSchema,
    '/api',
  ).then((r) => r.session)
}

// Sets the session aside in triage until something newer needs its owner:
// `ref` is the ask being set aside. Owner only.
export function setAside(id: string, ref: string) {
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(id)}/aside`,
    { method: 'PUT', body: JSON.stringify({ ref }) },
    SessionResultSchema,
    '/api',
  ).then((r) => r.session)
}

export function bringBack(id: string) {
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(id)}/aside`,
    { method: 'DELETE' },
    SessionResultSchema,
    '/api',
  ).then((r) => r.session)
}

export type IfBusy = 'queue' | 'steer' | 'interrupt'

export function sendTurn(id: string, input: string, ifBusy: IfBusy) {
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(id)}/turns`,
    { method: 'POST', body: JSON.stringify({ input, ifBusy }) },
    SendResultSchema,
    '/api',
  )
}

const TicketSchema = z.looseObject({
  ticket: z.looseObject({ token: z.string(), url: z.string() }),
})

/** A ticket for one terminal connection to session `id`; refused unless the caller may drive it. */
export async function mintTerminalTicket(id: string) {
  const { ticket } = await apiFetch(
    `${PREFIX}/tickets`,
    {
      method: 'POST',
      body: JSON.stringify({
        client: 'dashboard',
        terminal: true,
        sessionIds: [id],
      }),
    },
    TicketSchema,
    '/api',
  )
  return ticket
}

/** Starts a stopped (suspended or idle) session's computer again. */
export function resumeSession(id: string) {
  return apiFetch<unknown>(
    `${PREFIX}/sessions/${encodeURIComponent(id)}/resume`,
    { method: 'POST', body: '{}' },
    undefined,
    '/api',
  )
}

export function interruptSession(id: string) {
  return apiFetch<unknown>(
    `${PREFIX}/sessions/${encodeURIComponent(id)}/interrupt`,
    { method: 'POST', body: '{}' },
    undefined,
    '/api',
  )
}

export type AskAnswer =
  | { decision: 'allow' | 'deny' | 'always'; message?: string }
  | {
      answers: Array<{
        questionId: string
        choices: string[]
        text: string | null
      }>
    }

export function answerAsk(sessionId: string, askId: string, answer: AskAnswer) {
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(sessionId)}/asks/${encodeURIComponent(askId)}/answer`,
    { method: 'POST', body: JSON.stringify(answer) },
    AskResultSchema,
    '/api',
  )
}

export function dismissAsk(sessionId: string, askId: string) {
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(sessionId)}/asks/${encodeURIComponent(askId)}/dismiss`,
    { method: 'POST', body: '{}' },
    AskResultSchema,
    '/api',
  )
}

// One page of events: the last `tailTurns` turns, or those after `after`; with
// `waitMs` the server holds the request until something new arrives
// (long-poll).
export function getEvents(
  id: string,
  opts: { after?: number; tailTurns?: number; limit?: number; waitMs?: number },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams()
  if (opts.after !== undefined) params.set('after', String(opts.after))
  if (opts.tailTurns !== undefined)
    params.set('tailTurns', String(opts.tailTurns))
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.waitMs !== undefined) params.set('waitMs', String(opts.waitMs))
  return apiFetch(
    `${PREFIX}/sessions/${encodeURIComponent(id)}/events?${params}`,
    { signal },
    EventPageSchema,
    '/api',
  )
}

export function getCapabilities() {
  return apiFetch(
    `${PREFIX}/capabilities`,
    undefined,
    z.looseObject({ capabilities: CapabilitiesSchema }),
    '/api',
  ).then((r) => r.capabilities)
}

export const sessionKeys = {
  all: ['computer-sessions'] as const,
  list: (q: ListSessionsQuery) => ['computer-sessions', 'list', q] as const,
  one: (id: string) => ['computer-sessions', 'one', id] as const,
  events: (id: string, q: object) =>
    ['computer-sessions', 'events', id, q] as const,
  capabilities: ['computer-sessions', 'capabilities'] as const,
}
