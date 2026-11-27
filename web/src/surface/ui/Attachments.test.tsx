// @vitest-environment happy-dom
// Files on messages (work 126): the composer's chips while they upload, and
// a sent message's chips, over a stubbed surface.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingAttachment } from '@opencomputer/sdk/computer'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SurfaceContext } from '../hooks'
import type { State } from '../store/surface-state'
import type { Surface } from '../store/surface-store'
import type { ItemAttachment } from '../store/transcript'
import { MessageAttachments, SessionScope } from './Attachments'
import { Composer } from './Composer'

const pending = (over: Partial<PendingAttachment>): PendingAttachment => ({
  id: 'at_1',
  sessionId: 'cs_1',
  name: 'photo.png',
  mimetype: 'image/png',
  bytes: 2048,
  state: 'uploading',
  progress: 0.4,
  ...over,
})

let root: Root
let el: HTMLDivElement
let store: StoreApi<State>
let surface: {
  store: typeof store
  setDraft: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  removeAttachment: ReturnType<typeof vi.fn>
  toast: ReturnType<typeof vi.fn>
  client: { attachmentFile: ReturnType<typeof vi.fn>; readAttachment: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  store = createStore<State>(() => ({ drafts: {}, draftAttachments: {}, attachments: [] }) as unknown as State)
  surface = {
    store,
    setDraft: vi.fn((key: string, text: string) => store.setState({ drafts: { ...store.getState().drafts, [key]: text } })),
    attach: vi.fn(),
    removeAttachment: vi.fn(),
    toast: vi.fn(),
    client: { attachmentFile: vi.fn(() => Promise.resolve(undefined)), readAttachment: vi.fn(() => Promise.resolve(new Blob([new Uint8Array(3)]))) },
  }
  // happy-dom has no object URLs.
  URL.createObjectURL = vi.fn(() => 'blob:fake')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

function draw(node: React.ReactNode) {
  act(() =>
    root.render(
      <TooltipProvider>
        <SurfaceContext.Provider value={surface as unknown as Surface}>{node}</SurfaceContext.Provider>
      </TooltipProvider>,
    ),
  )
}

const button = (label: string) => {
  const b = [...el.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === label || x.getAttribute('title') === label)
  if (!b) throw new Error(`no button ${label}`)
  return b
}
const click = (b: HTMLElement) => void act(() => b.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('the composer', () => {
  it('shows a chip per attached file, with its upload, and sends once there is a file even without text', () => {
    const onSend = vi.fn()
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={onSend} />)
    expect(button('Send').hasAttribute('disabled')).toBe(true)
    act(() => store.setState({ attachments: [pending({})], draftAttachments: { 't:cs_1': ['at_1'] } }))
    const chip = el.querySelector('[data-slot=draft-attachments] [data-state]')!
    expect(chip.getAttribute('data-state')).toBe('uploading')
    expect(chip.textContent).toContain('photo.png')
    expect(chip.textContent).toContain('40%')
    expect(chip.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('40')
    expect(button('Send').hasAttribute('disabled')).toBe(false)
    click(button('Send'))
    expect(onSend).toHaveBeenCalledWith('', { meta: false })
  })

  it('shows a ready chip with its size and no progress', () => {
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={() => {}} />)
    act(() => store.setState({ attachments: [pending({ state: 'ready', progress: 1 })], draftAttachments: { 't:cs_1': ['at_1'] } }))
    const chip = el.querySelector('[data-state=ready]')!
    expect(chip.textContent).toContain('2 KB')
    expect(chip.querySelector('[role=progressbar]')).toBeNull()
  })

  it('does not send while a chip has failed, and says why on the chip', () => {
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={() => {}} />)
    act(() =>
      store.setState({
        drafts: { 't:cs_1': 'look' },
        attachments: [pending({ state: 'failed', error: { code: 'attachment_too_large', reason: 'over 100 MB' } })],
        draftAttachments: { 't:cs_1': ['at_1'] },
      }),
    )
    const chip = el.querySelector('[data-state=failed]')!
    expect(chip.textContent).toContain('Failed')
    expect(chip.getAttribute('title')).toBe('photo.png: over 100 MB')
    expect(button('Send').hasAttribute('disabled')).toBe(true)
    click(button('Remove photo.png'))
    expect(surface.removeAttachment).toHaveBeenCalledWith('t:cs_1', 'at_1')
  })

  it('ignores ids the client no longer holds', () => {
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={() => {}} />)
    act(() => store.setState({ attachments: [], draftAttachments: { 't:cs_1': ['at_gone'] } }))
    expect(el.querySelector('[data-slot=draft-attachments]')).toBeNull()
    expect(button('Send').hasAttribute('disabled')).toBe(true)
  })

  it('attaches what is dropped on it, pasted in it, or picked by the paperclip', () => {
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={() => {}} />)
    const file = new File([new Uint8Array(3)], 'a.txt', { type: 'text/plain' })
    const box = el.firstElementChild as HTMLElement
    const transfer = { types: ['Files'], files: [file], dropEffect: 'none' }
    act(() => {
      const drop = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(drop, 'dataTransfer', { value: transfer })
      box.dispatchEvent(drop)
    })
    expect(surface.attach).toHaveBeenLastCalledWith('t:cs_1', [file])

    const textarea = el.querySelector('textarea')!
    act(() => {
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } })
      textarea.dispatchEvent(paste)
    })
    expect(surface.attach).toHaveBeenCalledTimes(2)

    const input = el.querySelector<HTMLInputElement>('input[type=file]')!
    expect(input.multiple).toBe(true)
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(surface.attach).toHaveBeenCalledTimes(3)
  })

  it('draws a thumbnail of a pending image from the local file', async () => {
    surface.client.attachmentFile.mockResolvedValue(new Blob([new Uint8Array(3)], { type: 'image/png' }))
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={() => {}} />)
    act(() => store.setState({ attachments: [pending({})], draftAttachments: { 't:cs_1': ['at_1'] } }))
    await flush()
    expect(surface.client.attachmentFile).toHaveBeenCalledWith('at_1')
    expect(el.querySelector('[data-slot=draft-attachments] img')?.getAttribute('src')).toBe('blob:fake')
  })
})

