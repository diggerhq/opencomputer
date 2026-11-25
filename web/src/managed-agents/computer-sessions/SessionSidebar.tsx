import { Suspense, useRef, useState, type KeyboardEvent } from 'react'
import { Loader2, PanelRightClose } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { clampWidth, type SidebarPrefs } from './sidebar-prefs'
import { activeTab, SIDEBAR_TABS, type SidebarTab } from './sidebar-tabs'

/** How far an arrow key moves the edge. */
const KEY_STEP = 32

// The session page's right-hand sidebar: tabs onto the session's computer
// (Terminal now; Browser and Desktop later). Its left edge drags to resize.
// Closing it or switching tabs only hides a tab, so a shell outlives both.
export function SessionSidebar({
  sessionId,
  prefs,
  onChange,
  tabs = SIDEBAR_TABS,
}: {
  sessionId: string
  prefs: SidebarPrefs
  onChange: (change: Partial<SidebarPrefs>) => void
  tabs?: readonly SidebarTab[]
}) {
  const current = activeTab(prefs.tab, tabs)
  // Tabs shown at least once stay mounted.
  const [shown, setShown] = useState<string[]>([])
  if (prefs.open && !shown.includes(current.id))
    setShown([...shown, current.id])
  const [width, setWidth] = useState<number | null>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)

  if (!shown.length) return null
  const w = width ?? prefs.width

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') onChange({ width: clampWidth(w + KEY_STEP) })
    else if (e.key === 'ArrowRight')
      onChange({ width: clampWidth(w - KEY_STEP) })
    else return
    e.preventDefault()
  }

  return (
    <aside
      aria-label="Session computer"
      hidden={!prefs.open}
      style={{ width: w }}
      className="border-border relative flex min-h-0 max-w-[calc(100%-360px)] shrink-0 flex-col border-l bg-[#14120f]"
    >
      <button
        type="button"
        aria-label="Resize the sidebar"
        title="Drag, or use the arrow keys, to resize"
        onKeyDown={onKey}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId)
          drag.current = { x: e.clientX, width: w }
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setWidth(
              clampWidth(drag.current.width + drag.current.x - e.clientX),
            )
        }}
        onPointerUp={() => {
          if (drag.current && width !== null) onChange({ width })
          drag.current = null
          setWidth(null)
        }}
        className="hover:bg-primary/40 focus-visible:bg-primary/60 absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none"
      ></button>
      <div
        role="tablist"
        aria-label="Session computer"
        className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 px-2"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={t.id === current.id}
            aria-disabled={!t.available}
            disabled={!t.available}
            title={t.hint}
            onClick={() => onChange({ tab: t.id })}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-[#c2bcae]',
              t.id === current.id && 'bg-white/10 text-[#e6e1d8]',
              t.available
                ? 'hover:bg-white/5'
                : 'cursor-not-allowed opacity-50',
            )}
          >
            <t.icon className="size-3.5" aria-hidden />
            {t.label}
            {t.available ? null : (
              <span className="rounded bg-white/10 px-1 text-[10px]">Soon</span>
            )}
          </button>
        ))}
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto text-[#c2bcae]"
          aria-label="Close the sidebar"
          title="Close the sidebar"
          onClick={() => onChange({ open: false })}
        >
          <PanelRightClose />
        </Button>
      </div>
      {tabs
        .filter((t) => shown.includes(t.id))
        .map((t) => (
          <div
            key={t.id}
            role="tabpanel"
            aria-label={t.label}
            hidden={t.id !== current.id}
            className="flex min-h-0 flex-1 flex-col"
          >
            {t.component ? (
              <Suspense
                fallback={
                  <Loader2 className="m-3 size-4 animate-spin text-[#c2bcae]" />
                }
              >
                <t.component sessionId={sessionId} />
              </Suspense>
            ) : (
              <ComingSoon tab={t} />
            )}
          </div>
        ))}
    </aside>
  )
}

function ComingSoon({ tab }: { tab: SidebarTab }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-[#c2bcae]">
      <tab.icon className="size-5" aria-hidden />
      <p>{tab.label} is coming soon.</p>
    </div>
  )
}
