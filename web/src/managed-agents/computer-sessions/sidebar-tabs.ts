import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { Globe, SquareTerminal, type LucideIcon } from 'lucide-react'
import type { Capabilities } from '../computer-sessions-api'

// The sidebar's tabs. Each one is a component that gets the session; adding a
// tab is writing that component and listing it here. A tab with `available`
// shows only where the computer's capabilities say so.

export interface SidebarTabProps {
  sessionId: string
}

export interface SidebarTab {
  id: string
  label: string
  icon: LucideIcon
  /** What the tab is for, as its tooltip. */
  hint: string
  component:
    | ComponentType<SidebarTabProps>
    | LazyExoticComponent<ComponentType<SidebarTabProps>>
  available?: (features: Capabilities['features']) => boolean
}

// xterm is heavy: loaded when the terminal tab is first shown.
const SessionTerminal = lazy(() =>
  import('./SessionTerminal').then((m) => ({ default: m.SessionTerminal })),
)

const SessionBrowser = lazy(() =>
  import('./SessionBrowser').then((m) => ({ default: m.SessionBrowser })),
)

export const SIDEBAR_TABS: readonly SidebarTab[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    icon: SquareTerminal,
    hint: "A shell in this session's computer",
    component: SessionTerminal,
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: Globe,
    hint: "A browser in this session's computer, for its localhost and the web",
    component: SessionBrowser,
    available: (f) => f.browser === true,
  },
]

/** The tabs this computer offers; before its capabilities load, those that need none. */
export function tabsFor(
  caps: Pick<Capabilities, 'features'> | undefined,
  tabs: readonly SidebarTab[] = SIDEBAR_TABS,
): readonly SidebarTab[] {
  return tabs.filter(
    (t) => !t.available || (caps && t.available(caps.features)),
  )
}

/** The tab to show: the remembered one if it still exists, else the first. */
export function activeTab(
  id: string,
  tabs: readonly SidebarTab[] = SIDEBAR_TABS,
): SidebarTab {
  return tabs.find((t) => t.id === id) ?? tabs[0]
}
