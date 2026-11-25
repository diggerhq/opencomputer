// The one socket's fan-out (spec sections 24.1, 42.3). Each window says what
// it watches (`subs`); this decides which windows a pushed frame goes to, and
// which of a window's frames reach the socket. It reads `t`, `stream` and
// `session` and nothing else: cursors are the page's.
import type { Frame } from '../shared/bridge'

export class Router<W> {
  private subs = new Map<W, Set<string>>()
  /** Windows that sent `hello` on the socket that is open now. */
  private greeted = new Set<W>()
  private ready: Frame | null = null

  setSubs(w: W, streams: string[]): void {
    this.subs.set(w, new Set(streams))
  }

  remove(w: W): string[] {
    const streams = [...(this.subs.get(w) ?? [])]
    this.subs.delete(w)
    this.greeted.delete(w)
    return streams.filter((s) => !this.watched(s))
  }

  /** The socket closed: the next `hello` of each window starts over. */
  closed(): void {
    this.greeted.clear()
    this.ready = null
  }

  private watched(stream: string, except?: W): boolean {
    for (const [w, set] of this.subs) if (w !== except && set.has(stream)) return true
    return false
  }

  /**
   * A frame from a window. `forward`: send it on the socket. `reply`: answer
   * the window with this frame instead (a second window's `hello` gets the
   * `ready` the first one was given, since the socket says hello once).
   */
  outgoing(w: W, frame: Frame): { forward: boolean; reply?: Frame } {
    if (frame.t === 'hello') {
      const first = this.greeted.size === 0
      this.greeted.add(w)
      if (first) return { forward: true }
      return this.ready ? { forward: false, reply: this.ready } : { forward: false }
    }
    if (frame.t === 'sub' && typeof frame.stream === 'string') {
      const set = this.subs.get(w) ?? new Set<string>()
      set.add(frame.stream)
      this.subs.set(w, set)
      return { forward: true }
    }
    if (frame.t === 'unsub' && typeof frame.stream === 'string') {
      this.subs.get(w)?.delete(frame.stream)
      // Another window still watches it: the socket stays subscribed.
      return { forward: !this.watched(frame.stream, w) }
    }
    return { forward: true }
  }

  /** The windows a frame from the socket goes to. */
  incoming(frame: Frame): W[] {
    if (frame.t === 'ready') this.ready = frame
    const stream = streamOf(frame)
    if (stream === null) return [...new Set([...this.greeted, ...this.subs.keys()])]
    const to: W[] = []
    for (const [w, set] of this.subs) if (set.has(stream)) to.push(w)
    return to
  }
}

function streamOf(frame: Frame): string | null {
  if (frame.t === 'feed') return 'feed'
  if (frame.t === 'events' && typeof frame.session === 'string') return `events:${frame.session}`
  if (frame.t === 'delta' && typeof frame.session === 'string') return `deltas:${frame.session}`
  if (typeof frame.stream === 'string') return frame.stream
  return null
}
