import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Host } from './host'
import { SurfaceContext, useList, useOpenTrackId, useS, useSurface } from './hooks'
import { createSurface, type Surface as SurfaceApi } from './store'
import { idbStorage } from './store/idb'
import { I } from './ui/bits'
import { KeysSheet, Toasts } from './ui/Chrome'
import { bindKeys } from './ui/keys'
import { List } from './ui/List'
import { Palette } from './ui/Palette'
import { StartBox } from './ui/StartBox'
import { ThreadPane } from './ui/ThreadPane'
import { TrackPane } from './ui/TrackPane'
import './ui/surface.css'
import './ui/shell.css'

// The surface (spec part one): the list, the two panes, and what opens over
// them. The same tree in the web tab and the Mac app; `host` is the difference.

const Review = lazy(() => import('./ui/Review'))

const MODE = { L1: 'm-tp', L2: 'm-kp', L3: 'm-t' } as const

function Shell() {
  const surface = useSurface()
  const root = useRef<HTMLDivElement>(null)
  const loc = useS((s) => s.loc)
  const ready = useS((s) => s.ready)
  const listHidden = useS((s) => s.listHidden)
  const theme = useS((s) => s.theme)
  const status = useS((s) => s.status)
  const trackId = useOpenTrackId()
  const layout = useS((s) => (trackId ? (s.layout[trackId] ?? 'L1') : 'L1'))
  const blocked = useList().blocked

  useEffect(() => (root.current ? bindKeys(root.current, surface) : undefined), [surface])
  // The tab says when something is blocked on the person (R27).
  useEffect(() => {
    document.title = `${blocked ? '● ' : ''}OpenComputer`
  }, [blocked])

  const dark =
    theme === 'dark' || (theme === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches)
  const mode = loc.thread ? (trackId ? MODE[layout] : 'm-t') : loc.track ? 'm-k' : 'm-new'
  const me = surface.host.name ?? ''

  return (
    <div className="surface" data-theme={dark ? 'dark' : 'light'} data-platform={surface.host.platform} ref={root}>
      <div className={`app ${listHidden ? 'nosb' : ''}`}>
        <aside className="side">
          <div className="top">
            {surface.host.platform === 'desktop' && <div className="lights" />}
            <button className="ib" data-act="sidebar" aria-label={listHidden ? 'Show list' : 'Hide list'} onClick={() => surface.toggleList()}>
              {I.side}
            </button>
          </div>
          <button className={`newb ${mode === 'm-new' ? 'on' : ''}`} onClick={() => surface.openStart()}>
            {I.compose}New<kbd>N</kbd>
          </button>
          {ready && <List />}
          <div className="foot">
            {me && <span className="av">{me[0].toUpperCase()}</span>}
            {me}
            {status === 'offline' && <span className="off">Offline</span>}
            <span style={{ flex: 1 }} />
            <button
              className="ib r"
              aria-label="Theme"
              data-tip="Light or dark"
              onClick={() => surface.setTheme(dark ? 'light' : 'dark')}
            >
              {I.theme}
            </button>
            <button className="ib r" aria-label="Shortcuts" data-tip="Shortcuts  ?" onClick={() => surface.setKeysSheet(true)}>
              {I.help}
            </button>
          </div>
        </aside>
        <main className={`main ${mode}`}>
          <section className="pane" id="track">
            {ready && trackId && <TrackPane key={trackId} tid={trackId} />}
          </section>
          <section className="pane" id="thread">
            {ready && loc.thread && <ThreadPane key={loc.thread} sid={loc.thread} />}
          </section>
          {loc.result && (
            <Suspense fallback={null}>
              <Review key={loc.result} resultId={loc.result} />
            </Suspense>
          )}
          {mode === 'm-new' && <StartBox />}
        </main>
      </div>
      <Palette />
      <KeysSheet />
      <Toasts />
    </div>
  )
}

export function Surface({ host }: { host: Host }) {
  // Made in an effect: a closed surface is never reused (StrictMode mounts twice).
  const [surface, setSurface] = useState<SurfaceApi | null>(null)
  useEffect(() => {
    const key = `oc-surface:${host.principal.org}:${host.principal.subject}`
    const made = createSurface({
      host,
      storage: idbStorage(host.principal),
      kept: { get: () => localStorage.getItem(key), set: (v) => localStorage.setItem(key, v) },
    })
    setSurface(made)
    return () => made.close()
  }, [host])
  if (!surface) return null
  return (
    <SurfaceContext.Provider value={surface}>
      <Shell />
    </SurfaceContext.Provider>
  )
}
