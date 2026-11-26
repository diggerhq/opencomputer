import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { ApiError } from '@/api/client'
import { mintTerminalTicket, resumeSession } from '../computer-sessions-api'
import { AppStatus } from './AppStatus'
import { openDesktop } from './desktop-wire'
import type { TerminalState } from './terminal-wire'
import type { SidebarTabProps } from './sidebar-tabs'

/** How long Wake waits for the session's computer before trying again. */
const WAKE_RETRY_MS = 3_000

function ticketError(e: unknown): Error {
  if (e instanceof ApiError && e.status === 403)
    return new Error(
      'Only people who may drive this session can use its desktop.',
    )
  if (e instanceof ApiError && e.status === 404)
    return new Error('This session does not exist or is not shared with you.')
  return e instanceof Error ? e : new Error('Could not open the desktop.')
}

// The sidebar's Desktop tab: the session's X display, over VNC on one channel
// of the wire (desktop-wire.ts), drawn by noVNC and scaled to the tab. The
// display outlives the tab: what runs on it is there when the tab reopens.
export function SessionDesktop({ sessionId: id }: SidebarTabProps) {
  const screen = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<TerminalState>({ kind: 'connecting' })
  const [refused, setRefused] = useState<string | null>(null)
  const [waking, setWaking] = useState(false)
  const [dial, setDial] = useState(0)

  useEffect(() => {
    const el = screen.current
    if (!el) return
    let rfb: RFB | null = null
    const drop = () => {
      rfb?.disconnect()
      rfb = null
    }
    setRefused(null)
    const c = openDesktop(
      {
        sessionId: id,
        ticket: () =>
          mintTerminalTicket(id).catch((e: unknown) =>
            Promise.reject(ticketError(e)),
          ),
      },
      {
        onState: (s) => {
          if (s.kind !== 'open') drop()
          setState(s)
        },
        onChannel: (channel) => {
          drop()
          const r = new RFB(el, channel)
          r.scaleViewport = true
          r.resizeSession = false
          r.background = '#1a1917'
          r.addEventListener('securityfailure', (e) => {
            const d = (e as CustomEvent<{ reason?: string }>).detail
            setRefused(d?.reason || 'The desktop refused the connection.')
          })
          r.addEventListener('connect', () => r.focus())
          rfb = r
        },
      },
    )
    return () => {
      c.close()
      drop()
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

  const open = state.kind === 'open' && !refused
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!open ? (
        <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 px-3 py-1 text-xs text-[#c2bcae]">
          <AppStatus
            starting="Starting the desktop…"
            state={refused ? { kind: 'error', message: refused } : state}
            waking={waking}
            onWake={() => void wake()}
            onReconnect={() => setDial((n) => n + 1)}
          />
        </div>
      ) : null}
      <div
        ref={screen}
        aria-label="Desktop"
        className="relative min-h-0 flex-1 overflow-hidden bg-[#1a1917]"
      />
    </div>
  )
}
