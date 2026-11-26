import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from '@/components/ui/sonner'
import type { Host } from './host'
import { Surface } from './Surface'

// The desktop bundle's entry (spec 25): the same surface, given the shell's
// bridge. Opened in a browser, where there is no bridge, it runs on the fake
// server so the bundle can be looked at on its own.

// The dashboard's theme, before the first paint (index.html does this inline;
// the app's CSP has no inline scripts).
const stored = localStorage.getItem('oc.theme')
document.documentElement.classList.toggle(
  'dark',
  stored
    ? stored === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches,
)

async function host(): Promise<Host> {
  if (window.oc) return (await import('./host-desktop')).desktopHost(window.oc)
  return (await import('./host-fake')).fakeHost({
    base: '',
    platform: 'desktop',
  })
}

void host().then((h) =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Surface host={h} />
      <Toaster />
    </StrictMode>,
  ),
)
