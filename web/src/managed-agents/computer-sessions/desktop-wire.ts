// The session's desktop over the wire (docs/design/session-browser-desktop.md),
// dialled as app-wire.ts does. Its one channel carries VNC (RFB 3.8, no
// authentication: the wire did that) both ways, and noVNC speaks it through
// `RfbChannel`, an object with the WebSocket interface noVNC takes in place
// of a URL. No websockify, no port.

import { dialApp } from './app-wire'
import type { SocketFactory, TerminalState, WireTicket } from './terminal-wire'

type Handler<E> = ((e: E) => void) | null

/**
 * One desktop channel as noVNC's raw channel (core/websock.js): already open,
 * bytes in through `onmessage`, out through `send`. Bytes that arrive before
 * noVNC attaches are kept for it.
 */
export class RfbChannel {
  binaryType = 'arraybuffer'
  protocol = ''
  onopen: Handler<Event> = null
  onerror: Handler<Event> = null
  onclose: Handler<{ code: number; reason: string; wasClean: boolean }> = null
  private state: 'open' | 'closed' = 'open'
  private handler: Handler<{ data: ArrayBuffer }> = null
  private early: ArrayBuffer[] = []

  constructor(
    private write: (bytes: Uint8Array) => void,
    private hangUp: () => void,
  ) {}

  get readyState() {
    return this.state
  }

  get onmessage() {
    return this.handler
  }

  set onmessage(h: Handler<{ data: ArrayBuffer }>) {
    this.handler = h
    if (!h) return
    const early = this.early
    this.early = []
    for (const data of early) h({ data })
  }

  send(data: ArrayBuffer | Uint8Array) {
    if (this.state === 'open')
      this.write(data instanceof Uint8Array ? data : new Uint8Array(data))
  }

  close() {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.hangUp()
  }

  /** From the wire: the app's bytes. */
  receive(bytes: Uint8Array) {
    const data = bytes.slice().buffer
    if (this.handler) this.handler({ data })
    else this.early.push(data)
  }

  /** From the wire: the channel ended. */
  ended() {
    const was = this.state
    this.state = 'closed'
    if (was === 'open')
      this.onclose?.({ code: 1000, reason: '', wasClean: true })
  }
}

/**
 * Opens the desktop of `sessionId`; `onChannel` gets each opened channel, for
 * noVNC. Closing ends it.
 */
export function openDesktop(
  o: {
    sessionId: string
    ticket: () => Promise<WireTicket>
    socket?: SocketFactory
  },
  cb: {
    onState: (state: TerminalState) => void
    onChannel: (channel: RfbChannel) => void
  },
): { close: () => void } {
  let channel: RfbChannel | null = null
  const conn = dialApp('desktop', o, {
    onState: cb.onState,
    onOpen: (write) => {
      channel = new RfbChannel(write, () => conn.close())
      cb.onChannel(channel)
    },
    onData: (bytes) => channel?.receive(bytes),
    onEnd: () => {
      channel?.ended()
      channel = null
    },
  })
  return conn
}
