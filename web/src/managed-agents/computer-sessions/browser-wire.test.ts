import { expect, it } from 'vitest'
import {
  browserExitMessage,
  browserRefusal,
  keyInput,
  openBrowser,
  records,
  type BrowserPageState,
} from './browser-wire'
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
  binary(b: Uint8Array) {
    this.onmessage?.({ data: b.slice().buffer } as MessageEvent)
  }
  calls() {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map(
        (d) => JSON.parse(d) as { id: number; method: string; params: unknown },
      )
  }
  /** The JSON lines the client wrote on `channel`. */
  lines(channel: number) {
    return this.sent
      .filter((d): d is Uint8Array => d instanceof Uint8Array)
      .map((d) => decodeFrame(d.slice().buffer))
      .filter((f) => f?.channel === channel)
      .map((f) => JSON.parse(new TextDecoder().decode(f!.data)) as unknown)
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1]

function record(kind: string, payload: Uint8Array | string) {
  const p =
    typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  const r = new Uint8Array(5 + p.length)
  r[0] = kind.charCodeAt(0)
  new DataView(r.buffer).setUint32(1, p.length)
  r.set(p, 5)
  return r
}

function harness() {
  const sockets: FakeSocket[] = []
  const states: TerminalState[] = []
  const pages: BrowserPageState[] = []
  const frames: number[][] = []
  const errors: string[] = []
  const socket: SocketFactory = (url, protocols) => {
    const s = new FakeSocket(url, protocols)
    sockets.push(s)
    return s as unknown as WebSocket
  }
  const conn = openBrowser(
    {
      sessionId: 'cs_7f3a9k2m4q8r1t6v',
      viewport: { width: 640, height: 480, dpr: 2 },
      ticket: () =>
        Promise.resolve({ token: 'tk_abc.def', url: 'wss://wire.test/v1' }),
      socket,
    },
    {
      onState: (s) => states.push(s),
      onPage: (p) => pages.push(p),
      onFrame: (f) => frames.push([...f]),
      onError: (m) => errors.push(m),
    },
  )
  return { sockets, states, pages, frames, errors, conn }
}

it('reassembles records however the relay cut them', () => {
  const got: [string, string][] = []
  const feed = records((k, p) => got.push([k, new TextDecoder().decode(p)]))
  const all = new Uint8Array([
    ...record('J', '{"t":"state"}'),
    ...record('F', 'jpeg'),
  ])
  for (const b of all) feed(new Uint8Array([b]))
  feed(new Uint8Array([...record('F', 'a'), ...record('F', 'b')]))
  expect(got).toEqual([
    ['J', '{"t":"state"}'],
    ['F', 'jpeg'],
    ['F', 'a'],
    ['F', 'b'],
  ])
  expect(() => feed(new Uint8Array([70, 0xff, 0xff, 0xff, 0xff]))).toThrow()
})

it('opens the session’s browser, sends its viewport, and passes on page state and frames', async () => {
  const h = harness()
  await flush()
  const s = h.sockets[0]
  expect(s.protocols).toEqual(['opc.v1', 'opc.ticket.tk_abc.def'])
  s.json({ jsonrpc: '2.0', method: 'ready', params: {} })
  expect(s.calls()[0]).toMatchObject({
    id: 1,
    method: 'browsers.open',
    params: { sessionId: 'cs_7f3a9k2m4q8r1t6v' },
  })
  s.json({
    jsonrpc: '2.0',
    id: 1,
    result: { browser: { id: 'br_000000000001', channel: 3 } },
  })
  expect(last(h.states)).toEqual({ kind: 'open' })
  expect(s.lines(3)).toEqual([
    { t: 'viewport', width: 640, height: 480, dpr: 2 },
  ])

  const page = {
    t: 'state',
    url: 'http://localhost:3000/',
    title: 'App',
    loading: false,
    canGoBack: true,
    canGoForward: false,
  }
  const stream = new Uint8Array([
    ...record('J', JSON.stringify(page)),
    ...record('F', new Uint8Array([0xff, 0xd8, 1])),
  ])
  s.binary(encodeFrame(3, stream.subarray(0, 7)))
  s.binary(encodeFrame(9, stream)) // another channel: not ours
  s.binary(encodeFrame(3, stream.subarray(7)))
  expect(h.pages).toEqual([page])
  expect(h.frames).toEqual([[0xff, 0xd8, 1]])

  h.conn.send({ t: 'navigate', url: 'localhost:3000' })
  expect(last(s.lines(3))).toEqual({ t: 'navigate', url: 'localhost:3000' })

  s.binary(
    encodeFrame(
      3,
      record('J', '{"t":"error","message":"net::ERR_CONNECTION_REFUSED"}'),
    ),
  )
  expect(h.errors).toEqual(['net::ERR_CONNECTION_REFUSED'])

  s.json({
    jsonrpc: '2.0',
    method: 'browser.exited',
    params: { browserId: 'br_000000000001', reason: 'idle' },
  })
  expect(last(h.states)).toEqual({
    kind: 'ended',
    message: 'Closed after 15 minutes without input.',
  })
})

it('says why the browser was refused', () => {
  expect(browserRefusal({ data: { code: 'browser_unavailable' } })).toEqual({
    kind: 'error',
    message: "This session's computer does not run a browser.",
  })
  expect(browserRefusal({ data: { code: 'too_many_browsers' } }).kind).toBe(
    'error',
  )
  expect(
    browserRefusal({
      data: { code: 'conflict', reason: 'session_not_running' },
    }),
  ).toEqual({ kind: 'not-running' })
  expect(browserExitMessage({ reason: 'access_lost' })).toMatch(
    /no longer drive/,
  )
})

it('maps keys as DevTools takes them', () => {
  const k = (key: string, o: Partial<KeyboardEvent> = {}) =>
    ({
      key,
      code: '',
      keyCode: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...o,
    }) as KeyboardEvent
  expect(keyInput('down', k('a'))).toMatchObject({
    type: 'keyDown',
    text: 'a',
    modifiers: 0,
  })
  expect(keyInput('down', k('A', { shiftKey: true }))).toMatchObject({
    type: 'keyDown',
    text: 'A',
    modifiers: 8,
  })
  expect(keyInput('down', k('Enter'))).toMatchObject({
    type: 'keyDown',
    text: '\r',
  })
  expect(keyInput('down', k('Backspace'))).toMatchObject({ type: 'rawKeyDown' })
  expect(keyInput('down', k('a', { ctrlKey: true }))).toMatchObject({
    type: 'rawKeyDown',
    modifiers: 2,
  })
  expect(keyInput('up', k('a'))).toMatchObject({ type: 'keyUp' })
})
