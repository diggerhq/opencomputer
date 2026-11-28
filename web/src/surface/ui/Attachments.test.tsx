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
let objectUrl: ReturnType<typeof vi.fn<(b: Blob) => string>>
let el: HTMLDivElement
let store: StoreApi<State>
let surface: {
  store: typeof store
  setDraft: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  removeAttachment: ReturnType<typeof vi.fn>
  toast: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
  // The bytes of what was attached in this page, by id.
  attachmentBlob: ReturnType<typeof vi.fn<(id: string) => Blob | undefined>>
  host: { platform: 'web' | 'desktop' }
  client: { attachmentUrl: ReturnType<typeof vi.fn<(sid: string, id: string, o?: { download?: boolean }) => Promise<string>>> }
}

beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  store = createStore<State>(() => ({ drafts: {}, draftAttachments: {}, attachments: [], canAttach: true }) as unknown as State)
  surface = {
    store,
    setDraft: vi.fn((key: string, text: string) => store.setState({ drafts: { ...store.getState().drafts, [key]: text } })),
    attach: vi.fn(),
    removeAttachment: vi.fn(),
    toast: vi.fn(),
    openExternal: vi.fn(),
    attachmentBlob: vi.fn(() => undefined),
    host: { platform: 'web' },
    client: { attachmentUrl: vi.fn((sid, id, o) => Promise.resolve(`https://store.test/${sid}/${id}${o?.download ? '?download' : ''}`)) },
  }
  // happy-dom has no object URLs.
  objectUrl = vi.fn(() => 'blob:fake')
  URL.createObjectURL = objectUrl
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

    const text = el.querySelector<HTMLElement>('[data-draft="t:cs_1"]')!
    act(() => {
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } })
      text.dispatchEvent(paste)
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

  it('draws a thumbnail of a pending image from the file this page holds', () => {
    surface.attachmentBlob.mockReturnValue(new Blob([new Uint8Array(3)], { type: 'image/png' }))
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={() => {}} />)
    act(() => store.setState({ attachments: [pending({})], draftAttachments: { 't:cs_1': ['at_1'] } }))
    expect(surface.attachmentBlob).toHaveBeenCalledWith('at_1')
    expect(el.querySelector('[data-slot=draft-attachments] img')?.getAttribute('src')).toBe('blob:fake')
  })

  it('shows a plain chip after a reload, and why an interrupted upload failed', () => {
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={() => {}} />)
    const lost = pending({ id: 'at_2', name: 'cut.png', state: 'failed', progress: 0, error: { code: 'attachment_lost', reason: 'the upload was interrupted: attach the file again' } })
    act(() => store.setState({ attachments: [pending({ state: 'ready', progress: 1 }), lost], draftAttachments: { 't:cs_1': ['at_1', 'at_2'] } }))
    expect(el.querySelector('[data-slot=draft-attachments] img')).toBeNull()
    expect(el.querySelector('[data-state=ready]')?.textContent).toContain('photo.png')
    expect(el.querySelector('[data-state=failed]')?.getAttribute('title')).toBe('cut.png: the upload was interrupted: attach the file again')
    expect(button('Send').hasAttribute('disabled')).toBe(true)
  })

  it('has no paperclip and ignores a dropped or pasted file where files cannot be attached', () => {
    act(() => store.setState({ canAttach: false }))
    draw(<Composer draftKey="t:cs_1" placeholder="Reply" onSend={() => {}} />)
    expect([...el.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Attach files')).toBe(false)
    expect(el.querySelector('input[type=file]')).toBeNull()
    const file = new File([new Uint8Array(3)], 'a.txt', { type: 'text/plain' })
    const box = el.firstElementChild as HTMLElement
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    act(() => {
      Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [file], dropEffect: 'none' } })
      box.dispatchEvent(drop)
    })
    // Still taken from the browser, which would open the file.
    expect(drop.defaultPrevented).toBe(true)
    expect(box.hasAttribute('data-dragging')).toBe(false)
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    act(() => {
      Object.defineProperty(paste, 'clipboardData', { value: { files: [file], getData: () => '' } })
      el.querySelector('[data-draft="t:cs_1"]')!.dispatchEvent(paste)
    })
    // CodeMirror takes every paste as text; with no text, nothing lands.
    expect(surface.setDraft).not.toHaveBeenCalled()
    expect(surface.attach).not.toHaveBeenCalled()
  })
})

