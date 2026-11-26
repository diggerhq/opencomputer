import { askLine, type ListView } from './views'

// What is blocked on the person in the list, by session: what the
// notification of a new block says.
export interface Blocked {
  title: string
  body: string
  askId?: string
  approval: boolean
}

export function blockedIn(l: ListView): Map<string, Blocked> {
  const now = new Map<string, Blocked>()
  for (const t of [...l.threads, ...l.tracks.flatMap((k) => k.threads)])
    if (t.mark === 'blocked')
      now.set(t.id, {
        title: t.title,
        body: t.ask ? askLine(t.ask) : (t.line ?? 'Needs you'),
        askId: t.ask?.id,
        approval: t.ask?.kind === 'approval',
      })
  for (const k of l.tracks)
    if (k.agent?.blocked) {
      const ask = k.agent.asks.find((a) => a.status === 'open')
      now.set(k.agentSession, { title: k.name, body: ask ? askLine(ask) : 'Needs you', askId: ask?.id, approval: ask?.kind === 'approval' })
    }
  return now
}
