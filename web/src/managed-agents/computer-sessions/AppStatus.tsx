import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TerminalState } from './terminal-wire'

// The status line of the Browser and Desktop tabs while they are not open:
// starting, waking, or why they ended, with Wake or Reconnect.

export function AppStatus({
  starting,
  state,
  waking,
  onWake,
  onReconnect,
}: {
  starting: string
  state: TerminalState
  waking: boolean
  onWake: () => void
  onReconnect: () => void
}) {
  if (waking) return <Line text="Waking the session…" />
  switch (state.kind) {
    case 'connecting':
      return <Line text={starting} />
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
