import { Refused, type Client } from '@opencomputer/sdk/computer'
import { docSpans, mergeDoc } from './doc'
import type { State, Toast } from './surface-state'

// `base` is the Doc the person started editing from. When the Doc moved
// meanwhile, the save is merged three ways and sent again (spec 22.3);
// overlapping lines keep the person's, and the track's agent is told.
export async function saveMerged(
  { get, me, mutate, toast, send }: {
    get: () => State
    me: string
    mutate: Client['mutate']
    toast: (t: Omit<Toast, 'id'>) => void
    send: (sid: string, input: string) => void
  },
  tid: string,
  text: string,
  base: { rev: number; text: string },
): Promise<{ conflicts: number }> {
  let from = base
  let ours = text
  let conflicts = 0
  const onto = (theirs: { rev: number; text: string }) => {
    if (theirs.rev === from.rev) return
    const m = mergeDoc(from.text, ours, theirs.text)
    ours = m.text
    conflicts += m.conflicts
    from = { rev: theirs.rev, text: theirs.text }
  }
  const now = get().rows.doc.get(tid)
  if (now) onto(now)
  for (let tries = 0; ; tries++) {
    const row = get().rows.doc.get(tid)
    const spans = docSpans(row, from.text, ours, `user:${me}`)
    try {
      await mutate('doc.save', { tid, baseRev: from.rev, text: ours, spans }).settled
      break
    } catch (e) {
      const d = e instanceof Refused && e.code === 'conflict' ? (e.detail as { rev?: number; text?: string } | undefined) : undefined
      if (tries >= 3 || typeof d?.rev !== 'number' || typeof d.text !== 'string') {
        if (e instanceof Refused && e.code === 'conflict') toast({ text: 'The Doc kept changing while saving; your edit is still open', tone: 'error' })
        throw e
      }
      onto({ rev: d.rev, text: d.text })
    }
  }
  if (conflicts) {
    const agent = get().rows.track.get(tid)?.agentSession
    if (agent)
      send(
          agent,
          `I edited the Doc while you were changing it. Where we both changed the same lines (${conflicts === 1 ? 'one place' : `${conflicts} places`}), I kept mine.`,
      )
    toast({ text: 'Saved. Where you and the agent changed the same lines, yours were kept' })
  }
  return { conflicts }
}
