// The desktop `Host` (spec section 25), built on `window.oc` (section 42.3).
// Runs in the page: the surface's desktop entry imports `createDesktopHost`
// and hands the result to the surface. No dependency on Electron, Node or
// React, so the web build can bundle it as is.
import { type BackupKind, type Frame, type MainToPage, type Notice, type OcBridge, type OpenTarget, type Principal } from '../shared/bridge'

export type { Frame, Notice, OpenTarget, Principal } from '../shared/bridge'

export interface Channel {
  send(frame: Frame): void
  onFrame(cb: (frame: Frame) => void): () => void
  onState(cb: (state: 'open' | 'closed') => void): () => void
  /** What this window watches, so the main process routes pushed frames to it. Desktop only. */
  subs(streams: string[]): void
}

export interface DesktopHost {
  platform: 'desktop'
  principal: Principal
  api: { fetch(path: string, init?: RequestInit): Promise<Response> }
  connect(): Channel
  notify(n: Notice): void
  badge(count: number): void
  openExternal(url: string): void
  onOpen(cb: (target: OpenTarget) => void): void
  backup: { read(what: BackupKind): Promise<Uint8Array | null>; write(what: BackupKind, v: Uint8Array): Promise<void> }
  // Beyond section 25's interface, for the desktop entry alone:
  /** A button pressed on a permission's notification; send it as the thread's own `answer`. */
  onAnswer(cb: (a: { threadId: string; askId: string; choice: string }) => void): void
  /** The credential was refused or the person signed out: wipe this principal's cache and queue. */
  onSignedOut(cb: () => void): void
  /** The location the surface shows, mirrored so the window reopens there. */
  location(path: string): void
  signOut(): void
}

declare global {
  interface Window {
    oc?: OcBridge
  }
}

export function createDesktopHost(oc: OcBridge | undefined = window.oc): DesktopHost {
  if (!oc) throw new Error('window.oc is missing: this bundle is not running in the desktop shell')
  if (!oc.host.principal) throw new Error('the desktop shell loaded the surface without a principal')
  const bridge = oc

  const subs = new Map<MainToPage['t'], Set<(msg: never) => void>>()
  function on<T extends MainToPage['t']>(t: T, cb: (msg: Extract<MainToPage, { t: T }>) => void): () => void {
    let set = subs.get(t)
    if (!set) subs.set(t, (set = new Set()))
    set.add(cb as (msg: never) => void)
    return () => set.delete(cb as (msg: never) => void)
  }
  // Subscribed on a microtask, so the callers of this function have attached
  // theirs before the messages that arrived early are delivered.
  let state: 'open' | 'closed' = 'closed'
  on('chan.state', (m) => {
    state = m.state
  })
  queueMicrotask(() =>
    bridge.on((msg) => {
      for (const cb of subs.get(msg.t) ?? []) (cb as (m: MainToPage) => void)(msg)
    }),
  )

  const reads = new Map<string, (data: Uint8Array | null) => void>()
  on('backup.data', (m) => {
    reads.get(m.id)?.(m.data)
    reads.delete(m.id)
  })
  let readId = 0

  return {
    platform: 'desktop',
    principal: oc.host.principal,
    api: {
      fetch(path, init) {
        if (!path.startsWith('/api/')) return Promise.reject(new TypeError(`not an API path: ${path}`))
        return fetch(path, init)
      },
    },
    connect() {
      return {
        send: (frame) => bridge.send({ t: 'chan.send', frame }),
        onFrame: (cb) => on('chan.frame', (m) => cb(m.frame)),
        onState(cb) {
          // A channel made after the socket opened still hears that it is open.
          if (state === 'open') queueMicrotask(() => state === 'open' && cb('open'))
          return on('chan.state', (m) => cb(m.state))
        },
        subs: (streams) => bridge.send({ t: 'subs', streams }),
      }
    },
    notify: (n) => bridge.send({ t: 'notify', n }),
    badge: (count) => bridge.send({ t: 'badge', count }),
    openExternal: (url) => bridge.send({ t: 'open.external', url }),
    onOpen: (cb) => void on('open', (m) => cb(m.target)),
    backup: {
      read(what) {
        const id = String(++readId)
        return new Promise((resolve) => {
          reads.set(id, resolve)
          bridge.send({ t: 'backup.read', what, id })
        })
      },
      write(what, data) {
        bridge.send({ t: 'backup.write', what, data })
        return Promise.resolve()
      },
    },
    onAnswer: (cb) => void on('answer', (m) => cb({ threadId: m.threadId, askId: m.askId, choice: m.choice })),
    onSignedOut: (cb) => void on('signed-out', () => cb()),
    location: (path) => bridge.send({ t: 'location', path }),
    signOut: () => bridge.send({ t: 'signout' }),
  }
}
