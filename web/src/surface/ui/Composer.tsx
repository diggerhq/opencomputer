import { useEffect, useRef, type ReactNode } from 'react'
import { ChatTextarea } from '@/components/chat-textarea'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useS, useSurface } from '../hooks'
import { I } from './icons'

// ---- the composer: the dashboard's chat box, whose draft is kept (R44) ----

export function Composer({
  draftKey,
  placeholder,
  onSend,
  autoFocus,
  rows = 1,
  className,
  tools,
}: {
  draftKey: string
  placeholder: string
  onSend: (text: string, e: { meta: boolean }) => void
  autoFocus?: boolean
  rows?: number
  className?: string
  // Beside the send button, under the text: the settings pickers.
  tools?: ReactNode
}) {
  const surface = useSurface()
  const text = useS((s) => s.drafts[draftKey] ?? '')
  const ref = useRef<HTMLDivElement>(null)
  const meta = useRef(false)
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector('textarea')?.focus()
  }, [autoFocus, draftKey])
  const send = () => {
    const t = text.trim()
    if (!t) return
    surface.setDraft(draftKey, '')
    onSend(t, { meta: meta.current })
    meta.current = false
  }
  const button = (
    // Filled once there is something to send.
    <Button
      size="icon-sm"
      variant={text.trim() ? 'default' : 'secondary'}
      className="rounded-full"
      aria-label="Send"
      title="Send (Enter)"
      disabled={!text.trim()}
      onClick={() => {
        meta.current = false
        send()
      }}
    >
      {I.up}
    </Button>
  )
  return (
    <div
      ref={ref}
      className={cn(
        'bg-card focus-within:border-input flex flex-none gap-1 rounded-xl border p-1.5 shadow-sm transition-colors',
        tools ? 'flex-col' : 'items-end',
        className,
      )}
    >
      <ChatTextarea
        data-draft={draftKey}
        placeholder={placeholder}
        rows={rows}
        value={text}
        onChange={(e) => surface.setDraft(draftKey, e.target.value)}
        onSend={send}
        onKeyDown={(e) => {
          // Only the Enter that sends says whether ⌘ was held: a ⌘V before a
          // click on Send must not interrupt the agent (work 134).
          if (e.key === 'Enter') meta.current = e.metaKey || e.ctrlKey
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
        className="text-reading md:text-reading placeholder:text-faint min-h-10 flex-1 border-0 bg-transparent px-2.5 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      {tools ? (
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">{tools}</div>
          {button}
        </div>
      ) : (
        button
      )}
    </div>
  )
}
