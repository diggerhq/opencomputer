import type { Channel, ClientFrame, Principal, ServerFrame } from '@opencomputer/sdk/computer'
import type { Host, Location } from './host'
import { NOWHERE } from './host'

// The Mac app's host, over the preload bridge of spec 42.3. The page sees a
// channel and never a socket or a token; API requests go to `/api/…` on the
// app's own origin, where the main process adds the credential.

type Target = { threadId?: string; trackId?: string; askId?: string; new?: boolean }
type FromMain =
  | { t: 'chan.frame'; frame: ServerFrame }
  | { t: 'chan.state'; state: 'open' | 'closed' }
  | { t: 'backup.data'; id: string; data: Uint8Array | null }
  | { t: 'open'; target: Target }
  | { t: 'answer'; threadId: string; askId: string; choice: string }
  | { t: 'principal'; principal: Principal }
  | { t: 'signed-out' }

export interface Bridge {
  send(msg: Record<string, unknown>): void
  on(cb: (msg: FromMain) => void): void
  host: { platform: 'desktop'; principal: Principal; name?: string }
}

declare global {
  interface Window {
    oc?: Bridge
  }
}

export function desktopHost(oc: Bridge): Host {
  let frame: (f: ServerFrame) => void = () => {}
  let state: (s: 'open' | 'closed') => void = () => {}
  let open: (t: Target) => void = () => {}
  let answer: (a: { threadId: string; askId: string; choice: string }) => void = () => {}
  let linked: 'open' | 'closed' = 'closed'
  const reads = new Map<string, (d: Uint8Array | null) => void>()
  const moved = new Set<(l: Location) => void>()
  let loc: Location = NOWHERE

  oc.on((m) => {
    if (m.t === 'chan.frame') frame(m.frame)
    else if (m.t === 'chan.state') {
      linked = m.state
      state(m.state)
    } else if (m.t === 'backup.data') {
      reads.get(m.id)?.(m.data)
      reads.delete(m.id)
    } else if (m.t === 'open') open(m.target)
    else if (m.t === 'answer') answer(m)
    // Another person's rows must never show: start again as whoever it is now.
    else if (m.t === 'principal' || m.t === 'signed-out') location.reload()
  })

  return {
    platform: 'desktop',
    principal: oc.host.principal,
    name: oc.host.name,
    // The shell answers `/api` only to its own page, which says so (spec 24.2).
    api: {
      fetch(path, init) {
        const headers = new Headers(init?.headers)
        headers.set('x-oc-app', '1')
        return fetch(`/api${path}`, { ...init, headers })
      },
    },
    // One relay for the app: each "connection" is a view of it.
    connect(): Channel {
      return {
        send: (f: ClientFrame) => oc.send({ t: 'chan.send', frame: f }),
        onFrame(cb) {
          frame = cb
        },
        onState(cb) {
          state = cb
          if (linked === 'open') cb('open')
        },
        close() {},
      }
    },
    notify: (n) => oc.send({ t: 'notify', n }),
    badge: (count) => oc.send({ t: 'badge', count }),
    openExternal: (url) => oc.send({ t: 'open.external', url }),
    onOpen(cb) {
      open = cb
    },
    onAnswer(cb) {
      answer = cb
    },
    backup: {
      read: (what) =>
        new Promise((resolve) => {
          const id = crypto.randomUUID()
          reads.set(id, resolve)
          oc.send({ t: 'backup.read', what, id })
        }),
      write: async (what, data) => oc.send({ t: 'backup.write', what, data }),
    },
    location: {
      get: () => loc,
      set(l) {
        loc = l
        const path = l.thread ? `/t/${l.thread}` : l.track ? `/k/${l.track}` : l.start ? '/new' : '/'
        oc.send({ t: 'location', path: l.result ? `${path}?r=${l.result}` : path })
      },
      onChange(cb) {
        moved.add(cb)
        return () => moved.delete(cb)
      },
    },
  }
}
