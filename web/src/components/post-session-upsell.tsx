import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { useCreditState } from '@/hooks/useCreditState'
import {
  PLAN_OFFERS,
  UPGRADE_PLAN,
  billingOnrampV2Enabled,
  formatMinutes,
  planPriceLabel,
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

// Shown under a serverless-agent session once it has finished a turn, during
// the trial. Sessions don't expose per-session cost, so the card speaks in
// terms of the trial's work minutes instead.
export function PostSessionUpsell({
  sessionId,
  completed,
  className,
}: {
  sessionId: string
  completed: boolean
  className?: string
}) {
  const { billing, usagePlan, isHalted, creditsRemainingCents } =
    useCreditState()
  const minutes = billing?.workMinutes ?? null
  const spentMinutes = minutes
    ? Math.max(0, minutes.granted - minutes.remaining)
    : null
  const eligible =
    billingOnrampV2Enabled &&
    completed &&
    usagePlan === 'trial' &&
    !isHalted &&
    spentMinutes !== null &&
    spentMinutes > 0
  const seen = eligible ? rememberSession(sessionId) : null
  const show = seen?.show ?? false

  useEffect(() => {
    if (!show) return
    if (seen?.index === 0)
      trackFirstSessionCompleted({
        sessionId,
        usagePlan,
      })
    trackUpsellShown({
      surface: 'post_session_card',
      plan: UPGRADE_PLAN,
      usagePlan,
      creditsRemainingCents,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, sessionId])

  if (!show || !minutes || spentMinutes === null) return null
  return (
    <Panel
      className={`flex flex-wrap items-center justify-between gap-4 p-4 ${className ?? ''}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Sparkles className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="text-sm">
          <p className="font-medium">
            You&apos;ve used {formatMinutes(spentMinutes)} of your{' '}
            {formatMinutes(minutes.granted)} trial —{' '}
            {formatMinutes(minutes.remaining)} left.
          </p>
          <p className="text-muted-foreground mt-0.5">
            {planPriceLabel(UPGRADE_PLAN)} gives you{' '}
            {formatMinutes(PLAN_OFFERS[UPGRADE_PLAN].minutes)} a month.
          </p>
        </div>
      </div>
      <Button asChild size="sm">
        <Link
          to={upgradeHref(UPGRADE_PLAN)}
          onClick={() =>
            trackUpsellClicked({
              surface: 'post_session_card',
              plan: UPGRADE_PLAN,
              usagePlan,
              creditsRemainingCents,
            })
          }
        >
          Upgrade to {planPriceLabel(UPGRADE_PLAN)}
        </Link>
      </Button>
    </Panel>
  )
}
