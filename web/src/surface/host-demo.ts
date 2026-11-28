import type { ApiEvent, Channel, ServerFrame } from '@opencomputer/sdk/computer'
import type { Host } from './host'
import { browserParts, urlLink, urlLocation } from './host-web'
import recording from './demo-data.json'
import { demoLog, readLog, type DemoShape } from './demo-log'
import { playTurn, type DemoTurn } from './demo-turn'

// The surface over recorded data, to look at without a backend: `?fake` in
// development and previews. demo-data.json is what the real server answered
// for a small organization (scripts/demo-recording.ts). Nothing here is a
// rule of the server: a read gets its recorded reply or nothing new, and a
// write is never answered, so what it shows stays as the surface drew it.
// A message sent to a thread is the one exception: the thread plays a scripted
// turn (demo-turn.ts) over the socket, so sending and streaming can be watched.
// `?fake=empty` is the same organization with nothing in it. `?fake=long` and
// `?fake=tools` make its first thread a long one (demo-log.ts), read in pages
// the way the server answers them, each after a network's delay.

const replies = recording.replies as Record<string, unknown>
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function reply(path: string, empty: boolean): Response {
  const url = new URL(path, 'http://demo')
  const after = url.searchParams.get('after')
  const feed = replies['/feed'] as {
    rows: unknown[]
    to: string
    version: number
  }
  if (url.pathname === '/feed') {
    if (empty) return json(200, { ...feed, rows: [], counts: {} })
    return json(
      200,
      after === null
        ? feed
        : { ...feed, from: after, to: after, rows: [], gone: [] },
    )
  }
  if (after !== null)
    return json(200, { events: [], cursor: after, hasMore: false })
  const recorded =
    empty && url.pathname !== '/capabilities'
      ? undefined
      : replies[url.pathname]
  return recorded === undefined
    ? json(404, { error: { code: 'not_found', message: 'Not recorded.' } })
    : json(200, recorded)
}

// The long thread, when there is one: its session and its whole log.
let long: { sid: string; events: ApiEvent[] } | null = null
// What a read of the long thread waits, in ms: a round trip.
const LAG = 60

function read(path: string, empty: boolean): Promise<Response> {
  const url = new URL(path, 'http://demo')
  const log = long
  if (!log || url.pathname !== `/sessions/${log.sid}/events`)
    return Promise.resolve(reply(path, empty))
  // A mark per read, for a trace of what opening a thread asked for.
  performance.mark(`demo:read${url.search}`)
  return new Promise((done) =>
    setTimeout(() => done(json(200, readLog(log.events, url.searchParams))), LAG),
  )
}

// The frame callback of the open socket, for the scripted turn.
let toSocket: (f: ServerFrame) => void = () => {}
// Each session's last seq and cursor, as the recording left them and the
// scripted turns moved them.
const logs = new Map<string, { seq: number; cursor: string | null }>()
const logOf = (sid: string) => {
  let log = logs.get(sid)
  if (!log && long?.sid === sid) {
    const seq = long.events.length
    logs.set(sid, (log = { seq, cursor: `e1.0.${seq}` }))
  }
  if (!log) {
    const recorded = replies[`/sessions/${sid}/events`] as
      | { cursor: string; events: { seq: number }[] }
      | undefined
    const seq = Math.max(0, ...(recorded?.events.map((e) => e.seq) ?? []))
    logs.set(sid, (log = { seq, cursor: recorded?.cursor ?? null }))
  }
  return log
}

// Each session's demo turn while it runs: a message sent to it steers it.
const playing = new Map<string, DemoTurn>()

const play = (sid: string, turnId: string, input: string, held = false) => {
  const t = playTurn({
    sid,
    turnId,
    input,
    me: recording.principal.subject,
    log: logOf(sid),
    emit: (f) => toSocket(f),
    slow: /wait|slow/i.test(input),
    held,
    // Steers a turn did not take start the next one, as the runner's harness does.
    ended: (left) => {
      playing.delete(sid)
      if (left.length)
        play(sid, left[0].id, left.map((l) => l.input).join('\n\n'), true)
    },
  })
  playing.set(sid, t)
}

function write(path: string, init?: RequestInit): Promise<Response> {
  const turn = /^\/sessions\/([^/]+)\/turns$/.exec(path)
  const interrupt = /^\/sessions\/([^/]+)\/interrupt$/.exec(path)
  if (interrupt) playing.get(interrupt[1])?.stop()
  if (turn && typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as {
      id: string
      input: string
      ifBusy?: string
    }
    const running = playing.get(turn[1])
    // The demo sends no session rows, so the store may think it idle: a reply
    // to a running turn steers it. An interrupt then stops it, and the next
    // turn starts from every message waiting, this one last, as the runner's does.
    if (running) {
      running.steer(body.id, body.input)
      if (body.ifBusy === 'interrupt') running.stop()
    } else play(turn[1], body.id, body.input)
  }
  // Accepted: the SDK's queue sends the next write once this one is answered.
  if (turn || interrupt) return Promise.resolve(json(200, {}))
  return new Promise<Response>(() => {})
}

function channel(): Channel {
  let frame: (f: ServerFrame) => void = () => {}
  toSocket = (f) => frame(f)
  return {
    send(f) {
      if (f.t !== 'hello') return
      const { org, subject } = recording.principal
      const ready: ServerFrame = {
        t: 'ready',
        connectionId: 'demo',
        protocol: 1,
        org,
        subject,
        expiresAt: '2100-01-01T00:00:00Z',
        limits: {},
      }
      queueMicrotask(() => frame(ready))
    },
    onFrame(cb) {
      frame = cb
    },
    onState(cb) {
      queueMicrotask(() => cb('open'))
    },
    close() {},
  }
}

export function demoHost(o: {
  base: string
  empty?: boolean
  long?: DemoShape
  platform?: Host['platform']
}): Host {
  const first = (replies['/feed'] as { rows: { kind: string; id: string }[] }).rows.find((r) => r.kind === 'session')
  long =
    o.long && first
      ? { sid: first.id, events: demoLog(first.id, o.long, recording.principal.subject) }
      : null
  return {
    platform: o.platform ?? 'web',
    principal: recording.principal,
    name: 'Igor',
    api: {
      fetch: (path, init) =>
        (init?.method ?? 'GET') === 'GET'
          ? read(path, !!o.empty)
          : write(path, init),
    },
    connect: channel,
    location: urlLocation(o.base),
    ...(o.platform === 'desktop' ? {} : { link: urlLink(o.base) }),
    ...browserParts(),
  }
}
