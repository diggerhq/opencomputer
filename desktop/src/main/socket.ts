// The app's one socket (spec sections 18.7, 24.1, 38): held here, in the main
// process, authenticated by the token in the subprotocol offer, and relayed
// to the windows. A page sees a channel, never a socket or a token.
import type { Frame } from '../shared/bridge'

export type SocketDeps = {
  url: string // wss://…/live
  token(): Promise<string | null>
  invalidate(token: string): void
  /** Milliseconds until the token should be renewed on the open socket. */
  renewIn(): number | null
  onFrame(frame: Frame): void
  onState(state: 'open' | 'closed'): void
  WebSocket?: typeof WebSocket
  /** For tests: the reconnect delay for an attempt. */
  delay?: (attempt: number) => number
}

/** Section 38.3, step 6: a random delay within 1 to 5 s, doubling to 60 s. */
export function reconnectDelay(attempt: number, random = Math.random()): number {
  return Math.min(60_000, (1000 + random * 4000) * 2 ** attempt)
}

export class LiveSocket {
  private ws: WebSocket | null = null
  private open = false
  private wanted = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private renewTimer: ReturnType<typeof setTimeout> | null = null
  private token: string | null = null

  constructor(private deps: SocketDeps) {}

  get state(): 'open' | 'closed' {
    return this.open ? 'open' : 'closed'
  }

  start(): void {
    if (this.wanted) return
    this.wanted = true
    void this.connect()
  }

  stop(): void {
    this.wanted = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.drop()
  }

  /** Reconnect now (the machine woke, the network came back). */
  kick(): void {
    if (!this.wanted || this.open || this.ws) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    void this.connect()
  }

  /** Frames sent while the socket is closed are dropped: on `open` a page starts from `hello` again. */
  send(frame: Frame): void {
    if (this.open) this.ws?.send(JSON.stringify(frame))
  }

  private drop(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer)
    this.renewTimer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close()
      } catch {
        // already closed
      }
    }
    if (this.open) {
      this.open = false
      this.deps.onState('closed')
    }
  }

  private retry(): void {
    this.drop()
    if (!this.wanted || this.timer) return
    const ms = (this.deps.delay ?? reconnectDelay)(this.attempt++)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, ms)
  }

  private async connect(): Promise<void> {
    if (!this.wanted || this.ws) return
    const token = await this.deps.token()
    if (!this.wanted || this.ws) return
    if (!token) return this.retry()
    this.token = token
    const WS = this.deps.WebSocket ?? WebSocket
    // Tokens never ride in a URL (section 18.7): the second subprotocol carries it.
    const ws = new WS(this.deps.url, ['oc.live.v1', `oc.bearer.${token}`])
    this.ws = ws
    ws.onopen = () => {
      this.open = true
      this.attempt = 0
      this.deps.onState('open')
      this.scheduleRenew()
    }
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      let frame: Frame
      try {
        frame = JSON.parse(e.data) as Frame
      } catch {
        return
      }
      if (frame && typeof frame.t === 'string') this.deps.onFrame(frame)
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      // 4001: unauthenticated or expired. The next attempt takes a fresh token.
      if (e.code === 4001 && this.token) this.deps.invalidate(this.token)
      this.retry()
    }
    ws.onerror = () => {
      // A close follows.
    }
  }

  /** Renews the credential on the open socket with an `auth` frame before it expires (section 38.1). */
  private scheduleRenew(): void {
    const ms = this.deps.renewIn()
    if (ms === null) return
    this.renewTimer = setTimeout(async () => {
      const token = await this.deps.token()
      if (!this.open) return
      if (token && token !== this.token) {
        this.token = token
        this.ws?.send(JSON.stringify({ t: 'auth', token }))
      }
      this.scheduleRenew()
    }, Math.max(ms, 5_000))
  }
}
