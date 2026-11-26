// A session's browser or desktop over the wire
// (docs/design/session-browser-desktop.md): the same ticket and dial as a
// terminal (terminal-wire.ts), then `browsers.open` or `desktops.open`, whose
// one channel carries the app's bytes both ways. The tabs read and write them
// (browser-wire.ts, desktop-wire.ts); this keeps the connection.
//
// The host runs one of each per session, only where it allows them
// (`<app>_unavailable`); the relay closes one after 15 minutes without input
// or when access is lost (`<app>.exited` `reason`).

import {
  decodeFrame,
  encodeFrame,
  openRefusal,
  readClose,
  type SocketFactory,
  type TerminalState,
  type WireTicket,
} from './terminal-wire'

export type WireApp = 'browser' | 'desktop'

export interface AppHandlers {
  onState: (state: TerminalState) => void
  /** The app is open: `write` sends bytes on its channel. */
  onOpen: (write: (bytes: Uint8Array) => void) => void
  /** Bytes from the app; throwing ends the connection as a broken stream. */
  onData: (bytes: Uint8Array) => void
  /** The app's channel ended, after onOpen, however it ended. */
  onEnd?: () => void
}

const WAKE_ATTEMPTS = 12

/** What `<app>.exited` means to the person looking at it. */
export function appExitMessage(app: WireApp, p: { reason?: string }): string {
  if (p.reason === 'idle') return 'Closed after 15 minutes without input.'
  if (p.reason === 'access_lost')
    return 'Closed: you may no longer drive this session.'
  return `The ${app} closed.`
}

/** A refused `<app>s.open`, as the tab shows it. */
export function appRefusal(
  app: WireApp,
  e: {
    message?: string
    data?: { code?: string; reason?: string; message?: string }
  },
): TerminalState {
  if (e.data?.code === `${app}_unavailable`)
    return {
      kind: 'error',
      message: `This session's computer does not run a ${app}.`,
    }
  if (e.data?.code === `too_many_${app}s`)
    return {
      kind: 'error',
      message: `The ${app} is open in another tab, yours or someone else’s.`,
    }
  const r = openRefusal(e)
  return r.kind === 'error' && !e.data?.message
    ? { kind: 'error', message: `Could not open the ${app}.` }
    : r
}

/**
 * Opens the `app` of `sessionId`. `ticket` is called for every dial.
 * Closing ends it (the relay hangs it up with the connection).
 */
export function dialApp(
  app: WireApp,
  o: {
    sessionId: string
    ticket: () => Promise<WireTicket>
    socket?: SocketFactory
  },
  h: AppHandlers,
): { close: () => void } {
  const dial: SocketFactory =
    o.socket ?? ((url, protocols) => new WebSocket(url, protocols))
  let closed = false
  let attempt = 0
  let ws: ReturnType<SocketFactory> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const state = (s: TerminalState) => {
    if (!closed) h.onState(s)
  }

  const connect = async () => {
    let ticket: WireTicket
    try {
      ticket = await o.ticket()
    } catch (e) {
      state({
        kind: 'error',
        message: e instanceof Error ? e.message : `Could not open the ${app}.`,
      })
      return
    }
    if (closed) return
    const sock = dial(ticket.url, ['opc.v1', `opc.ticket.${ticket.token}`])
    sock.binaryType = 'arraybuffer'
    ws = sock
    let open: { id: string; channel: number } | null = null
    let ended = false
    const stop = () => {
      if (!open) return
      open = null
      h.onEnd?.()
    }
    const end = (s: TerminalState) => {
      ended = true
      stop()
      state(s)
      sock.close(1000)
    }
    sock.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        const f = decodeFrame(ev.data)
        if (!f || !open || f.channel !== open.channel) return
        try {
          h.onData(f.data)
        } catch {
          end({ kind: 'error', message: `The ${app} stream broke.` })
        }
        return
      }
      let m: {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: Record<string, { id: string; channel: number } | undefined>
        error?: Parameters<typeof appRefusal>[1]
      }
      try {
        m = JSON.parse(String(ev.data)) as typeof m
      } catch {
        return
      }
      if (m.method === 'ready')
        sock.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: `${app}s.open`,
            params: { sessionId: o.sessionId },
          }),
        )
      else if (m.id === 1 && m.result?.[app]) {
        const opened = m.result[app]
        open = opened
        attempt = 0
        state({ kind: 'open' })
        h.onOpen((bytes) => {
          if (open === opened && sock.readyState === 1)
            sock.send(encodeFrame(opened.channel, bytes))
        })
      } else if (m.id === 1 && m.error) end(appRefusal(app, m.error))
      else if (
        m.method === `${app}.exited` &&
        open &&
        m.params?.[`${app}Id`] === open.id
      )
        end({ kind: 'ended', message: appExitMessage(app, m.params) })
    }
    sock.onclose = (ev: CloseEvent) => {
      if (ws === sock) ws = null
      const wasOpen = open !== null
      stop()
      if (closed || ended) return
      const c = readClose(ev.code, ev.reason)
      if (!wasOpen && c.waking && attempt < WAKE_ATTEMPTS) {
        attempt++
        state({ kind: 'waking-computer' })
        timer = setTimeout(() => void connect(), c.retryAfterMs)
        return
      }
      const message = c.message.replace('terminal', app)
      state(
        wasOpen && !c.waking
          ? { kind: 'ended', message }
          : { kind: 'error', message },
      )
    }
  }

  state({ kind: 'connecting' })
  void connect()
  return {
    close: () => {
      closed = true
      clearTimeout(timer)
      ws?.close(1000)
    },
  }
}
