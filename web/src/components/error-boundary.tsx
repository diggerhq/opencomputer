import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { isChunkLoadError, reloadForStaleChunk } from '@/lib/chunk-reload'

interface Props {
  children: ReactNode
  /** Render the recovery UI; `reset` clears the error and re-renders children. */
  fallback?: (reset: () => void) => ReactNode
}

interface State {
  error: Error | null
  /** A chunk-load error we're recovering from by reloading — render nothing. */
  recovering: boolean
}

/**
 * Catches render-time errors in its subtree so an unexpected throw shows a
 * recovery UI instead of a blank white screen. Pair it with a `key` (e.g. the
 * route pathname) to auto-reset on navigation.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, recovering: false }

  static getDerivedStateFromError(error: Error): State {
    // A failed dynamic import (usually a stale code-split chunk after a deploy)
    // is recoverable by reloading. Mark it so render shows nothing until
    // componentDidCatch decides — avoids flashing the error UI before reload.
    return { error, recovering: isChunkLoadError(error) }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    if (isChunkLoadError(error)) {
      // Backstop for import failures the main.tsx vite:preloadError handler
      // misses. Reload once; if the guard declines (already reloaded — likely a
      // real failure, not a stale chunk), fall through to the error UI.
      if (reloadForStaleChunk()) return
      this.setState({ recovering: false })
    }
    console.error('Unhandled UI error:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null, recovering: false })

  render() {
    if (this.state.recovering) return null
    if (this.state.error) {
      return this.props.fallback ? (
        this.props.fallback(this.reset)
      ) : (
        <DefaultErrorFallback onRetry={this.reset} />
      )
    }
    return this.props.children
  }
}

export function DefaultErrorFallback({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      icon={TriangleAlert}
      title="Something went wrong"
      description="This view hit an unexpected error. Try again, or reload the page if it keeps happening."
      action={
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      }
    />
  )
}
