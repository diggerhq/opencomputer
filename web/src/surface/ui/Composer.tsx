import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useS, useSurface } from '../hooks'
import { DraftChips } from './Attachments'
import { I } from './icons'
import { MarkdownInput } from './MarkdownInput'
import { Tip } from './Tip'

// ---- the composer: the dashboard's chat box, whose draft is kept (R44) ----
//
// Files come in by the paperclip, by drop, or by paste (work 126); they show
// as chips under the text and upload at once. The message can be sent while
// they upload: it waits for them. A failed chip must be taken out first.
// On a deployment with no store for files (`canAttach` false) there is no
// paperclip, and a dropped or pasted file is ignored.

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
  const canAttach = useS((s) => s.canAttach !== false)
  const fileInput = useRef<HTMLInputElement>(null)
  const meta = useRef(false)
  // A drag over the box, counted in and out through its children.
  const [over, setOver] = useState(0)
  const ready = (!!text.trim() || held > 0) && !failed
  const send = () => {
    if (!ready) return
    surface.setDraft(draftKey, '')
    onSend(text.trim(), { meta: meta.current })
    meta.current = false
  }
  const attach = (files: FileList | File[] | null | undefined) => {
    if (canAttach && files?.length) surface.attach(draftKey, [...files])
  }
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files')
  const button = (
    // Filled once there is something to send: text, or a file that uploaded.
    <Button
      size="icon-sm"
      variant={ready ? 'default' : 'secondary'}
      className="rounded-full"
      aria-label="Send"
      title={failed ? 'Remove the failed file to send' : 'Send (Enter)'}
      disabled={!ready}
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
      className={cn(
        // Always a column: the paperclip's row is under the text.
        'bg-card focus-within:border-input flex flex-none flex-col gap-1 rounded-xl border p-1.5 shadow-sm transition-colors',
        over > 0 && 'border-ring ring-ring/30 ring-3',
        className,
      )}
      data-dragging={over > 0 || undefined}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        if (canAttach) setOver((n) => n + 1)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        // Still ours when files cannot be attached: the browser would open the file.
        e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none'
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
      <MarkdownInput
        draftKey={draftKey}
        placeholder={placeholder}
        rows={rows}
        focus={autoFocus}
        value={text}
        onChange={(t) => surface.setDraft(draftKey, t)}
        // Only the Enter that sends says whether ⌘ was held: a ⌘V before a
        // click on Send must not interrupt the agent (work 134).
        onSend={(e) => {
          meta.current = e.meta
          send()
        }}
        onFiles={canAttach ? attach : undefined}
      />
      <DraftChips draftKey={draftKey} ids={ids} />
      <div className="flex items-center gap-1">
        {canAttach && (
          <>
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
          </>
        )}
        <div className="min-w-0 flex-1">{tools}</div>
        {button}
      </div>
    </div>
  )
}
