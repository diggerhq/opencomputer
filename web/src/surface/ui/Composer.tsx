import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChatTextarea } from '@/components/chat-textarea'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useS, useSurface } from '../hooks'
import { MAX_UPLOAD_BYTES } from '../store/upload'
import { I } from './icons'

// ---- the composer: the dashboard's chat box, whose draft is kept (R44) ----
// With `onAttach`, files can come with the message: picked, dropped or pasted.
// They are kept here, not in the draft, until `onAttach` resolves; when it
// throws they stay, so nothing attached is lost to a failed upload.

const kb = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`

export function Composer({
  draftKey,
  placeholder,
  onSend,
  onAttach,
  autoFocus,
  rows = 1,
  className,
  tools,
}: {
  draftKey: string
  placeholder: string
  onSend: (text: string, e: { meta: boolean }) => void
  // Sends the message with files; resolves once they are uploaded.
  onAttach?: (text: string, files: File[]) => Promise<unknown>
  autoFocus?: boolean
  rows?: number
  className?: string
  // Beside the send button, under the text: the settings pickers.
  tools?: ReactNode
}) {
  const surface = useSurface()
  const text = useS((s) => s.drafts[draftKey] ?? '')
  const ref = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const meta = useRef(false)
  // Held for one draft: another thread's composer starts with none.
  const [held, setHeld] = useState<{ key: string; files: File[] }>({ key: draftKey, files: [] })
  const files = held.key === draftKey ? held.files : []
  const setFiles = (f: File[]) => setHeld({ key: draftKey, files: f })
  const [uploading, setUploading] = useState(false)
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector('textarea')?.focus()
  }, [autoFocus, draftKey])
  const add = (more: File[]) => {
    if (!onAttach || !more.length) return
    const all = [...files, ...more]
    if (all.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) {
      surface.toast({ text: 'Attachments are limited to 1 GB per message', tone: 'error' })
      return
    }
    setFiles(all)
  }
  const ready = !uploading && (!!text.trim() || files.length > 0)
  const send = () => {
    const t = text.trim()
    if (!ready) return
    if (files.length && onAttach) {
      setUploading(true)
      onAttach(t, files)
        .then(
          () => {
            surface.setDraft(draftKey, '')
            setFiles([])
          },
          () => {},
        )
        .finally(() => setUploading(false))
      return
    }
    surface.setDraft(draftKey, '')
    onSend(t, { meta: meta.current })
    meta.current = false
  }
  const button = (
    // Filled once there is something to send.
    <Button
      size="icon-sm"
      variant={ready ? 'default' : 'secondary'}
      className="rounded-full"
      aria-label="Send"
      title={uploading ? 'Uploading…' : 'Send (Enter)'}
      disabled={!ready}
      onClick={() => {
        meta.current = false
        send()
      }}
    >
      {I.up}
    </Button>
  )
  const attach = onAttach && (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          add([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-muted-foreground rounded-full"
        aria-label="Attach files"
        title="Attach files"
        disabled={uploading}
        onClick={() => picker.current?.click()}
      >
        {I.clip}
      </Button>
    </>
  )
  const actions = (
    <>
      {attach}
      {button}
    </>
  )
  return (
    <div
      ref={ref}
      className={cn(
        'bg-card focus-within:border-input flex flex-none flex-col gap-1 rounded-xl border p-1.5 shadow-sm transition-colors',
        over && 'border-primary',
        className,
      )}
      onDragOver={(e) => {
        if (!onAttach || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        setOver(false)
        if (!onAttach || !e.dataTransfer.files.length) return
        e.preventDefault()
        add([...e.dataTransfer.files])
      }}
      onPaste={(e) => {
        // A pasted screenshot or file; pasted text stays text.
        if (!onAttach || !e.clipboardData.files.length) return
        e.preventDefault()
        add([...e.clipboardData.files])
      }}
    >
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1 px-1 pt-1" aria-label="Attached files">
          {files.map((f, i) => (
            <li
              key={`${i}:${f.name}`}
              className="bg-muted text-meta flex max-w-60 items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2"
            >
              <span className="truncate">{f.name || 'file'}</span>
              <span className="text-muted-foreground flex-none">{kb(f.size)}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${f.name}`}
                disabled={uploading}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
              >
                {I.x}
              </Button>
            </li>
          ))}
          {uploading && <li className="text-muted-foreground text-meta self-center px-1">Uploading…</li>}
        </ul>
      )}
      <div className={cn('flex gap-1', tools ? 'flex-col' : 'items-end')}>
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
            {actions}
          </div>
        ) : (
          <div className="flex items-center gap-1">{actions}</div>
        )}
      </div>
    </div>
  )
}
