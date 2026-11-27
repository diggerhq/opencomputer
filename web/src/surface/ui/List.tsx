import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from '@tanstack/react-virtual'
import { useCallback, useRef, type MouseEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useList, useS, useSurface } from '../hooks'
import type { ListView, ThreadView, TrackView } from '../store/views'
import { I } from './icons'
import { ago, when } from './day-label'
import { Mk } from './Mark'

// S1: the list. Tracks, then threads on their own, then Earlier, drawn as one
// virtual list of rows so a long Earlier costs only what is on screen.

// A row; `data-sel` marks the open one, which J and K move from.
const ROW =
  'group/row relative flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-row-hover focus-visible:bg-row-hover data-sel:bg-row-selected data-sel:text-strong'
// A section's label: furniture, quieter than the rows it heads.
const SEC = 'text-faint px-2 pt-5 pb-1 text-xs font-medium'
const FOLD =
  'text-faint hover:bg-row-hover hover:text-muted-foreground flex w-full rounded-md py-1 pr-2 text-left text-meta outline-none focus-visible:bg-row-hover'
const WH = 'text-faint flex-none text-xs tabular-nums'

// A click on a row puts the cursor in the opened pane's composer, so typing
// goes there and not to the letter keys. J and K click rows from code
// (`detail` 0) and keep focus where it is, so they go on moving.
const toComposer = (e: MouseEvent, key: string) => {
  if (!e.detail) return
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLTextAreaElement>(`textarea[data-draft="${key}"]`)
      ?.focus(),
  )
}

function ThreadRow({ t, kid }: { t: ThreadView; kid?: boolean }) {
  const surface = useSurface()
  const sel = useS((s) => s.loc.thread === t.id)
  return (
    <button
      className={cn(ROW, kid && 'pl-7')}
      data-nav={`thread:${t.id}`}
      data-sel={sel || undefined}
      data-mark={t.mark ?? ''}
      onClick={(e) => {
        surface.openThread(t.id)
        toComposer(e, `t:${t.id}`)
      }}
    >
      <Mk mark={t.mark} />
      <span
        className={cn('min-w-0 flex-1 truncate', t.unread && 'font-semibold')}
      >
        {t.title}
      </span>
      {t.subagents > 0 && (
        <span
          className={cn(WH, 'group-hover/row:hidden')}
          title={`${t.subagents} ${t.subagents === 1 ? 'subagent' : 'subagents'} running`}
        >
          {t.subagents} {t.subagents === 1 ? 'agent' : 'agents'}
        </span>
      )}
      <span className={cn(WH, 'hidden group-hover/row:inline')}>
        {ago(t.session.lastActiveAt)}
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
      onClick={(e) => {
        surface.openThread(t.id)
        toComposer(e, `t:${t.id}`)
      }}
    >
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      <span className={WH}>
        {t.done ? `${t.outcome ?? 'done'} · ` : ''}
        {when(t.place.doneAt ?? t.place.earlierAt)}
      </span>
    </button>
  )
}

// The list as rows, in the order they are drawn.
type Row =
  | { kind: 'sec'; key: string; label: string }
  | { kind: 'track'; key: string; k: TrackView }
  | { kind: 'thread'; key: string; t: ThreadView; kid?: boolean }
  | { kind: 'fold'; key: string; k: TrackView }
  | { kind: 'old'; key: string; t: ThreadView }
  | { kind: 'earlier'; key: string }
  | { kind: 'oldTrack'; key: string; k: TrackView }
  | { kind: 'more'; key: string; n: number }

function rowsOf(
  list: ListView,
  openTracks: Record<string, boolean>,
  trackEarlierOpen: Record<string, boolean>,
  earlierOpen: boolean,
  more: unknown,
): Row[] {
  const rows: Row[] = []
  if (list.tracks.length)
    rows.push({ kind: 'sec', key: 'sec:tracks', label: 'Tracks' })
  for (const k of list.tracks) {
    rows.push({ kind: 'track', key: `track:${k.id}`, k })
    if (!openTracks[k.id]) continue
    for (const t of k.threads)
      rows.push({ kind: 'thread', key: `thread:${t.id}`, t, kid: true })
    if (k.earlier > 0) rows.push({ kind: 'fold', key: `fold:${k.id}`, k })
    if (trackEarlierOpen[k.id])
      for (const t of k.earlierThreads)
        rows.push({ kind: 'old', key: `old:${t.id}`, t })
  }
  if (list.threads.length)
    rows.push({ kind: 'sec', key: 'sec:threads', label: 'Threads' })
  for (const t of list.threads)
    rows.push({ kind: 'thread', key: `thread:${t.id}`, t })
  if (list.earlier > 0) rows.push({ kind: 'earlier', key: 'earlier' })
  if (earlierOpen) {
    for (const k of list.earlierTracks)
      rows.push({ kind: 'oldTrack', key: `oldTrack:${k.id}`, k })
    for (const t of list.earlierThreads)
      rows.push({ kind: 'old', key: `old:${t.id}`, t })
    const held = list.earlierThreads.length + list.earlierTracks.length
    if (more !== null && list.earlier > held)
      rows.push({ kind: 'more', key: 'more', n: list.earlier - held })
  }
  return rows
}

// What a row shows as `data-mark`: the "below" count looks for blocked ones.
const blocked = (r: Row, openTracks: Record<string, boolean>) =>
  (r.kind === 'thread' && r.t.mark === 'blocked') ||
  (r.kind === 'track' && !openTracks[r.k.id] && r.k.mark === 'blocked')

