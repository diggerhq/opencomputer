import { useEffect, useRef, useState } from 'react'
import { useList, useS, useSurface } from '../hooks'
import type { ThreadView } from '../store/views'
import { I, Mk, when } from './bits'

// S1: the list. Tracks, then threads on their own, then Earlier.

function ThreadRow({ t, kid }: { t: ThreadView; kid?: boolean }) {
  const surface = useSurface()
  const sel = useS((s) => s.loc.thread === t.id)
  return (
    <div
      className={`row ${kid ? 'kid' : ''} ${sel ? 'sel' : ''}`}
      data-nav={`thread:${t.id}`}
      data-mark={t.mark ?? ''}
      onClick={() => surface.openThread(t.id)}
    >
      <Mk mark={t.mark} />
      <span className="n">{t.unread ? <b>{t.title}</b> : t.title}</span>
    </div>
  )
}

function OldRow({ t }: { t: ThreadView }) {
  const surface = useSurface()
  const sel = useS((s) => s.loc.thread === t.id)
  return (
    <div className={`row old ${sel ? 'sel' : ''}`} data-nav={`thread:${t.id}`} onClick={() => surface.openThread(t.id)}>
      <span className="n">{t.title}</span>
      <span className="wh">{t.done ? `${t.outcome ?? 'done'} · ` : ''}{when(t.place.doneAt ?? t.place.earlierAt)}</span>
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
  const ref = useRef<HTMLDivElement>(null)
  const [below, setBelow] = useState(0)

  // R9: nothing moves to the top; a blocked row out of sight is counted instead.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const count = () => {
      const bottom = el.getBoundingClientRect().bottom
      let n = 0
      for (const row of el.querySelectorAll('[data-mark=blocked]')) if (row.getBoundingClientRect().top >= bottom - 8) n++
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
      <div className="list" ref={ref}>
        {list.tracks.length > 0 && <div className="sec">Tracks</div>}
        {list.tracks.map((k) => {
          const open = !!openTracks[k.id]
          return (
            <div key={k.id}>
              <div
                className={`row tr ${selTrack === k.id ? 'sel' : ''}`}
                data-nav={`track:${k.id}`}
                data-mark={open ? '' : (k.mark ?? '')}
                onClick={() => surface.openTrack(k.id)}
              >
                <Mk mark={k.mark} />
                <span className="n">
                  {k.unread ? <b>{k.name}</b> : k.name}
                  <span className="st">{k.stand}</span>
                </span>
                <button
                  className={`chev ${open ? '' : 'shut'}`}
                  aria-label={open ? 'Collapse' : 'Expand'}
                  title={open ? 'Collapse' : 'Expand'}
                  onClick={(e) => {
                    e.stopPropagation()
                    surface.toggleTrack(k.id)
                  }}
                >
                  {I.chev}
                </button>
              </div>
              {open && k.threads.map((t) => <ThreadRow key={t.id} t={t} kid />)}
              {open && k.earlier > 0 && (
                <div className="fold" role="button" onClick={() => surface.toggleEarlier(k.id)}>
                  {k.earlier} earlier
                </div>
              )}
              {open && trackEarlierOpen[k.id] && k.earlierThreads.map((t) => <OldRow key={t.id} t={t} />)}
            </div>
          )
        })}
        {list.threads.length > 0 && <div className="sec">Threads</div>}
        {list.threads.map((t) => (
          <ThreadRow key={t.id} t={t} />
        ))}
        {list.earlier > 0 && (
          <div className="fold top" role="button" onClick={() => surface.toggleEarlier()}>
            {I.clock}Earlier · {list.earlier}
          </div>
        )}
        {earlierOpen && (
          <>
            {list.earlierTracks.map((k) => (
              <div key={k.id} className={`row old ${selTrack === k.id ? 'sel' : ''}`} data-nav={`track:${k.id}`} onClick={() => surface.openTrack(k.id)}>
                <span className="n">{k.name}</span>
                <span className="wh">{k.done ? 'done · ' : ''}{when(k.track.doneAt ?? k.track.standAt)}</span>
              </div>
            ))}
            {list.earlierThreads.map((t) => (
              <OldRow key={t.id} t={t} />
            ))}
            {more !== null && list.earlier > held && (
              <div className="fold more" role="button" onClick={() => void surface.loadEarlier()}>
                {list.earlier - held} more
              </div>
            )}
          </>
        )}
      </div>
      {below > 0 && (
        <button
          className="belowp"
          onClick={() => {
            const el = ref.current
            if (!el) return
            const bottom = el.getBoundingClientRect().bottom
            for (const row of el.querySelectorAll('[data-mark=blocked]'))
              if (row.getBoundingClientRect().top >= bottom - 8) return row.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }}
        >
          <Mk mark="blocked" />
          {below} below
        </button>
      )}
    </>
  )
}
