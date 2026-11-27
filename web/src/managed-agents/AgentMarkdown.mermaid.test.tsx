// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}))
vi.mock('mermaid', () => ({ default: mermaid }))

const { AgentMarkdown } = await import('./AgentMarkdown')
const { RENDER_DELAY_MS } = await import('./MermaidBlock')
const { isFenceClosed } = await import('./mermaid')
const { useTheme } = await import('@/hooks/useTheme')

describe('isFenceClosed', () => {
  it('needs a closing fence of the same kind, at least as long', () => {
    expect(isFenceClosed('```mermaid\ngraph TD\n```')).toBe(true)
    expect(isFenceClosed('````mermaid\na\n`````')).toBe(true)
    expect(isFenceClosed('~~~mermaid\na\n~~~')).toBe(true)
    expect(isFenceClosed('```mermaid\ngraph TD')).toBe(false)
    expect(isFenceClosed('```mermaid\ngraph TD\n``')).toBe(false)
    expect(isFenceClosed('````mermaid\na\n```')).toBe(false)
    expect(isFenceClosed('```mermaid\na\n~~~')).toBe(false)
    expect(isFenceClosed('```mermaid')).toBe(false)
  })

  it('allows blockquote markers and list indentation', () => {
    expect(isFenceClosed('> ```mermaid\n> a\n> ```')).toBe(true)
    expect(isFenceClosed('```mermaid\n   a\n   ```')).toBe(true)
  })
})

describe('mermaid blocks in AgentMarkdown', () => {
  let container: HTMLDivElement
  let root: Root
  let setDark: (dark: boolean) => void
  let n = 0
  // Rendered diagrams are cached by source, so each test draws its own.
  let graph: string

  function ThemeHandle() {
    setDark = useTheme().setDark
    return null
  }

  function show(text: string) {
    act(() =>
      root.render(
        <>
          <ThemeHandle />
          <AgentMarkdown>{text}</AgentMarkdown>
        </>,
      ),
    )
  }

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS + 10)
    })
  }

  const diagram = () =>
    container.querySelector('[data-testid="mermaid-diagram"]')

  beforeEach(() => {
    vi.useFakeTimers()
    graph = `graph TD\n  A${++n} --> B`
    mermaid.initialize.mockReset()
    mermaid.render.mockReset()
    mermaid.render.mockImplementation((id: string) =>
      Promise.resolve({ svg: `<svg id="${id}"><text>drawn</text></svg>` }),
    )
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    document.documentElement.classList.remove('dark')
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('shows the code while the fence is still open, and draws once it closes', async () => {
    show(`Here:\n\n\`\`\`mermaid\n${graph}`)
    await settle()
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(container.querySelector('pre')?.textContent).toContain('A' + n)

    show(`Here:\n\n\`\`\`mermaid\n${graph}\n\`\`\``)
    await settle()
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(mermaid.render.mock.calls[0][1]).toBe(`${graph}\n`)
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', theme: 'default' }),
    )
    expect(diagram()?.innerHTML).toContain('drawn')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('draws once while the text after the block keeps streaming', async () => {
    const block = `\`\`\`mermaid\n${graph}\n\`\`\`\n\n`
    show(block + 'Th')
    show(block + 'The')
    show(block + 'The diagram')
    await settle()
    show(block + 'The diagram shows')
    await settle()
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(diagram()).not.toBeNull()
  })

  it('falls back to the code with a note when the diagram is invalid', async () => {
    mermaid.render.mockRejectedValue(
      new Error('Parse error on line 2:\n...caret drawing...'),
    )
    show(`\`\`\`mermaid\n${graph}\n\`\`\``)
    await settle()
    expect(diagram()).toBeNull()
    expect(container.querySelector('pre')?.textContent).toContain('A' + n)
    expect(container.textContent).toContain(
      "Couldn't draw this diagram: Parse error on line 2",
    )
    expect(container.textContent).not.toContain('caret drawing')
  })

  it('draws again in the dark theme when the theme changes', async () => {
    show(`\`\`\`mermaid\n${graph}\n\`\`\``)
    await settle()
    act(() => setDark(true))
    // The light diagram stays up until the dark one is drawn.
    expect(diagram()).not.toBeNull()
    await settle()
    expect(mermaid.render).toHaveBeenCalledTimes(2)
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ securityLevel: 'strict', theme: 'dark' }),
    )
    act(() => setDark(false))
  })

  it('copies the diagram source, drawn or not', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    show(`\`\`\`mermaid\n${graph}\n\`\`\``)
    const copy = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy diagram source"]',
      )
    expect(copy()).not.toBeNull()
    await settle()
    expect(diagram()).not.toBeNull()
    act(() => copy()?.click())
    await act(() => Promise.resolve())
    expect(writeText).toHaveBeenCalledWith(graph)
  })

  it('leaves other code blocks alone', async () => {
    show('```ts\nconst a = 1\n```')
    await settle()
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(container.querySelector('pre')?.textContent).toContain('const a')
    expect(container.querySelector('button')).toBeNull()
  })
})
