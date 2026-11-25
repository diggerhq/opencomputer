// One interactive terminal in a session over the wire (opc docs
// websocket/terminals.mdx), as `opc shell` opens it: a dashboard terminal
// ticket in the `opc.ticket.<t>` subprotocol, `ready`, then `terminals.open`;
// the shell's bytes travel as binary frames `[u32 BE channel][data]`.
//
// The relay opens terminals only for people who may drive the session, never
// wakes a stopped session (`session_not_running`: the panel offers Wake), and
// hangs a terminal up after 15 idle minutes or when access is lost
// (`terminal.exited` `reason`). A parked computer refuses the upgrade with
// 4503 and how long to wait while it wakes; this retries that on its own.

export interface WireTicket {
  token: string
  url: string
}

export type TerminalState =
  | { kind: 'connecting' }
  | { kind: 'waking-computer' }
  | { kind: 'not-running' }
  | { kind: 'open' }
  | { kind: 'ended'; message: string }
  | { kind: 'error'; message: string }

export interface TerminalCallbacks {
  onState: (state: TerminalState) => void
  onData: (bytes: Uint8Array) => void
}

export interface TerminalConnection {
  send: (text: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

type Socket = Pick<
  WebSocket,
  | 'send'
  | 'close'
  | 'readyState'
  | 'binaryType'
  | 'onopen'
  | 'onmessage'
  | 'onclose'
  | 'onerror'
>
export type SocketFactory = (url: string, protocols: string[]) => Socket

/** Waking a parked computer is retried this many times before the panel gives up. */
const WAKE_ATTEMPTS = 12

export function encodeFrame(
  channel: number,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(4 + data.length)
  new DataView(frame.buffer).setUint32(0, channel)
  frame.set(data, 4)
  return frame
}

export function decodeFrame(
  buf: ArrayBuffer,
): { channel: number; data: Uint8Array } | null {
  if (buf.byteLength < 4) return null
  return {
    channel: new DataView(buf).getUint32(0),
    data: new Uint8Array(buf, 4),
  }
}

/** What a refused or dropped connection's close says: whether to retry, after how long, and why. */
export function readClose(
  code: number,
  reason: string,
): { retryAfterMs?: number; waking: boolean; message: string } {
  let r: { code?: string; reason?: string; retryAfterMs?: number } = {}
  try {
    r = JSON.parse(reason) as typeof r
  } catch {
    // Not one of the Worker's JSON reasons.
  }
  if (code === 4503) {
    if (r.reason === 'asleep')
      return {
        waking: false,
        message: 'The computer is asleep and could not be woken.',
      }
    if (r.reason === 'gone')
      return { waking: false, message: 'The computer is gone.' }
    return {
      retryAfterMs: r.retryAfterMs ?? 5_000,
      waking: true,
      message: 'Waking the computer…',
    }
  }
  if (code === 4001)
    return {
      waking: false,
      message: 'Your sign-in for the terminal expired. Reconnect.',
    }
  if (code === 4003)
    return {
      waking: false,
      message: 'You may not open a terminal in this session.',
    }
  return { waking: false, message: 'Disconnected.' }
}

/** What `terminal.exited` means to the person who was typing. */
export function exitMessage(p: {
  exitCode?: number | null
  signal?: string | null
  reason?: string
}): string {
  if (p.reason === 'idle') return 'Closed after 15 minutes without activity.'
  if (p.reason === 'access_lost')
    return 'Closed: you may no longer drive this session.'
  if (p.exitCode != null) return `The shell exited (${p.exitCode}).`
  return p.signal ? `The shell ended (${p.signal}).` : 'The shell ended.'
}

interface RpcError {
  message?: string
  data?: { code?: string; reason?: string; message?: string }
}

/**
 * A refused `terminals.open` as the panel shows it. Hosts answer a stopped
 * session with `409 session_not_running`; older ones said `404
 * session_not_found` ("No such session on this computer"). The ticket was
 * minted for this session, so it exists and is visible: both mean not running.
 */
export function openRefusal(e: RpcError): TerminalState {
  if (
    e.data?.reason === 'session_not_running' ||
    e.data?.code === 'session_not_found'
  )
    return { kind: 'not-running' }
  return {
    kind: 'error',
    message: e.data?.message ?? e.message ?? 'Could not open a terminal.',
  }
}

/**
 * Opens a terminal in `sessionId`. `ticket` is called for every dial (a ticket
 * is good for one connection, ten minutes to present). Closing ends it.
 */
export function openTerminal(
  o: {
    sessionId: string
    cols: number
    rows: number
    ticket: () => Promise<WireTicket>
    socket?: SocketFactory
  },
  cb: TerminalCallbacks,
): TerminalConnection {
  const dial: SocketFactory =
    o.socket ?? ((url, protocols) => new WebSocket(url, protocols))
  const encoder = new TextEncoder()
  let ws: Socket | null = null
  let closed = false
  let attempt = 0
  let size = { cols: o.cols, rows: o.rows }
  let terminal: { id: string; channel: number } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let nextId = 2
  const state = (s: TerminalState) => {
    if (!closed) cb.onState(s)
  }
  const call = (id: number, method: string, params: unknown) =>
    ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))

