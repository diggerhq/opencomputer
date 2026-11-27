import { useContext, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useS, useSurface } from '../hooks'
import type { ItemAttachment } from '../store/transcript'
import { formatBytes, isImage, SessionContext } from './attachment-rules'
import { I } from './icons'

// Files on messages (work 126): the chips under a composer while they upload,
// and the chips on a sent message. An image is shown as a thumbnail: from the
// file itself while this page still has it (it was attached here), and once
// sent from a signed URL of the server, straight in an `<img src>`. The URL is
// its own authority and short-lived; the client keeps it until it nears its end.

// An object URL of a file this page holds, revoked when it is no longer shown.
function useLocalUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return
    // The URL is a resource made here and revoked in the cleanup; publishing
    // it is the one render this effect causes.
    const made = URL.createObjectURL(blob)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(made)
    return () => {
      URL.revokeObjectURL(made)
      setUrl(null)
    }
  }, [blob])
  return url
}

const CHIP = 'bg-background/70 text-foreground flex h-9 max-w-56 items-center gap-2 rounded-lg border px-2 text-xs'

// ---- under the composer ----

export function DraftChip({ id, draftKey }: { id: string; draftKey: string }) {
  const surface = useSurface()
  const a = useS((s) => s.attachments.find((x) => x.id === id))
  const image = a && isImage(a)
  // After a reload the page has no bytes: a plain file chip.
  const url = useLocalUrl(image ? surface.attachmentBlob(id) : undefined)
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

// One box for the placeholder and the picture, so a row does not move when it loads.
const IMAGE_BOX = 'relative block h-36 w-48 overflow-hidden rounded-lg border'

function MessageImage({ a, sending }: { a: ItemAttachment; sending: boolean }) {
  const surface = useSurface()
  const sid = useContext(SessionContext)
  const [open, setOpen] = useState(false)
  // The file, when it was attached in this page: taken once and shown from
  // then on, so the picture does not change when the message is accepted.
  const [blob] = useState(() => surface.attachmentBlob(a.id))
  const local = useLocalUrl(blob)
  // Else the server's, once it has the message.
  const [signed, setSigned] = useState<string | null>(null)
  const ask = !blob && !sending
  useEffect(() => {
    if (!ask) return
    let gone = false
    surface.client.attachmentUrl(sid, a.id).then(
      (url) => void (gone || setSigned(url)),
      () => {},
    )
    return () => {
      gone = true
    }
  }, [surface, ask, sid, a.id])
  const url = local ?? signed
  if (!url)
    return (
      <span className={cn(CHIP, IMAGE_BOX, 'bg-background/40 justify-center', ask && 'animate-pulse')} title={a.name}>
        <span className="truncate">{a.name}</span>
        {sending && a.upload !== 'ready' && <Progress a={a} />}
      </span>
    )
  return (
    <>
      <button
        type="button"
        className={cn(IMAGE_BOX, 'focus-visible:ring-ring/50 outline-none focus-visible:ring-3')}
        title={a.name}
        aria-label={`Open ${a.name}`}
        onClick={() => setOpen(true)}
      >
        <img src={url} alt={a.name} loading="lazy" decoding="async" className="size-full object-cover" />
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
  // The browser fetches the file itself, from a signed URL that says
  // "attachment": nothing of it is held in this page. The Mac app does not
  // navigate away from itself, so there the URL goes to the browser.
  const download = async () => {
    setBusy(true)
    try {
      const url = await surface.client.attachmentUrl(sid, a.id, { download: true })
      if (surface.host.platform === 'desktop') surface.openExternal(url)
      else {
        const link = document.createElement('a')
        link.href = url
        link.download = a.name
        link.rel = 'noopener'
        link.click()
      }
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
      title={failed ? `${a.name}: ${a.error ?? 'the upload failed'}` : sending ? a.name : `Download ${a.name}`}
      disabled={busy || sending}
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
