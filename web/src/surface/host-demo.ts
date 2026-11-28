import type { ApiEvent, AttachmentRef, Channel, ServerFrame, UploadRequest } from '@opencomputer/sdk/computer'
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
//
// Attachments (work 126) are the one thing the fake plays: a message of the
// recording carries files so their chips can be seen, their bytes are drawn
// here, and an upload is answered the way the server and its store would, so
// the composer's chips can be looked at in every state. A file named "slow"
// uploads part way and stops; one named "large" is refused as too large.

const replies = recording.replies as Record<string, unknown>
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// The message of the recording that is shown with files.
const WITH_FILES = 'ev_cs_0pmnvt9w0pba00an_read_1'
const FILES: AttachmentRef[] = [
  { id: 'at_demo_profile', name: 'build-profile.png', mimetype: 'image/png', bytes: 184_320 },
  { id: 'at_demo_flame', name: 'flamegraph.png', mimetype: 'image/png', bytes: 96_512 },
  { id: 'at_demo_log', name: 'ci-run-4821.log', mimetype: 'text/plain', bytes: 2_359_296 },
]

// A picture drawn here, in the file's own colours, as the bytes of a demo attachment.
function picture(name: string): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 400
  const g = canvas.getContext('2d')!
  const hue = [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 360
  const fill = g.createLinearGradient(0, 0, 640, 400)
  fill.addColorStop(0, `hsl(${hue} 60% 55%)`)
  fill.addColorStop(1, `hsl(${(hue + 60) % 360} 60% 35%)`)
  g.fillStyle = fill
  g.fillRect(0, 0, 640, 400)
  g.fillStyle = 'rgba(255,255,255,0.85)'
  for (let i = 0; i < 12; i++) g.fillRect(40 + i * 48, 360 - (((i * 97) % 11) + 1) * 26, 32, (((i * 97) % 11) + 1) * 26)
  g.font = '600 28px system-ui, sans-serif'
  g.fillText(name, 40, 56)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? new Blob()), 'image/png'))
}

// The "signed URL" of a recorded file: an object URL of bytes drawn here, made once.
const urls = new Map<string, Promise<string>>()
function signedUrl(path: string): Promise<Response> | null {
  const m = /^\/sessions\/[^/]+\/attachments\/([^/]+)\/url$/.exec(new URL(path, 'http://demo').pathname)
  if (!m) return null
  const file = FILES.find((f) => f.id === m[1])
  if (!file) return Promise.resolve(json(404, { error: { code: 'attachment_not_found', message: 'Not recorded.' } }))
  const bytes = () => (file.mimetype.startsWith('image/') ? picture(file.name) : Promise.resolve(new Blob([`[demo] ${file.name}\n`], { type: file.mimetype })))
  let url = urls.get(file.id)
  if (!url) urls.set(file.id, (url = bytes().then((b) => URL.createObjectURL(b))))
  return url.then((u) => json(200, { url: u, expiresAt: new Date(Date.now() + 300_000).toISOString() }))
}

// The three steps of an upload (work 126). The row: refused for a file named
// "large", else it answers where the bytes go.
const UPLOAD = 'https://demo.invalid/upload/'
function attachment(path: string, init?: RequestInit): Response | null {
  const m = /^\/sessions\/[^/]+\/attachments\/([^/]+)(\/complete)?$/.exec(path)
  if (!m) return null
  if (init?.method === 'DELETE') return new Response(null, { status: 204 })
  if (m[2]) return json(200, { attachment: { id: m[1], state: 'ready' } })
  const { name, mimetype } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { name?: string; mimetype?: string }
  if (name?.includes('large')) return json(413, { error: { code: 'attachment_too_large', message: 'A file can be at most 1 GB.' } })
  const upload = { url: `${UPLOAD}${m[1]}?name=${encodeURIComponent(name ?? '')}`, method: 'PUT', headers: { 'content-type': mimetype ?? 'application/octet-stream' }, expiresAt: new Date(Date.now() + 900_000).toISOString() }
  return json(201, { attachment: { id: m[1], state: 'uploading' }, upload })
}

// The store's reply to the bytes, after their progress: nearly all of it for
// a file named "slow", which then never ends.
async function upload(url: string, req: UploadRequest): Promise<Response> {
  const slow = (new URL(url).searchParams.get('name') ?? '').includes('slow')
  const steps = slow ? 6 : 10
  for (let i = 1; i <= steps; i++) {
    await new Promise((r) => setTimeout(r, 120))
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
    req.onProgress((req.body.size * i) / 10, req.body.size)
  }
  if (slow) return new Promise<Response>(() => {})
  return new Response(null, { status: 200 })
}

function withFiles(recorded: unknown): unknown {
  const r = recorded as { events?: { id: string; data: Record<string, unknown> }[] }
  if (!r?.events) return recorded
  return { ...r, events: r.events.map((e) => (e.id === WITH_FILES ? { ...e, data: { ...e.data, attachments: FILES } } : e)) }
}

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
    : json(200, withFiles(recorded))
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
  const file = attachment(path, init)
  if (file) return Promise.resolve(file)
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
          ? (signedUrl(path) ?? read(path, !!o.empty))
          : write(path, init),
      uploadTo: (url, req) => upload(url, req),
    },
    connect: channel,
    location: urlLocation(o.base),
    ...(o.platform === 'desktop' ? {} : { link: urlLink(o.base) }),
    ...browserParts(),
  }
}
