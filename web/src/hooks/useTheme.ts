import { useSyncExternalStore } from 'react'

// Theme is a DOM-level fact (the `.dark` class on <html>, applied before React
// boots by the inline script in index.html) so it can't live in component
// state — the toaster and every toggle must observe the same value.
const STORAGE_KEY = 'oc.theme'
const listeners = new Set<() => void>()

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

export function useTheme() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false)
  const setDark = (next: boolean) => {
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light')
    listeners.forEach((listener) => listener())
  }
  return { dark, setDark }
}