describe("a message's attachments", () => {
  const image: ItemAttachment = { id: 'at_img', name: 'shot.png', mimetype: 'image/png', bytes: 100 }
  const big: ItemAttachment = { id: 'at_big', name: 'huge.png', mimetype: 'image/png', bytes: 6 * 1024 * 1024 }
  const doc: ItemAttachment = { id: 'at_doc', name: 'notes.pdf', mimetype: 'application/pdf', bytes: 3 * 1024 * 1024 }

  it("shows a sent image straight from its signed URL, lazily, in a box of a fixed size; a big one and a file are chips", async () => {
    draw(
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[image, big, doc]} sending={false} />
      </SessionScope>,
    )
    // Before the URL: a placeholder of the picture's size.
    const box = el.querySelector('[title="shot.png"]')!
    expect(box.className).toContain('h-36 w-48')
    await flush()
    expect(surface.client.attachmentUrl).toHaveBeenCalledWith('cs_7', 'at_img')
    expect(surface.client.attachmentUrl).toHaveBeenCalledTimes(1)
    const img = el.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://store.test/cs_7/at_img')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('alt')).toBe('shot.png')
    expect(button('Open shot.png').className).toContain('h-36 w-48')
    // Nothing was pulled into the page.
    expect(objectUrl).not.toHaveBeenCalled()
    const chips = [...el.querySelectorAll('button')].map((b) => b.textContent)
    expect(chips.some((t) => t?.includes('huge.png') && t.includes('6 MB'))).toBe(true)
    expect(chips.some((t) => t?.includes('notes.pdf') && t.includes('3 MB'))).toBe(true)
  })

  it('opens the image full size on click, and downloads a file by its signed URL', async () => {
    draw(
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[image, doc]} sending={false} />
      </SessionScope>,
    )
    await flush()
    click(button('Open shot.png'))
    expect(document.querySelector('[role=dialog] img')?.getAttribute('alt')).toBe('shot.png')

    const hrefs: string[] = []
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(`${this.href} ${this.download}`)
    })
    click(button('Download notes.pdf'))
    await flush()
    expect(surface.client.attachmentUrl).toHaveBeenLastCalledWith('cs_7', 'at_doc', { download: true })
    expect(hrefs).toEqual(['https://store.test/cs_7/at_doc?download notes.pdf'])
    expect(objectUrl).not.toHaveBeenCalled()
    clicked.mockRestore()
  })

  it('hands a download to the browser in the Mac app, which does not navigate', async () => {
    surface.host.platform = 'desktop'
    draw(
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[doc]} sending={false} />
      </SessionScope>,
    )
    click(button('Download notes.pdf'))
    await flush()
    expect(surface.openExternal).toHaveBeenCalledWith('https://store.test/cs_7/at_doc?download')
  })

  it('shows the upload of a message still being sent', () => {
    draw(
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[{ ...doc, progress: 0.25, upload: 'uploading' }]} sending />
      </SessionScope>,
    )
    expect(el.textContent).toContain('25%')
    expect(el.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('25')
    expect(surface.client.attachmentUrl).not.toHaveBeenCalled()
  })

  it('shows an image being sent from the file this page holds, and keeps it once sent, asking nothing', async () => {
    surface.attachmentBlob.mockReturnValue(new Blob([new Uint8Array(3)], { type: 'image/png' }))
    const view = (sending: boolean) => (
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[sending ? { ...image, progress: 0.5, upload: 'uploading' } : image]} sending={sending} />
      </SessionScope>
    )
    draw(view(true))
    expect(el.querySelector('img')?.getAttribute('src')).toBe('blob:fake')
    expect(el.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('50')
    // Accepted: the page has let go of the file, the picture stays as it is.
    surface.attachmentBlob.mockReturnValue(undefined)
    draw(view(false))
    await flush()
    expect(el.querySelector('img')?.getAttribute('src')).toBe('blob:fake')
    expect(el.querySelector('[role=progressbar]')).toBeNull()
    expect(surface.client.attachmentUrl).not.toHaveBeenCalled()
    expect(objectUrl).toHaveBeenCalledTimes(1)
  })

  it('shows a placeholder for an image being sent whose file this page no longer has, then the signed URL', async () => {
    const view = (sending: boolean) => (
      <SessionScope sid="cs_7">
        <MessageAttachments attachments={[sending ? { ...image, progress: 1, upload: 'ready' } : image]} sending={sending} />
      </SessionScope>
    )
    draw(view(true))
    await flush()
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[title="shot.png"]')?.className).toContain('h-36 w-48')
    expect(surface.client.attachmentUrl).not.toHaveBeenCalled()
    draw(view(false))
    await flush()
    expect(el.querySelector('img')?.getAttribute('src')).toBe('https://store.test/cs_7/at_img')
    expect(surface.client.attachmentUrl).toHaveBeenCalledTimes(1)
  })
})
