import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { UIMessageChunkPacer } from './chunk-pacer'

function collect() {
  const out: UIMessageChunk[] = []
  return { out, sink: (chunk: UIMessageChunk) => out.push(chunk) }
}

const text = (out: UIMessageChunk[]) =>
  out
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => (chunk as { delta: string }).delta)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('UIMessageChunkPacer', () => {
  it('trickles a burst out over several ticks and scales with backlog', () => {
    const { out, sink } = collect()
    const pacer = new UIMessageChunkPacer(sink, { intervalMs: 10, catchUpMs: 40 })
    pacer.push({ type: 'text-start', id: 't' })
    pacer.push({ type: 'text-delta', id: 't', delta: 'abcd' })
    pacer.push({ type: 'text-delta', id: 't', delta: 'efgh' })
    expect(out.map((c) => c.type)).toEqual(['text-start'])

    vi.advanceTimersByTime(10)
    // 8 chars / 4 ticks = 2 per tick, easing down to the 2-char floor
    expect(text(out)).toEqual(['ab'])
    vi.advanceTimersByTime(30)
    expect(text(out)).toEqual(['ab', 'cd', 'ef', 'gh'])
    expect(pacer.pending).toBe(false)
  })

  it('keeps non-text chunks in order relative to the text around them', () => {
    const { out, sink } = collect()
    const pacer = new UIMessageChunkPacer(sink, { intervalMs: 10, catchUpMs: 10 })
    pacer.push({ type: 'text-delta', id: 't', delta: 'one' })
    pacer.push({
      type: 'tool-input-available',
      toolCallId: 'c',
      toolName: 'x',
      input: {},
    })
    pacer.push({ type: 'text-delta', id: 't', delta: 'two' })
    expect(out).toEqual([])

    vi.advanceTimersByTime(10)
    expect(out.map((c) => c.type)).toEqual(['text-delta', 'tool-input-available'])
    expect(text(out)).toEqual(['one'])
    vi.advanceTimersByTime(10)
    expect(text(out)).toEqual(['one', 'two'])
  })

  it('emits non-text chunks immediately when nothing is queued', () => {
    const { out, sink } = collect()
    const pacer = new UIMessageChunkPacer(sink)
    pacer.push({ type: 'start', messageId: 'm' })
    expect(out.map((c) => c.type)).toEqual(['start'])
  })

  it('never splits a surrogate pair', () => {
    const { out, sink } = collect()
    const pacer = new UIMessageChunkPacer(sink, {
      intervalMs: 10,
      catchUpMs: 10,
      minCharsPerTick: 1,
    })
    pacer.push({ type: 'text-delta', id: 't', delta: '😀x' })
    vi.advanceTimersByTime(10)
    expect(text(out).join('')).toBe('😀x')

    const slow = new UIMessageChunkPacer(sink, { intervalMs: 10, catchUpMs: 1_000 })
    out.length = 0
    slow.push({ type: 'text-delta', id: 't', delta: '😀x' })
    vi.advanceTimersByTime(10)
    expect(text(out)).toEqual(['😀'])
  })

  it('drain resolves once paced out, flush dumps everything at once', async () => {
    const { out, sink } = collect()
    const pacer = new UIMessageChunkPacer(sink, { intervalMs: 10, catchUpMs: 1_000 })
    pacer.push({ type: 'text-delta', id: 't', delta: 'hello world' })
    let drained = false
    void pacer.drain().then(() => {
      drained = true
    })
    vi.advanceTimersByTime(30)
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(text(out).join('')).toBe('hello ')

    pacer.flush()
    await Promise.resolve()
    expect(drained).toBe(true)
    expect(text(out).join('')).toBe('hello world')
    expect(pacer.pending).toBe(false)
  })

  it('drops queued output after dispose', () => {
    const { out, sink } = collect()
    const pacer = new UIMessageChunkPacer(sink, { intervalMs: 10 })
    pacer.push({ type: 'text-delta', id: 't', delta: 'late' })
    pacer.dispose()
    vi.advanceTimersByTime(100)
    pacer.push({ type: 'finish' })
    expect(out).toEqual([])
  })
})
