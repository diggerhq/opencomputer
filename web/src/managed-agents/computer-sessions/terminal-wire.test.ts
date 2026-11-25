import { afterEach, expect, it, vi } from 'vitest'
import {
  decodeFrame,
  encodeFrame,
  exitMessage,
  openRefusal,
  openTerminal,
  readClose,
  type SocketFactory,
  type TerminalState,
} from './terminal-wire'

/** A socket the test drives: what the client sent, and hooks to answer it. */
class FakeSocket {
  sent: unknown[] = []
  readyState = 1
  binaryType = 'blob'
  onopen: unknown = null
  onerror: unknown = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(d: unknown) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
  json(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent)
  }
  shut(code: number, reason = '') {
    this.onclose?.({ code, reason } as CloseEvent)
  }
  calls() {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map(
        (d) =>
          JSON.parse(d) as {
            id: number
            method: string
            params: Record<string, unknown>
          },
      )
  }
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1]
const flush = () => new Promise((r) => setTimeout(r, 0))

function harness() {
  const sockets: FakeSocket[] = []
  const states: TerminalState[] = []
  const data: string[] = []
  const socket: SocketFactory = (url, protocols) => {
    const s = new FakeSocket(url, protocols)
    sockets.push(s)
    return s as unknown as WebSocket
  }
  const conn = openTerminal(
    {
      sessionId: 'cs_7f3a9k2m4q8r1t6v',
      cols: 80,
      rows: 24,
      ticket: () =>
        Promise.resolve({ token: 'tk_abc.def', url: 'wss://wire.test/v1' }),
      socket,
    },
    {
      onState: (s) => states.push(s),
      onData: (b) => data.push(new TextDecoder().decode(b)),
    },
  )
  return { sockets, states, data, conn }
}

afterEach(() => vi.useRealTimers())

it('frames bytes with a big-endian channel', () => {
  const f = encodeFrame(258, new TextEncoder().encode('ls\n'))
  expect([...f.subarray(0, 4)]).toEqual([0, 0, 1, 2])
  const back = decodeFrame(f.buffer)!
  expect(back.channel).toBe(258)
  expect(new TextDecoder().decode(back.data)).toBe('ls\n')
  expect(decodeFrame(new ArrayBuffer(2))).toBeNull()
})

it('dials with the ticket, opens on ready, and pipes the shell both ways', async () => {
  const h = harness()
  await flush()
  const ws = h.sockets[0]
  expect(ws.protocols).toEqual(['opc.v1', 'opc.ticket.tk_abc.def'])
  ws.json({ jsonrpc: '2.0', method: 'ready', params: {} })
  expect(ws.calls()[0]).toMatchObject({
    id: 1,
    method: 'terminals.open',
    params: { sessionId: 'cs_7f3a9k2m4q8r1t6v', cols: 80, rows: 24 },
  })
  ws.json({
    jsonrpc: '2.0',
    id: 1,
    result: { terminal: { id: 'tm_000000000001', channel: 7 } },
  })
  expect(last(h.states)).toEqual({ kind: 'open' })
  ws.onmessage?.({
    data: encodeFrame(7, new TextEncoder().encode('$ ')).buffer,
  } as MessageEvent)
  ws.onmessage?.({
    data: encodeFrame(9, new TextEncoder().encode('other')).buffer,
  } as MessageEvent)
  expect(h.data).toEqual(['$ '])
  h.conn.send('pwd\r')
  const frame = ws.sent.find((d) => d instanceof Uint8Array) as Uint8Array
  expect(decodeFrame(frame.buffer as ArrayBuffer)).toMatchObject({ channel: 7 })
  h.conn.resize(100, 30)
  expect(last(ws.calls())).toMatchObject({
    method: 'terminals.resize',
    params: { terminalId: 'tm_000000000001', cols: 100, rows: 30 },
  })
})

it('says the session is not running instead of a raw error', async () => {
  const h = harness()
  await flush()
  const ws = h.sockets[0]
  ws.json({ jsonrpc: '2.0', method: 'ready', params: {} })
  ws.json({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32000,
      message: 'x',
      data: { code: 'conflict', reason: 'session_not_running' },
    },
  })
  ws.shut(1000)
  expect(last(h.states)).toEqual({ kind: 'not-running' })
})

it('offers Wake for a stopped session from new and old hosts', () => {
  expect(
    openRefusal({
      message: 'The session is not running',
      data: { code: 'conflict', reason: 'session_not_running' },
    }),
  ).toEqual({ kind: 'not-running' })
  expect(
    openRefusal({
      message: 'No such session on this computer.',
      data: { code: 'session_not_found' },
    }),
  ).toEqual({ kind: 'not-running' })
  expect(openRefusal({ message: 'boom', data: { code: 'internal' } })).toEqual({
    kind: 'error',
    message: 'boom',
  })
})

it('waits for a parked computer to wake, then dials again', async () => {
  vi.useFakeTimers()
  const h = harness()
  await vi.advanceTimersByTimeAsync(0)
  h.sockets[0].shut(
    4503,
    JSON.stringify({ reason: 'waking', retryAfterMs: 5000 }),
  )
  expect(last(h.states)).toEqual({ kind: 'waking-computer' })
  await vi.advanceTimersByTimeAsync(5000)
  expect(h.sockets).toHaveLength(2)
})

it('explains why the relay hung up', async () => {
  const h = harness()
  await flush()
  const ws = h.sockets[0]
  ws.json({ jsonrpc: '2.0', method: 'ready', params: {} })
  ws.json({
    jsonrpc: '2.0',
    id: 1,
    result: { terminal: { id: 'tm_000000000001', channel: 7 } },
  })
  ws.json({
    jsonrpc: '2.0',
    method: 'terminal.exited',
    params: {
      terminalId: 'tm_000000000001',
      exitCode: null,
      signal: 'SIGHUP',
      reason: 'idle',
    },
  })
  expect(last(h.states)).toEqual({
    kind: 'ended',
    message: 'Closed after 15 minutes without activity.',
  })
  expect(exitMessage({ reason: 'access_lost' })).toMatch(/no longer drive/)
  expect(exitMessage({ exitCode: 0 })).toBe('The shell exited (0).')
  expect(readClose(4503, JSON.stringify({ reason: 'asleep' })).waking).toBe(
    false,
  )
  expect(readClose(4003, '').message).toMatch(/may not open/)
})
