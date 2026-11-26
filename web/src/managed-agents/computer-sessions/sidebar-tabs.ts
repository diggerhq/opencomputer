import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { SquareTerminal, type LucideIcon } from 'lucide-react'

// The sidebar's tabs. Each one is a component that gets the session; adding a
// tab is writing that component and listing it here.

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
    hint: "A shell in this session's computer",
    component: SessionTerminal,
  },
]

/** The tab to show: the remembered one if it still exists, else the first. */
export function activeTab(
  id: string,
  tabs: readonly SidebarTab[] = SIDEBAR_TABS,
): SidebarTab {
  return tabs.find((t) => t.id === id) ?? tabs[0]
}
