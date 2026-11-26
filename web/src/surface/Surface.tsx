import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import '@/index.css'
import type { Host } from './host'
import {
  SurfaceContext,
  useList,
  useOpenTrackId,
  useS,
  useSurface,
} from './hooks'
import { createSurface, type Surface as SurfaceApi } from './store'
import { idbStorage } from './store/idb'
import { DRAG, I, Tip } from './ui/bits'
import { KeysSheet, Toasts } from './ui/Chrome'
import { bindKeys } from './ui/keys'
import { List } from './ui/List'
import { Palette } from './ui/Palette'
import { StartBox } from './ui/StartBox'
import { ThreadPane } from './ui/ThreadPane'
import { TrackPane } from './ui/TrackPane'

// The surface (spec part one): the list, the two panes, and what opens over
// them. The same tree in the web tab and the Mac app; `host` is the difference.

const Review = lazy(() => import('./ui/Review'))

type Mode = 'tp' | 'kp' | 't' | 'k' | 'new'
const MODE = { L1: 'tp', L2: 'kp', L3: 't' } as const

// How the two panes share the width in each mode. Too narrow for two panes,
// the thread or its track shows alone, picked from the list.
const PANE =
  'flex min-w-0 flex-col overflow-hidden transition-[flex-grow,flex-basis,opacity] duration-200 ease-out'
const TRACK: Record<Mode, string> = {
  tp: 'basis-[348px] grow-0 shrink-0 border-r max-[960px]:basis-0 max-[960px]:opacity-0 max-[960px]:border-0',
  kp: 'basis-0 grow border-r max-[960px]:grow-0 max-[960px]:opacity-0 max-[960px]:border-0',
  t: 'basis-0 grow-0 opacity-0',
  k: 'basis-0 grow',
  new: 'basis-0 grow-0 opacity-0',
}
const THREAD: Record<Mode, string> = {
  tp: 'basis-0 grow',
  kp: 'basis-[420px] grow-0 shrink-0 max-[1100px]:basis-[380px] max-[960px]:basis-0 max-[960px]:grow',
  t: 'basis-0 grow',
  k: 'basis-0 grow-0 opacity-0',
  new: 'basis-0 grow-0 opacity-0',
}

function Shell() {
  const surface = useSurface()
  const root = useRef<HTMLDivElement>(null)
  const loc = useS((s) => s.loc)
  const ready = useS((s) => s.ready)
  const listHidden = useS((s) => s.listHidden)
  const status = useS((s) => s.status)
  const trackId = useOpenTrackId()
  const layout = useS((s) => (trackId ? (s.layout[trackId] ?? 'L1') : 'L1'))
  const blocked = useList().blocked
  // The dashboard's theme (`.dark` on <html>), so the two toggles agree.
  const { dark, setDark } = useTheme()

  useEffect(
    () => (root.current ? bindKeys(root.current, surface) : undefined),
    [surface],
  )
  // The tab says when something is blocked on the person (R27).
  useEffect(() => {
    document.title = `${blocked ? '● ' : ''}OpenComputer`
  }, [blocked])

  const mode: Mode = loc.thread
    ? trackId
      ? MODE[layout]
      : 't'
    : loc.track
      ? 'k'
      : 'new'
  const me = surface.host.name ?? ''
  const desktop = surface.host.platform === 'desktop'

  const sideButton = (
    <Tip label={listHidden ? 'Show list  [' : 'Hide list  ['} side="right">
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(
          'text-muted-foreground',
          listHidden && 'fixed top-2.5 left-2 z-10',
        )}
        aria-label={listHidden ? 'Show list' : 'Hide list'}
        onClick={() => surface.toggleList()}
      >
        {I.side}
      </Button>
    </Tip>
  )

  return (
    <TooltipProvider delayDuration={500}>
      <div
        className="surface bg-background text-foreground fixed inset-0 overflow-hidden text-sm antialiased"
        data-platform={surface.host.platform}
        data-list={listHidden ? 'hidden' : 'shown'}
        ref={root}
      >
        <div className="flex h-full">
          <aside
            className={cn(
              'bg-sidebar relative flex w-68 flex-none flex-col border-r transition-[margin] duration-200 ease-out select-none max-[700px]:w-screen max-[700px]:border-0',
              listHidden && '-ml-68 max-[700px]:-ml-[100vw]',
            )}
          >
            <div
              className={cn(
                'flex h-12 flex-none items-center gap-2 px-3',
                DRAG,
              )}
            >
              {/* The window's own buttons sit at the left in the Mac app. */}
              {desktop && <span className="flex-1" />}
              {sideButton}
            </div>
            <Button
              variant="outline"
              className={cn(
                'text-muted-foreground mx-2 mb-1 justify-start gap-2 px-2 font-normal',
                mode === 'new' && 'text-foreground border-input',
              )}
              onClick={() => surface.openStart()}
            >
              {I.compose}New<Kbd className="ml-auto">N</Kbd>
            </Button>
            {ready && <List />}
            <div className="text-muted-foreground flex items-center gap-1 border-t px-2 py-2 text-[13px]">
              {me && (
                <span className="bg-secondary text-foreground mr-1.5 flex size-6 items-center justify-center rounded-full text-xs font-medium">
                  {me[0].toUpperCase()}
                </span>
              )}
              <span className="truncate">{me}</span>
              {status === 'offline' && (
                <span className="text-muted-foreground/70 ml-2">Offline</span>
              )}
              <span className="flex-1" />
              <Tip label="Light or dark">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label="Theme"
                  onClick={() => setDark(!dark)}
                >
                  {I.theme}
                </Button>
              </Tip>
              <Tip
                label={
                  <>
                    Shortcuts <Kbd>?</Kbd>
                  </>
                }
              >
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label="Shortcuts"
                  onClick={() => surface.setKeysSheet(true)}
                >
                  {I.help}
                </Button>
              </Tip>
            </div>
          </aside>
          <main
            className="relative flex min-w-0 flex-1 max-[700px]:overflow-clip"
            data-mode={mode}
          >
            <section
              className={cn(PANE, 'bg-sidebar/50', TRACK[mode])}
              id="track"
            >
              {ready && trackId && <TrackPane key={trackId} tid={trackId} />}
            </section>
            <section
              className={cn(PANE, '@container', THREAD[mode])}
              id="thread"
            >
              {ready && loc.thread && (
                <ThreadPane key={loc.thread} sid={loc.thread} />
              )}
            </section>
            {loc.result && (
              <Suspense fallback={null}>
                <Review key={loc.result} resultId={loc.result} />
              </Suspense>
            )}
            {mode === 'new' && <StartBox />}
          </main>
        </div>
        <Palette />
        <KeysSheet />
        <Toasts />
      </div>
    </TooltipProvider>
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
      kept: {
        get: () => localStorage.getItem(key),
        set: (v) => localStorage.setItem(key, v),
      },
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
