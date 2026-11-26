// The session's browser over the wire (docs/design/session-browser-desktop.md):
// the same ticket and dial as a terminal (terminal-wire.ts), then
// `browsers.open`. One channel carries both directions: JSON lines in
// (viewport, navigate, mouse, key…), and records out, `type (1 byte) | length
// (u32 BE) | payload`, which the relay cuts into frames of at most 64 KiB, so
// a record may span frames and a frame may hold several.
//
// The host runs one browser per session, only where it allows them
// (`browser_unavailable`); the relay closes it after 15 minutes without input
// or when access is lost (`browser.exited` `reason`).

import {
  decodeFrame,
  encodeFrame,
  openRefusal,
  readClose,
  type SocketFactory,
  type TerminalState,
  type WireTicket,
} from './terminal-wire'

export interface BrowserPageState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserInput =
  | { t: 'viewport'; width: number; height: number; dpr: number }
  | { t: 'navigate'; url: string }
  | { t: 'back' | 'forward' | 'reload' | 'stop' }
  | {
      t: 'mouse'
      type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
      x: number
      y: number
      button?: 'none' | 'left' | 'middle' | 'right'
      buttons?: number
      clickCount?: number
      modifiers?: number
      deltaX?: number
      deltaY?: number
    }
  | {
      t: 'key'
      type: 'keyDown' | 'rawKeyDown' | 'keyUp'
      key: string
      code: string
      text?: string
      keyCode?: number
      modifiers?: number
    }
  | { t: 'text'; text: string }

export interface BrowserCallbacks {
  onState: (state: TerminalState) => void
  onPage: (page: BrowserPageState) => void
  onFrame: (jpeg: Uint8Array<ArrayBuffer>) => void
  onError: (message: string) => void
}

export interface BrowserConnection {
  send: (input: BrowserInput) => void
  close: () => void
}

const WAKE_ATTEMPTS = 12
/** A record larger than this is not one the helper writes: the stream is broken. */
const MAX_RECORD = 32 * 1024 * 1024

/** Reassembles the helper's records from the channel's bytes, however they were cut. */
export function records(
  on: (kind: string, payload: Uint8Array<ArrayBuffer>) => void,
): (chunk: Uint8Array) => void {
  let buf = new Uint8Array(0)
  return (chunk) => {
    const all = new Uint8Array(buf.length + chunk.length)
    all.set(buf)
    all.set(chunk, buf.length)
    let at = 0
    while (all.length - at >= 5) {
      const len = new DataView(all.buffer, at + 1, 4).getUint32(0)
      if (len > MAX_RECORD) throw new Error('browser stream out of step')
      if (all.length - at - 5 < len) break
      on(String.fromCharCode(all[at]), all.slice(at + 5, at + 5 + len))
      at += 5 + len
    }
    buf = all.slice(at)
  }
}

/** What `browser.exited` means to the person looking at the page. */
export function browserExitMessage(p: { reason?: string }): string {
  if (p.reason === 'idle') return 'Closed after 15 minutes without input.'
  if (p.reason === 'access_lost')
    return 'Closed: you may no longer drive this session.'
  return 'The browser closed.'
}

/** A refused `browsers.open`, as the tab shows it. */
export function browserRefusal(e: {
  message?: string
  data?: { code?: string; reason?: string; message?: string }
}): TerminalState {
  if (e.data?.code === 'browser_unavailable')
    return {
      kind: 'error',
      message: "This session's computer does not run a browser.",
    }
  if (e.data?.code === 'too_many_browsers')
    return {
      kind: 'error',
      message: 'The browser is open in another tab, yours or someone else’s.',
    }
  const r = openRefusal(e)
  return r.kind === 'error' && !e.data?.message
    ? { kind: 'error', message: 'Could not open the browser.' }
    : r
}

/**
 * Opens the browser of `sessionId`. `ticket` is called for every dial.
 * Closing ends it (the relay hangs it up with the connection).
 */
