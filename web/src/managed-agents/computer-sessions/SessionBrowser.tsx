import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { ArrowLeft, ArrowRight, Loader2, RotateCw, X } from 'lucide-react'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import { mintTerminalTicket, resumeSession } from '../computer-sessions-api'
import {
  keyInput,
  modifiers,
  openBrowser,
  type BrowserConnection,
  type BrowserInput,
  type BrowserPageState,
} from './browser-wire'
import type { TerminalState } from './terminal-wire'
import type { SidebarTabProps } from './sidebar-tabs'

/** How long Wake waits for the session's computer before trying again. */
const WAKE_RETRY_MS = 3_000
/** Frames are rendered at most at this density, to bound their size. */
const MAX_DPR = 2

const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = {
  0: 'left',
  1: 'middle',
  2: 'right',
}

/** Paste stays with the dashboard, which sends the clipboard's text. */
const keepKey = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && e.key === 'v'

function ticketError(e: unknown): Error {
  if (e instanceof ApiError && e.status === 403)
    return new Error(
      'Only people who may drive this session can use its browser.',
    )
  if (e instanceof ApiError && e.status === 404)
    return new Error('This session does not exist or is not shared with you.')
  return e instanceof Error ? e : new Error('Could not open the browser.')
}

// The sidebar's Browser tab: the session's headless Chromium, streamed as JPEG
// frames over the wire (browser-wire.ts). The page is laid out at this tab's
// size, so resizing the sidebar resizes the page; mouse, wheel, keys and
// paste go to it while the page has focus.
export function SessionBrowser({ sessionId: id }: SidebarTabProps) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const conn = useRef<BrowserConnection | null>(null)
  const viewport = useRef({ width: 0, height: 0, dpr: 1 })
  const [state, setState] = useState<TerminalState>({ kind: 'connecting' })
  const [page, setPage] = useState<BrowserPageState | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [waking, setWaking] = useState(false)
  const [dial, setDial] = useState(0)

  useEffect(() => {
    const el = box.current
    const cv = canvas.current
    if (!el || !cv) return
    const measure = () => ({
      width: Math.max(100, Math.round(el.clientWidth)),
      height: Math.max(100, Math.round(el.clientHeight)),
      dpr: Math.min(MAX_DPR, window.devicePixelRatio || 1),
    })
    viewport.current = measure()
    let drawing = false
    let next: Uint8Array<ArrayBuffer> | null = null
    // Draw the newest frame only: one that arrives while another decodes replaces any waiting.
    const draw = async (jpeg: Uint8Array<ArrayBuffer>) => {
      if (drawing) return void (next = jpeg)
      drawing = true
      try {
        const bmp = await createImageBitmap(
          new Blob([jpeg], { type: 'image/jpeg' }),
        )
        if (cv.width !== bmp.width) cv.width = bmp.width
        if (cv.height !== bmp.height) cv.height = bmp.height
        cv.getContext('2d')?.drawImage(bmp, 0, 0)
        bmp.close()
      } catch {
        // A frame that does not decode is skipped.
      } finally {
        drawing = false
        const n = next
        next = null
        if (n) void draw(n)
      }
    }
    const c = openBrowser(
      {
        sessionId: id,
        viewport: viewport.current,
        ticket: () =>
          mintTerminalTicket(id).catch((e: unknown) =>
            Promise.reject(ticketError(e)),
          ),
      },
      {
        onState: (s) => {
          setState(s)
          if (s.kind === 'open') cv.focus()
        },
        onPage: (p) => {
          setPage(p)
          setPageError(null)
        },
        onFrame: (jpeg) => void draw(jpeg),
        onError: setPageError,
      },
    )
    conn.current = c
    let pending: ReturnType<typeof setTimeout> | undefined
    // A hidden tab or closed sidebar has no size: keep the last one.
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      clearTimeout(pending)
      pending = setTimeout(() => {
        const v = measure()
        const old = viewport.current
        if (
          v.width === old.width &&
          v.height === old.height &&
          v.dpr === old.dpr
        )
          return
        viewport.current = v
        c.send({ t: 'viewport', ...v })
      }, 150)
    })
    observer.observe(el)
    // React's wheel handlers are passive; the page scrolls, not the dashboard.
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = point(cv, e)
      c.send({
        t: 'mouse',
        type: 'mouseWheel',
        ...p,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        modifiers: modifiers(e),
      })
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => {
      clearTimeout(pending)
      observer.disconnect()
      cv.removeEventListener('wheel', wheel)
      c.close()
      conn.current = null
    }
  }, [id, dial])

  const send = (input: BrowserInput) => conn.current?.send(input)
  const mouse = (
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    e: PointerEvent<HTMLCanvasElement>,
  ) =>
    send({
      t: 'mouse',
      type,
      ...point(e.currentTarget, e.nativeEvent),
      button: type === 'mouseMoved' ? 'none' : (BUTTONS[e.button] ?? 'none'),
      buttons: e.buttons,
      clickCount: type === 'mouseMoved' ? 0 : Math.max(1, e.detail),
      modifiers: modifiers(e),
    })

  const wake = async () => {
    setWaking(true)
    try {
      await resumeSession(id)
      await new Promise((r) => setTimeout(r, WAKE_RETRY_MS))
      setDial((n) => n + 1)
    } catch (e) {
      setState({
        kind: 'error',
        message:
          e instanceof Error
            ? `Could not wake the session: ${e.message}`
            : 'Could not wake the session.',
      })
    } finally {
      setWaking(false)
    }
  }

  const open = state.kind === 'open'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex h-9 shrink-0 items-center gap-1 px-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (url?.trim()) send({ t: 'navigate', url: url.trim() })
          setUrl(null)
          canvas.current?.focus()
        }}
      >
        <NavButton
          label="Back"
          disabled={!open || !page?.canGoBack}
          onClick={() => send({ t: 'back' })}
        >
          <ArrowLeft />
        </NavButton>
        <NavButton
          label="Forward"
          disabled={!open || !page?.canGoForward}
          onClick={() => send({ t: 'forward' })}
        >
          <ArrowRight />
        </NavButton>
        <NavButton
          label={page?.loading ? 'Stop' : 'Reload'}
          disabled={!open}
          onClick={() => send({ t: page?.loading ? 'stop' : 'reload' })}
        >
          {page?.loading ? <X /> : <RotateCw />}
        </NavButton>
        <input
          aria-label="Address"
          spellCheck={false}
          disabled={!open}
          value={url ?? (page?.url === 'about:blank' ? '' : (page?.url ?? ''))}
          placeholder="Type a URL, e.g. localhost:3000"
          onChange={(e) => setUrl(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setUrl(null)}
          className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 text-xs text-[#e6e1d8] outline-none placeholder:text-[#8a8478] focus:border-white/25 disabled:opacity-50"
        />
      </form>
      {!open || pageError ? (
        <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 px-3 py-1 text-xs text-[#c2bcae]">
          {open ? (
            <span role="alert">{pageError}</span>
          ) : (
            <Status
              state={state}
              waking={waking}
              onWake={() => void wake()}
              onReconnect={() => setDial((n) => n + 1)}
            />
          )}
        </div>
      ) : null}
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label={page?.title ? `Page: ${page.title}` : 'Page'}
          className="absolute inset-0 h-full w-full bg-white object-contain object-left-top outline-none"
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            e.currentTarget.focus()
            e.currentTarget.setPointerCapture?.(e.pointerId)
            mouse('mousePressed', e)
          }}
          onPointerUp={(e) => mouse('mouseReleased', e)}
          onPointerMove={(e) => mouse('mouseMoved', e)}
          onKeyDown={(e) => {
            if (keepKey(e)) return
            e.preventDefault()
            send(keyInput('down', e.nativeEvent))
          }}
          onKeyUp={(e) => {
            if (keepKey(e)) return
            e.preventDefault()
            send(keyInput('up', e.nativeEvent))
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text/plain')
            if (text) send({ t: 'text', text })
            e.preventDefault()
          }}
        />
      </div>
    </div>
  )
}

/** Where an event falls on the page, in its CSS pixels. */
function point(
  el: HTMLElement,
  e: { clientX: number; clientY: number },
): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return {
    x: Math.round(e.clientX - r.left),
    y: Math.round(e.clientY - r.top),
  }
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className="text-[#c2bcae]"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function Status({
  state,
  waking,
  onWake,
  onReconnect,
}: {
  state: TerminalState
  waking: boolean
  onWake: () => void
  onReconnect: () => void
}) {
  if (waking) return <Line text="Waking the session…" />
  switch (state.kind) {
    case 'connecting':
      return <Line text="Starting the browser…" />
    case 'waking-computer':
      return <Line text="Waking the computer…" />
    case 'open':
      return null
    case 'not-running':
      return (
        <>
          <span>The session is not running.</span>
          <Button
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-xs"
            onClick={onWake}
          >
            Wake it
          </Button>
        </>
      )
    case 'ended':
    case 'error':
      return (
        <>
          <span role={state.kind === 'error' ? 'alert' : undefined}>
            {state.message}
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-xs"
            onClick={onReconnect}
          >
            Reconnect
          </Button>
        </>
      )
  }
}

function Line({ text }: { text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {text}
    </span>
  )
}
