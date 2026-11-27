import type { Channel, ClientFrame, Principal, ServerFrame } from '@opencomputer/sdk/computer'
import type { Host, Location } from './host'
import { NOWHERE } from './host'

// The browser's host (spec 25): the dashboard's cookie, one socket per tab,
// the URL as the location.

// /<base>, /<base>/new, /<base>/t/<thread>, /<base>/k/<track>; ?r=<result> over any of them.
const pathOf = (l: Location) =>
  l.thread ? `/t/${encodeURIComponent(l.thread)}` : l.track ? `/k/${encodeURIComponent(l.track)}` : l.start ? '/new' : ''

/** The full address of a thread or track, without this tab's other parameters. */
export function urlLink(base: string): NonNullable<Host['link']> {
  return (l) => `${location.origin}${base}${pathOf(l)}${l.result ? `?r=${encodeURIComponent(l.result)}` : ''}`
}

export function urlLocation(base: string): Host['location'] {
  const read = (): Location => {
    const rest = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : ''
    const [, kind, id] = rest.split('/')
    const result = new URLSearchParams(location.search).get('r')
    return {
      ...NOWHERE,
      thread: kind === 't' && id ? decodeURIComponent(id) : null,
      track: kind === 'k' && id ? decodeURIComponent(id) : null,
      start: kind === 'new',
      result,
    }
  }
  const write = (l: Location) => {
    const path = pathOf(l)
    // Other parameters (the fake's switches) stay.
    const q = new URLSearchParams(location.search)
    if (l.result) q.set('r', l.result)
    else q.delete('r')
    const qs = q.toString()
    return `${base}${path}${qs ? `?${qs}` : ''}`
  }
  return {
    get: read,
    set(l, o) {
      const url = write(l)
      if (url === location.pathname + location.search) return
      if (o?.replace) history.replaceState(null, '', url)
      else history.pushState(null, '', url)
    },
    onChange(cb) {
      const on = () => cb(read())
      addEventListener('popstate', on)
      return () => removeEventListener('popstate', on)
    },
  }
}

export function socketChannel(url: string, protocols: string[]): Channel {
  const ws = new WebSocket(url, protocols)
  const queue: string[] = []
  let frame: (f: ServerFrame) => void = () => {}
  let state: (s: 'open' | 'closed') => void = () => {}
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    state('closed')
  }
  ws.onopen = () => {
    for (const f of queue.splice(0)) ws.send(f)
    state('open')
  }
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return
    try {
      frame(JSON.parse(e.data) as ServerFrame)
    } catch {
      // Not a frame.
    }
  }
  ws.onclose = close
  ws.onerror = close
  return {
    send(f: ClientFrame) {
      const text = JSON.stringify(f)
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(text)
    },
    onFrame(cb) {
      frame = cb
    },
    onState(cb) {
      state = cb
      if (ws.readyState === WebSocket.OPEN) cb('open')
      else if (closed) cb('closed')
    },
    close() {
      ws.close()
      close()
    },
  }
}

// What every browser host shares: notifications from the page, links in a new tab.
export function browserParts(): Pick<Host, 'notify' | 'badge' | 'openExternal' | 'onOpen'> {
  let open: Parameters<Host['onOpen']>[0] = () => {}
  // Permission can only be asked from a gesture: the first click asks.
  if (typeof Notification !== 'undefined' && Notification.permission === 'default')
    addEventListener('pointerdown', () => void Notification.requestPermission(), { once: true })
  return {
    notify(n) {
      // Only while the person is elsewhere (R27).
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.hasFocus()) return
      const note = new Notification(n.title, { body: n.body, tag: n.threadId })
      note.onclick = () => {
        window.focus()
        open({ threadId: n.threadId, askId: n.askId })
        note.close()
      }
    },
    badge() {},
    openExternal(url) {
      window.open(url, '_blank', 'noopener')
    },
    onOpen(cb) {
      open = cb
    },
  }
}

export function webHost(o: {
  principal: Principal
  name?: string
  api: string
  base: string
  // The login expired while the page is open: off to log in again.
  signedOut: () => void
  billing?: string
}): Host {
  const ws = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${o.api}/live`
  let out = false
  return {
    platform: 'web',
    principal: o.principal,
    name: o.name,
    billing: o.billing,
    api: {
      async fetch(path, init) {
        const reply = await fetch(`${o.api}${path}`, { ...init, credentials: 'include' })
        if (reply.status === 401 && !out) {
          out = true
          o.signedOut()
        }
        return reply
      },
    },
    connect: () => socketChannel(ws, ['oc.live.v1']),
    location: urlLocation(o.base),
    link: urlLink(o.base),
    ...browserParts(),
  }
}
