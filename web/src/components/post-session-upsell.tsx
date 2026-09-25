import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { useCreditState } from '@/hooks/useCreditState'
import {
  BASE_GRANT_CENTS,
  PLAN_OFFERS,
  billingOnrampV2Enabled,
  formatUsd,
  trackFirstSessionCompleted,
  trackUpsellClicked,
  trackUpsellShown,
  upgradeHref,
} from '@/lib/billing-onramp'

const SEEN_KEY = 'oc.billing.upsell_sessions'
const MAX_SESSIONS = 3

// Sessions this browser has already shown the card for. The card is only
// worth showing on the first few sessions — after that the value is proven
// and the sidebar meter/banner take over.
function rememberSession(sessionId: string): { index: number; show: boolean } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')
    const seen = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : []
    const existing = seen.indexOf(sessionId)
    if (existing >= 0) return { index: existing, show: existing < MAX_SESSIONS }
    if (seen.length >= MAX_SESSIONS) return { index: seen.length, show: false }
    seen.push(sessionId)
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
    return { index: seen.length - 1, show: true }
  } catch {
    return { index: 0, show: true }
  }
}

// Shown under a serverless-agent session once it has finished a turn. Sessions
// don't expose per-session cost, so the card speaks in terms of the org's free
// credit grant instead.
export function PostSessionUpsell({
  sessionId,
  completed,
  className,
}: {
  sessionId: string
  completed: boolean
  className?: string
}) {
  const { usagePlan, isHalted, creditsRemainingCents } = useCreditState()
  const spentCents =
    creditsRemainingCents === undefined
      ? null
      : Math.max(0, BASE_GRANT_CENTS - creditsRemainingCents)
  const eligible =
    billingOnrampV2Enabled &&
    completed &&
    usagePlan === 'base' &&
    !isHalted &&
    spentCents !== null &&
    spentCents > 0
  const seen = eligible ? rememberSession(sessionId) : null
  const show = seen?.show ?? false

  useEffect(() => {
    if (!show) return
    if (seen?.index === 0)
      trackFirstSessionCompleted({
        sessionId,
        costCents: spentCents ?? 0,
        usagePlan,
      })
    trackUpsellShown({
      surface: 'post_session_card',
      plan: 'pro',
      usagePlan,
      creditsRemainingCents,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, sessionId])

  if (!show || spentCents === null) return null
  const pro = PLAN_OFFERS.pro
  return (
    <Panel
      className={`flex flex-wrap items-center justify-between gap-4 p-4 ${className ?? ''}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Sparkles className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="text-sm">
          <p className="font-medium">
            You&apos;ve used {formatUsd(spentCents)} of your{' '}
            {formatUsd(BASE_GRANT_CENTS)} free credits —{' '}
            {formatUsd(creditsRemainingCents ?? 0)} left.
          </p>
          <p className="text-muted-foreground mt-0.5">
            Pro is ${pro.priceUsd}/mo for ${pro.creditsUsd} in credits —{' '}
            {Math.round(pro.creditsUsd / (BASE_GRANT_CENTS / 100))}× your free
            grant every month, and your agents never pause.
          </p>
        </div>
      </div>
      <Button asChild size="sm">
        <Link
          to={upgradeHref('pro')}
          onClick={() =>
            trackUpsellClicked({
              surface: 'post_session_card',
              plan: 'pro',
              usagePlan,
              creditsRemainingCents,
            })
          }
        >
          Upgrade to Pro — ${pro.priceUsd}/mo
        </Link>
      </Button>
    </Panel>
  )
}
