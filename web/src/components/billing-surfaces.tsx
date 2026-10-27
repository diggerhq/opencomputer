import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { CircleAlert, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useCreditState } from '@/hooks/useCreditState'
import { useBillingActions } from '@/hooks/useBillingActions'
import {
  BILLING_ACTION_LABELS,
  CREDIT_PACKS_USD,
  PAID_PLANS,
  PLAN_NAMES,
  PLAN_OFFERS,
  billingActionHref,
  billingOnrampV2Enabled,
  billingPillText,
  formatMinutes,
  haltNotice,
  trackPaywallShown,
  trackWarningShown,
  warningNotice,
} from '@/lib/billing-onramp'
import { cn } from '@/lib/utils'

// The app-shell billing surfaces of serverless-agents-ws 086 ("Surfaces"):
// the header pill, the warning banner and the halt modal. All read the shared
// 'autumn-billing' poll; legacy orgs 404 there and see none of them.

export function BillingPill({ className }: { className?: string }) {
  const { billing } = useCreditState()
  const text = billing ? billingPillText(billing) : null
  if (!billingOnrampV2Enabled || !text) return null
  // The trial pill is filled and asks to upgrade, so a trial org can't miss it;
  // a paid org's stays quiet.
  const trial = billing?.usagePlan === 'trial' && !billing.isHalted
  return (
    <Link
      to="/billing"
      className={cn(
        'rounded-full border font-mono whitespace-nowrap transition-colors',
        trial
          ? 'bg-primary text-primary-foreground border-primary inline-flex items-center gap-2 py-1 pr-1 pl-3 text-xs font-medium hover:opacity-90'
          : 'text-muted-foreground hover:text-foreground hover:border-foreground/30 px-3 py-1 text-[11px]',
        billing?.isHalted && 'border-destructive/40 text-destructive',
        className,
      )}
    >
      {text}
      {trial && (
        <span className="bg-primary-foreground text-primary rounded-full px-2 py-0.5 font-sans font-semibold">
          Upgrade
        </span>
      )}
    </Link>
  )
}

export function BillingWarningBanner() {
  const location = useLocation()
  const { billing, warning } = useCreditState()
  const onBilling = location.pathname.startsWith('/billing')
  useEffect(() => {
    if (warning) trackWarningShown(warning)
  }, [warning])
  if (!billingOnrampV2Enabled || !warning || !billing) return null
  const notice = warningNotice(warning, billing)
  const urgent = warning === 'payment_failed'
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-center gap-2 border-b px-4 py-2.5 text-center text-sm font-medium sm:px-8',
        urgent
          ? 'border-destructive/40 bg-status-error-bg text-destructive'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
      )}
    >
      <CircleAlert className="size-4 shrink-0" />
      <span>
        {notice.text}{' '}
        {onBilling ? null : (
          <Link
            to={billingActionHref(notice.action, 'warning')}
            className="font-semibold underline underline-offset-2"
          >
            {BILLING_ACTION_LABELS[notice.action]}
          </Link>
        )}
      </span>
    </div>
  )
}

// Blocks every page while the org's halt stops work. The Billing page is the one
// exception: it shows the same notice inline so plans, packs and the card
// stay reachable there.
export function HaltModal() {
  const location = useLocation()
  const { billing, sessionsBlocked, haltReason, usagePlan } = useCreditState()
  const onBilling = location.pathname.startsWith('/billing')
  // A paid org on the fallback model keeps working, so it isn't blocked.
  const open = sessionsBlocked && !onBilling
  const reason = haltReason ?? 'unknown'
  useEffect(() => {
    if (open) trackPaywallShown(reason)
  }, [open, reason])
  if (!open || !billing) return null
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <HaltNoticeBody
          reason={haltReason}
          usagePlan={usagePlan}
          from="paywall"
          title={(t) => <DialogTitle>{t}</DialogTitle>}
          description={(d) => <DialogDescription>{d}</DialogDescription>}
        />
        <Link
          to="/billing"
          className="text-muted-foreground hover:text-foreground text-center text-xs underline-offset-2 hover:underline"
        >
          See billing details
        </Link>
      </DialogContent>
    </Dialog>
  )
}

// The notice and its actions, shared by the modal and the Billing page.
export function HaltNoticeBody({
  reason,
  usagePlan,
  from,
  title = (t) => <h2 className="text-base font-semibold">{t}</h2>,
  description = (d) => <p className="text-muted-foreground text-sm">{d}</p>,
}: {
  reason: string | null | undefined
  usagePlan: ReturnType<typeof useCreditState>['usagePlan']
  from: 'paywall' | 'billing_page'
  title?: (text: string) => ReactNode
  description?: (text: string) => ReactNode
}) {
  const notice = haltNotice(reason)
  const actions = useBillingActions({ from, usagePlan })
  // Never offer the plan the org is already on (out of credits on Max).
  const plans = PAID_PLANS.filter(
    (plan) => reason === 'lapsed' || plan !== usagePlan,
  )
  return (
    <div className="grid gap-4">
      <DialogHeader className="text-left">
        {title(notice.title)}
        {description(notice.body)}
      </DialogHeader>
      {notice.actions.map((action) => {
        if (action === 'plans' && plans.length > 0) {
          return (
            <div key={action} className="grid gap-2 sm:grid-cols-2">
              {plans.map((plan) => (
                <Button
                  key={plan}
                  className="h-auto flex-col items-start gap-0.5 py-2.5"
                  variant={plan === 'pro' ? 'default' : 'outline'}
                  disabled={actions.pending}
                  onClick={() => actions.subscribe.mutate(plan)}
                >
                  <span>
                    {PLAN_NAMES[plan]} · ${PLAN_OFFERS[plan].priceUsd}/mo
                  </span>
                  <span className="text-xs font-normal opacity-80">
                    {formatMinutes(PLAN_OFFERS[plan].minutes)} a month
                  </span>
                </Button>
              ))}
            </div>
          )
        }
        if (action === 'credits') {
          return (
            <div key={action} className="grid gap-1.5">
              <span className="text-muted-foreground text-xs">
                {BILLING_ACTION_LABELS.credits}
              </span>
              <div className="grid grid-cols-3 gap-2">
                {CREDIT_PACKS_USD.map((usd) => (
                  <Button
                    key={usd}
                    variant="outline"
                    disabled={actions.pending}
                    onClick={() => actions.buyPack.mutate(usd)}
                  >
                    ${usd}
                  </Button>
                ))}
              </div>
            </div>
          )
        }
        if (action === 'card') {
          return (
            <Button
              key={action}
              disabled={actions.pending}
              onClick={() => actions.portal.mutate()}
            >
              {actions.portal.isPending ? (
                <Loader2 className="animate-spin" />
              ) : null}
              {BILLING_ACTION_LABELS.card}
            </Button>
          )
        }
        return null
      })}
    </div>
  )
}
