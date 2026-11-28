// @vitest-environment happy-dom
// The composer's text (MarkdownInput): what Enter does where, and a draft
// that changes from outside.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { MarkdownInput } from './MarkdownInput'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function draw(value: string, on: { onChange?: (t: string) => void; onSend?: (e: { meta: boolean }) => void } = {}) {
  act(() =>
    root.render(
      <MarkdownInput
        draftKey="t:cs_1"
        placeholder="Reply"
        value={value}
        onChange={on.onChange ?? (() => {})}
        onSend={on.onSend ?? (() => {})}
        onFiles={() => {}}
      />,
    ),
  )
  return EditorView.findFromDOM(el.querySelector<HTMLElement>('[data-draft="t:cs_1"]')!)!
}

const key = (view: EditorView, k: string, mods: KeyboardEventInit = {}) =>
  act(() => {
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }))
  })

describe('the composer text', () => {
  it('sends on Enter, and says when ⌘ was held', () => {
    const onSend = vi.fn()
    const view = draw('hello', { onSend })
    key(view, 'Enter')
    expect(onSend).toHaveBeenLastCalledWith({ meta: false })
    key(view, 'Enter', { metaKey: true })
    expect(onSend).toHaveBeenLastCalledWith({ meta: true })
    expect(view.state.doc.toString()).toBe('hello')
  })

  it('takes Shift+Enter as a newline that continues a list', () => {
    const onChange = vi.fn()
    const onSend = vi.fn()
    const view = draw('- one', { onChange, onSend })
    key(view, 'Enter', { shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenLastCalledWith('- one\n- ')
  })

  it('numbers the next item, and ends the list on an empty one', () => {
    const view = draw('1. one')
    key(view, 'Enter', { shiftKey: true })
    expect(view.state.doc.toString()).toBe('1. one\n2. ')
    key(view, 'Enter', { shiftKey: true })
    expect(view.state.doc.toString()).toBe('1. one\n')
  })

  it('takes Enter inside a code block as a newline, and sends after its closing fence', () => {
    const onSend = vi.fn()
    const view = draw('```ts\nconst a = 1', { onSend })
    key(view, 'Enter')
    expect(onSend).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('```ts\nconst a = 1\n')
    act(() => view.dispatch(view.state.replaceSelection('```')))
    key(view, 'Enter')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('follows the draft when it changes from outside, without echoing it back', () => {
    const onChange = vi.fn()
    const view = draw('typed', { onChange })
    draw('', { onChange })
    expect(view.state.doc.toString()).toBe('')
    draw('from the other tab', { onChange })
    expect(view.state.doc.toString()).toBe('from the other tab')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the editor, and so the focus, when the placeholder changes', () => {
    const view = draw('hi')
    act(() =>
      root.render(
        <MarkdownInput draftKey="t:cs_1" placeholder="Reply · the agent reads it" value="hi" onChange={() => {}} onSend={() => {}} onFiles={() => {}} />,
      ),
    )
    expect(EditorView.findFromDOM(el.querySelector<HTMLElement>('[data-draft="t:cs_1"]')!)).toBe(view)
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Reply · the agent reads it')
  })

  it('formats inline code and code blocks as they are typed', () => {
    draw('a `b` c\n```\nx\n```')
    expect(el.querySelector('.cm-md-code')?.textContent).toBe('`b`')
    expect(el.querySelectorAll('.cm-md-fence')).toHaveLength(3)
  })
})
