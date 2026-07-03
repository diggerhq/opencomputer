import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import posthog from 'posthog-js'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import {
  actionHandlers,
  decodeAction,
  type ActionEnvelope,
} from '@/lib/deferred-actions'

// /do — the deferred-action executor. Reads ?action=<envelope>, and:
//  - anonymous → captures the pre-auth `landed` event, then bounces to WorkOS
//    login carrying the full URL as returnTo (so we come back here and run).
//  - authenticated → executes the action once, strips the param, navigates.
// It lives OUTSIDE ProtectedRoute so the anonymous branch can fire analytics
// while the attribution-laden URL is still live.

// Decode the action from the live URL. Captured ONCE in state at mount, before
// runAction strips the param — computing it during render would flip to null
// after the strip.
function readEnvelope(): ActionEnvelope | null {
  const raw = new URLSearchParams(window.location.search).get('action')
  return raw ? decodeAction(raw) : null
}

export default function DeferredAction() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [envelope] = useState(readEnvelope)
  const supported = !!envelope && !!actionHandlers[envelope.type]
  // Non-null while showing the failure screen; holds the error message.
  const [failure, setFailure] = useState<string | null>(null)
  // One-shot guard: StrictMode double-invokes effects on the same fiber, so a
  // ref set before the first async hop keeps createAgent from running twice.
  const executedRef = useRef(false)

  const runAction = useCallback(
    async (env: ActionEnvelope) => {
      const handler = actionHandlers[env.type]
      if (!handler) return
      // Strip ONLY `action` before executing — keep utm_*/gclid siblings live
      // for the analytics session — so refresh/back can't replay the create.
      const url = new URL(window.location.href)
      url.searchParams.delete('action')
      window.history.replaceState(null, '', url.pathname + url.search)

      const started = performance.now()
      try {
        const result = await handler(env.params)
        posthog.capture('deferred_action_executed', {
          action_type: env.type,
          navigate_to: result.navigateTo, // carries the created agent id
          ms: Math.round(performance.now() - started),
        })
        void navigate(result.navigateTo, {
          replace: true,
          state: result.navigateState,
        })
      } catch (e) {
        posthog.capture('deferred_action_failed', {
          action_type: env.type,
          reason: 'api_error',
        })
        setFailure(e instanceof Error ? e.message : 'Something went wrong.')
      }
    },
    [navigate],
  )

  useEffect(() => {
    if (executedRef.current) return

    // Structurally invalid → record why and stop; no auth needed to show this.
    if (!supported) {
      executedRef.current = true
      posthog.capture('deferred_action_failed', {
        action_type: envelope?.type ?? null,
        reason: envelope ? 'unknown_type' : 'malformed',
      })
      return
    }
    if (loading) return // wait for auth to resolve before choosing the branch

    if (!user) {
      // Anonymous: record the top of the funnel while the URL is intact, then
      // hand off to login. sendBeacon so the batched event survives the nav.
      executedRef.current = true
      posthog.capture(
        'deferred_action_landed',
        { action_type: envelope.type, authenticated: false },
        { transport: 'sendBeacon' },
      )
      const returnTo = window.location.pathname + window.location.search
      window.location.replace(
        `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      )
      return
    }

    executedRef.current = true
    posthog.capture('deferred_action_landed', {
      action_type: envelope.type,
      authenticated: true,
    })
    // runAction only setStates after an await (network I/O); the rule can't see
    // through the callback and reads it as a synchronous effect setState.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runAction(envelope)
  }, [loading, user, supported, envelope, runAction])

  const retry = () => {
    if (!envelope) return
    setFailure(null)
    void runAction(envelope)
  }

  return (
    <div className="bg-background flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      {!supported ? (
        <>
          <p className="text-foreground text-sm font-medium">
            This link isn&rsquo;t supported.
          </p>
          <p className="text-muted-foreground max-w-sm text-sm">
            It may be from a newer version of the site. Head to your dashboard to
            keep going.
          </p>
          <Link
            to="/"
            className="text-foreground text-sm underline underline-offset-4"
          >
            Go to dashboard
          </Link>
        </>
      ) : failure !== null ? (
        <>
          <p className="text-foreground text-sm font-medium">
            Couldn&rsquo;t set up your agent.
          </p>
          {failure && (
            <p className="text-muted-foreground max-w-sm text-sm">{failure}</p>
          )}
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
            <Link
              to="/"
              className="text-muted-foreground text-sm underline underline-offset-4"
            >
              Go to dashboard
            </Link>
          </div>
        </>
      ) : (
        <>
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
          <span className="text-muted-foreground font-mono text-xs tracking-wide">
            Setting up your agent&hellip;
          </span>
        </>
      )}
    </div>
  )
}
