import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getBilling, billingSetup, billingPortal, getBillingInvoices, redeemPromoCode,
  getAutumnBilling, autumnTopup, autumnSubscribeConcurrency, getSandboxUsage, setAutumnAutoTopup,
  type StripeInvoice, type AutumnBilling,
} from '../api/client'

type Tab = 'sandboxes' | 'invoices'

export default function Billing() {
  const [tab, setTab] = useState<Tab>('sandboxes')

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 className="page-title">Billing</h1>
        <p className="page-subtitle">Manage your plan, payment method, and invoices</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)', marginBottom: 18, gap: 4 }}>
        {(['sandboxes', 'invoices'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent-indigo)' : '2px solid transparent',
              padding: '10px 14px',
              color: tab === t ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 13,
              fontFamily: 'var(--font-body)',
              fontWeight: tab === t ? 600 : 400,
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'sandboxes' && <PlanTab />}
      {tab === 'invoices' && <InvoicesTab />}
    </div>
  )
}

// ───────────── Plan & Usage tab ─────────────

function PlanTab() {
  const queryClient = useQueryClient()
  const { data: billing, isLoading } = useQuery({
    queryKey: ['billing'], queryFn: getBilling, refetchInterval: 30_000,
  })

  const [promoCode, setPromoCode] = useState('')
  const [redeemSuccess, setRedeemSuccess] = useState('')

  const setupMutation = useMutation({
    mutationFn: billingSetup,
    onSuccess: (data) => { window.location.href = data.url },
  })
  const portalMutation = useMutation({
    mutationFn: billingPortal,
    onSuccess: (data) => { window.location.href = data.url },
  })
  const redeemMutation = useMutation({
    mutationFn: () => redeemPromoCode(promoCode),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['billing'] })
      setPromoCode('')
      setRedeemSuccess(`$${(data.creditAppliedCents / 100).toFixed(2)} credit applied!`)
      setTimeout(() => setRedeemSuccess(''), 4000)
    },
  })

  const isPro = billing?.plan === 'pro'

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <div className="loading-spinner" />
      </div>
    )
  }

  // Autumn (prepaid) orgs get the credits/top-up/concurrency view instead of
  // the legacy free-trial / Pro-upgrade card.
  if (billing?.billingProvider === 'autumn') {
    return <PrepaidPlan />
  }

  return (
    <>
      {/* Plan Card */}
      <div className="glass-card animate-in stagger-1" style={{ padding: 28, marginBottom: 14 }}>
        <span className="section-title" style={{ marginBottom: 16, display: 'block' }}>
          Current Plan
        </span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
          <span className="metric-value" style={{
            fontSize: 36, fontWeight: 700,
            color: isPro ? 'var(--accent-indigo)' : 'var(--text-primary)',
          }}>
            {isPro ? 'Pro' : 'Free'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {isPro
              ? `${billing?.maxConcurrentSandboxes ?? 5} concurrent sandboxes, all tiers`
              : `${billing?.maxConcurrentSandboxes ?? 5} concurrent sandboxes, up to 4GB / 1 vCPU`}
          </span>
        </div>

        {isPro && billing?.stripeCreditCents != null && billing.stripeCreditCents > 0 && (
          <div style={{ fontSize: 13, color: 'var(--accent-emerald)', marginBottom: 12 }}>
            ${(billing.stripeCreditCents / 100).toFixed(2)} promotional credit remaining
          </div>
        )}

        {!isPro && billing != null && (
          <div style={{ marginTop: 12 }}>
            {billing.freeCreditsRemainingCents > 0 ? (
              <div style={{
                fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-mono)',
                color: 'var(--accent-emerald)', marginBottom: 12,
              }}>
                ${(billing.freeCreditsRemainingCents / 100).toFixed(2)} free trial credit remaining
              </div>
            ) : (
              <div style={{
                fontSize: 13, color: 'var(--accent-rose)', marginBottom: 12,
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                Free trial credits exhausted — upgrade to continue using sandboxes
              </div>
            )}

            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
              Upgrade to Pro for an additional $30 free credit and larger machine sizes
            </div>
            <button
              onClick={() => setupMutation.mutate()}
              disabled={setupMutation.isPending}
              style={{
                padding: '10px 24px', fontSize: 14, fontWeight: 600,
                fontFamily: 'var(--font-body)', cursor: 'pointer',
                border: 'none', borderRadius: 'var(--radius-sm)',
                background: 'var(--accent-indigo)', color: '#fff',
                opacity: setupMutation.isPending ? 0.6 : 1,
              }}
            >
              {setupMutation.isPending ? 'Redirecting...' : 'Upgrade to Pro'}
            </button>
            {setupMutation.isError && (
              <p style={{ fontSize: 12, color: 'var(--accent-rose)', marginTop: 8 }}>
                {(setupMutation.error as Error).message}
              </p>
            )}
          </div>
        )}

        {isPro && (
          <div style={{
            fontSize: 11, color: 'var(--accent-emerald)', marginTop: 4,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
            Payment method on file — billed monthly via Stripe
          </div>
        )}

        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 12 }}>
          Need more concurrency?{' '}
          <a href="https://cal.com/team/digger/opencomputer-founder-chat" target="_blank" rel="noreferrer"
            style={{ color: 'var(--accent-indigo)', textDecoration: 'none' }}>
            Talk to us
          </a>
        </div>
      </div>

      {/* Stripe Billing Portal CTA (pro only) */}
      {isPro && (
        <div className="glass-card animate-in stagger-2" style={{ padding: '22px 24px', marginBottom: 14 }}>
          <span className="section-title" style={{ marginBottom: 10, display: 'block' }}>
            Usage & Payment Method
          </span>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.5 }}>
            View your current-cycle usage, manage your payment method, and download invoices on Stripe.
          </p>
          <button
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
            style={{
              padding: '10px 20px', fontSize: 13, fontWeight: 600,
              fontFamily: 'var(--font-body)', cursor: 'pointer',
              border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
              background: 'rgba(255,255,255,0.02)', color: 'var(--text-primary)',
              opacity: portalMutation.isPending ? 0.6 : 1,
            }}
          >
            {portalMutation.isPending ? 'Opening Stripe…' : 'Open Stripe billing portal ↗'}
          </button>
          {portalMutation.isError && (
            <p style={{ fontSize: 12, color: 'var(--accent-rose)', marginTop: 10 }}>
              {(portalMutation.error as Error).message}
            </p>
          )}
        </div>
      )}

      {/* Redeem Promotion Code (pro only) */}
      {isPro && (
        <div className="glass-card animate-in stagger-3" style={{ padding: '22px 24px', marginBottom: 14 }}>
          <span className="section-title" style={{ marginBottom: 12, display: 'block' }}>Promotion Code</span>
          <div style={{ display: 'flex', alignItems: 'end', gap: 14 }}>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'block', marginBottom: 6 }}>
                Enter a promotion code to apply credit
              </label>
              <input
                className="input"
                type="text"
                placeholder="e.g. WELCOME100"
                value={promoCode}
                onChange={e => setPromoCode(e.target.value.toUpperCase())}
                style={{ width: 240, fontFamily: 'var(--font-mono)', fontSize: 13 }}
              />
            </div>
            <button
              onClick={() => redeemMutation.mutate()}
              disabled={redeemMutation.isPending || !promoCode.trim()}
              style={{
                padding: '8px 20px', fontSize: 13, fontWeight: 600,
                fontFamily: 'var(--font-body)', cursor: 'pointer',
                border: 'none', borderRadius: 'var(--radius-sm)',
                background: 'var(--accent-indigo)', color: '#fff',
                opacity: redeemMutation.isPending || !promoCode.trim() ? 0.5 : 1,
              }}
            >
              {redeemMutation.isPending ? 'Applying...' : 'Redeem'}
            </button>
          </div>
          {redeemSuccess && (
            <p style={{ fontSize: 13, color: 'var(--accent-emerald)', marginTop: 10 }}>{redeemSuccess}</p>
          )}
          {redeemMutation.isError && (
            <p style={{ fontSize: 12, color: 'var(--accent-rose)', marginTop: 10 }}>
              {(redeemMutation.error as Error).message}
            </p>
          )}
        </div>
      )}
    </>
  )
}

