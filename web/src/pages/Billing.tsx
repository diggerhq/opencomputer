import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import {
  autumnCancelPlan,
  billingPortal,
  billingSetup,
  getAutumnBilling,
  getAgentSessionUsage,
  getBilling,
  getBillingInvoices,
  redeemPromoCode,
  setAutumnAutoTopup,
  type AutumnBilling,
  type CheckoutFrom,
  type AgentSessionUsageRow,
  type StripeInvoice,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, Input, Label, Select } from '@/components/form'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'
import { cn } from '@/lib/utils'
import {
  CENTS_PER_CREDIT,
  CREDIT_PACKS_USD,
  OVERAGE_USD_PER_MINUTE,
  PAID_PLANS,
  PLAN_NAMES,
  PLAN_OFFERS,
  TRIAL_CREDITS_USD,
  TRIAL_DAYS,
  TRIAL_MINUTES,
  billingOnrampV2Enabled,
  deepLinkedPlanFor,
  formatCreditCount,
  formatMinutes,
  formatUsd,
  planChangeTiming,
  planPriceLabel,
  trackPlanActivated,
  trackUpsellShown,
  withSavedOption,
  type CreditPackUsd,
  type PaidPlanId,
  type UsagePlanId,
} from '@/lib/billing-onramp'
import { useBillingActions } from '@/hooks/useBillingActions'
import { HaltNoticeBody } from '@/components/billing-surfaces'

type Tab = 'usage' | 'invoices'

export default function Billing() {
  const [tab, setTab] = useState<Tab>('usage')

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Manage your plan, payment method, and invoices"
      />

      <div className="mb-6 flex gap-1 border-b">
        {(['usage', 'invoices'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm capitalize transition-colors',
              tab === t
                ? 'border-foreground text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'usage' ? <PlanTab /> : <InvoicesTab />}
    </div>
  )
}

/* ── Plan & usage ─────────────────────────────────────────────────────────── */

function PlanTab() {
  const queryClient = useQueryClient()
  const { data: billing, isLoading } = useQuery({
    queryKey: ['billing'],
    queryFn: getBilling,
    refetchInterval: 30_000,
  })

  const [promoCode, setPromoCode] = useState('')

  const setupMutation = useMutation({
    mutationFn: billingSetup,
    onSuccess: (data) => {
      window.location.href = data.url
    },
    onError: (e) => notifyError("Couldn't start checkout.", e),
  })
  const portalMutation = useMutation({
    mutationFn: billingPortal,
    onSuccess: (data) => {
      window.location.href = data.url
    },
    onError: (e) => notifyError("Couldn't open the billing portal.", e),
  })
  const redeemMutation = useMutation({
    mutationFn: () => redeemPromoCode(promoCode),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['billing'] })
      setPromoCode('')
      toast.success(
        `$${(data.creditAppliedCents / 100).toFixed(2)} credit applied`,
      )
    },
    onError: (e) => notifyError("Couldn't redeem that promo code.", e),
  })

  if (isLoading) return <Skeleton className="h-64 max-w-2xl" />

  if (billing?.billingProvider === 'autumn') return <PrepaidPlan />

  const isPro = billing?.plan === 'pro'

  return (
    <div className="max-w-2xl space-y-4">
      <Panel className="p-6">
        <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          Current plan
        </h2>
        <div className="text-foreground text-2xl font-semibold tracking-tight">
          {isPro ? 'Pro' : 'Free'}
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          {billing?.maxConcurrentSandboxes ?? 50} concurrent sandboxes ·{' '}
          {isPro ? 'all tiers' : 'up to 4 GB / 1 vCPU'}
        </p>

        {isPro &&
        billing?.stripeCreditCents != null &&
        billing.stripeCreditCents > 0 ? (
          <p className="text-status-running mt-3 text-sm">
            ${(billing.stripeCreditCents / 100).toFixed(2)} promotional credit
            remaining
          </p>
        ) : null}

        {!isPro && billing != null ? (
          <div className="mt-4 space-y-3">
            {billing.freeCreditsRemainingCents > 0 ? (
              <p className="text-status-running text-sm">
                <span className="font-mono font-semibold">
                  ${(billing.freeCreditsRemainingCents / 100).toFixed(2)}
                </span>{' '}
                free trial credit remaining
              </p>
            ) : (
              <p className="text-status-error flex items-center gap-1.5 text-sm">
                <CircleAlert className="size-4 shrink-0" />
                Free trial credits exhausted — upgrade to continue using
                sandboxes
              </p>
            )}
            <p className="text-muted-foreground text-sm">
              Upgrade to Pro for an additional $30 free credit and larger
              machine sizes.
            </p>
            <Button
              onClick={() => setupMutation.mutate()}
              disabled={setupMutation.isPending}
            >
              {setupMutation.isPending ? 'Redirecting…' : 'Upgrade to Pro'}
            </Button>
          </div>
        ) : null}

        {isPro ? (
          <p className="text-status-running mt-3 flex items-center gap-1.5 text-xs">
            <CircleCheck className="size-3.5 shrink-0" />
            Payment method on file — billed monthly via Stripe
          </p>
        ) : null}

        <p className="text-muted-foreground mt-3 text-xs">
          Need more concurrency?{' '}
          <a
            href="https://cal.com/team/digger/opencomputer-founder-chat"
            target="_blank"
            rel="noreferrer"
            className="text-foreground font-medium underline underline-offset-4"
          >
            Talk to us
          </a>
        </p>
      </Panel>

      {isPro || billing?.hasPaymentMethod ? (
        <Panel className="p-6">
          <h2 className="mb-2 text-sm font-semibold">
            Usage &amp; payment method
          </h2>
          <p className="text-muted-foreground mb-3 text-sm">
            View current-cycle usage, manage your payment method, and download
            invoices on Stripe.
          </p>
          <Button
            variant="outline"
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
          >
            {portalMutation.isPending
              ? 'Opening Stripe…'
              : 'Open Stripe billing portal ↗'}
          </Button>
        </Panel>
      ) : null}

      {isPro ? (
        <Panel className="p-6">
          <h2 className="mb-3 text-sm font-semibold">Promotion code</h2>
          <form
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (promoCode.trim()) redeemMutation.mutate()
            }}
          >
            <Field
              label="Enter a promotion code to apply credit"
              htmlFor="promo"
            >
              <Input
                id="promo"
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                placeholder="e.g. WELCOME100"
                className="w-60 font-mono"
              />
            </Field>
            <Button
              type="submit"
              disabled={redeemMutation.isPending || !promoCode.trim()}
            >
              {redeemMutation.isPending ? 'Applying…' : 'Redeem'}
            </Button>
          </form>
        </Panel>
      ) : null}
    </div>
  )
}

