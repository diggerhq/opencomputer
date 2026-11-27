import type { AttachmentRef, Channel, ServerFrame, UploadRequest } from '@opencomputer/sdk/computer'
import type { Host } from './host'
import { browserParts, urlLocation } from './host-web'
import recording from './demo-data.json'

// The surface over recorded data, to look at without a backend: `?fake` in
// development and previews. demo-data.json is what the real server answered
// for a small organization (scripts/demo-recording.ts). Nothing here is a
// rule of the server: a read gets its recorded reply or nothing new, and a
// write is never answered, so what it shows stays as the surface drew it.
// `?fake=empty` is the same organization with nothing in it.
//
// Attachments (work 126) are the one thing the fake plays: a message of the
// recording carries files so their chips can be seen, their bytes are drawn
// here, and an upload is answered the way the server would, so the composer's
// chips can be looked at in every state. A file named "slow" uploads part way
// and stops; one named "large" is refused as too large.

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

function content(path: string): Promise<Response> | null {
  const m = /^\/sessions\/[^/]+\/attachments\/([^/]+)\/content$/.exec(new URL(path, 'http://demo').pathname)
  if (!m) return null
  const file = FILES.find((f) => f.id === m[1])
  if (!file) return Promise.resolve(json(404, { error: { code: 'attachment_not_found', message: 'Not recorded.' } }))
  if (file.mimetype.startsWith('image/')) return picture(file.name).then((b) => new Response(b, { status: 200 }))
  return Promise.resolve(new Response(`[demo] ${file.name}\n`, { status: 200, headers: { 'content-type': file.mimetype } }))
}

// The reply to an upload, after its progress: nearly all of it for a file
// named "slow", which then never ends; a refusal for one named "large".
async function upload(req: UploadRequest): Promise<Response> {
  const name = decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(req.headers['content-disposition'] ?? '')?.[1] ?? '')
  const slow = name.includes('slow')
  const steps = slow ? 6 : 10
  for (let i = 1; i <= steps; i++) {
    await new Promise((r) => setTimeout(r, 120))
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
    req.onProgress((req.body.size * i) / 10, req.body.size)
  }
  if (slow) return new Promise<Response>(() => {})
  if (name.includes('large')) return json(413, { error: { code: 'attachment_too_large', message: 'A file can be at most 100 MB.' } })
  return json(201, { attachment: { state: 'ready' } })
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

function channel(): Channel {
  let frame: (f: ServerFrame) => void = () => {}
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
  platform?: Host['platform']
}): Host {
  return {
    platform: o.platform ?? 'web',
    principal: recording.principal,
    name: 'Igor',
    api: {
      fetch: (path, init) =>
        (init?.method ?? 'GET') === 'GET'
          ? (content(path) ?? Promise.resolve(reply(path, !!o.empty)))
          : new Promise<Response>(() => {}),
      upload: (_path, req) => upload(req),
    },
    connect: channel,
    location: urlLocation(o.base),
    ...browserParts(),
  }
}
