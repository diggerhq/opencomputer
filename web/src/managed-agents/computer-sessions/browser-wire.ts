// The session's browser over the wire (docs/design/session-browser-desktop.md),
// dialled as app-wire.ts does. Its one channel carries JSON lines in
// (viewport, navigate, mouse, key…), and records out, `type (1 byte) | length
// (u32 BE) | payload`, which the relay cuts into frames of at most 64 KiB, so
// a record may span frames and a frame may hold several.

import { appExitMessage, appRefusal, dialApp } from './app-wire'
import type { SocketFactory, TerminalState, WireTicket } from './terminal-wire'

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
export const browserExitMessage = (p: { reason?: string }) =>
  appExitMessage('browser', p)

/** A refused `browsers.open`, as the tab shows it. */
export const browserRefusal = (e: Parameters<typeof appRefusal>[1]) =>
  appRefusal('browser', e)

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
  const encoder = new TextEncoder()
  let viewport = o.viewport
  let write: ((bytes: Uint8Array) => void) | null = null
  const send = (input: BrowserInput) =>
    write?.(encoder.encode(`${JSON.stringify(input)}\n`))
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
  let feed = records(onRecord)
  const conn = dialApp('browser', o, {
    onState: cb.onState,
    onOpen: (w) => {
      feed = records(onRecord)
      write = w
      send({ t: 'viewport', ...viewport })
    },
    onData: (bytes) => feed(bytes),
    onEnd: () => (write = null),
  })
  return {
    send: (input) => {
      if (input.t === 'viewport') viewport = input
      send(input)
    },
    close: conn.close,
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