/* ── Prepaid (Autumn) ─────────────────────────────────────────────────────── */

// The plan picker of serverless-agents-ws 086: the trial, Pro ($20/mo, 2,000
// work minutes) and Max ($200/mo, 25,000). Upgrades apply now; Max → Pro and
// cancelling take effect at the end of the paid period.
const PLAN_DESCRIPTIONS: Record<UsagePlanId, string> = {
  trial: `${formatMinutes(TRIAL_MINUTES)} of work and $${TRIAL_CREDITS_USD} of model credits for ${TRIAL_DAYS} days. No card needed.`,
  base: 'Free credits to get started.',
  pro: `${formatMinutes(PLAN_OFFERS.pro.minutes)} of work a month.`,
  max: `${formatMinutes(PLAN_OFFERS.max.minutes)} of work a month.`,
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

function checkoutFromParam(value: string | null): CheckoutFrom {
  return value === 'paywall' || value === 'warning' || value === 'signup'
    ? value
    : 'billing_page'
}

// A pending plan change waiting for the user's confirmation.
type PlanDialog =
  | { kind: 'switch'; plan: PaidPlanId }
  | { kind: 'cancel'; plan: PaidPlanId }

function PrepaidPlan() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const redirectedPlan = searchParams.get('usage-plan')
  const pendingUsagePlan =
    redirectedPlan === 'pro' || redirectedPlan === 'max' ? redirectedPlan : null
  const activationToastShown = useRef(false)
  const { data: autumn, isLoading } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    refetchInterval: pendingUsagePlan != null ? 1_500 : 30_000,
  })
  const currentPlan: UsagePlanId = autumn?.usagePlan ?? 'trial'
  // `?plan=` (upsell or site deep link) opens that plan's upgrade confirmation.
  const deepLinkedPlan =
    billingOnrampV2Enabled && autumn
      ? deepLinkedPlanFor(searchParams.get('plan'), autumn.usagePlan)
      : null
  const [dialog, setDialog] = useState<PlanDialog | null>(null)
  // While `?plan=` is in the URL it drives the dialog; closing it clears the
  // param so the same link can reopen it later.
  const openDialog: PlanDialog | null =
    dialog ?? (deepLinkedPlan ? { kind: 'switch', plan: deepLinkedPlan } : null)
  const closeDialog = () => {
    setDialog(null)
    if (!searchParams.has('plan')) return
    const next = new URLSearchParams(searchParams)
    next.delete('plan')
    setSearchParams(next, { replace: true })
  }

  const actions = useBillingActions({
    from: checkoutFromParam(searchParams.get('from')),
    usagePlan: autumn?.usagePlan,
    onPlanChanged: closeDialog,
  })
  const cancelMutation = useMutation({
    mutationFn: (v: { plan: PaidPlanId; undo: boolean }) =>
      autumnCancelPlan(v.plan, v.undo),
    onSuccess: (_d, v) => {
      closeDialog()
      toast.success(v.undo ? 'Your plan stays as it is' : 'Plan cancelled', {
        description: v.undo
          ? undefined
          : 'It stays active until the end of the period.',
      })
      void queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })
    },
    onError: (e) => notifyError("Couldn't update your plan.", e),
  })

  useEffect(() => {
    if (!deepLinkedPlan || !autumn) return
    trackUpsellShown({
      surface: 'billing_deeplink',
      plan: deepLinkedPlan,
      usagePlan: autumn.usagePlan,
      creditsRemainingCents: autumn.creditsRemainingCents,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkedPlan, autumn?.usagePlan])

  useEffect(() => {
    if (pendingUsagePlan == null || autumn?.usagePlan !== pendingUsagePlan)
      return

    if (!activationToastShown.current) {
      const label = PLAN_NAMES[pendingUsagePlan]
      toast.success(`${label} plan activated`, {
        description: 'Your work minutes are ready to use.',
      })
      trackPlanActivated({ plan: pendingUsagePlan })
      activationToastShown.current = true
    }
    const next = new URLSearchParams(searchParams)
    next.delete('usage-plan')
    setSearchParams(next, { replace: true })
  }, [autumn?.usagePlan, pendingUsagePlan, searchParams, setSearchParams])

  // Prompts link to #plans, #credits or #payment.
  useEffect(() => {
    if (isLoading || !location.hash) return
    document
      .getElementById(location.hash.slice(1))
      ?.scrollIntoView({ block: 'start' })
  }, [isLoading, location.hash])

  // Whether a card is on file → offer the Stripe portal to manage it. Compliance
  // requires that anyone with a saved card can view/update/remove it.
  const { data: billing } = useQuery({
    queryKey: ['billing'],
    queryFn: getBilling,
  })

  if (isLoading) return <Skeleton className="h-64 max-w-2xl" />

  const halted = autumn?.isHalted ?? false
  const hasCard =
    (billing?.hasPaymentMethod ?? false) ||
    (autumn?.hasToppedUp ?? false) ||
    (autumn?.hasPaidSubscription ?? false)
  const scheduled = autumn?.scheduledChange ?? null
  const dialogPlan = openDialog?.plan
  const dialogTiming =
    openDialog?.kind === 'switch'
      ? planChangeTiming(currentPlan, openDialog.plan)
      : null
  const periodEnd = autumn?.periodEndsAt
    ? formatDate(autumn.periodEndsAt)
    : 'the end of the period'

  return (
    <div className="max-w-5xl space-y-4">
      {pendingUsagePlan != null ? (
        <Panel className="p-4">
          <div className="flex items-start gap-3">
            <CircleCheck className="text-status-running mt-0.5 size-5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">
                Activating {PLAN_NAMES[pendingUsagePlan]}…
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Payment completed. We are waiting for the plan and its work
                minutes to synchronize.
              </p>
            </div>
          </div>
        </Panel>
      ) : null}

      {/* The halt modal stays off this page so its way out is reachable. */}
      {halted ? (
        <Panel className="border-destructive/40 p-6">
          <HaltNoticeBody
            reason={autumn?.haltReason}
            usagePlan={autumn?.usagePlan}
            from={
              searchParams.get('from') === 'paywall'
                ? 'paywall'
                : 'billing_page'
            }
          />
        </Panel>
      ) : null}

      {autumn ? <UsageSummary autumn={autumn} /> : null}

      <PlanPicker
        currentPlan={currentPlan}
        trialEndsAt={autumn?.trialEndsAt ?? null}
        periodEndsAt={autumn?.periodEndsAt ?? null}
        scheduled={scheduled}
        busy={actions.pending || cancelMutation.isPending}
        onSwitch={(plan) => setDialog({ kind: 'switch', plan })}
        onCancel={(plan) => setDialog({ kind: 'cancel', plan })}
        onUndo={(plan) => cancelMutation.mutate({ plan, undo: true })}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        <CreditPacksCard
          creditsRemainingCents={autumn?.creditsRemainingCents ?? 0}
          busy={actions.pending}
          onBuy={(usd) => actions.buyPack.mutate(usd)}
        />
        <AutoTopupCard
          current={autumn?.autoTopup ?? null}
          hasToppedUp={autumn?.hasToppedUp ?? false}
        />
      </div>

      <Panel id="payment" className="scroll-mt-24 p-6">
        <h2 className="mb-2 text-sm font-semibold">Payment method</h2>
        <p className="text-muted-foreground mb-3 text-sm">
          {hasCard
            ? 'Update your card, download invoices, or remove your payment method on Stripe.'
            : 'No card on file yet. You add one when you choose a plan or buy credits.'}
        </p>
        {hasCard ? (
          <Button
            variant="outline"
            onClick={() => actions.portal.mutate()}
            disabled={actions.portal.isPending}
          >
            {actions.portal.isPending ? 'Opening Stripe…' : 'Update card ↗'}
          </Button>
        ) : null}
      </Panel>

      <AgentUsageBreakdown usage={autumn?.modelUsage ?? null} />

      <ConfirmDialog
        open={openDialog?.kind === 'switch' && !!dialogPlan}
        onOpenChange={(open) => !open && closeDialog()}
        title={
          dialogTiming === 'period_end'
            ? `Switch to ${dialogPlan ? PLAN_NAMES[dialogPlan] : ''} on ${periodEnd}`
            : `Upgrade to ${dialogPlan ? PLAN_NAMES[dialogPlan] : ''}`
        }
        description={
          dialogPlan
            ? dialogTiming === 'period_end'
              ? `You keep Max until ${periodEnd}. Then Pro starts at $${PLAN_OFFERS.pro.priceUsd}/month with ${formatMinutes(PLAN_OFFERS.pro.minutes)} a month.`
              : `${planPriceLabel(dialogPlan)} starts now with ${formatMinutes(PLAN_OFFERS[dialogPlan].minutes)} a month. Stripe prorates any change from your current plan.`
            : ''
        }
        confirmLabel={
          dialogPlan
            ? dialogTiming === 'period_end'
              ? `Switch on ${periodEnd}`
              : `${PLAN_NAMES[dialogPlan]} — $${PLAN_OFFERS[dialogPlan].priceUsd}/mo`
            : 'Continue'
        }
        pending={actions.subscribe.isPending}
        onConfirm={() => dialogPlan && actions.subscribe.mutate(dialogPlan)}
      />
      <ConfirmDialog
        open={openDialog?.kind === 'cancel'}
        onOpenChange={(open) => !open && closeDialog()}
        title={`Cancel ${dialogPlan ? PLAN_NAMES[dialogPlan] : ''}?`}
        description={`Your plan stays active until ${periodEnd}. After that, work pauses until you choose a plan again.`}
        confirmLabel={`Cancel on ${periodEnd}`}
        cancelLabel="Keep plan"
        destructive
        pending={cancelMutation.isPending}
        onConfirm={() =>
          dialogPlan && cancelMutation.mutate({ plan: dialogPlan, undo: false })
        }
      />
    </div>
  )
}

// Work minutes left this period (or in the trial) and the credit balance
// overage draws from.
function UsageSummary({ autumn }: { autumn: AutumnBilling }) {
  const minutes = autumn.workMinutes
  const halted = autumn.isHalted
  const pct = minutes
    ? Math.max(
        0,
        Math.min(100, (minutes.remaining / Math.max(1, minutes.granted)) * 100),
      )
    : 0
  const low = pct <= 20
  const resetLine =
    autumn.usagePlan === 'trial'
      ? autumn.trialEndsAt
        ? `Trial ends ${formatDate(autumn.trialEndsAt)}`
        : null
      : minutes?.resetsAt
        ? `Resets ${formatDate(minutes.resetsAt)}`
        : null
  return (
    <Panel className="grid gap-6 p-6 md:grid-cols-2">
      <div>
        <h2 className="text-sm font-semibold">Work minutes</h2>
        {minutes ? (
          <>
            <div className="mt-3 flex items-baseline gap-2">
              <span
                className={cn(
                  'font-mono text-3xl font-semibold',
                  halted && 'text-status-error',
                )}
              >
                {new Intl.NumberFormat('en-US').format(minutes.remaining)}
              </span>
              <span className="text-muted-foreground text-xs">
                of {formatMinutes(minutes.granted)} left
              </span>
            </div>
            <div className="bg-secondary mt-3 h-2 overflow-hidden rounded-full">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-700',
                  halted
                    ? 'bg-destructive'
                    : low
                      ? 'bg-amber-500'
                      : 'bg-primary',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            {resetLine ? (
              <p className="text-muted-foreground mt-1.5 font-mono text-[11px]">
                {resetLine}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground mt-3 text-sm">
            Choose a plan to get work minutes.
          </p>
        )}
      </div>
      <div>
        <h2 className="text-sm font-semibold">Credits</h2>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-mono text-3xl font-semibold">
            {formatUsd(autumn.creditsRemainingCents)}
          </span>
          <span className="text-muted-foreground text-xs">available</span>
        </div>
        <p className="text-muted-foreground mt-3 text-sm">
          {autumn.usagePlan === 'trial'
            ? 'Model credits included with your trial.'
            : `Used past your monthly minutes, at $${OVERAGE_USD_PER_MINUTE}/min, and for models.`}
        </p>
      </div>
    </Panel>
  )
}

function PlanPicker({
  currentPlan,
  trialEndsAt,
  periodEndsAt,
  scheduled,
  busy,
  onSwitch,
  onCancel,
  onUndo,
}: {
  currentPlan: UsagePlanId
  trialEndsAt: string | null
  periodEndsAt: string | null
  scheduled: AutumnBilling['scheduledChange'] | null
  busy: boolean
  onSwitch: (plan: PaidPlanId) => void
  onCancel: (plan: PaidPlanId) => void
  onUndo: (plan: PaidPlanId) => void
}) {
  const paidCurrent =
    currentPlan === 'pro' || currentPlan === 'max' ? currentPlan : null
  // The trial (or the old free tier) is listed only while the org is on it.
  const plans: UsagePlanId[] = paidCurrent
    ? PAID_PLANS
    : [currentPlan, ...PAID_PLANS]
  const changeDate = scheduled?.at ? formatDate(scheduled.at) : null
  return (
    <Panel id="plans" className="scroll-mt-24 p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">Plan</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Work minutes cover your computer and automations. Past them, work
          draws prepaid credits at ${OVERAGE_USD_PER_MINUTE}/min.
        </p>
      </div>
      <div
        className={cn(
          'grid gap-3',
          plans.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
        )}
      >
        {plans.map((plan) => {
          const current = plan === currentPlan
          const paid = plan === 'pro' || plan === 'max' ? plan : null
          const startsLater = scheduled?.to === 'pro' && plan === 'pro'
          const cancelling = current && scheduled?.to === 'cancel'
          let note: string | null = null
          if (current && plan === 'trial' && trialEndsAt)
            note = `Ends ${formatDate(trialEndsAt)}`
          else if (cancelling) note = `Ends ${changeDate ?? 'at period end'}`
          else if (current && scheduled?.to === 'pro')
            note = `Until ${changeDate ?? 'the period ends'}`
          else if (current && paid && periodEndsAt)
            note = `Renews ${formatDate(periodEndsAt)}`
          else if (startsLater) note = `Starts ${changeDate ?? 'at period end'}`
          return (
            <div
              key={plan}
              className={cn(
                'flex flex-col rounded-md border p-4',
                current && 'border-foreground/40',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">{PLAN_NAMES[plan]}</div>
                  <div className="mt-1 font-mono text-xl font-semibold">
                    {paid ? `$${PLAN_OFFERS[paid].priceUsd}` : '$0'}
                    <span className="text-muted-foreground text-xs font-normal">
                      {paid ? '/mo' : ` for ${TRIAL_DAYS} days`}
                    </span>
                  </div>
                </div>
                {current ? (
                  <StatusBadge status="active" label="Current" />
                ) : startsLater ? (
                  <StatusBadge status="pending" label="Scheduled" />
                ) : null}
              </div>
              <p className="text-muted-foreground mt-3 min-h-10 text-sm">
                {PLAN_DESCRIPTIONS[plan]}
              </p>
              {note ? (
                <p
                  className={cn(
                    'mt-1 font-mono text-[11px]',
                    cancelling ? 'text-status-error' : 'text-muted-foreground',
                  )}
                >
                  {note}
                </p>
              ) : null}
              <div className="mt-auto pt-4">
                {!paid ? (
                  <Button className="w-full" variant="outline" disabled>
                    Current plan
                  </Button>
                ) : current ? (
                  scheduled ? (
                    <Button
                      className="w-full"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onUndo(paid)}
                    >
                      Keep {PLAN_NAMES[paid]}
                    </Button>
                  ) : (
                    <Button
                      className="w-full"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onCancel(paid)}
                    >
                      Cancel plan
                    </Button>
                  )
                ) : startsLater ? (
                  <Button className="w-full" variant="outline" disabled>
                    Starts {changeDate ?? 'at period end'}
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    variant={
                      planChangeTiming(currentPlan, paid) === 'now'
                        ? 'default'
                        : 'outline'
                    }
                    disabled={busy}
                    onClick={() => onSwitch(paid)}
                  >
                    {planChangeTiming(currentPlan, paid) === 'now'
                      ? `Upgrade to ${PLAN_NAMES[paid]}`
                      : `Switch to ${PLAN_NAMES[paid]}`}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

function CreditPacksCard({
  creditsRemainingCents,
  busy,
  onBuy,
}: {
  creditsRemainingCents: number
  busy: boolean
  onBuy: (usd: CreditPackUsd) => void
}) {
  const [confirm, setConfirm] = useState<CreditPackUsd | null>(null)
  return (
    <Panel id="credits" className="scroll-mt-24 p-6">
      <h2 className="mb-2 text-sm font-semibold">Buy credits</h2>
      <p className="text-muted-foreground mb-4 text-sm">
        {formatUsd(creditsRemainingCents)} available. Credits cover work past
        your monthly minutes (${OVERAGE_USD_PER_MINUTE}/min) and models.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {CREDIT_PACKS_USD.map((usd) => (
          <Button
            key={usd}
            variant="outline"
            disabled={busy}
            onClick={() => setConfirm(usd)}
          >
            ${usd}
          </Button>
        ))}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Buy $${confirm ?? ''} of credits`}
        description={`We charge $${confirm ?? ''} to your saved card, or take you to Stripe to add one.`}
        confirmLabel={`Buy $${confirm ?? ''}`}
        pending={busy}
        onConfirm={() => {
          if (confirm !== null) onBuy(confirm)
          setConfirm(null)
        }}
      />
    </Panel>
  )
}

function ModelUsageCard({
  usage,
}: {
  usage: AutumnBilling['modelUsage'] | null
}) {
  const status = usage?.status ?? 'off'
  const enabled = usage?.enabled ?? false
  const markupPct = ((usage?.markupBps ?? 0) / 100).toFixed(1)

  return (
    <Panel className="p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Model usage</h2>
        <StatusBadge
          status={
            enabled ? 'success' : status === 'error' ? 'error' : 'stopped'
          }
          label={status}
        />
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-foreground font-mono text-3xl font-semibold">
          {formatCost(usage?.billedCreditsCents ?? 0)}
        </span>
        <span className="text-muted-foreground text-xs">credits used</span>
      </div>
      <p className="text-muted-foreground mt-2 text-sm">
        Serverless-agent models draw from the same prepaid credits balance as
        agent runtime and sandboxes.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-muted-foreground text-xs">Provider cost</div>
          <div className="text-foreground font-mono">
            ${((usage?.providerSpendCents ?? 0) / 100).toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Markup</div>
          <div className="text-foreground font-mono">{markupPct}%</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Active keys</div>
          <div className="text-foreground font-mono">
            {usage?.activeKeyCount ?? 0}
          </div>
        </div>
      </div>
    </Panel>
  )
}

const AGENT_RUNTIME_CENTS_PER_SECOND = (0.00315 * 100) / 60

function sessionRuntimeSeconds(session: AgentSessionUsageRow): number {
  return Object.values(session.runtimeSecondsByTier).reduce(
    (total, seconds) => total + seconds,
    0,
  )
}

function billableModelUsage(
  session: AgentSessionUsageRow,
  billingStartedAt?: string | null,
): { calls: number; providerCostUsd: number } {
  const cutoff = billingStartedAt ? Date.parse(billingStartedAt) : NaN
  const events = Number.isFinite(cutoff)
    ? session.modelUsage.filter(
        (event) => Date.parse(event.timestamp) >= cutoff,
      )
    : session.modelUsage
  return {
    calls: events.length,
    providerCostUsd: events.reduce((total, event) => total + event.costUsd, 0),
  }
}

function AgentUsageBreakdown({
  usage,
}: {
  usage: AutumnBilling['modelUsage'] | null
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-session-usage'],
    queryFn: () => getAgentSessionUsage(100),
    refetchInterval: 30_000,
  })
  const rows = data?.sessions ?? []
  const markup = 1 + (usage?.markupBps ?? 0) / 10_000
  const runtimeSeconds = rows.reduce(
    (total, session) => total + sessionRuntimeSeconds(session),
    0,
  )
  const runtimeCostCents = runtimeSeconds * AGENT_RUNTIME_CENTS_PER_SECOND

  const columns: Column<AgentSessionUsageRow>[] = [
    {
      key: 'session',
      header: 'Session',
      cell: (session) => {
        const content = (
          <>
            <div className="text-foreground max-w-sm truncate text-sm font-medium">
              {session.title ?? 'Untitled session'}
            </div>
            <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 font-mono text-xs">
              <span>{session.projectName ?? 'Unknown project'}</span>
              <span>{session.id}</span>
              <span>{session.source}</span>
              <span>{session.status}</span>
            </div>
          </>
        )
        return session.projectId ? (
          <Link
            to={`/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`}
            className="block min-w-0 hover:underline hover:underline-offset-4"
          >
            {content}
          </Link>
        ) : (
          <div className="min-w-0">{content}</div>
        )
      },
    },
    {
      key: 'model',
      header: 'Model',
      align: 'right',
      cell: (session) => {
        const model = billableModelUsage(session, usage?.billingStartedAt)
        return (
          <div className="font-mono text-xs">
            <div className="text-foreground">
              {formatCost(model.providerCostUsd * 100 * markup)}
            </div>
            <div className="text-muted-foreground">
              {model.calls} call{model.calls === 1 ? '' : 's'}
            </div>
          </div>
        )
      },
    },
    {
      key: 'runtime',
      header: 'Runtime',
      align: 'right',
      cell: (session) => {
        const seconds = sessionRuntimeSeconds(session)
        return (
          <div className="font-mono text-xs">
            <div className="text-foreground">
              {formatCost(seconds * AGENT_RUNTIME_CENTS_PER_SECOND)}
            </div>
            <div className="text-muted-foreground">
              {formatDuration(seconds)}
            </div>
          </div>
        )
      },
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      cell: (session) => {
        const model =
          billableModelUsage(session, usage?.billingStartedAt).providerCostUsd *
          100 *
          markup
        const runtime =
          sessionRuntimeSeconds(session) * AGENT_RUNTIME_CENTS_PER_SECOND
        return (
          <span className="text-foreground font-mono text-xs font-medium">
            {formatCost(model + runtime)}
          </span>
        )
      },
    },
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ModelUsageCard usage={usage} />
        <Panel className="p-6">
          <h2 className="text-sm font-semibold">Agent runtime usage</h2>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-foreground font-mono text-3xl font-semibold">
              {formatCost(runtimeCostCents)}
            </span>
            <span className="text-muted-foreground text-xs">
              credits · {formatDuration(runtimeSeconds)} in recent sessions
            </span>
          </div>
          <p className="text-muted-foreground mt-2 text-sm">
            Runtime is billed per second at the serverless-agent resource rate.
          </p>
        </Panel>
      </div>

      <Panel className="overflow-hidden">
        <div className="px-6 pt-6">
          <h2 className="text-sm font-semibold">Usage by agent session</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Recent serverless-agent sessions, split into model and runtime cost.
            Organization totals remain the billing ledger of record.
          </p>
        </div>
        <div className="mt-3">
          <ResourceTable
            columns={columns}
            rows={rows}
            rowKey={(session) => session.id}
            loading={isLoading}
            empty={
              <EmptyState title="No serverless-agent usage to show yet." />
            }
          />
        </div>
      </Panel>
    </div>
  )
}

// Monthly cap options for automatic top-up, as a number of packs (the edge
// requires the budget to be a whole multiple of the pack).
const TOPUPS_PER_MONTH = [1, 2, 3, 5, 10]

function AutoTopupCard({
  current,
  hasToppedUp,
}: {
  current: AutumnBilling['autoTopup']
  hasToppedUp: boolean
}) {
  const queryClient = useQueryClient()
  // Canonical values come from the server (`current`); local edits are nullable
  // overrides, so a refetch / org switch updates the form instead of being
  // shadowed by once-copied state. Draft is cleared after a successful save.
  const [draft, setDraft] = useState<{
    enabled?: boolean
    threshold?: number
    quantity?: number
    perMonth?: number
  }>({})
  // A policy saved before the presets (e.g. $25 packs, a $100 cap) stays
  // selectable, so saving another field never rewrites it.
  const savedPack =
    current && current.quantity > 0 ? current.quantity : undefined
  const savedPerMonth =
    current && current.budget != null && current.quantity > 0
      ? Math.round(current.budget / current.quantity)
      : undefined
  const packOptions = withSavedOption(CREDIT_PACKS_USD, savedPack)
  const perMonthOptions = withSavedOption(TOPUPS_PER_MONTH, savedPerMonth)
  const enabled = draft.enabled ?? current?.enabled ?? false
  const threshold = draft.threshold ?? current?.threshold ?? 5
  const quantity = draft.quantity ?? savedPack ?? 10
  const perMonth = draft.perMonth ?? savedPerMonth ?? 3
  const budget = quantity * perMonth
  const [saved, markSaved] = useTransientFlag(3000)
  const [confirm, setConfirm] = useState(false)

  const mutation = useMutation({
    mutationFn: () =>
      setAutumnAutoTopup({ enabled, threshold, quantity, budget }),
    onSuccess: (data) => {
      setConfirm(false)
      if (data?.url) {
        window.location.href = data.url
        return
      }
      void queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })
      setDraft({}) // server config is canonical again
      markSaved()
    },
    onError: (e) => notifyError("Couldn't save auto-top-up settings.", e),
  })

  // Saving only charges when enabling WITHOUT a card on file. Gate that one path.
  const willCharge = enabled && !hasToppedUp
  const onSave = () => {
    if (willCharge) setConfirm(true)
    else mutation.mutate()
  }

  return (
    <Panel className="p-6">
      <h2 className="mb-2 text-sm font-semibold">Automatic top-up</h2>
      <p className="text-muted-foreground mb-4 text-sm">
        When your credits drop below the threshold, we buy a pack with your
        saved card so work doesn&apos;t pause.
      </p>

      <div className="flex items-center gap-2">
        <Checkbox
          id="auto-topup"
          checked={enabled}
          onCheckedChange={(v) =>
            setDraft((d) => ({ ...d, enabled: v === true }))
          }
        />
        <Label htmlFor="auto-topup" className="cursor-pointer font-normal">
          Top up automatically
        </Label>
      </div>

      {enabled ? (
        <div className="mt-4 flex flex-wrap gap-5">
          <Field label="Buy" htmlFor="topup-pack">
            <Select
              id="topup-pack"
              value={String(quantity)}
              onValueChange={(v) =>
                setDraft((d) => ({ ...d, quantity: Number(v) }))
              }
              options={packOptions.map((usd) => ({
                value: String(usd),
                label: `$${usd} pack`,
              }))}
              className="w-32"
            />
          </Field>
          <Field label="When credits fall below" htmlFor="threshold">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-sm">$</span>
              <Input
                id="threshold"
                type="number"
                min={0}
                value={threshold}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    threshold: Math.max(
                      0,
                      Math.floor(Number(e.target.value) || 0),
                    ),
                  }))
                }
                className="w-24 font-mono"
              />
            </div>
          </Field>
          <Field label="At most" htmlFor="topup-limit">
            <Select
              id="topup-limit"
              value={String(perMonth)}
              onValueChange={(v) =>
                setDraft((d) => ({ ...d, perMonth: Number(v) }))
              }
              options={perMonthOptions.map((n) => ({
                value: String(n),
                label: `${n}× a month ($${n * quantity})`,
              }))}
              className="w-44"
            />
          </Field>
        </div>
      ) : null}

      <div className="mt-4">
        <Button
          variant="outline"
          disabled={mutation.isPending}
          onClick={onSave}
        >
          {mutation.isPending ? 'Saving…' : saved ? 'Saved' : 'Save'}
        </Button>
      </div>

      {enabled && !hasToppedUp ? (
        <p className="text-muted-foreground mt-3 text-xs">
          Since you haven&apos;t bought credits yet, enabling buys your first $
          {quantity} pack now to set up your card.
        </p>
      ) : null}

      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => !o && setConfirm(false)}
        title="Turn on automatic top-up"
        description={`You don't have a saved card yet, so turning this on buys your first $${quantity} pack now to set it up. After that we buy a $${quantity} pack whenever your credits drop below $${threshold}, at most ${perMonth}× ($${budget}) a month.`}
        confirmLabel={`Buy $${quantity} & turn on`}
        pending={mutation.isPending}
        onConfirm={() => mutation.mutate()}
      />
    </Panel>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

// Usage in credits. Can be a fraction of a hundredth — show the real value
// rather than 0.
function formatCost(cents: number): string {
  const credits = cents / CENTS_PER_CREDIT
  if (credits <= 0) return '0'
  if (credits < 0.01) return credits.toFixed(4)
  return formatCreditCount(cents)
}

/* ── Invoices ─────────────────────────────────────────────────────────────── */

function invoiceTone(status: string) {
  if (status === 'paid') return 'success'
  if (status === 'open') return 'pending'
  if (status === 'uncollectible') return 'error'
  return 'stopped'
}

function InvoicesTab() {
  const { data: billing } = useQuery({
    queryKey: ['billing'],
    queryFn: getBilling,
  })
  const { data: invoiceData, isLoading } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => getBillingInvoices(),
  })

  const isPro = billing?.plan === 'pro'

  if (!isPro) {
    return (
      <Panel className="max-w-2xl">
        <EmptyState
          title="No invoices yet"
          description="Invoices appear here once you're on the Pro plan."
        />
      </Panel>
    )
  }

  const columns: Column<StripeInvoice>[] = [
    {
      key: 'date',
      header: 'Date',
      cell: (inv) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(inv.created * 1000).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'number',
      header: 'Number',
      cell: (inv) => <span className="text-sm">{inv.number}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (inv) => (
        <StatusBadge status={invoiceTone(inv.status)} label={inv.status} />
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (inv) => (
        <span className="font-mono text-sm font-medium">
          ${(inv.amountDue / 100).toFixed(2)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (inv) =>
        inv.hostedUrl ? (
          <a
            href={inv.hostedUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground text-sm font-medium underline underline-offset-4"
          >
            View
          </a>
        ) : null,
    },
  ]

  return (
    <Panel className="max-w-3xl overflow-hidden">
      <ResourceTable
        columns={columns}
        rows={invoiceData?.invoices ?? []}
        rowKey={(inv) => inv.id}
        loading={isLoading}
        empty={
          <EmptyState
            title="No invoices yet"
            description="Your first invoice will appear at the end of the billing period."
          />
        }
      />
    </Panel>
  )
}
