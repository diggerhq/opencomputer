import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { useCreditState } from '@/hooks/useCreditState'
import { formatUsd, usageCostUsd, type UsageLike } from '@/lib/usage'
import {
  PLAN_OFFERS,
  billingOnrampV2Enabled,
  trackFirstSessionCompleted,
  trackUpsellClicked,
  trackUpsellShown,
  upgradeHref,
} from '@/lib/billing-onramp'

const SEEN_KEY = 'oc.billing.upsell_sessions'
const MAX_SESSIONS = 3
const ACTIVE_STATUSES = new Set(['queued', 'running'])

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

export function PostSessionUpsell({
  sessionId,
  status,
  usage,
}: {
  sessionId: string
  status: string
  usage: UsageLike
}) {
  const { usagePlan, isHalted, creditsRemainingCents } = useCreditState()
  const costUsd = usageCostUsd(usage)
  const eligible =
    billingOnrampV2Enabled &&
    usagePlan === 'base' &&
    !isHalted &&
    !ACTIVE_STATUSES.has(status) &&
    status !== 'archived' &&
    costUsd !== null &&
    costUsd > 0
  const seen = eligible ? rememberSession(sessionId) : null
  const show = seen?.show ?? false

  useEffect(() => {
    if (!show) return
    if (seen?.index === 0)
      trackFirstSessionCompleted({
        sessionId,
        costCents: Math.round((costUsd ?? 0) * 100),
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

  if (!show || costUsd === null) return null
  const pro = PLAN_OFFERS.pro
  const sessionsPerMonth = Math.floor(pro.creditsUsd / Math.max(costUsd, 0.01))
  return (
    <Panel className="mb-4 flex flex-wrap items-center justify-between gap-4 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Sparkles className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="text-sm">
          <p className="font-medium">
            This session cost {formatUsd(costUsd)} of your free credits
            {creditsRemainingCents !== undefined
              ? ` — $${(creditsRemainingCents / 100).toFixed(2)} left`
              : ''}
            .
          </p>
          <p className="text-muted-foreground mt-0.5">
            Pro is ${pro.priceUsd}/mo for ${pro.creditsUsd} in credits — about{' '}
            {sessionsPerMonth.toLocaleString()} sessions like this one every
            month, and sessions never pause.
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
