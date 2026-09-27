import { z } from 'zod'
import { managedAgentEventSchema, type ManagedAgentEvent } from './events'

const frameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    sessionId: z.string(),
    cursor: z.number(),
  }),
  z.object({ type: z.literal('event'), event: managedAgentEventSchema }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])

export type ManagedAgentEventStreamOptions = {
  /** REST fallback used when the WebSocket relay is unavailable. */
  fetchEvents: (
    sessionId: string,
    after: number,
    signal?: AbortSignal,
  ) => Promise<ManagedAgentEvent[]>
  signal?: AbortSignal
  /** How long an upgraded socket may stay silent before it counts as unavailable. */
  readyTimeoutMs?: number
  /** Delay between REST polls when the WebSocket path is unavailable. */
  pollIntervalMs?: number
  /** WebSocket reconnect attempts before falling back to polling for good. */
  maxSocketReconnects?: number
  /** Override the WebSocket constructor (tests). `null` disables sockets. */
  webSocket?: (new (url: string) => WebSocket) | null
  sleep?: (ms: number) => Promise<void>
}

export function managedAgentSocketUrl(
  sessionId: string,
  cursor: number,
  location: { protocol: string; host: string } = globalThis.location,
) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/api/dashboard/managed-agents/sessions/${encodeURIComponent(sessionId)}/connect?role=client&cursor=${cursor}`
}

export class ManagedAgentEventStreamTimeout extends Error {
  constructor() {
    super('Timed out waiting for the agent.')
    this.name = 'ManagedAgentEventStreamTimeout'
  }
}

/**
 * Ordered, de-duplicated feed of a session's events starting after `after`.
 *
 * Prefers the edge WebSocket relay (events arrive the moment the runtime
 * emits them); falls back to REST polling when sockets can't be established.
 * Either way `next()` yields one event at a time in `seq` order.
 */
export class ManagedAgentEventStream {
  private cursor: number
  private readonly queue: ManagedAgentEvent[] = []
  private waiter: {
    resolve: (event: ManagedAgentEvent) => void
    reject: (error: Error) => void
  } | null = null
  private failure: Error | null = null
  private closed = false
  private socket: WebSocket | null = null
  private readonly onAbort = () =>
    this.fail(new DOMException('Aborted', 'AbortError'))

  constructor(
    private readonly sessionId: string,
    after: number,
    private readonly options: ManagedAgentEventStreamOptions,
  ) {
    this.cursor = after
    options.signal?.addEventListener('abort', this.onAbort, { once: true })
    if (options.signal?.aborted) this.onAbort()
    else void this.run()
  }

  /** Highest `seq` delivered so far. */
  get position() {
    return this.cursor
  }

  next(timeoutMs: number): Promise<ManagedAgentEvent> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new Error('Event stream closed.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new ManagedAgentEventStreamTimeout())
      }, timeoutMs)
      this.waiter = {
        resolve: (event) => {
          clearTimeout(timer)
          resolve(event)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.options.signal?.removeEventListener('abort', this.onAbort)
    this.socket?.close(1000, 'done')
    this.socket = null
    this.waiter?.reject(new Error('Event stream closed.'))
    this.waiter = null
  }

  private fail(reason: unknown) {
    if (this.closed) return
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.failure = error
    const waiter = this.waiter
    this.waiter = null
    this.close()
    waiter?.reject(error)
  }

  private deliver(event: ManagedAgentEvent) {
    if (this.closed || event.seq <= this.cursor) return
    this.cursor = event.seq
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter.resolve(event)
    } else {
      this.queue.push(event)
    }
  }

  private async run() {
    const Socket =
      this.options.webSocket === undefined
        ? typeof WebSocket === 'undefined'
          ? null
          : WebSocket
        : this.options.webSocket
    const maxReconnects = this.options.maxSocketReconnects ?? 3
    let attempts = 0
    while (Socket && !this.closed && attempts <= maxReconnects) {
      const outcome = await this.runSocket(Socket)
      if (this.closed) return
      if (outcome === 'unavailable') break
      attempts += 1
      await this.pause(Math.min(250 * 2 ** attempts, 2_000))
    }
    if (!this.closed) await this.runPolling()
  }

  private runSocket(
    Socket: new (url: string) => WebSocket,
  ): Promise<'unavailable' | 'dropped'> {
    return new Promise((resolve) => {
      let ready = false
      let settled = false
      const settle = (outcome: 'unavailable' | 'dropped') => {
        if (settled) return
        settled = true
        clearTimeout(readyTimer)
        if (this.socket === socket) this.socket = null
        resolve(outcome)
      }
      let socket: WebSocket
      try {
        socket = new Socket(managedAgentSocketUrl(this.sessionId, this.cursor))
      } catch {
        resolve('unavailable')
        return
      }
      this.socket = socket
      const readyTimer = setTimeout(() => {
        if (ready || settled) return
        try {
          socket.close(1000, 'ready timeout')
        } catch {
          // Already closed.
        }
        settle('unavailable')
      }, this.options.readyTimeoutMs ?? 5_000)
      socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') return
        let parsed: unknown
        try {
          parsed = JSON.parse(message.data)
        } catch {
          return
        }
        const frame = frameSchema.safeParse(parsed)
        if (!frame.success) return
        if (frame.data.type === 'ready') {
          ready = true
          clearTimeout(readyTimer)
        } else if (frame.data.type === 'event') this.deliver(frame.data.event)
      })
      socket.addEventListener('close', () =>
        settle(ready ? 'dropped' : 'unavailable'),
      )
      socket.addEventListener('error', () =>
        settle(ready ? 'dropped' : 'unavailable'),
      )
    })
  }

  private async runPolling() {
    const { fetchEvents } = this.options
    const interval = this.options.pollIntervalMs ?? 300
    while (!this.closed) {
      try {
        const events = await fetchEvents(
          this.sessionId,
          this.cursor,
          this.options.signal,
        )
        for (const event of events) this.deliver(event)
      } catch (error) {
        if (this.options.signal?.aborted) return
        this.fail(error)
        return
      }
      await this.pause(interval)
    }
  }

  private pause(ms: number) {
    return (this.options.sleep ?? defaultSleep)(ms)
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
