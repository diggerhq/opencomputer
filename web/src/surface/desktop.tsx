// First: before any module builds a zod schema.
import './jitless'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from '@/components/ui/sonner'
import type { Host } from './host'
import { Surface } from './Surface'

// The desktop bundle's entry (spec 25): the same surface, given the shell's
// bridge. Opened in a browser, where there is no bridge, it says so.

// The dashboard's theme, before the first paint (index.html does this inline;
// the app's CSP has no inline scripts).
const stored = localStorage.getItem('oc.theme')
document.documentElement.classList.toggle(
  'dark',
  stored
    ? stored === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches,
)

async function host(): Promise<Host | null> {
  return window.oc
    ? (await import('./host-desktop')).desktopHost(window.oc)
    : null
}

// The dashboard gives the web tab its query client; the desktop has its own.
const queries = new QueryClient()

void host().then((h) =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queries}>
        {h ? (
          <Surface host={h} />
        ) : (
          <p className="text-muted-foreground p-6 text-sm">
            This bundle runs inside the OpenComputer desktop app.
          </p>
        )}
        <Toaster />
      </QueryClientProvider>
    </StrictMode>,
  ),
)
