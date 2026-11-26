import { useEffect, useMemo, useRef, useState } from 'react'
import { useList, useS, useSurface } from '../hooks'
import type { Mark } from '../store/views'
import { Mk } from './bits'

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
  return useS((s) => s.palette) ? <Open /> : null
}

function Open() {
  const surface = useSurface()
  const list = useList()
  const text = useS((s) => s.drafts.pal ?? '')
  const q = text.trim().toLowerCase()
  const [sel, setSel] = useState(-1)
  const [found, setFound] = useState<Hit[]>([])
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => box.current?.focus(), [])

  useEffect(() => {
    if (q.length < 2) return
    const t = setTimeout(() => {
      surface.search(q).then(
        (rows) => {
          const hits: Hit[] = []
          for (const r of rows) {
            if (r.kind === 'session' && r.role !== 'track') hits.push({ kind: 'thread', id: r.id, name: r.title || 'New thread', mark: null })
            else if (r.kind === 'track') hits.push({ kind: 'track', id: r.id, name: r.name || 'New track', mark: null })
          }
          setFound(hits)
        },
        () => {},
      )
    }, 200)
    return () => clearTimeout(t)
  }, [surface, q])

  const hits = useMemo(() => {
    if (!q) return []
    const all: Hit[] = []
    const tracks = [...list.tracks, ...list.earlierTracks]
    for (const k of tracks) all.push({ kind: 'track', id: k.id, name: k.name, mark: k.mark })
    for (const t of [...list.threads, ...list.earlierThreads]) all.push({ kind: 'thread', id: t.id, name: t.title, mark: t.mark })
    for (const k of tracks)
      for (const t of [...k.threads, ...k.earlierThreads]) all.push({ kind: 'thread', id: t.id, name: t.title, mark: t.mark, within: k.name })
    const seen = new Set<string>()
    return [...all.filter((h) => h.name.toLowerCase().includes(q)), ...(q.length < 2 ? [] : found)]
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
    <>
      <div className="scrim on" role="presentation" onClick={close} />
      <div className="pal on">
        <textarea
          ref={box}
          placeholder="What do you want done?"
          value={text}
          onChange={(e) => {
            surface.setDraft('pal', e.target.value)
            setSel(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // This layer only (R19).
              e.preventDefault()
              e.stopPropagation()
              close()
            } else if (e.key === 'ArrowDown' && hits.length) {
              e.preventDefault()
              setSel(Math.min(hits.length - 1, sel + 1))
            } else if (e.key === 'ArrowUp' && hits.length) {
              e.preventDefault()
              setSel(Math.max(-1, sel - 1))
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              const meta = e.metaKey || e.ctrlKey
              if (!meta && hits[sel]) go(hits[sel])
              else start(meta)
            }
          }}
        />
        {hits.length > 0 && (
          <div className="jump">
            <div className="sec">Or go to</div>
            {hits.map((h, i) => (
              <button className={i === sel ? 'row sel' : 'row'} key={h.kind + h.id} tabIndex={-1} onClick={() => go(h)}>
                <Mk mark={h.mark} />
                <span className="n">{h.name}</span>
                {h.within && (
                  <span className="w" style={{ color: 'var(--faint)', fontSize: 12 }}>
                    {h.within}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="pf">
          <span>Starts a thread. It becomes a track if the work turns out bigger.</span>
          <span style={{ flex: 1 }} />
          <span>
            <kbd>↩</kbd>start
          </span>
          <span>
            <kbd>⌘↩</kbd>start and open
          </span>
        </div>
      </div>
    </>
  )
}