  const connect = async () => {
    let ticket: WireTicket
    try {
      ticket = await o.ticket()
    } catch (e) {
      state({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not open a terminal.',
      })
      return
    }
    if (closed) return
    const sock = dial(ticket.url, ['opc.v1', `opc.ticket.${ticket.token}`])
    sock.binaryType = 'arraybuffer'
    ws = sock
    let ended = false
    sock.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        const f = decodeFrame(ev.data)
        if (f && terminal && f.channel === terminal.channel) cb.onData(f.data)
        return
      }
      let m: {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: { terminal?: { id: string; channel: number } }
        error?: RpcError
      }
      try {
        m = JSON.parse(String(ev.data)) as typeof m
      } catch {
        return
      }
      if (m.method === 'ready')
        call(1, 'terminals.open', {
          sessionId: o.sessionId,
          cols: size.cols,
          rows: size.rows,
        })
      else if (m.id === 1 && m.result?.terminal) {
        terminal = m.result.terminal
        attempt = 0
        state({ kind: 'open' })
      } else if (m.id === 1 && m.error) {
        ended = true
        state(openRefusal(m.error))
        sock.close(1000)
      } else if (
        m.method === 'terminal.exited' &&
        terminal &&
        m.params?.terminalId === terminal.id
      ) {
        ended = true
        terminal = null
        state({ kind: 'ended', message: exitMessage(m.params) })
        sock.close(1000)
      }
    }
    sock.onclose = (ev: CloseEvent) => {
      if (ws === sock) ws = null
      const wasOpen = terminal !== null
      terminal = null
      if (closed || ended) return
      const c = readClose(ev.code, ev.reason)
      if (!wasOpen && c.waking && attempt < WAKE_ATTEMPTS) {
        attempt++
        state({ kind: 'waking-computer' })
        timer = setTimeout(() => void connect(), c.retryAfterMs)
        return
      }
      state(
        wasOpen && !c.waking
          ? { kind: 'ended', message: c.message }
          : { kind: 'error', message: c.message },
      )
    }
  }

  state({ kind: 'connecting' })
  void connect()
  return {
    send: (text) => {
      if (terminal && ws?.readyState === 1)
        ws.send(encodeFrame(terminal.channel, encoder.encode(text)))
    },
    resize: (cols, rows) => {
      size = { cols, rows }
      if (terminal)
        call(nextId++, 'terminals.resize', {
          terminalId: terminal.id,
          cols,
          rows,
        })
    },
    close: () => {
      closed = true
      clearTimeout(timer)
      ws?.close(1000)
    },
  }
}