// ───────────── Prepaid (Autumn) plan view ─────────────

const TOPUP_AMOUNTS = [5, 25, 100] // dollars == credits ($1/credit)

const CONCURRENCY_TIERS = [
  { id: 'concurrency_pro', label: 'Pro', limit: 100, price: 150 },
  { id: 'concurrency_pro_plus', label: 'Pro+', limit: 600, price: 500 },
  { id: 'concurrency_pro_plus_plus', label: 'Pro++', limit: 1000, price: 1000 },
]

function PrepaidPlan() {
  const { data: autumn, isLoading } = useQuery({
    queryKey: ['autumn-billing'], queryFn: getAutumnBilling, refetchInterval: 30_000,
  })
  const [amount, setAmount] = useState<number>(25)
  const queryClient = useQueryClient()

  // url present → redirect to hosted checkout (collect a new card); url null →
  // the existing card was charged server-side, so just refresh the balance.
  const onPurchase = (data: { url: string | null }) => {
    if (data.url) window.location.href = data.url
    else queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })
  }
  const topupMutation = useMutation({
    mutationFn: () => autumnTopup(amount),
    onSuccess: onPurchase,
  })
  const planMutation = useMutation({
    mutationFn: (plan: string) => autumnSubscribeConcurrency(plan),
    onSuccess: onPurchase,
  })


  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <div className="loading-spinner" />
      </div>
    )
  }

  const credits = (autumn?.creditsRemainingCents ?? 0) / 100
  const halted = autumn?.isHalted ?? false
  const currentPlan = autumn?.concurrencyPlan ?? 'base'

  return (
    <>
      {/* Credits balance */}
      <div className="glass-card animate-in stagger-1" style={{ padding: 28, marginBottom: 14 }}>
        <span className="section-title" style={{ marginBottom: 16, display: 'block' }}>
          Prepaid Credits
        </span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
          <span className="metric-value" style={{
            fontSize: 36, fontWeight: 700, fontFamily: 'var(--font-mono)',
            color: halted ? 'var(--accent-rose)' : 'var(--accent-emerald)',
          }}>
            ${credits.toFixed(2)}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>remaining</span>
        </div>
        {halted && (
          <div style={{
            fontSize: 13, color: 'var(--accent-rose)', marginBottom: 12,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            Credits exhausted — top up to resume your sandboxes
          </div>
        )}

        {/* Top-up */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>
            Add credits (billed at the same per-second rates)
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            {TOPUP_AMOUNTS.map((a) => (
              <button
                key={a}
                onClick={() => setAmount(a)}
                style={{
                  padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
                  fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600,
                  border: amount === a ? '1px solid var(--accent-indigo)' : '1px solid var(--border-subtle)',
                  background: amount === a ? 'var(--accent-indigo-soft, rgba(99,102,241,0.12))' : 'transparent',
                  color: amount === a ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                }}
              >
                ${a}
              </button>
            ))}
            <input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
              style={{
                width: 90, padding: '8px 12px', borderRadius: 8,
                border: '1px solid var(--border-subtle)', background: 'transparent',
                color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 14,
              }}
            />
          </div>
          <button
            className="btn-primary"
            disabled={topupMutation.isPending || amount < 1}
            onClick={() => topupMutation.mutate()}
            style={{ padding: '10px 20px' }}
          >
            {topupMutation.isPending ? 'Redirecting…' : `Top up $${amount}`}
          </button>
          {topupMutation.isError && (
            <div style={{ fontSize: 12, color: 'var(--accent-rose)', marginTop: 8 }}>
              {(topupMutation.error as Error).message}
            </div>
          )}
        </div>
      </div>

      <AutoTopupCard current={autumn?.autoTopup ?? null} hasToppedUp={autumn?.hasToppedUp ?? false} />

      {/* Concurrency plans */}
      <div className="glass-card animate-in stagger-3" style={{ padding: 28 }}>
        <span className="section-title" style={{ marginBottom: 8, display: 'block' }}>
          Concurrency
        </span>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          You can run <strong style={{ color: 'var(--text-primary)' }}>{autumn?.maxConcurrentSandboxes ?? 5}</strong> sandboxes
          at once on the <strong style={{ color: 'var(--text-primary)' }}>{currentPlan === 'base' ? 'Base' : currentPlan}</strong> tier.
          Subscribe to a higher tier for more — billed monthly, separate from usage credits.
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          {CONCURRENCY_TIERS.map((tier) => {
            const active = currentPlan === tier.id
            return (
              <div
                key={tier.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '14px 16px', borderRadius: 10,
                  border: active ? '1px solid var(--accent-indigo)' : '1px solid var(--border-subtle)',
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {tier.label} — {tier.limit} concurrent
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    ${tier.price}/mo
                  </div>
                </div>
                <button
                  className="btn-secondary"
                  disabled={active || planMutation.isPending}
                  onClick={() => planMutation.mutate(tier.id)}
                  style={{ padding: '8px 16px' }}
                >
                  {active ? 'Current' : 'Subscribe'}
                </button>
              </div>
            )
          })}
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
            Need more than 1000? <a href="mailto:support@digger.dev" style={{ color: 'var(--accent-indigo)' }}>Contact us</a>.
          </div>
        </div>
        {planMutation.isError && (
          <div style={{ fontSize: 12, color: 'var(--accent-rose)', marginTop: 10 }}>
            {(planMutation.error as Error).message}
          </div>
        )}
      </div>

      <UsageBreakdown />
    </>
  )
}

function UsageBreakdown() {
  const { data, isLoading } = useQuery({
    queryKey: ['sandbox-usage'], queryFn: () => getSandboxUsage(30),
  })

  const rows = data?.sandboxes ?? []

  return (
    <div className="glass-card animate-in stagger-4" style={{ padding: 28, marginTop: 14 }}>
      <span className="section-title" style={{ marginBottom: 4, display: 'block' }}>
        Usage by sandbox
      </span>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 16 }}>
        Compute cost over the last {data?.windowDays ?? 30} days (disk overage not included).
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <div className="loading-spinner" />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          No recent sandbox usage to show yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 1 }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12,
            fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase',
            letterSpacing: '0.04em', padding: '0 4px 8px',
          }}>
            <span>Sandbox</span><span style={{ textAlign: 'right' }}>Runtime</span><span style={{ textAlign: 'right' }}>Cost</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.sandboxId}
              style={{
                display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12,
                alignItems: 'center', padding: '10px 4px',
                borderTop: '1px solid var(--border-subtle)', fontSize: 13,
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.sandboxId}
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-body)' }}>
                  {r.status}
                </span>
              </span>
              <span style={{ textAlign: 'right', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                {formatDuration(r.seconds)}
              </span>
              <span style={{ textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                ${(r.costCents / 100).toFixed(2)}
              </span>
            </div>
          ))}
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr auto', gap: 12,
            padding: '12px 4px 0', borderTop: '1px solid var(--border-subtle)',
            marginTop: 4, fontSize: 13, fontWeight: 600,
          }}>
            <span style={{ color: 'var(--text-secondary)' }}>Total</span>
            <span style={{ textAlign: 'right', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              ${((data?.totalCents ?? 0) / 100).toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

const autoTopupInputStyle = {
  width: 80, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-subtle)',
  background: 'transparent', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 13,
}

function AutoTopupCard({ current, hasToppedUp }: { current: AutumnBilling['autoTopup']; hasToppedUp: boolean }) {
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(current?.enabled ?? false)
  const [threshold, setThreshold] = useState(current?.threshold ?? 5)
  const [quantity, setQuantity] = useState(current?.quantity ?? 25)
  const [saved, setSaved] = useState(false)

  const mutation = useMutation({
    mutationFn: () => setAutumnAutoTopup({ enabled, threshold, quantity }),
    onSuccess: (data) => {
      // Auto-recharge needs a saved off-session card. If enabling without one, the
      // server returns a no-charge Stripe setup URL — redirect to capture the card,
      // after which auto-recharge is live. Otherwise just confirm the save.
      if (data?.url) { window.location.href = data.url; return }
      queryClient.invalidateQueries({ queryKey: ['autumn-billing'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    },
  })

  return (
    <div className="glass-card animate-in stagger-2" style={{ padding: 28, marginBottom: 14 }}>
      <span className="section-title" style={{ marginBottom: 8, display: 'block' }}>
        Automatic Top-up
      </span>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
        Keep your balance from running out — when it drops below the threshold we
        automatically add credits to your saved card.
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, cursor: 'pointer', fontSize: 13 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span style={{ color: 'var(--text-primary)' }}>Enable automatic top-up</span>
      </label>
      {enabled && (
        <div style={{ display: 'flex', gap: 20, marginBottom: 16, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            When balance falls below
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <span style={{ color: 'var(--text-secondary)' }}>$</span>
              <input
                type="number" min={0} value={threshold}
                onChange={(e) => setThreshold(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                style={autoTopupInputStyle}
              />
            </div>
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            Add credits
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <span style={{ color: 'var(--text-secondary)' }}>$</span>
              <input
                type="number" min={1} value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
                style={autoTopupInputStyle}
              />
            </div>
          </label>
        </div>
      )}
      <button
        className="btn-secondary"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
        style={{ padding: '8px 16px' }}
      >
        {mutation.isPending ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
      </button>
      {enabled && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 10 }}>
          Charges your saved card automatically when the balance drops below the threshold.
          {!hasToppedUp && ` Since you haven't topped up yet, enabling runs your first $${quantity} recharge now to set up your card.`}
        </div>
      )}
      {mutation.isError && (
        <div style={{ fontSize: 12, color: 'var(--accent-rose)', marginTop: 8 }}>
          {(mutation.error as Error).message}
        </div>
      )}
    </div>
  )
}

// ───────────── Invoices tab ─────────────

function InvoicesTab() {
  const { data: billing } = useQuery({ queryKey: ['billing'], queryFn: getBilling })
  const { data: invoiceData, isLoading } = useQuery({
    queryKey: ['invoices'], queryFn: () => getBillingInvoices(),
  })

  const isPro = billing?.plan === 'pro'

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <div className="loading-spinner" />
      </div>
    )
  }

  if (!isPro) {
    return (
      <div className="glass-card" style={{ padding: 28, textAlign: 'center' }}>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
          Invoices appear here once you're on the Pro plan.
        </p>
      </div>
    )
  }

  return (
    <div className="glass-card animate-in stagger-1" style={{ padding: '22px 24px' }}>
      <span className="section-title" style={{ marginBottom: 14, display: 'block' }}>Invoices</span>
      {!invoiceData?.invoices?.length ? (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-tertiary)', fontSize: 13 }}>
          No invoices yet — your first invoice will appear at the end of the billing period
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Date</th><th>Number</th><th>Status</th><th>Amount</th><th></th></tr>
          </thead>
          <tbody>
            {invoiceData.invoices.map((inv: StripeInvoice) => (
              <tr key={inv.id}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {new Date(inv.created * 1000).toLocaleDateString()}
                </td>
                <td style={{ fontSize: 12 }}>{inv.number}</td>
                <td><InvoiceStatus status={inv.status} /></td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600 }}>
                  ${(inv.amountDue / 100).toFixed(2)}
                </td>
                <td>
                  {inv.hostedUrl && (
                    <a href={inv.hostedUrl} target="_blank" rel="noreferrer"
                      style={{ fontSize: 12, color: 'var(--accent-indigo)', textDecoration: 'none' }}>
                      View
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ───────────── Helpers ─────────────

function InvoiceStatus({ status }: { status: string }) {
  let color = 'var(--text-tertiary)'
  let bg = 'rgba(255,255,255,0.04)'
  if (status === 'paid') { color = 'var(--accent-emerald)'; bg = 'rgba(52,211,153,0.1)' }
  else if (status === 'open') { color = 'var(--accent-cyan)'; bg = 'rgba(34,211,238,0.1)' }
  else if (status === 'uncollectible') { color = 'var(--accent-rose)'; bg = 'rgba(244,63,94,0.1)' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, color, background: bg,
      textTransform: 'uppercase', letterSpacing: '0.5px',
    }}>{status}</span>
  )
}
