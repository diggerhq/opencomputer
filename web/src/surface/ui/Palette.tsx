import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatTextarea } from '@/components/chat-textarea'
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useList, useS, useSurface } from '../hooks'
import type { Mark } from '../store/views'
import { Mk } from './bits'
import { oneLayer } from './kit'

interface Hit {
  kind: 'thread' | 'track'
  id: string
  name: string
  mark: Mark
  // The track a thread is in.
  within?: string
}

// S11: a small start box over whatever is open.
export function Palette() {
  const surface = useSurface()
  const on = useS((s) => s.palette)
  return (
    <Dialog open={on} onOpenChange={(open) => surface.setPalette(open)}>
      <DialogContent
        showCloseButton={false}
        className="top-[22vh] translate-y-0 gap-0 overflow-hidden rounded-xl p-0 sm:max-w-165"
        onEscapeKeyDown={oneLayer}
      >
        <DialogTitle className="sr-only">Start or go to</DialogTitle>
        <DialogDescription className="sr-only">
          Starts a thread, or goes to one
        </DialogDescription>
        {on && <Open />}
      </DialogContent>
    </Dialog>
  )
}

function Open() {
  const surface = useSurface()
  const list = useList()
  const text = useS((s) => s.drafts.pal ?? '')
  const q = text.trim().toLowerCase()
  const [sel, setSel] = useState(-1)
  const [found, setFound] = useState<Hit[]>([])
  const box = useRef<HTMLDivElement>(null)
  const meta = useRef(false)
  useEffect(() => box.current?.querySelector('textarea')?.focus(), [])

  useEffect(() => {
    if (q.length < 2) return
    // A reply to an older query never replaces a newer one.
    let live = true
    const t = setTimeout(() => {
      surface.search(q).then(
        (rows) => {
          if (!live) return
          const hits: Hit[] = []
          for (const r of rows) {
            if (r.kind === 'session' && r.role !== 'track')
              hits.push({
                kind: 'thread',
                id: r.id,
                name: r.title || 'New thread',
                mark: null,
              })
            else if (r.kind === 'track')
              hits.push({
                kind: 'track',
                id: r.id,
                name: r.name || 'New track',
                mark: null,
              })
          }
          setFound(hits)
        },
        () => {},
      )
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [surface, q])

  const hits = useMemo(() => {
    if (!q) return []
    const all: Hit[] = []
    const tracks = [...list.tracks, ...list.earlierTracks]
    for (const k of tracks)
      all.push({ kind: 'track', id: k.id, name: k.name, mark: k.mark })
    for (const t of [...list.threads, ...list.earlierThreads])
      all.push({ kind: 'thread', id: t.id, name: t.title, mark: t.mark })
    for (const k of tracks)
      for (const t of [...k.threads, ...k.earlierThreads])
        all.push({
          kind: 'thread',
          id: t.id,
          name: t.title,
          mark: t.mark,
          within: k.name,
        })
    const seen = new Set<string>()
    return [
      ...all.filter((h) => h.name.toLowerCase().includes(q)),
      ...(q.length < 2 ? [] : found),
    ]
      .filter((h) => !seen.has(h.kind + h.id) && seen.add(h.kind + h.id))
      .slice(0, 6)
  }, [list, q, found])

  const close = () => surface.setPalette(false)
  const go = (h: Hit) => {
    surface.setDraft('pal', '')
    close()
    if (h.kind === 'track') surface.openTrack(h.id)
    else surface.openThread(h.id)
  }
  const start = (open: boolean) => {
    const input = text.trim()
    if (!input) return
    surface.setDraft('pal', '')
    surface.start(input, { open })
    close()
    if (!open) surface.toast({ text: 'Started' })
  }

  return (
    // The list is cmdk's; which row is picked stays here, so nothing is picked
    // until an arrow says so and Enter starts by default.
    <Command
      shouldFilter={false}
      value={hits[sel] ? hits[sel].kind + hits[sel].id : ''}
      disablePointerSelection
      loop={false}
      className="rounded-none p-0"
    >
      <div ref={box}>
        <ChatTextarea
          placeholder="What do you want done?"
          value={text}
          rows={2}
          onChange={(e) => {
            surface.setDraft('pal', e.target.value)
            setSel(-1)
          }}
          onKeyDown={(e) => {
            meta.current = e.metaKey || e.ctrlKey
            // The caret's keys stay the field's, not the list's.
            if (
              [
                'ArrowUp',
                'ArrowDown',
                'Home',
                'End',
                'PageUp',
                'PageDown',
              ].includes(e.key)
            )
              e.stopPropagation()
            if (e.key === 'ArrowDown' && hits.length) {
              e.preventDefault()
              setSel(Math.min(hits.length - 1, sel + 1))
            } else if (e.key === 'ArrowUp' && hits.length) {
              e.preventDefault()
              setSel(Math.max(-1, sel - 1))
            }
          }}
          onSend={() => {
            if (!meta.current && hits[sel]) go(hits[sel])
            else start(meta.current)
          }}
          className="min-h-21 border-0 bg-transparent px-4 pt-4 pb-2 text-lg shadow-none focus-visible:ring-0 md:text-lg dark:bg-transparent"
        />
      </div>
      {hits.length > 0 && (
        <CommandList className="border-t px-2 py-1">
          <CommandGroup heading="Or go to">
            {hits.map((h) => (
              <CommandItem
                key={h.kind + h.id}
                value={h.kind + h.id}
                onSelect={() => go(h)}
              >
                <Mk mark={h.mark} />
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                {h.within && (
                  <span className="text-muted-foreground/80 text-xs">
                    {h.within}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      )}
      <div className="text-muted-foreground flex items-center gap-4 border-t px-4 py-2 text-xs">
        <span>
          Starts a thread. It becomes a track if the work turns out bigger.
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 max-[700px]:hidden">
          <Kbd>↩</Kbd>start
        </span>
        <span className="flex items-center gap-1 max-[700px]:hidden">
          <Kbd>⌘↩</Kbd>start and open
        </span>
      </div>
    </Command>
  )
}