export function openBrowser(
  o: {
    sessionId: string
    viewport: { width: number; height: number; dpr: number }
    ticket: () => Promise<WireTicket>
    socket?: SocketFactory
  },
  cb: BrowserCallbacks,
): BrowserConnection {
  const dial: SocketFactory =
    o.socket ?? ((url, protocols) => new WebSocket(url, protocols))
  const encoder = new TextEncoder()
  let ws: ReturnType<SocketFactory> | null = null
  let closed = false
  let attempt = 0
  let viewport = o.viewport
  let browser: { id: string; channel: number } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const state = (s: TerminalState) => {
    if (!closed) cb.onState(s)
  }
  const write = (input: BrowserInput) => {
    if (browser && ws?.readyState === 1)
      ws.send(
        encodeFrame(
          browser.channel,
          encoder.encode(`${JSON.stringify(input)}\n`),
        ),
      )
  }
  const onRecord = (kind: string, payload: Uint8Array<ArrayBuffer>) => {
    if (kind === 'F') return cb.onFrame(payload)
    if (kind !== 'J') return
    let m: { t?: string; message?: string } & Partial<BrowserPageState>
    try {
      m = JSON.parse(new TextDecoder().decode(payload)) as typeof m
    } catch {
      return
    }
    if (m.t === 'state') cb.onPage(m as BrowserPageState)
    else if (m.t === 'error') cb.onError(m.message ?? 'The browser failed.')
  }

  const connect = async () => {
    let ticket: WireTicket
    try {
      ticket = await o.ticket()
    } catch (e) {
      state({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not open the browser.',
      })
      return
    }
    if (closed) return
    const sock = dial(ticket.url, ['opc.v1', `opc.ticket.${ticket.token}`])
    sock.binaryType = 'arraybuffer'
    ws = sock
    let ended = false
    let feed = records(onRecord)
    const end = (s: TerminalState) => {
      ended = true
      browser = null
      state(s)
      sock.close(1000)
    }
    sock.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        const f = decodeFrame(ev.data)
        if (!f || !browser || f.channel !== browser.channel) return
        try {
          feed(f.data)
        } catch {
          feed = () => {}
          end({ kind: 'error', message: 'The browser stream broke.' })
        }
        return
      }
      let m: {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: { browser?: { id: string; channel: number } }
        error?: Parameters<typeof browserRefusal>[0]
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
            method: 'browsers.open',
            params: { sessionId: o.sessionId },
          }),
        )
      else if (m.id === 1 && m.result?.browser) {
        browser = m.result.browser
        attempt = 0
        write({ t: 'viewport', ...viewport })
        state({ kind: 'open' })
      } else if (m.id === 1 && m.error) end(browserRefusal(m.error))
      else if (
        m.method === 'browser.exited' &&
        browser &&
        m.params?.browserId === browser.id
      )
        end({ kind: 'ended', message: browserExitMessage(m.params) })
    }
    sock.onclose = (ev: CloseEvent) => {
      if (ws === sock) ws = null
      const wasOpen = browser !== null
      browser = null
      if (closed || ended) return
      const c = readClose(ev.code, ev.reason)
      if (!wasOpen && c.waking && attempt < WAKE_ATTEMPTS) {
        attempt++
        state({ kind: 'waking-computer' })
        timer = setTimeout(() => void connect(), c.retryAfterMs)
        return
      }
      const message = c.message.replace('terminal', 'browser')
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
    send: (input) => {
      if (input.t === 'viewport') viewport = input
      write(input)
    },
    close: () => {
      closed = true
      clearTimeout(timer)
      ws?.close(1000)
    },
  }
}

/** DevTools' modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiers(e: {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): number {
  return (
    (e.altKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.metaKey ? 4 : 0) |
    (e.shiftKey ? 8 : 0)
  )
}

/** A key as DevTools takes it: printable keys carry their text, the rest are raw. */
export function keyInput(
  type: 'down' | 'up',
  e: Pick<
    globalThis.KeyboardEvent,
    'key' | 'code' | 'keyCode' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
  >,
): BrowserInput {
  const mods = modifiers(e)
  const base = { key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods }
  if (type === 'up') return { t: 'key', type: 'keyUp', ...base }
  const text =
    e.key === 'Enter' ? '\r' : e.key.length === 1 && !(mods & 6) ? e.key : ''
  return text
    ? { t: 'key', type: 'keyDown', ...base, text }
    : { t: 'key', type: 'rawKeyDown', ...base }
}
