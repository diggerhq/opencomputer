import { useContext, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useS, useSurface } from '../hooks'
import type { ItemAttachment } from '../store/transcript'
import { formatBytes, isImage, SessionContext } from './attachment-rules'
import { I } from './icons'

// Files on messages (work 126): the chips under a composer while they upload,
// and the chips on a sent message. An image is shown as a thumbnail, from the
// local file while it is pending and from the server once sent; the bytes
// are always fetched with the credential, never put in an `<img src>` (the
// API's cookie is not sent for one from another origin).

// An object URL for `load`'s blob, revoked when it is no longer shown.
function useObjectUrl(load: (() => Promise<Blob | undefined>) | null, key: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!load) return
    let made: string | null = null
    let gone = false
    load().then(
      (blob) => {
        if (gone || !blob) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      },
      () => {},
    )
    return () => {
      gone = true
      if (made) URL.revokeObjectURL(made)
      setUrl(null)
    }
    // `key` stands for `load`: a new file, a new reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return url
}

const CHIP = 'bg-background/70 text-foreground flex h-9 max-w-56 items-center gap-2 rounded-lg border px-2 text-xs'

// ---- under the composer ----

export function DraftChip({ id, draftKey }: { id: string; draftKey: string }) {
  const surface = useSurface()
  const a = useS((s) => s.attachments.find((x) => x.id === id))
  const image = a && isImage(a)
  const url = useObjectUrl(image ? () => surface.client.attachmentFile(id) : null, image ? id : '')
  if (!a) return null
  const failed = a.state === 'failed'
  const pct = Math.round(a.progress * 100)
  const title = failed ? `${a.name}: ${a.error?.reason ?? 'the upload failed'}` : a.state === 'ready' ? a.name : `${a.name}: ${a.state === 'uploading' ? `uploading, ${pct}%` : 'waiting to upload'}`
  return (
    <div
      className={cn(CHIP, 'relative overflow-hidden pr-1', failed && 'border-destructive/50 text-destructive')}
      data-state={a.state}
      title={title}
    >
      {url ? (
        <img src={url} alt="" className="size-6 flex-none rounded object-cover" />
      ) : (
        <span className="text-muted-foreground flex-none">{I.file}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{a.name}</span>
      <span className={cn('flex-none tabular-nums', failed ? 'text-destructive/80' : 'text-muted-foreground')}>
        {failed ? 'Failed' : a.state === 'ready' ? formatBytes(a.bytes) : a.state === 'uploading' ? `${pct}%` : 'Waiting'}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-foreground -mr-0.5 flex-none"
        aria-label={`Remove ${a.name}`}
        onClick={() => surface.removeAttachment(draftKey, id)}
      >
        {I.x}
      </Button>
      {!failed && a.state !== 'ready' && (
        <span
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Uploading ${a.name}`}
          className="bg-primary/70 absolute inset-x-0 bottom-0 h-0.5 transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  )
}

// `ids`: the draft's, of which only those the client still holds are drawn
// (one sent or dropped elsewhere leaves an id behind).
export function DraftChips({ draftKey, ids }: { draftKey: string; ids: string[] }) {
  const held = useS((s) => s.attachments)
  const shown = ids.filter((id) => held.some((a) => a.id === id))
  if (!shown.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-1.5 pt-1" data-slot="draft-attachments">
      {shown.map((id) => (
        <DraftChip key={id} id={id} draftKey={draftKey} />
      ))}
    </div>
  )
}

// ---- on a message ----

function MessageImage({ a, sending }: { a: ItemAttachment; sending: boolean }) {
  const surface = useSurface()
  const sid = useContext(SessionContext)
  const [open, setOpen] = useState(false)
  const url = useObjectUrl(sending ? () => surface.client.attachmentFile(a.id) : () => surface.client.readAttachment(sid, a.id), `${sending}:${sid}:${a.id}`)
  if (!url)
    return (
      <span className={cn(CHIP, 'bg-background/40 h-24 w-32 animate-pulse justify-center')} title={a.name}>
        <span className="truncate">{a.name}</span>
      </span>
    )
  return (
    <>
      <button
        type="button"
        className="focus-visible:ring-ring/50 relative block overflow-hidden rounded-lg border outline-none focus-visible:ring-3"
        title={a.name}
        aria-label={`Open ${a.name}`}
        onClick={() => setOpen(true)}
      >
        <img src={url} alt={a.name} className="max-h-48 max-w-64 object-cover" />
        {sending && a.upload !== 'ready' && <Progress a={a} />}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-[90vw] items-center justify-center bg-transparent p-0 shadow-none sm:max-w-[90vw]" showCloseButton={false}>
          <DialogTitle className="sr-only">{a.name}</DialogTitle>
          <img src={url} alt={a.name} className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" />
        </DialogContent>
      </Dialog>
    </>
  )
}

function Progress({ a }: { a: ItemAttachment }) {
  const pct = Math.round((a.progress ?? 0) * 100)
  return (
    <span
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Uploading ${a.name}`}
      className="bg-primary/70 absolute inset-x-0 bottom-0 h-0.5 transition-[width] duration-200"
      style={{ width: `${pct}%` }}
    />
  )
}

function MessageFile({ a, sending }: { a: ItemAttachment; sending: boolean }) {
  const surface = useSurface()
  const sid = useContext(SessionContext)
  const [busy, setBusy] = useState(false)
  // The bytes come with the credential; a link to `…/content` would not carry it.
  const download = async () => {
    setBusy(true)
    try {
      const blob = sending ? await surface.client.attachmentFile(a.id) : await surface.client.readAttachment(sid, a.id)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = a.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      surface.toast({ text: `Could not download ${a.name}`, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const failed = sending && a.upload === 'failed'
  return (
    <button
      type="button"
      className={cn(CHIP, 'focus-visible:ring-ring/50 hover:bg-background relative overflow-hidden outline-none focus-visible:ring-3', failed && 'border-destructive/50 text-destructive')}
      title={failed ? `${a.name}: ${a.error ?? 'the upload failed'}` : `Download ${a.name}`}
      disabled={busy}
      onClick={() => void download()}
    >
      <span className="text-muted-foreground flex-none">{I.file}</span>
      <span className="min-w-0 flex-1 truncate">{a.name}</span>
      <span className="text-muted-foreground flex-none tabular-nums">
        {failed ? 'Failed' : sending && a.upload !== 'ready' ? `${Math.round((a.progress ?? 0) * 100)}%` : formatBytes(a.bytes)}
      </span>
      {!sending && <span className="text-muted-foreground flex-none">{I.download}</span>}
      {sending && a.upload !== 'ready' && !failed && <Progress a={a} />}
    </button>
  )
}

export function MessageAttachments({ attachments, sending, className }: { attachments: ItemAttachment[]; sending: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)} data-slot="message-attachments">
      {attachments.map((a) => (isImage(a) ? <MessageImage key={a.id} a={a} sending={sending} /> : <MessageFile key={a.id} a={a} sending={sending} />))}
    </div>
  )
}

export function SessionScope({ sid, children }: { sid: string; children: ReactNode }) {
  return <SessionContext.Provider value={sid}>{children}</SessionContext.Provider>
}
