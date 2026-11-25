import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Loader2 } from 'lucide-react'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import { mintTerminalTicket, resumeSession } from '../computer-sessions-api'
import {
  openTerminal,
  type TerminalConnection,
  type TerminalState,
} from './terminal-wire'
import type { SidebarTabProps } from './sidebar-tabs'

const THEME = {
  background: '#14120f',
  foreground: '#e6e1d8',
  cursor: '#c2bcae',
  selectionBackground: 'rgba(230, 225, 216, 0.16)',
}

const FONT_NAME = '"Geist Mono Variable"'

/** How long Wake waits for the session's computer before trying the terminal again. */
const WAKE_RETRY_MS = 3_000

/** Why a ticket was refused, in the panel's words. */
function ticketError(e: unknown): Error {
  if (e instanceof ApiError && e.status === 403)
    return new Error(
      'Only people who may drive this session can open a terminal in it.',
    )
  if (e instanceof ApiError && e.status === 404)
    return new Error('This session does not exist or is not shared with you.')
  return e instanceof Error ? e : new Error('Could not open a terminal.')
}

// The sidebar's Terminal tab: an interactive shell in the session's computer,
// over the same wire `opc shell` uses (terminal-wire.ts). It refits whenever
// its box changes size, so dragging or reopening the sidebar resizes the shell.
export function SessionTerminal({ sessionId: id }: SidebarTabProps) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TerminalState>({ kind: 'connecting' })
  const [waking, setWaking] = useState(false)
  const [dial, setDial] = useState(0)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let stop: (() => void) | null = null
    let cancelled = false
    // xterm measures its cells once, on open: with the web font not yet
    // loaded it measures a fallback and the text comes out unevenly spaced.
    const font = document.fonts?.load(`13px ${FONT_NAME}`) ?? Promise.resolve()
    void font
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) stop = start(el)
      })
    const start = (el: HTMLDivElement) => {
      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: `${FONT_NAME}, Menlo, Monaco, Consolas, monospace`,
        theme: THEME,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(el)
      // A hidden tab or closed sidebar has no size to fit to.
      const refit = () => {
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
      }
      refit()
      let conn: TerminalConnection | null = openTerminal(
        {
          sessionId: id,
          cols: term.cols,
          rows: term.rows,
          ticket: () =>
            mintTerminalTicket(id).catch((e: unknown) =>
              Promise.reject(ticketError(e)),
            ),
        },
        {
          onState: (s) => {
            setState(s)
            if (s.kind === 'open') term.focus()
          },
          onData: (bytes) => term.write(bytes),
        },
      )
      const input = term.onData((d) => conn?.send(d))
      const resize = term.onResize(({ cols, rows }) => conn?.resize(cols, rows))
      const observer = new ResizeObserver(refit)
      observer.observe(el)
      return () => {
        observer.disconnect()
        input.dispose()
        resize.dispose()
        conn?.close()
        conn = null
        term.dispose()
      }
    }
    return () => {
      cancelled = true
      stop?.()
    }
  }, [id, dial])

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 px-3 py-1 text-xs text-[#c2bcae]">
        <Status
          state={state}
          waking={waking}
          onWake={() => void wake()}
          onReconnect={() => setDial((n) => n + 1)}
        />
      </div>
      {/* Geist Mono joins runs like `--` and `..`; xterm measures each glyph
          from such a run and would pad single ones apart. */}
      <div
        ref={host}
        style={{
          fontVariantLigatures: 'none',
          fontFeatureSettings: '"liga" 0, "calt" 0',
        }}
        className="min-h-0 flex-1 px-2 pb-2"
      />
    </div>
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
  if (waking) return <Line spin text="Waking the session…" />
  switch (state.kind) {
    case 'connecting':
      return <Line spin text="Connecting…" />
    case 'waking-computer':
      return <Line spin text="Waking the computer…" />
    case 'open':
      return <span>Connected</span>
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

function Line({ text, spin }: { text: string; spin?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {spin ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      {text}
    </span>
  )
}
