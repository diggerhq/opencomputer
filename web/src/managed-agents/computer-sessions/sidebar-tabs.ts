import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { AppWindow, Globe, SquareTerminal, type LucideIcon } from 'lucide-react'

// The sidebar's tabs. Each one is a component that gets the session; adding
// Browser or Desktop is writing that component and setting `available`.

export interface SidebarTabProps {
  sessionId: string
}

export interface SidebarTab {
  id: string
  label: string
  icon: LucideIcon
  /** False: the tab shows but cannot be chosen yet. */
  available: boolean
  /** What the tab is for, as its tooltip. */
  hint: string
  component?:
    | ComponentType<SidebarTabProps>
    | LazyExoticComponent<ComponentType<SidebarTabProps>>
}

// xterm is heavy: loaded when the terminal tab is first shown.
const SessionTerminal = lazy(() =>
  import('./SessionTerminal').then((m) => ({ default: m.SessionTerminal })),
)

export const SIDEBAR_TABS: readonly SidebarTab[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    icon: SquareTerminal,
    available: true,
    hint: "A shell in this session's computer",
    component: SessionTerminal,
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: Globe,
    available: false,
    hint: "The session's browser. Coming soon",
  },
  {
    id: 'desktop',
    label: 'Desktop',
    icon: AppWindow,
    available: false,
    hint: "The session's desktop. Coming soon",
  },
]

/** The tab to show: the remembered one if it is available, else the first that is. */
export function activeTab(
  id: string,
  tabs: readonly SidebarTab[] = SIDEBAR_TABS,
): SidebarTab {
  return (
    tabs.find((t) => t.id === id && t.available) ??
    tabs.find((t) => t.available) ??
    tabs[0]
  )
}
