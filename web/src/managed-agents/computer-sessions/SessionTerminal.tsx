import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Loader2, X } from 'lucide-react'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import { mintTerminalTicket, resumeSession } from '../computer-sessions-api'
import {
  openTerminal,
  type TerminalConnection,
  type TerminalState,
} from './terminal-wire'

const THEME = {
  background: '#14120f',
  foreground: '#e6e1d8',
  cursor: '#c2bcae',
  selectionBackground: 'rgba(230, 225, 216, 0.16)',
}

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

// An interactive shell in the session's computer, over the same wire
// `opc shell` uses (terminal-wire.ts). Remounting (`key`) reconnects.
export function SessionTerminal({
  id,
  onClose,
}: {
  id: string
  onClose: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TerminalState>({ kind: 'connecting' })
  const [waking, setWaking] = useState(false)
  const [dial, setDial] = useState(0)

  useEffect(() => {
    if (!host.current) return
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Geist Mono Variable", Menlo, Monaco, Consolas, monospace',
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
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
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(host.current)
    return () => {
      observer.disconnect()
      input.dispose()
      resize.dispose()
      conn?.close()
      conn = null
      term.dispose()
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
    <div className="border-border flex h-[45%] min-h-48 shrink-0 flex-col border-b bg-[#14120f]">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-[#c2bcae]">
        <span className="font-medium">Terminal</span>
        <Status
          state={state}
          waking={waking}
          onWake={() => void wake()}
          onReconnect={() => setDial((n) => n + 1)}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto text-[#c2bcae]"
          aria-label="Close terminal"
          title="Close terminal"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div ref={host} className="min-h-0 flex-1 px-2 pb-2" />
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

function Line({ text, spin }: { text: string; spin?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {spin ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      {text}
    </span>
  )
}
