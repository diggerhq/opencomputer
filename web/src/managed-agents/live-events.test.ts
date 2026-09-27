import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedAgentEvent } from './events'
import {
  ManagedAgentEventStream,
  ManagedAgentEventStreamTimeout,
  managedAgentSocketUrl,
} from './live-events'

class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = []
  closed: { code?: number; reason?: string } | null = null
  constructor(readonly url: string) {
    super()
    FakeSocket.instances.push(this)
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
  }
  frame(frame: unknown) {
    this.dispatchEvent(
      Object.assign(new Event('message'), { data: JSON.stringify(frame) }),
    )
  }
  raw(data: string) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }))
  }
  drop() {
    this.dispatchEvent(new Event('close'))
  }
}

const Socket = FakeSocket as unknown as new (url: string) => WebSocket

function event(seq: number, type = 'message.delta'): ManagedAgentEvent {
  return { seq, type, data: { text: String(seq) } }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const noSleep = tick

beforeEach(() => {
  vi.stubGlobal('location', { protocol: 'https:', host: 'app.test' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  FakeSocket.instances = []
})

describe('ManagedAgentEventStream', () => {
  it('yields socket events in order and drops replays at or below the cursor', async () => {
    const fetchEvents = vi.fn()
    const stream = new ManagedAgentEventStream('s1', 2, {
      fetchEvents,
      webSocket: Socket,
      sleep: noSleep,
    })
    const socket = FakeSocket.instances[0]
    expect(socket.url).toBe(
      'wss://app.test/api/dashboard/managed-agents/sessions/s1/connect?role=client&cursor=2',
    )
    socket.frame({ type: 'ready', sessionId: 's1', cursor: 2 })
    socket.raw('not json')
    socket.frame({ type: 'event', event: event(2) })
    socket.frame({ type: 'event', event: event(3) })
    socket.frame({ type: 'pong' })
    const next = stream.next(1_000)
    socket.frame({ type: 'event', event: event(4) })

    expect((await next).seq).toBe(3)
    expect((await stream.next(1_000)).seq).toBe(4)
    expect(stream.position).toBe(4)
    expect(fetchEvents).not.toHaveBeenCalled()

    stream.close()
    expect(socket.closed).toEqual({ code: 1000, reason: 'done' })
  })

  it('reconnects from the last cursor when a live socket drops', async () => {
    const stream = new ManagedAgentEventStream('s1', 0, {
      fetchEvents: vi.fn(),
      webSocket: Socket,
      sleep: noSleep,
    })
    const first = FakeSocket.instances[0]
    first.frame({ type: 'ready', sessionId: 's1', cursor: 0 })
    first.frame({ type: 'event', event: event(1) })
    first.drop()
    await tick()
    await tick()

    const second = FakeSocket.instances[1]
    expect(second.url).toBe(managedAgentSocketUrl('s1', 1))
    second.frame({ type: 'ready', sessionId: 's1', cursor: 1 })
    second.frame({ type: 'event', event: event(1) })
    second.frame({ type: 'event', event: event(2) })

    expect((await stream.next(1_000)).seq).toBe(1)
    expect((await stream.next(1_000)).seq).toBe(2)
    stream.close()
  })

  it('falls back to polling when the socket never becomes ready', async () => {
    const pages = new Map([
      [0, [event(1), event(2)]],
      [2, []],
      [3, [event(3)]],
    ])
    const fetchEvents = vi.fn((_sessionId: string, after: number) => {
      const page = pages.get(after) ?? []
      pages.set(after, [])
      if (after === 2) pages.set(3, pages.get(3) ?? [])
      return Promise.resolve(page)
    })
    const stream = new ManagedAgentEventStream('s1', 0, {
      fetchEvents,
      webSocket: Socket,
      sleep: noSleep,
    })
    FakeSocket.instances[0].dispatchEvent(new Event('error'))

    expect((await stream.next(1_000)).seq).toBe(1)
    expect((await stream.next(1_000)).seq).toBe(2)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(fetchEvents.mock.calls[0]).toEqual(['s1', 0, undefined])
    stream.close()
  })

  it('gives up on a socket that never becomes ready and polls instead', async () => {
    const fetchEvents = vi
      .fn<
        (
          sessionId: string,
          after: number,
          signal?: AbortSignal,
        ) => Promise<ManagedAgentEvent[]>
      >()
      .mockResolvedValueOnce([event(1)])
      .mockResolvedValue([])
    const controller = new AbortController()
    const stream = new ManagedAgentEventStream('s1', 0, {
      fetchEvents,
      webSocket: Socket,
      sleep: noSleep,
      readyTimeoutMs: 5,
      signal: controller.signal,
    })
    expect((await stream.next(1_000)).seq).toBe(1)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(FakeSocket.instances[0].closed?.reason).toBe('ready timeout')
    expect(fetchEvents.mock.calls[0]).toEqual(['s1', 0, controller.signal])
    stream.close()
  })

  it('polls directly when WebSockets are unavailable', async () => {
    const fetchEvents = vi
      .fn<(sessionId: string, after: number) => Promise<ManagedAgentEvent[]>>()
      .mockResolvedValueOnce([event(1)])
      .mockResolvedValue([])
    const stream = new ManagedAgentEventStream('s1', 0, {
      fetchEvents,
      webSocket: null,
      sleep: noSleep,
    })
    expect((await stream.next(1_000)).seq).toBe(1)
    stream.close()
  })

  it('times out when nothing arrives within the inactivity window', async () => {
    vi.useFakeTimers()
    try {
      const stream = new ManagedAgentEventStream('s1', 0, {
        fetchEvents: vi.fn(),
        webSocket: Socket,
        sleep: noSleep,
      })
      const pending = stream.next(500)
      vi.advanceTimersByTime(500)
      await expect(pending).rejects.toBeInstanceOf(
        ManagedAgentEventStreamTimeout,
      )
      stream.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects pending reads and closes the socket when aborted', async () => {
    const controller = new AbortController()
    const stream = new ManagedAgentEventStream('s1', 0, {
      fetchEvents: vi.fn(),
      webSocket: Socket,
      sleep: noSleep,
      signal: controller.signal,
    })
    const pending = stream.next(1_000)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeSocket.instances[0].closed?.code).toBe(1000)
  })
})
