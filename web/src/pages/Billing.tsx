import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import {
  autumnSubscribeConcurrency,
  autumnTopup,
  billingPortal,
  billingSetup,
  getAutumnBilling,
  getBilling,
  getBillingInvoices,
  getSandboxUsage,
  redeemPromoCode,
  setAutumnAutoTopup,
  type AutumnBilling,
  type StripeInvoice,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, Input, Label } from '@/components/form'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'
import { cn } from '@/lib/utils'

type Tab = 'sandboxes' | 'invoices'

export default function Billing() {
  const [tab, setTab] = useState<Tab>('sandboxes')

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Manage your plan, payment method, and invoices"
      />

      <div className="mb-6 flex gap-1 border-b">
        {(['sandboxes', 'invoices'] as Tab[]).map((t) => (
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

      {tab === 'sandboxes' ? <PlanTab /> : <InvoicesTab />}
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
          {billing?.maxConcurrentSandboxes ?? 5} concurrent sandboxes ·{' '}
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

      {isPro ? (
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

const TOPUP_AMOUNTS = [5, 25, 100]

const CONCURRENCY_TIERS = [
  { id: 'concurrency_pro', label: 'Pro', limit: 100, price: 150 },
  { id: 'concurrency_pro_plus', label: 'Pro+', limit: 600, price: 500 },
  { id: 'concurrency_pro_plus_plus', label: 'Pro++', limit: 1000, price: 1000 },
]

function PrepaidPlan() {
  const queryClient = useQueryClient()
  const { data: autumn, isLoading } = useQuery({
    queryKey: ['autumn-billing'],
    queryFn: getAutumnBilling,
    refetchInterval: 30_000,
  })
  const [amount, setAmount] = useState(25)
  const [confirmTopup, setConfirmTopup] = useState(false)
  const [confirmPlanId, setConfirmPlanId] = useState<string | null>(null)

  // url present → redirect to hosted checkout (new card); url null → the
  // existing card was charged server-side, so just refresh the balance.
  const onPurchase = (data: { url: string | null }) => {
    if (data.url) window.location.href = data.url
    else void queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })
  }
  const topupMutation = useMutation({
    mutationFn: () => autumnTopup(amount),
    onSuccess: (d) => {
      setConfirmTopup(false)
      onPurchase(d)
    },
    onError: (e) => notifyError("Couldn't complete the top-up.", e),
  })
  const planMutation = useMutation({
    mutationFn: (plan: string) => autumnSubscribeConcurrency(plan),
    onSuccess: (d) => {
      setConfirmPlanId(null)
      onPurchase(d)
    },
    onError: (e) => notifyError("Couldn't update your subscription.", e),
  })

  if (isLoading) return <Skeleton className="h-64 max-w-2xl" />

  const credits = (autumn?.creditsRemainingCents ?? 0) / 100
  const halted = autumn?.isHalted ?? false
  const currentPlan = autumn?.concurrencyPlan ?? 'base'
  const tier = CONCURRENCY_TIERS.find((t) => t.id === confirmPlanId)

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
      {/* Credits */}
      <Panel className="p-6">
        <h2 className="mb-4 text-sm font-semibold">Prepaid credits</h2>
        <div className="flex items-baseline gap-3">
          <span
            className={cn(
              'font-mono text-4xl font-semibold',
              halted ? 'text-status-error' : 'text-status-running',
            )}
          >
            ${credits.toFixed(2)}
          </span>
          <span className="text-muted-foreground text-xs">remaining</span>
        </div>
        {halted ? (
          <p className="text-status-error mt-2 flex items-center gap-1.5 text-sm">
            <CircleAlert className="size-4 shrink-0" />
            Credits exhausted — top up to resume your agent sessions and
            sandboxes
          </p>
        ) : null}

        <div className="mt-5">
          <p className="text-muted-foreground mb-2.5 text-sm">
            Add credits (billed at the same per-second rates)
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {TOPUP_AMOUNTS.map((a) => (
              <Button
                key={a}
                variant={amount === a ? 'default' : 'outline'}
                size="sm"
                className="font-mono"
                onClick={() => setAmount(a)}
              >
                ${a}
              </Button>
            ))}
            <Input
              type="number"
              min={1}
              value={amount}
              onChange={(e) =>
                setAmount(Math.max(1, Math.floor(Number(e.target.value) || 0)))
              }
              className="w-24 font-mono"
            />
          </div>
          <Button disabled={amount < 1} onClick={() => setConfirmTopup(true)}>
            Top up ${amount}
          </Button>
        </div>
      </Panel>

      <AutoTopupCard
        current={autumn?.autoTopup ?? null}
        hasToppedUp={autumn?.hasToppedUp ?? false}
      />

      {/* Concurrency */}
      <Panel className="p-6">
        <h2 className="mb-2 text-sm font-semibold">Concurrency</h2>
        <p className="text-muted-foreground mb-4 text-sm">
          You can run{' '}
          <strong className="text-foreground">
            {autumn?.maxConcurrentSandboxes ?? 5}
          </strong>{' '}
          sandboxes at once on the{' '}
          <strong className="text-foreground">
            {currentPlan === 'base' ? 'Base' : currentPlan}
          </strong>{' '}
          tier. Subscribe to a higher tier for more — billed monthly, separate
          from usage credits.
        </p>
        <div className="space-y-2">
          {CONCURRENCY_TIERS.map((t) => {
            const active = currentPlan === t.id
            return (
              <div
                key={t.id}
                className={cn(
                  'flex items-center justify-between rounded-md border px-4 py-3',
                  active && 'border-foreground/40 bg-secondary',
                )}
              >
                <div>
                  <div className="text-foreground text-sm font-medium">
                    {t.label} — {t.limit} concurrent
                  </div>
                  <div className="text-muted-foreground font-mono text-xs">
                    ${t.price}/mo
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={active}
                  onClick={() => setConfirmPlanId(t.id)}
                >
                  {active ? 'Current' : 'Subscribe'}
                </Button>
              </div>
            )
          })}
          <p className="text-muted-foreground text-xs">
            Need more than 1000?{' '}
            <a
              href="mailto:support@digger.dev"
              className="text-foreground font-medium underline underline-offset-4"
            >
              Contact us
            </a>
            .
          </p>
        </div>
      </Panel>

      <UsageBreakdown />

      <ConfirmDialog
        open={confirmTopup}
        onOpenChange={(o) => !o && setConfirmTopup(false)}
        title="Confirm top-up"
        description={`Add $${amount} in prepaid credits. If a payment method is on file you'll be charged $${amount} now; otherwise you'll continue to checkout to add one.`}
        confirmLabel={`Top up $${amount}`}
        pending={topupMutation.isPending}
        onConfirm={() => topupMutation.mutate()}
      />
      <ConfirmDialog
        open={!!tier}
        onOpenChange={(o) => !o && setConfirmPlanId(null)}
        title="Confirm subscription"
        description={
          tier
            ? `Subscribe to ${tier.label} (${tier.limit} concurrent sandboxes) for $${tier.price}/mo. If a payment method is on file you'll be charged now and monthly; otherwise you'll continue to checkout.`
            : ''
        }
        confirmLabel={tier ? `Subscribe — $${tier.price}/mo` : 'Subscribe'}
        pending={planMutation.isPending}
        onConfirm={() => tier && planMutation.mutate(tier.id)}
      />
    </div>
  )
}

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
  }>({})
  const enabled = draft.enabled ?? current?.enabled ?? false
  const threshold = draft.threshold ?? current?.threshold ?? 5
  const quantity = draft.quantity ?? current?.quantity ?? 25
  const [saved, markSaved] = useTransientFlag(3000)
  const [confirm, setConfirm] = useState(false)

  const mutation = useMutation({
    mutationFn: () => setAutumnAutoTopup({ enabled, threshold, quantity }),
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
  const onSave = () => (willCharge ? setConfirm(true) : mutation.mutate())

  return (
    <Panel className="p-6">
      <h2 className="mb-2 text-sm font-semibold">Automatic top-up</h2>
      <p className="text-muted-foreground mb-4 text-sm">
        Keep your balance from running out — when it drops below the threshold
        we automatically add credits to your saved card.
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
          Enable automatic top-up
        </Label>
      </div>

      {enabled ? (
        <div className="mt-4 flex flex-wrap gap-5">
          <Field label="When balance falls below" htmlFor="threshold">
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
          <Field label="Add credits" htmlFor="quantity">
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-sm">$</span>
              <Input
                id="quantity"
                type="number"
                min={1}
                value={quantity}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    quantity: Math.max(
                      1,
                      Math.floor(Number(e.target.value) || 0),
                    ),
                  }))
                }
                className="w-24 font-mono"
              />
            </div>
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
          Since you haven&apos;t topped up yet, enabling runs your first $
          {quantity} recharge now to set up your card.
        </p>
      ) : null}

      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => !o && setConfirm(false)}
        title="Enable automatic top-up"
        description={`You don't have a saved card yet, so enabling runs your first $${quantity} recharge now to set it up — you'll be charged $${quantity}. After that we top up automatically whenever your balance drops below $${threshold}.`}
        confirmLabel={`Charge $${quantity} & enable`}
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