function TrackRow({ k }: { k: TrackView }) {
  const surface = useSurface()
  const open = useS((s) => !!s.openTracks[k.id])
  const sel = useS((s) => !s.loc.thread && s.loc.track === k.id)
  return (
    <div
      className={cn(ROW, 'h-11 items-start pt-1.5')}
      role="button"
      tabIndex={0}
      data-nav={`track:${k.id}`}
      data-sel={sel || undefined}
      data-mark={open ? '' : (k.mark ?? '')}
      onClick={(e) => {
        surface.openTrack(k.id)
        toComposer(e, `k:${k.id}`)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget)
          surface.openTrack(k.id)
      }}
    >
      <Mk mark={k.mark} className="mt-[5px]" />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', k.unread && 'font-semibold')}>
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
          'text-faint transition-[opacity,transform]',
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
  const selKey = useS((s) =>
    s.loc.thread
      ? `thread:${s.loc.thread}`
      : s.loc.track
        ? `track:${s.loc.track}`
        : null,
  )
  const synced = useS((s) => s.synced)
  const ref = useRef<HTMLDivElement>(null)
  const rows = rowsOf(list, openTracks, trackEarlierOpen, earlierOpen, more)

  // J and K move from the open row to its neighbours by what is drawn, so the
  // open row and the rows either side of it are drawn even when out of sight.
  const sel = rows.findIndex(
    (r) =>
      r.key === selKey ||
      (r.kind === 'old' && `thread:${r.t.id}` === selKey) ||
      (r.kind === 'oldTrack' && `track:${r.k.id}` === selKey),
  )
  const rangeExtractor = useCallback(
    (range: Range) => {
      const at = defaultRangeExtractor(range)
      if (sel < 0) return at
      const keep = [sel - 1, sel, sel + 1].filter(
        (i) => i >= 0 && i < range.count,
      )
      return [...new Set([...at, ...keep])].sort((a, b) => a - b)
    },
    [sel],
  )

  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: (i) =>
      ({ sec: 40, track: 44, earlier: 38, fold: 26, more: 26 })[
        rows[i].kind as 'sec'
      ] ?? 28,
    getItemKey: (i) => rows[i].key,
    rangeExtractor,
    paddingStart: 4,
    paddingEnd: 12,
    overscan: 10,
  })

  // R9: nothing moves to the top; a blocked row out of sight is counted
  // instead, from the rows' measured places rather than what is drawn.
  const bottom = (v.scrollOffset ?? 0) + (v.scrollRect?.height ?? 0) - 8
  const measured = v.measurementsCache
  const below: number[] = []
  if (v.scrollRect?.height)
    rows.forEach((r, i) => {
      if (blocked(r, openTracks) && (measured[i]?.start ?? 0) >= bottom)
        below.push(i)
    })

  const draw = (r: Row): ReactNode => {
    switch (r.kind) {
      case 'sec':
        return <div className={SEC}>{r.label}</div>
      case 'track':
        return <TrackRow k={r.k} />
      case 'thread':
        return <ThreadRow t={r.t} kid={r.kid} />
      case 'fold':
        return (
          <button
            className={cn(FOLD, 'pl-[45px]')}
            aria-expanded={!!trackEarlierOpen[r.k.id]}
            onClick={() => surface.toggleEarlier(r.k.id)}
          >
            {r.k.earlier} earlier
          </button>
        )
      case 'old':
        return <OldRow t={r.t} />
      case 'earlier':
        return (
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
        )
      case 'oldTrack':
        return (
          <button
            className={cn(ROW, 'text-muted-foreground pl-[25px]')}
            data-nav={`track:${r.k.id}`}
            data-sel={selTrack === r.k.id || undefined}
            onClick={(e) => {
              surface.openTrack(r.k.id)
              toComposer(e, `k:${r.k.id}`)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{r.k.name}</span>
            <span className={WH}>
              {r.k.done ? 'done · ' : ''}
              {when(r.k.track.doneAt ?? r.k.track.standAt)}
            </span>
          </button>
        )
      case 'more':
        return (
          <button
            className={cn(FOLD, 'pl-[25px]')}
            onClick={() => void surface.loadEarlier()}
          >
            {r.n} more
          </button>
        )
    }
  }

  if (!rows.length)
    return (
      <div className="flex-1 px-4 pt-3" data-slot="surface-list">
        {synced ? (
          <p className="text-muted-foreground text-meta">Nothing here yet.</p>
        ) : (
          // Held rows are drawn at once; this is only a first visit.
          <div className="space-y-2 pt-1" aria-label="Loading">
            {[70, 55, 62].map((w) => (
              <Skeleton key={w} className="h-4" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
      </div>
    )

  return (
    <>
      <div
        className="flex-1 [scrollbar-width:thin] overflow-y-auto px-2"
        data-slot="surface-list"
        ref={ref}
      >
        <div className="relative" style={{ height: v.getTotalSize() }}>
          {v.getVirtualItems().map((it) => (
            <div
              key={it.key}
              ref={v.measureElement}
              data-index={it.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${it.start}px)` }}
            >
              {draw(rows[it.index])}
            </div>
          ))}
        </div>
      </div>
      {below.length > 0 && (
        <Button
          variant="outline"
          size="xs"
          className="bg-popover shadow-overlay absolute bottom-13 left-1/2 z-[4] -translate-x-1/2 rounded-full px-2.5"
          onClick={() =>
            v.scrollToIndex(below[0], { align: 'center', behavior: 'smooth' })
          }
        >
          <Mk mark="blocked" />
          {below.length} below
        </Button>
      )}
    </>
  )
}
