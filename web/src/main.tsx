import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import posthog from 'posthog-js'
import { PostHogProvider } from '@posthog/react'
import { createVendoClient, VendoProvider } from '@vendoai/ui'
import { VendoOverlay } from '@vendoai/ui/chrome'
import App from './App'
import { Toaster } from './components/ui/sonner'
import {
  ErrorBoundary,
  DefaultErrorFallback,
} from './components/error-boundary'
import { reloadForStaleChunk } from './lib/chunk-reload'
import { registry } from './vendo/registry'
import { theme } from './vendo/theme'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
})
const vendoClient = createVendoClient({ baseUrl: '/api/vendo' })

const PH_TOKEN = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN
const PH_HOST = import.meta.env.VITE_PUBLIC_POSTHOG_HOST
if (PH_TOKEN) {
  posthog.init(PH_TOKEN, {
    api_host: PH_HOST || 'https://us.i.posthog.com',
    defaults: '2025-05-24',
    person_profiles: 'identified_only',
  })
}

// After a deploy, an open tab still references the previous build's hashed route
// chunks; navigating to a not-yet-loaded route fails the dynamic import and Vite
// dispatches `vite:preloadError`. Reload once to pick up the new build instead
// of surfacing it as a render error. If the guard declines (a recent reload —
// likely a real failure), let it throw so the ErrorBoundary handles it.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForStaleChunk()) event.preventDefault()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PostHogProvider client={posthog}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <VendoProvider
            client={vendoClient}
            components={registry}
            theme={theme}
          >
            <ErrorBoundary
              fallback={(reset) => (
                <div className="bg-background flex min-h-screen items-center justify-center">
                  <DefaultErrorFallback onRetry={reset} />
                </div>
              )}
            >
              <App />
              <VendoOverlay />
            </ErrorBoundary>
          </VendoProvider>
          <Toaster theme="light" richColors closeButton />
        </BrowserRouter>
      </QueryClientProvider>
    </PostHogProvider>
  </React.StrictMode>,
)