// Cost can be fractional cents — show real value below a cent rather than $0.00.
function formatCost(cents: number): string {
  const dollars = cents / 100
  if (dollars <= 0) return '$0.00'
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  return `$${dollars.toFixed(2)}`
}

function UsageBreakdown() {
  const { data, isLoading } = useQuery({
    queryKey: ['sandbox-usage'],
    queryFn: () => getSandboxUsage(30),
  })
  const rows = data?.sandboxes ?? []

  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'sandbox',
      header: 'Sandbox',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <code className="text-foreground font-mono text-xs">
            {r.sandboxId}
          </code>
          <span className="text-muted-foreground text-xs">{r.status}</span>
        </span>
      ),
    },
    {
      key: 'runtime',
      header: 'Runtime',
      align: 'right',
      cell: (r) => (
        <span className="text-muted-foreground font-mono text-xs">
          {formatDuration(r.seconds)}
        </span>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      cell: (r) => (
        <span className="text-foreground font-mono text-xs font-medium">
          {formatCost(r.costCents)}
        </span>
      ),
    },
  ]

  return (
    <Panel className="overflow-hidden">
      <div className="px-6 pt-6">
        <h2 className="text-sm font-semibold">Usage by sandbox</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Compute cost over the last {data?.windowDays ?? 30} days (disk overage
          not included).
        </p>
      </div>
      <div className="mt-3">
        <ResourceTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.sandboxId}
          loading={isLoading}
          empty={<EmptyState title="No recent sandbox usage to show yet." />}
        />
      </div>
      {rows.length > 0 ? (
        <div className="flex items-center justify-between border-t px-6 py-3 text-sm font-medium">
          <span className="text-muted-foreground">Total</span>
          <span className="text-foreground font-mono">
            {formatCost(data?.totalCents ?? 0)}
          </span>
        </div>
      ) : null}
    </Panel>
  )
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
