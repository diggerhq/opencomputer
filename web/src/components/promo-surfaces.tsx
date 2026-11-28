import { SELFHOST } from '@/lib/selfhost'
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Tag, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { useBillingPromo } from '@/hooks/useBillingPromo'
import { useCreditState } from '@/hooks/useCreditState'
import {
  PAID_PLANS,
  PLAN_NAMES,
  billingOnrampV2Enabled,
  formatMinutes,
  trackUpsellClicked,
  trackUpsellShown,
} from '@/lib/billing-onramp'
import {
  countdownText,
  promoBannerKey,
  promoHref,
  promoOfferText,
  promoSpotsText,
  promoTermText,
  promoWelcomeKey,
} from '@/lib/promo'

// The Black Friday deal outside the Billing page: a strip across every page
// and a one-time popup for an org that can claim it. Billing has its own deal
// panel, and a halt or billing warning takes the spot first, so neither shows
// there.

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) != null
  } catch {
    return false
  }
}

function setFlag(key: string): void {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // storage unavailable (private mode); the prompt just shows again
  }
}

// Whether the deal prompts may show on this page right now.
function usePromoPrompt() {
  const location = useLocation()
  const { billing, warning, sessionsBlocked } = useCreditState()
  const promo = useBillingPromo()
  const onBilling = location.pathname.startsWith('/billing')
  const show =
    billingOnrampV2Enabled &&
    !!billing &&
    promo.applies &&
    !!promo.promo &&
    !onBilling &&
    !sessionsBlocked
  return { show, warning, onBilling, promo, usagePlan: billing?.usagePlan }
}

export const PromoBanner = SELFHOST ? () => null : PromoBannerImpl

function PromoBannerImpl() {
  const { show, warning, promo, usagePlan } = usePromoPrompt()
  const [dismissed, setDismissed] = useState(() => readFlag(promoBannerKey()))
  const visible = show && !warning && !dismissed
  useEffect(() => {
    if (visible) trackUpsellShown({ surface: 'promo_banner', usagePlan })
  }, [visible, usagePlan])
  if (!visible || !promo.promo) return null
  const deal = promo.promo
  return (
    <div
      role="status"
      className="bg-primary text-primary-foreground border-primary flex items-center gap-3 border-b px-4 py-2 text-sm sm:px-8"
    >
      <Tag className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 text-center">
        <span className="font-semibold">Black Friday:</span>{' '}
        {promoOfferText(deal)}.{' '}
        <span className="hidden opacity-80 sm:inline">
          {promoSpotsText(deal)} · ends in{' '}
          <BannerCountdown endsAt={deal.endsAt} />
        </span>{' '}
        <Link
          to={promoHref()}
          onClick={() =>
            trackUpsellClicked({ surface: 'promo_banner', usagePlan })
          }
          className="font-semibold whitespace-nowrap underline underline-offset-2"
        >
          Claim the deal
        </Link>
      </span>
      <button
        type="button"
        aria-label="Dismiss for today"
        onClick={() => {
          setFlag(promoBannerKey())
          setDismissed(true)
        }}
        className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

// Minute resolution is enough in a strip; ticks on its own.
function BannerCountdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="font-mono tabular-nums">
      {(countdownText(endsAt, now) ?? '').replace(/ \d\ds$/, '')}
    </span>
  )
}

export const PromoWelcomeModal = SELFHOST ? () => null : PromoWelcomeModalImpl

function PromoWelcomeModalImpl() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { show, onBilling, promo, usagePlan } = usePromoPrompt()
  const orgId = user?.orgId ?? ''
  const key = promoWelcomeKey(orgId)
  const [closed, setClosed] = useState(false)
  // Billing already shows the deal panel, so a visit there counts as seen.
  useEffect(() => {
    if (onBilling && orgId && promo.applies) setFlag(key)
  }, [onBilling, orgId, promo.applies, key])
  const seen = closed || readFlag(key)
  const open = show && !!orgId && !seen
  useEffect(() => {
    if (open) trackUpsellShown({ surface: 'promo_welcome', usagePlan })
  }, [open, usagePlan])
  if (!open || !promo.promo) return null
  const deal = promo.promo
  const close = () => {
    setFlag(key)
    setClosed(true)
  }
  return (
    <Dialog open onOpenChange={(next) => (next ? null : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <div className="text-primary mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase">
            <Tag className="size-3.5" aria-hidden />
            Black Friday · ends in <BannerCountdown endsAt={deal.endsAt} />
          </div>
          <DialogTitle>Half price, double the minutes</DialogTitle>
          <DialogDescription>{promoTermText(deal)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2">
          {PAID_PLANS.map((plan) => {
            const price = promo.pricing(plan)
            return (
              <Button
                key={plan}
                className="h-auto flex-col items-start gap-0.5 py-2.5"
                variant={plan === 'pro' ? 'default' : 'outline'}
                onClick={() => {
                  trackUpsellClicked({
                    surface: 'promo_welcome',
                    plan,
                    usagePlan,
                  })
                  close()
                  void navigate(promoHref(plan))
                }}
              >
                <span>
                  {PLAN_NAMES[plan]} ·{' '}
                  {price.normalPriceUsd != null ? (
                    <s className="font-normal opacity-70">
                      ${price.normalPriceUsd}
                    </s>
                  ) : null}{' '}
                  ${price.priceUsd}/mo
                </span>
                <span className="text-xs font-normal opacity-80">
                  {formatMinutes(price.minutes)} a month
                </span>
              </Button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={close}
          className="text-muted-foreground hover:text-foreground text-center text-xs underline-offset-2 hover:underline"
        >
          Not now
        </button>
      </DialogContent>
    </Dialog>
  )
}
