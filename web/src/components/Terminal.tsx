import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SquareTerminal } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'

interface TerminalProps {
  sandboxId: string
  onClose?: () => void
}

export default function Terminal({ sandboxId, onClose }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptySessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<
    'connecting' | 'connected' | 'disconnected' | 'error'
  >('connecting')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!termRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Geist Mono Variable", Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#14120f', // warm near-black — matches --terminal
        foreground: '#e6e1d8', // warm light
        cursor: '#c2bcae', // warm neutral (de-purpled)
        selectionBackground: 'rgba(230, 225, 216, 0.16)',
        black: '#18181b',
        red: '#fb7185',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#818cf8',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#fda4af',
        brightGreen: '#6ee7b7',
        brightYellow: '#fde68a',
        brightBlue: '#a5b4fc',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      },
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    const webLinks = new WebLinksAddon()

    term.loadAddon(fit)
    term.loadAddon(webLinks)
    term.open(termRef.current)

    // Fit after a frame to let the container render.
    const raf = requestAnimationFrame(() => fit.fit())

    xtermRef.current = term
    fitRef.current = fit

    term.writeln('\x1b[2m  Connecting to sandbox...\x1b[0m')

    // Guard the async PTY/WS setup against racing the effect cleanup (close or
    // navigate before the POST returns): abort the in-flight fetch and never
    // open a socket / write to a disposed terminal.
    let disposed = false
    const controller = new AbortController()

    // Create PTY session, then connect WebSocket
    const initTerminal = async () => {
      try {
        const cols = term.cols
        const rows = term.rows

        // Create PTY session
        const res = await fetch(`/api/dashboard/sessions/${sandboxId}/pty`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ cols, rows }),
          signal: controller.signal,
        })

        if (!res.ok) {
          const data: unknown = await res.json().catch(() => null)
          const err =
            data && typeof data === 'object'
              ? (data as Record<string, unknown>).error
              : undefined
          throw new Error(typeof err === 'string' ? err : `HTTP ${res.status}`)
        }

        const payload: unknown = await res.json()
        if (disposed) return
        const sessionId =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>).sessionId
            : undefined
        if (typeof sessionId !== 'string') {
          throw new Error('Invalid PTY session response')
        }
        ptySessionIdRef.current = sessionId

        // Connect WebSocket
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${proto}//${window.location.host}/api/dashboard/sessions/${sandboxId}/pty/${sessionId}`
        const ws = new WebSocket(wsUrl)
        ws.binaryType = 'arraybuffer'
        wsRef.current = ws

        ws.onopen = () => {
          if (disposed) return
          setStatus('connected')
          term.clear()
          term.focus()
        }

        ws.onmessage = (event) => {
          if (disposed) return
          const data = new Uint8Array(event.data)
          term.write(data)
        }

        ws.onclose = () => {
          if (disposed) return
          setStatus('disconnected')
          term.writeln('')
          term.writeln('\x1b[2m  Session ended.\x1b[0m')
        }

        ws.onerror = () => {
          if (disposed) return
          setStatus('error')
          setErrorMsg('WebSocket connection failed')
        }

        // Terminal input -> WebSocket
        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(data))
          }
        })

        // Handle resize — send to backend resize endpoint (not via PTY stream)
        term.onResize(({ cols, rows }) => {
          if (ptySessionIdRef.current) {
            fetch(
              `/api/dashboard/sessions/${sandboxId}/pty/${ptySessionIdRef.current}/resize`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ cols, rows }),
              },
            ).catch(() => {
              // Resize failed — not critical, ignore
            })
          }
        })
      } catch (err: unknown) {
        if (disposed) return // unmounted mid-setup (incl. fetch AbortError)
        setStatus('error')
        const msg = err instanceof Error ? err.message : 'Failed to connect'
        setErrorMsg(msg)
        term.writeln(`\x1b[31m  Error: ${msg}\x1b[0m`)
      }
    }

    void initTerminal()

    // Handle window resize
    const handleResize = () => {
      if (fitRef.current) {
        fitRef.current.fit()
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      disposed = true
      controller.abort()
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', handleResize)
      if (wsRef.current) {
        wsRef.current.close()
      }
      term.dispose()
    }
  }, [sandboxId])

  const statusColor = {
    connected: 'text-emerald-400',
    connecting: 'text-blue-400',
    error: 'text-rose-400',
    disconnected: 'text-zinc-500',
  }[status]

  return (
    <div className="bg-terminal border-code-border overflow-hidden rounded-lg border">
      {/* Header */}
      <div className="border-code-border flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <SquareTerminal className="text-code-muted size-3.5" />
          <span className="text-code-muted text-xs font-medium tracking-wide uppercase">
            Terminal
          </span>
          <span
            className={cn(
              'rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px]',
              statusColor,
            )}
          >
            {status}
          </span>
        </div>
        {onClose ? (
          <button
            onClick={onClose}
            className="text-code-muted hover:text-code-foreground text-xs transition-colors"
          >
            Close
          </button>
        ) : null}
      </div>

      {/* Terminal surface (xterm) */}
      <div ref={termRef} className="bg-terminal h-[350px] px-1 py-2" />

      {status === 'error' && errorMsg ? (
        <div className="border-code-border border-t px-4 py-2 text-[11px] text-rose-400">
          {errorMsg}
        </div>
      ) : null}
    </div>
  )
}
