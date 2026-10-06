import type { UIMessageChunk } from 'ai'

type TextChunk = Extract<
  UIMessageChunk,
  { type: 'text-delta' } | { type: 'reasoning-delta' }
>

function isTextChunk(chunk: UIMessageChunk): chunk is TextChunk {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
}

export type ChunkPacerOptions = {
  /** Tick cadence; one visual update per tick. */
  intervalMs?: number
  /** How quickly a backlog should be drained. Bigger = smoother but laggier. */
  catchUpMs?: number
  /** Never emit fewer than this many characters per tick while text is pending. */
  minCharsPerTick?: number
}

/**
 * Re-times `UIMessageChunk`s so text and reasoning arrive as a steady trickle
 * rather than in the bursts the network delivers them in.
 *
 * Text deltas are merged into one pending run per part and released a few
 * characters per tick; the per-tick amount scales with the backlog so the
 * display never falls more than ~`catchUpMs` behind the source. Every other
 * chunk keeps its position relative to the text around it, so tool calls still
 * show up exactly where they happened in the transcript.
 */
export class UIMessageChunkPacer {
  private readonly queue: UIMessageChunk[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private drainWaiters: Array<() => void> = []
  private readonly intervalMs: number
  private readonly catchUpMs: number
  private readonly minCharsPerTick: number

  constructor(
    private readonly sink: (chunk: UIMessageChunk) => void,
    options: ChunkPacerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 16
    this.catchUpMs = options.catchUpMs ?? 320
    this.minCharsPerTick = options.minCharsPerTick ?? 2
  }

  get pending() {
    return this.queue.length > 0
  }

  push(chunk: UIMessageChunk) {
    if (this.disposed) return
    if (isTextChunk(chunk)) {
      if (chunk.delta.length === 0) return
      const tail = this.queue[this.queue.length - 1]
      if (tail && isTextChunk(tail) && tail.type === chunk.type && tail.id === chunk.id) {
        this.queue[this.queue.length - 1] = {
          ...tail,
          delta: tail.delta + chunk.delta,
        }
      } else {
        this.queue.push({ ...chunk })
      }
      this.schedule()
      return
    }
    if (this.queue.length === 0) {
      this.sink(chunk)
      return
    }
    this.queue.push(chunk)
  }

  /** Resolves once the queue has been paced out (or the pacer is disposed). */
  drain(): Promise<void> {
    if (this.queue.length === 0 || this.disposed) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.push(resolve))
  }

  /** Emit everything still queued, immediately and in order. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.queue.length > 0) {
      const chunk = this.queue.shift()!
      this.sink(chunk)
    }
    this.settleDrain()
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue.length = 0
    this.settleDrain()
  }

  private settleDrain() {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  private schedule() {
    if (this.timer || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
    }, this.intervalMs)
  }

  private tick() {
    if (this.disposed) return
    const head = this.queue[0]
    if (head && isTextChunk(head)) {
      const ticksToCatchUp = Math.max(1, this.catchUpMs / this.intervalMs)
      const take = Math.max(
        this.minCharsPerTick,
        Math.ceil(head.delta.length / ticksToCatchUp),
      )
      const piece = sliceGraphemes(head.delta, take)
      const rest = head.delta.slice(piece.length)
      if (rest.length === 0) this.queue.shift()
      else this.queue[0] = { ...head, delta: rest }
      this.sink({ ...head, delta: piece })
    }
    while (this.queue.length > 0 && !isTextChunk(this.queue[0])) {
      this.sink(this.queue.shift()!)
    }
    if (this.queue.length > 0) this.schedule()
    else this.settleDrain()
  }
}

// Avoid splitting surrogate pairs (emoji etc.) across ticks.
function sliceGraphemes(text: string, count: number) {
  let end = Math.min(count, text.length)
  if (end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end += 1
  }
  return text.slice(0, end)
}
