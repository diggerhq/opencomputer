import { diff3Merge, diffComm } from 'node-diff3'
import type { DocRow } from '@opencomputer/sdk/computer'

// The Doc's save (spec 22.3): a save over a Doc that moved is merged three
// ways, line by line; where both sides changed the same lines the person's
// are kept. `spans` say which lines a person wrote.

type Spans = DocRow['spans']
type By = Spans[number]['by']

const lines = (text: string) => text.split('\n')

// `ours` and `theirs` both started from `base`.
export function mergeDoc(
  base: string,
  ours: string,
  theirs: string,
): { text: string; conflicts: number } {
  let conflicts = 0
  const out: string[] = []
  for (const r of diff3Merge(lines(ours), lines(base), lines(theirs))) {
    if (r.ok) out.push(...r.ok)
    else {
      conflicts += 1
      out.push(...r.conflict.a)
    }
  }
  return { text: out.join('\n'), conflicts }
}

// Who wrote each line of `next`: lines kept from `prev` keep their writer;
// lines that are not in `theirs` (the Doc the save lands on) are `me`'s.
export function docSpans(
  prev: { text: string; spans: Spans } | undefined,
  theirs: string,
  next: string,
  me: By,
): Spans {
  const nextLines = lines(next)
  const owner: (By | null)[] = nextLines.map(() => null)
  if (prev) {
    const was: (By | null)[] = lines(prev.text).map(() => null)
    for (const s of prev.spans)
      for (let i = s.from; i < s.to && i < was.length; i++) was[i] = s.by
    let a = 0
    let b = 0
    for (const c of diffComm(lines(prev.text), nextLines)) {
      if (c.common) {
        for (let k = 0; k < c.common.length; k++) owner[b + k] = was[a + k]
        a += c.common.length
        b += c.common.length
      } else {
        a += c.buffer1.length
        b += c.buffer2.length
      }
    }
  }
  let b = 0
  for (const c of diffComm(lines(theirs), nextLines)) {
    if (c.common) b += c.common.length
    else {
      for (let k = 0; k < c.buffer2.length; k++) owner[b + k] = me
      b += c.buffer2.length
    }
  }
  const spans: Spans = []
  owner.forEach((by, i) => {
    if (by === null) return
    const last = spans[spans.length - 1]
    if (last && last.to === i && last.by === by) last.to = i + 1
    else spans.push({ from: i, to: i + 1, by })
  })
  return spans
}
