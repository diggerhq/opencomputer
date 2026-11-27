import type { ApiEvent, ServerFrame } from '@opencomputer/sdk/computer'

// A turn the demo host plays when a message is sent (`?fake`): the events and
// text deltas a real one sends, in the order the runner's tap writes them
// (computer/src/runner/api/tap.ts): a passing message that streams and is
// followed by work, then the answer, streamed, with a step after it the way
// an agent marks its work ready. Its timing is a real turn's, made shorter.

type Emit = (f: ServerFrame) => void

const NOTE = 'Looking at the workflow before changing anything.'
const ANSWER = `The build spends most of its time reinstalling dependencies: the cache key in \`ci.yml\` hashes a file that does not exist, so every run misses.

I keyed the cache on \`package-lock.json\` instead. A dry run hits the cache and the install step drops from about four minutes to twenty seconds.

Two things to decide:
- Whether to also cache \`~/.cache/ms-playwright\`, which is the next slowest step.
- Whether the nightly job should keep a cold install, to catch lockfile drift.`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A demo turn still running: what a message sent to it meanwhile steers, or
// stops (work 134).
export type DemoTurn = {
  turnId: string
  // Steers sent, by the seq of their `message.received`, not yet taken.
  steers: number[]
  steer(id: string, input: string): void
  stop(): void
}

export function playTurn(o: {
  sid: string
  turnId: string
  input: string
  me: string
  // The session's last seq and cursor, moved on as events are sent.
  log: { seq: number; cursor: string | null }
  emit: Emit
  // The step that runs long, so a message sent meanwhile waits on it.
  slow?: boolean
  // A turn started by steers its predecessor left: their messages are already recorded.
  held?: boolean
  // Told the turn has ended, with the steers it did not take.
  ended?: (steers: { id: string; input: string }[]) => void
}): DemoTurn {
  let n = 0
  const id = () => `ev_demo_${o.turnId}_${++n}`
  const send = (...events: Omit<ApiEvent, 'id' | 'seq' | 'createdAt' | 'sessionId'>[]) => {
    const from = o.log.cursor ?? ''
    const out = events.map(
      (e) =>
        ({
          ...e,
          id: id(),
          seq: ++o.log.seq,
          createdAt: new Date().toISOString(),
          sessionId: o.sid,
        }),
    )
    o.log.cursor = `e1.0.${o.log.seq}`
    o.emit({ t: 'events', session: o.sid, from, to: o.log.cursor, events: out })
  }
  const ev = (type: string, data: Record<string, unknown> = {}) =>
    ({ type, turnId: o.turnId, actor: null, data }) as Omit<ApiEvent, 'id' | 'seq' | 'createdAt' | 'sessionId'>
  // Streams `text` in word-sized deltas, then completes it.
  const stream = async (text: string) => {
    const blockId = id()
    const words = text.match(/\S+\s*/g) ?? []
    let offset = 0
    for (const w of words) {
      if (stopped) return
      o.emit({ t: 'delta', session: o.sid, type: 'message.delta', turnId: o.turnId, data: { blockId, text: w }, offset })
      offset += w.length
      await sleep(25)
    }
    await sleep(40)
    if (stopped) return
    send(ev('message.completed', { blockId, parentCallId: null, text }))
  }
  let stopped = false
  const held: { id: string; input: string; seq: number }[] = []
  // A step's result goes back with every waiting message: the model reads them.
  const take = () => {
    for (const h of held.splice(0)) send(ev('turn.steered', { messageSeq: h.seq }))
  }
  const step = async (callId: string, title: string, ms: number) => {
    if (stopped) return
    take()
    send(ev('tool.started', { callId, toolName: 'Bash', title, parentCallId: null }))
    for (let t = 0; t < ms && !stopped; t += 50) await sleep(50)
    if (stopped) return
    send(ev('tool.completed', { callId, toolName: 'Bash', title, parentCallId: null }))
  }
  const turn: DemoTurn = {
    turnId: o.turnId,
    steers: [],
    steer(id, input) {
      send({ type: 'message.received', turnId: o.turnId, actor: { id: o.me, name: null, via: null, client: null }, data: { input, ifBusy: 'steer', delivery: 'steered', messageId: id } } as never)
      held.push({ id, input, seq: o.log.seq })
    },
    stop() {
      if (stopped) return
      stopped = true
      send(ev('turn.cancelled', { reason: 'interrupted', forced: false, input: null }), { ...ev('session.status_changed', { from: 'running', to: 'idle' }), turnId: null })
      o.ended?.(held.splice(0))
    },
  }

  void (async () => {
    await sleep(300)
    if (stopped) return
    send(
      ...(o.held ? [] : [{ type: 'message.received', turnId: o.turnId, actor: { id: o.me, name: null, via: null, client: null }, data: { input: o.input } } as never]),
      { ...ev('session.status_changed', { from: 'idle', to: 'running' }), turnId: null },
      ev('turn.started', { turn: { trigger: 'message' } }),
    )
    await sleep(700)
    send(ev('reasoning.completed', { text: '', redacted: true, durationMs: 700 }))
    await stream(NOTE)
    await sleep(80)
    await step(`${o.turnId}_1`, 'Read `.github/workflows/ci.yml`', 600)
    await step(`${o.turnId}_2`, 'Run `act -j build --dryrun`', o.slow ? 30_000 : 900)
    if (stopped) return
    take()
    send(ev('reasoning.completed', { text: '', redacted: true, durationMs: 400 }))
    await stream(ANSWER)
    await sleep(80)
    await step(`${o.turnId}_3`, 'Mark ready', 300)
    if (stopped) return
    stopped = true
    send(ev('turn.completed'), { ...ev('session.status_changed', { from: 'running', to: 'idle' }), turnId: null })
    o.ended?.(held.splice(0))
  })()
  return turn
}