describe("a message's attachments", () => {
  const image: ItemAttachment = { id: 'at_img', name: 'shot.png', mimetype: 'image/png', bytes: 100 }
  const big: ItemAttachment = { id: 'at_big', name: 'huge.png', mimetype: 'image/png', bytes: 6 * 1024 * 1024 }
  const doc: ItemAttachment = { id: 'at_doc', name: 'notes.pdf', mimetype: 'application/pdf', bytes: 3 * 1024 * 1024 }

  it('reads an image through the client, with the credential, and shows it; a big one and a file are chips', async () => {
    draw(
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[image, big, doc]} sending={false} />
      </SessionScope>,
    )
    await flush()
    expect(surface.client.readAttachment).toHaveBeenCalledWith('cs_7', 'at_img')
    expect(surface.client.readAttachment).toHaveBeenCalledTimes(1)
    expect(el.querySelector('img')?.getAttribute('src')).toBe('blob:fake')
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('shot.png')
    const chips = [...el.querySelectorAll('button')].map((b) => b.textContent)
    expect(chips.some((t) => t?.includes('huge.png') && t.includes('6 MB'))).toBe(true)
    expect(chips.some((t) => t?.includes('notes.pdf') && t.includes('3 MB'))).toBe(true)
  })

  it('opens the image full size on click, and downloads a file on click', async () => {
    draw(
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[image, doc]} sending={false} />
      </SessionScope>,
    )
    await flush()
    click(button('Open shot.png'))
    expect(document.querySelector('[role=dialog] img')?.getAttribute('alt')).toBe('shot.png')

    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    click(button('Download notes.pdf'))
    await flush()
    expect(surface.client.readAttachment).toHaveBeenLastCalledWith('cs_7', 'at_doc')
    expect(clicked).toHaveBeenCalledTimes(1)
    clicked.mockRestore()
  })

  it('shows the upload of a message still being sent', () => {
    draw(
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[{ ...doc, progress: 0.25, upload: 'uploading' }]} sending />
      </SessionScope>,
    )
    expect(el.textContent).toContain('25%')
    expect(el.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('25')
    expect(surface.client.readAttachment).not.toHaveBeenCalled()
  })
})
