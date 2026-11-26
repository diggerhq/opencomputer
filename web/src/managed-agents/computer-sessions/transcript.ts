import type { Ask, SessionEvent } from '../computer-sessions-api'
import { fromSlack } from './slack-text'

// Folds a session's events into what the transcript shows: people's messages,
// the agent's replies, and the tool calls between them collapsed into one
// "Worked for …" step (work 107). Types it does not know are skipped, as the
// API asks of every client.

export type ToolStep = {
  callId: string
  title: string
  toolName: string
  status: 'running' | 'done' | 'failed'
}

export type TranscriptItem =
  | {
      kind: 'user'
      key: string
      text: string
      author: string | null
      // The member id (`usr_…`) of whoever sent it.
      authorId: string | null
      via: string | null
      at: string
    }
  | { kind: 'agent'; key: string; text: string; at: string }
  | {
      kind: 'work'
      key: string
      tools: ToolStep[]
      startedAt: string
      endedAt: string
      open: boolean
    }
  | { kind: 'ask'; key: string; ask: Ask }
  | { kind: 'note'; key: string; text: string; tone: 'muted' | 'error' }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** A Slack message's words without the `[Slack: from … in #eng, mentions you]` line the computer puts above each for the model. */
export const withoutSlackHeader = (text: string | null): string | null =>
  text && text.replace(/^\[Slack: from [^\n]*\]\n?/gm, '').trim()

export function buildTranscript(events: SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  let work: Extract<TranscriptItem, { kind: 'work' }> | null = null
  const asks = new Map<string, Extract<TranscriptItem, { kind: 'ask' }>>()

  const closeWork = () => {
    if (work) work.open = false
    work = null
  }
  const workAt = (e: SessionEvent) => {
    if (!work) {
      work = {
        kind: 'work',
        key: `work-${e.seq}`,
        tools: [],
        startedAt: e.createdAt,
        endedAt: e.createdAt,
        open: true,
      }
      items.push(work)
    }
    work.endedAt = e.createdAt
    return work
  }

  for (const e of events) {
    const d = e.data
    switch (e.type) {
      case 'message.received': {
        closeWork()
        const input = withoutSlackHeader(str(d.input))
        const text = input && fromSlack(input)
        // Journals before the computer stopped using the git author name carry " via Computer".
        const name = e.actor?.name?.replace(/ via Computer$/, '')
        if (text)
          items.push({
            kind: 'user',
            key: e.id,
            text,
            // The computer falls back to the member id (`usr_…`) when there is no name: not worth showing.
            author: name && e.actor?.name !== e.actor?.id ? name : null,
            authorId: e.actor?.id ?? null,
            via: e.actor?.via ?? null,
            at: e.createdAt,
          })
        break
      }
      case 'message.completed': {
        const text = str(d.text)
        // A subagent's messages belong to its work, not the conversation.
        if (d.parentCallId) {
          workAt(e)
          break
        }
        closeWork()
        if (text)
          items.push({
            kind: 'agent',
            key: e.id,
            text: fromSlack(text),
            at: e.createdAt,
          })
        break
      }
      case 'reasoning.completed':
        workAt(e)
        break
      case 'tool.started': {
        const w = workAt(e)
        const callId = str(d.callId) ?? e.id
        if (!w.tools.some((t) => t.callId === callId))
          w.tools.push({
            callId,
            title: str(d.title) ?? str(d.toolName) ?? 'Tool',
            toolName: str(d.toolName) ?? '',
            status: 'running',
          })
        break
      }
      case 'tool.completed':
      case 'tool.failed': {
        const w = workAt(e)
        const callId = str(d.callId) ?? e.id
        const status = e.type === 'tool.completed' ? 'done' : 'failed'
        const tool = w.tools.find((t) => t.callId === callId)
        if (tool) tool.status = status
        else
          w.tools.push({
            callId,
            title: str(d.title) ?? str(d.toolName) ?? 'Tool',
            toolName: str(d.toolName) ?? '',
            status,
          })
        break
      }
      case 'ask.opened':
      case 'ask.closed': {
        const ask = d.ask as Ask | undefined
        if (!ask) break
        const seen = asks.get(ask.id)
        if (seen) {
          seen.ask = ask
          break
        }
        closeWork()
        const item = { kind: 'ask' as const, key: `ask-${ask.id}`, ask }
        asks.set(ask.id, item)
        items.push(item)
        break
      }
      case 'turn.failed': {
        closeWork()
        const err = d.error as { message?: unknown } | undefined
        items.push({
          kind: 'note',
          key: e.id,
          text: str(err?.message) ?? 'The turn failed.',
          tone: 'error',
        })
        break
      }
      case 'turn.cancelled':
        closeWork()
        items.push({ kind: 'note', key: e.id, text: 'Stopped', tone: 'muted' })
        break
      case 'session.compacted':
        closeWork()
        items.push({
          kind: 'note',
          key: e.id,
          text: 'Context compacted',
          tone: 'muted',
        })
        break
      case 'turn.completed':
        closeWork()
        break
    }
  }
  return items
}

// Merges a page into what is already loaded, in seq order, once each.
export function mergeEvents(
  have: SessionEvent[],
  page: SessionEvent[],
): SessionEvent[] {
  if (!page.length) return have
  const last = have.length ? have[have.length - 1].seq : -1
  if (page[0].seq > last) return [...have, ...page]
  const bySeq = new Map(have.map((e) => [e.seq, e]))
  for (const e of page) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

export function timeAgo(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}
