import type { ApiEvent } from '@opencomputer/sdk/computer'

// A long thread for the demo host (`?fake=long`, `?fake=tools`), and the
// events read over it as SessionLog answers it (spec 37.1): forward from a
// cursor or from the last turns, and backward from the end or from a cursor.
// It is what opening and paging a long thread are looked at and tested with,
// so its pages are the server's: the same bounds, cursors and flags.

export type DemoShape = 'long' | 'tools'

const cur = (seq: number) => `e1.0.${seq}`
const seqOf = (cursor: string) => Number(cursor.slice(cursor.lastIndexOf('.') + 1))

const ASKS = [
  'Why is the build slow?',
  'Can you check whether the cache ever hits?',
  'What changed in the lockfile last week?',
  'Try it on the nightly job too.',
  'Open a pull request with that.',
]
const ANSWERS = [
  'The install step takes most of the time.',
  'It never hits: the key is built from the lockfile’s modification time, which changes on every checkout.\n\nKeyed on the hash, it hits on every run where the lockfile has not changed.',
  'Three packages moved:\n\n- `vite` from 7.1 to 7.2\n- `vitest` from 3.2 to 3.3\n- `typescript` from 5.8 to 5.9\n\nNone of them changes the install time by more than a few seconds.',
  'Done. The nightly job keeps a cold install, to catch lockfile drift.\n\n```yaml\n- uses: actions/cache@v4\n  with:\n    path: ~/.npm\n    key: npm-${{ runner.os }}-${{ hashFiles(\'package-lock.json\') }}\n```',
  'Opened. The dry run hits the cache and the install step drops from about four minutes to twenty seconds.',
]
const STEPS = ['Read `ci.yml`', 'Search for `actions/cache`', 'Run `npm ci`', 'Read `package.json`', 'Run `gh run list`']

/**
 * `long`: a thousand short turns, two thousand messages. `tools`: twenty of
 * those, then one turn of a thousand tool calls, which folds to a few rows.
 */
export function demoLog(sid: string, shape: DemoShape, me: string): ApiEvent[] {
  const events: ApiEvent[] = []
  let at = Date.parse('2026-11-01T09:00:00Z')
  const add = (turnId: string | null, type: string, data: unknown, actor: ApiEvent['actor'] = null) => {
    const seq = events.length + 1
    at += 1500
    events.push({
      id: `ev_${sid}_long_${seq}`,
      seq,
      createdAt: new Date(at).toISOString(),
      sessionId: sid,
      turnId,
      type,
      actor,
      data,
    })
  }
  const tool = (turnId: string, n: number) => {
    const call = { callId: `${turnId}_c${n}`, toolName: 'Bash', title: STEPS[n % STEPS.length] }
    add(turnId, 'tool.started', call)
    add(turnId, 'tool.completed', call)
  }
  const turn = (i: number, calls: number) => {
    const id = `tn_long_${i}`
    add(
      id,
      'message.received',
      { input: `${ASKS[i % ASKS.length]} (${i + 1})`, ifBusy: 'queue', delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] },
      { id: me, name: null, via: 'app', client: null },
    )
    add(null, 'session.status_changed', { from: 'idle', to: 'running' })
    add(id, 'turn.started', { turn: { trigger: 'message' } })
    for (let n = 0; n < calls; n++) {
      tool(id, n)
      if (n % 200 === 199) add(id, 'message.completed', { text: `${n + 1} steps in; still going.` })
    }
    add(id, 'message.completed', { text: `${ANSWERS[i % ANSWERS.length]} (${i + 1})` })
    add(id, 'turn.completed', {})
    add(null, 'session.status_changed', { from: 'running', to: 'idle' })
  }
  if (shape === 'long') for (let i = 0; i < 1000; i++) turn(i, i % 5 === 4 ? 2 : 0)
  else {
    for (let i = 0; i < 20; i++) turn(i, i % 5 === 4 ? 2 : 0)
    turn(20, 1000)
  }
  return events
}

const int = (text: string | null, fallback: number, max: number) =>
  Math.min(max, Math.max(1, text === null ? fallback : Number(text) || fallback))

/** The body of `GET /sessions/{id}/events` over `events`, which run from seq 1 with no gaps. */
export function readLog(events: ApiEvent[], q: URLSearchParams): unknown {
  const lastSeq = events.length
  if (q.has('last')) {
    const before = q.get('before')
    const end = before === null ? lastSeq : Math.min(seqOf(before), lastSeq)
    const start = Math.max(0, end - int(q.get('last'), 1, 500))
    return {
      events: events.slice(start, end),
      cursor: cur(end),
      prevCursor: cur(start),
      hasMoreBefore: start > 0,
      lastSeq,
    }
  }
  const after = q.get('after')
  let from = after === null ? 0 : seqOf(after)
  if (after === null && q.has('tailTurns')) {
    const turns = events.filter((e) => e.type === 'turn.started')
    const first = turns[Math.max(0, turns.length - int(q.get('tailTurns'), 1, 50))]?.turnId
    from = Math.max(0, events.findIndex((e) => e.turnId === first))
  }
  const page = events.slice(from, from + int(q.get('limit'), 100, 500))
  return {
    events: page,
    cursor: cur(from + page.length),
    hasMore: from + page.length < lastSeq,
    lastSeq,
    ...(q.has('tailTurns') ? { earlierTurns: [] } : {}),
  }
}
