import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { ChatTextarea } from '@/components/chat-textarea'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useS, useSurface } from '../hooks'
import { DraftChips } from './Attachments'
import { I } from './icons'
import { Tip } from './Tip'

// ---- the composer: the dashboard's chat box, whose draft is kept (R44) ----
//
// Files come in by the paperclip, by drop, or by paste (work 126); they show
// as chips under the text and upload at once. The message can be sent while
// they upload: it waits for them. A failed chip must be taken out first.

const NONE: string[] = []

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
  const ids = useS((s) => s.draftAttachments[draftKey] ?? NONE)
  // Of the draft's files, how many the client still holds, and whether one failed.
  const held = useS((s) => s.attachments.filter((a) => ids.includes(a.id)).length)
  const failed = useS((s) => s.attachments.some((a) => a.state === 'failed' && ids.includes(a.id)))
  const ref = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const meta = useRef(false)
  // A drag over the box, counted in and out through its children.
  const [over, setOver] = useState(0)
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector('textarea')?.focus()
  }, [autoFocus, draftKey])
  const ready = (!!text.trim() || held > 0) && !failed
  const send = () => {
    if (!ready) return
    surface.setDraft(draftKey, '')
    onSend(text.trim(), { meta: meta.current })
    meta.current = false
  }
  const attach = (files: FileList | File[] | null | undefined) => {
    if (files?.length) surface.attach(draftKey, [...files])
  }
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files')
  const button = (
    <Button size="icon-sm" aria-label="Send" title={failed ? 'Remove the failed file to send' : 'Send (Enter)'} disabled={!ready} onClick={send}>
      {I.up}
    </Button>
  )
  return (
    <div
      ref={ref}
      className={cn(
        'bg-card focus-within:border-ring/60 flex flex-none flex-col gap-1 rounded-xl border p-1 pl-1 shadow-sm transition-colors',
        over > 0 && 'border-ring ring-ring/30 ring-3',
        className,
      )}
      data-dragging={over > 0 || undefined}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setOver((n) => n + 1)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (hasFiles(e)) setOver((n) => Math.max(0, n - 1))
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setOver(0)
        attach(e.dataTransfer.files)
      }}
    >
      <ChatTextarea
        data-draft={draftKey}
        placeholder={placeholder}
        rows={rows}
        value={text}
        onChange={(e) => surface.setDraft(draftKey, e.target.value)}
        onSend={send}
        onKeyDown={(e) => {
          meta.current = e.metaKey || e.ctrlKey
          if (e.key === 'Escape') e.currentTarget.blur()
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (!files.length) return
          e.preventDefault()
          attach(files)
        }}
        className="text-reading md:text-reading min-h-8 flex-1 border-0 bg-transparent px-2.5 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <DraftChips draftKey={draftKey} ids={ids} />
      <div className="flex items-center gap-1">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            attach(e.target.files)
            e.target.value = ''
          }}
        />
        <Tip label="Attach files">
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
            {I.attach}
          </Button>
        </Tip>
        <div className="min-w-0 flex-1">{tools}</div>
        {button}
      </div>
    </div>
  )
}
