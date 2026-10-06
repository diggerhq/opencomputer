import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import posthog from 'posthog-js'
import { PostHogProvider } from '@posthog/react'
import App from './App'
import { Toaster } from './components/ui/sonner'
import {
  ErrorBoundary,
  DefaultErrorFallback,
} from './components/error-boundary'
import { reloadForStaleChunk } from './lib/chunk-reload'
import { recordTouch } from './lib/attribution'
import { ME_QUERY_KEY } from './hooks/useAuth'
import { ApiError } from './api/errors'
import './index.css'

// When the dashboard session expires (laptop sleep, cookie TTL), the polling
// queries are the first to see the 401 — ['me'] keeps serving its cached user,
// so ProtectedRoute never redirects and screens render "not found" instead.
// Drop the cached user on any 401 so the auth gate re-checks and sends the
// user to login. Skipped when no user is cached: ['me'] itself failing with
// 401 is the normal signed-out state and must not loop.
const queryCache = new QueryCache({
  onError: (error) => {
    if (!(error instanceof ApiError) || error.status !== 401) return
    if (queryClient.getQueryData(ME_QUERY_KEY) === undefined) return
    void queryClient.resetQueries({ queryKey: ME_QUERY_KEY, exact: true })
  },
})

const queryClient = new QueryClient({
  queryCache,
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
})

// Sign-up attribution: record this landing's source into the shared `oc_attr`
// cookie once, on first load, before PostHog starts. Best-effort — attribution
// must never break the dashboard.
try {
  recordTouch()
} catch {
  // ignore
}

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
          <ErrorBoundary
            fallback={(reset) => (
              <div className="bg-background flex min-h-screen items-center justify-center">
                <DefaultErrorFallback onRetry={reset} />
              </div>
            )}
          >
            <App />
          </ErrorBoundary>
          <Toaster richColors closeButton />
        </BrowserRouter>
      </QueryClientProvider>
    </PostHogProvider>
  </React.StrictMode>,
)
