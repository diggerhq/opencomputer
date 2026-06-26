import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'

interface Props {
  children: ReactNode
  /** Render the recovery UI; `reset` clears the error and re-renders children. */
  fallback?: (reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches render-time errors in its subtree so an unexpected throw shows a
 * recovery UI instead of a blank white screen. Pair it with a `key` (e.g. the
 * route pathname) to auto-reset on navigation.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Unhandled UI error:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
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
