import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useList, useS, useSurface } from '../hooks'
import type { ThreadView } from '../store/views'
import { I, Mk, when } from './bits'

// S1: the list. Tracks, then threads on their own, then Earlier.

// A row; `data-sel` marks the open one, which J and K move from.
const ROW =
  'group/row relative flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-row-hover focus-visible:bg-row-hover data-sel:bg-row-selected'
const SEC = 'text-muted-foreground px-2 pt-3 pb-1 text-xs font-medium'
const FOLD =
  'text-muted-foreground/80 hover:bg-row-hover hover:text-muted-foreground flex w-full rounded-md py-1 pr-2 text-left text-[12.5px] outline-none focus-visible:bg-row-hover'
const WH = 'text-muted-foreground/70 flex-none text-xs tabular-nums'

function ThreadRow({ t, kid }: { t: ThreadView; kid?: boolean }) {
  const surface = useSurface()
  const sel = useS((s) => s.loc.thread === t.id)
  return (
    <button
      className={cn(ROW, kid && 'pl-7')}
      data-nav={`thread:${t.id}`}
      data-sel={sel || undefined}
      data-mark={t.mark ?? ''}
      onClick={() => surface.openThread(t.id)}
    >
      <Mk mark={t.mark} />
      <span
        className={cn('min-w-0 flex-1 truncate', t.unread && 'font-semibold')}
      >
        {t.title}
      </span>
    </button>
  )
}

function OldRow({ t }: { t: ThreadView }) {
  const surface = useSurface()
  const sel = useS((s) => s.loc.thread === t.id)
  return (
    <button
      className={cn(ROW, 'text-muted-foreground pl-[25px]')}
      data-nav={`thread:${t.id}`}
      data-sel={sel || undefined}
      onClick={() => surface.openThread(t.id)}
    >
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      <span className={WH}>
        {t.done ? `${t.outcome ?? 'done'} · ` : ''}
        {when(t.place.doneAt ?? t.place.earlierAt)}
      </span>
    </button>
  )
}

export function List() {
  const surface = useSurface()
  const list = useList()
  const openTracks = useS((s) => s.openTracks)
  const trackEarlierOpen = useS((s) => s.trackEarlierOpen)
  const earlierOpen = useS((s) => s.earlierOpen)
  const more = useS((s) => s.earlierNext[''])
  const selTrack = useS((s) => (s.loc.thread ? null : s.loc.track))
  const ref = useRef<HTMLDivElement>(null)
  const [below, setBelow] = useState(0)

  // R9: nothing moves to the top; a blocked row out of sight is counted instead.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const count = () => {
      const bottom = el.getBoundingClientRect().bottom
      let n = 0
      for (const row of el.querySelectorAll('[data-mark=blocked]'))
        if (row.getBoundingClientRect().top >= bottom - 8) n++
      setBelow(n)
    }
    count()
    el.addEventListener('scroll', count, { passive: true })
    const ro = new ResizeObserver(count)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', count)
      ro.disconnect()
    }
  }, [list, openTracks, earlierOpen])

  const held = list.earlierThreads.length + list.earlierTracks.length
  return (
    <>
      <div
        className="flex-1 [scrollbar-width:thin] overflow-y-auto px-2 pt-1 pb-3"
        data-slot="surface-list"
        ref={ref}
      >
        {list.tracks.length > 0 && <div className={SEC}>Tracks</div>}
        {list.tracks.map((k) => {
          const open = !!openTracks[k.id]
          return (
            <div key={k.id}>
              <div
                className={cn(ROW, 'h-11 items-start pt-1.5')}
                role="button"
                tabIndex={0}
                data-nav={`track:${k.id}`}
                data-sel={selTrack === k.id || undefined}
                data-mark={open ? '' : (k.mark ?? '')}
                onClick={() => surface.openTrack(k.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget)
                    surface.openTrack(k.id)
                }}
              >
                <Mk mark={k.mark} className="mt-[5px]" />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate',
                      k.unread && 'font-semibold',
                    )}
                  >
                    {k.name}
                  </span>
                  <span className="text-muted-foreground -mt-px block truncate text-xs">
                    {k.stand}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    'text-muted-foreground/80 transition-[opacity,transform]',
                    open
                      ? 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
                      : '-rotate-90',
                  )}
                  aria-label={open ? 'Collapse' : 'Expand'}
                  title={open ? 'Collapse' : 'Expand'}
                  onClick={(e) => {
                    e.stopPropagation()
                    surface.toggleTrack(k.id)
                  }}
                >
                  {I.chev}
                </Button>
              </div>
              {open && k.threads.map((t) => <ThreadRow key={t.id} t={t} kid />)}
              {open && k.earlier > 0 && (
                <button
                  className={cn(FOLD, 'pl-[45px]')}
                  aria-expanded={!!trackEarlierOpen[k.id]}
                  onClick={() => surface.toggleEarlier(k.id)}
                >
                  {k.earlier} earlier
                </button>
              )}
              {open &&
                trackEarlierOpen[k.id] &&
                k.earlierThreads.map((t) => <OldRow key={t.id} t={t} />)}
            </div>
          )
        })}
        {list.threads.length > 0 && <div className={SEC}>Threads</div>}
        {list.threads.map((t) => (
          <ThreadRow key={t.id} t={t} />
        ))}
        {list.earlier > 0 && (
          <button
            className={cn(
              FOLD,
              'text-muted-foreground mt-2.5 h-7 items-center gap-2 pl-2 text-sm tabular-nums',
            )}
            aria-expanded={earlierOpen}
            onClick={() => surface.toggleEarlier()}
          >
            {I.clock}Earlier · {list.earlier}
          </button>
        )}
        {earlierOpen && (
          <>
            {list.earlierTracks.map((k) => (
              <button
                key={k.id}
                className={cn(ROW, 'text-muted-foreground pl-[25px]')}
                data-nav={`track:${k.id}`}
                data-sel={selTrack === k.id || undefined}
                onClick={() => surface.openTrack(k.id)}
              >
                <span className="min-w-0 flex-1 truncate">{k.name}</span>
                <span className={WH}>
                  {k.done ? 'done · ' : ''}
                  {when(k.track.doneAt ?? k.track.standAt)}
                </span>
              </button>
            ))}
            {list.earlierThreads.map((t) => (
              <OldRow key={t.id} t={t} />
            ))}
            {more !== null && list.earlier > held && (
              <button
                className={cn(FOLD, 'pl-[25px]')}
                onClick={() => void surface.loadEarlier()}
              >
                {list.earlier - held} more
              </button>
            )}
          </>
        )}
      </div>
      {below > 0 && (
        <Button
          variant="outline"
          size="xs"
          className="bg-popover shadow-overlay absolute bottom-13 left-1/2 z-[4] -translate-x-1/2 rounded-full px-2.5"
          onClick={() => {
            const el = ref.current
            if (!el) return
            const bottom = el.getBoundingClientRect().bottom
            for (const row of el.querySelectorAll('[data-mark=blocked]'))
              if (row.getBoundingClientRect().top >= bottom - 8)
                return row.scrollIntoView({
                  block: 'center',
                  behavior: 'smooth',
                })
          }}
        >
          <Mk mark="blocked" />
          {below} below
        </Button>
      )}
    </>
  )
}
