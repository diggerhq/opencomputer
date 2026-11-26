import { expect, it } from 'vitest'
import { openDesktop, type RfbChannel } from './desktop-wire'
import {
  decodeFrame,
  encodeFrame,
  type SocketFactory,
  type TerminalState,
} from './terminal-wire'

class FakeSocket {
  sent: unknown[] = []
  readyState = 1
  binaryType = 'blob'
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  send(d: unknown) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
  json(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent)
  }
  binary(b: Uint8Array) {
    this.onmessage?.({ data: b.slice().buffer } as MessageEvent)
  }
  calls() {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { id: number; method: string })
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1]
const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b)

// The properties noVNC's Websock.attach requires of a raw channel.
const RAW_CHANNEL = [
  'send',
  'close',
  'binaryType',
  'onerror',
  'onmessage',
  'onopen',
  'protocol',
  'readyState',
]

function harness() {
  const sockets: FakeSocket[] = []
  const states: TerminalState[] = []
  const channels: RfbChannel[] = []
  const socket: SocketFactory = () => {
    const s = new FakeSocket()
    sockets.push(s)
    return s as unknown as WebSocket
  }
  const conn = openDesktop(
    {
      sessionId: 'cs_7f3a9k2m4q8r1t6v',
      ticket: () =>
        Promise.resolve({ token: 'tk_abc.def', url: 'wss://wire.test/v1' }),
      socket,
    },
    { onState: (s) => states.push(s), onChannel: (c) => channels.push(c) },
  )
  return { sockets, states, channels, conn }
}

it('opens the desktop and hands noVNC a channel that carries RFB both ways', async () => {
  const h = harness()
  await flush()
  const ws = h.sockets[0]
  ws.json({ jsonrpc: '2.0', method: 'ready', params: {} })
  expect(ws.calls()).toEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'desktops.open',
      params: { sessionId: 'cs_7f3a9k2m4q8r1t6v' },
    },
  ])
  ws.json({
    jsonrpc: '2.0',
    id: 1,
    result: { desktop: { id: 'dk_000000000001', channel: 3 } },
  })
  expect(last(h.states)).toEqual({ kind: 'open' })
  const ch = h.channels[0]
  const props = [
    ...Object.keys(ch),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(ch)),
  ]
  for (const p of RAW_CHANNEL) expect(props).toContain(p)
  expect(ch.readyState).toBe('open')

  // The server speaks first, maybe before noVNC attaches: nothing is lost.
  ws.binary(encodeFrame(3, bytes('RFB 003.008\n')))
  ws.binary(encodeFrame(9, bytes('another channel')))
  const got: string[] = []
  ch.onmessage = (e) => got.push(text(e.data))
  ws.binary(encodeFrame(3, bytes('\x01\x01')))
  expect(got).toEqual(['RFB 003.008\n', '\x01\x01'])

  ch.send(bytes('RFB 003.008\n'))
  const out = ws.sent.filter((d): d is Uint8Array => d instanceof Uint8Array)
  const f = decodeFrame(out[0].slice().buffer)
  expect([f?.channel, text(f!.data)]).toEqual([3, 'RFB 003.008\n'])

  const closes: number[] = []
  ch.onclose = (e) => closes.push(e.code)
  ws.json({
    jsonrpc: '2.0',
    method: 'desktop.exited',
    params: { desktopId: 'dk_000000000001', reason: 'idle' },
  })
  expect(closes).toEqual([1000])
  expect(ch.readyState).toBe('closed')
  expect(last(h.states)).toEqual({
    kind: 'ended',
    message: 'Closed after 15 minutes without input.',
  })
})

it('says why the desktop was refused, and noVNC closing the channel hangs up', async () => {
  const h = harness()
  await flush()
  h.sockets[0].json({ jsonrpc: '2.0', method: 'ready', params: {} })
  h.sockets[0].json({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32000,
      message: 'x',
      data: { code: 'desktop_unavailable' },
    },
  })
  expect(last(h.states)).toEqual({
    kind: 'error',
    message: "This session's computer does not run a desktop.",
  })

  const g = harness()
  await flush()
  const ws = g.sockets[0]
  ws.json({ jsonrpc: '2.0', method: 'ready', params: {} })
  ws.json({
    jsonrpc: '2.0',
    id: 1,
    result: { desktop: { id: 'dk_000000000002', channel: 1 } },
  })
  g.channels[0].close()
  expect(ws.readyState).toBe(3)
})
