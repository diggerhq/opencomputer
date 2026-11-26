import { useCallback, useState } from 'react'

// The session page's right-hand sidebar, remembered per user in this browser:
// whether it is open, how wide, and which tab is showing.

export const SIDEBAR_MIN_WIDTH = 320
export const SIDEBAR_MAX_WIDTH = 960
export const SIDEBAR_DEFAULT_WIDTH = 560

export interface SidebarPrefs {
  open: boolean
  width: number
  tab: string
}

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = {
  open: false,
  width: SIDEBAR_DEFAULT_WIDTH,
  tab: 'terminal',
}

export const sidebarKey = (userId: string) =>
  `computer-session-sidebar:${userId}`

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.round(
    Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)),
  )
}

export function loadSidebarPrefs(userId: string): SidebarPrefs {
  try {
    const raw = localStorage.getItem(sidebarKey(userId))
    if (!raw) return DEFAULT_SIDEBAR_PREFS
    const p = JSON.parse(raw) as Partial<SidebarPrefs>
    return {
      open: typeof p.open === 'boolean' ? p.open : DEFAULT_SIDEBAR_PREFS.open,
      width: clampWidth(
        typeof p.width === 'number' ? p.width : SIDEBAR_DEFAULT_WIDTH,
      ),
      tab: typeof p.tab === 'string' ? p.tab : DEFAULT_SIDEBAR_PREFS.tab,
    }
  } catch {
    // A broken entry starts over.
    return DEFAULT_SIDEBAR_PREFS
  }
}

export function saveSidebarPrefs(userId: string, prefs: SidebarPrefs) {
  try {
    localStorage.setItem(sidebarKey(userId), JSON.stringify(prefs))
  } catch {
    // Storage full or blocked: the sidebar still works, it just forgets.
  }
}

/** The prefs, and a setter that saves them. */
export function useSidebarPrefs(
  userId: string,
): [SidebarPrefs, (change: Partial<SidebarPrefs>) => void] {
  const [prefs, setPrefs] = useState(() => loadSidebarPrefs(userId))
  const update = useCallback(
    (change: Partial<SidebarPrefs>) =>
      setPrefs((p) => {
        const next = { ...p, ...change }
        if (change.width !== undefined) next.width = clampWidth(change.width)
        saveSidebarPrefs(userId, next)
        return next
      }),
    [userId],
  )
  return [prefs, update]
}
