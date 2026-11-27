import { describe, expect, it } from 'vitest'
import type { BillingPromo } from '@/api/schemas'
import {
  activeClaim,
  countdownText,
  planPricing,
  promoApplies,
  promoIntentPath,
  promoMonths,
  promoTermText,
  promoUnavailableText,
} from '@/lib/promo'

const NOW = new Date('2026-11-27T12:00:00Z').getTime()

const promo = (over: Partial<BillingPromo> = {}): BillingPromo => ({
  id: 'bfcm2026',
  active: true,
  endsAt: '2026-12-01T07:59:00Z',
  earlyCap: 50,
  earlyLeft: 37,
  plans: {
    pro: { price: 10, minutes: 4000, normalPrice: 20, normalMinutes: 2000 },
    max: { price: 100, minutes: 50000, normalPrice: 200, normalMinutes: 25000 },
  },
  eligible: true,
  claim: null,
  ...over,
})

describe('bfcm promo', () => {
  it('applies only while active, eligible, unclaimed and before endsAt', () => {
    expect(promoApplies(promo(), NOW)).toBe(true)
    expect(promoApplies(undefined, NOW)).toBe(false)
    expect(promoApplies(promo({ active: false }), NOW)).toBe(false)
    expect(promoApplies(promo({ eligible: false }), NOW)).toBe(false)
    expect(
      promoApplies(
        promo({
          claim: { plan: 'pro', months: 12, endsAt: '2027-11-30T00:00:00Z' },
        }),
        NOW,
      ),
    ).toBe(false)
    expect(
      promoApplies(promo(), new Date('2026-12-01T08:00:00Z').getTime()),
    ).toBe(false)
  })

  it('prices plans at the deal with the normal price struck through', () => {
    expect(planPricing('pro', promo(), NOW)).toEqual({
      priceUsd: 10,
      minutes: 4000,
      normalPriceUsd: 20,
      normalMinutes: 2000,
    })
    expect(planPricing('max', promo(), NOW).priceUsd).toBe(100)
  })

  it('falls back to normal pricing when the deal is unknown or not for this org', () => {
    const normal = {
      priceUsd: 20,
      minutes: 2000,
      normalPriceUsd: null,
      normalMinutes: null,
    }
    expect(planPricing('pro', undefined, NOW)).toEqual(normal)
    expect(planPricing('pro', promo({ eligible: false }), NOW)).toEqual(normal)
  })

  it('keeps the deal price on the claimed plan only', () => {
    const claimed = promo({
      eligible: false,
      claim: { plan: 'pro', months: 12, endsAt: '2027-11-30T00:00:00Z' },
    })
    expect(planPricing('pro', claimed, NOW).priceUsd).toBe(10)
    expect(planPricing('max', claimed, NOW).priceUsd).toBe(200)
    expect(activeClaim(claimed, NOW)?.plan).toBe('pro')
    expect(
      activeClaim(claimed, new Date('2027-12-01T00:00:00Z').getTime()),
    ).toBeNull()
  })

  it('says 12 months while early spots remain, 3 after', () => {
    expect(promoMonths(promo())).toBe(12)
    expect(promoMonths(promo({ earlyLeft: 0 }))).toBe(3)
    expect(promoTermText(promo())).toBe(
      'Locked for 12 months for the first 50 workspaces. 37 spots left.',
    )
    expect(promoTermText(promo({ earlyLeft: 1 }))).toContain('1 spot left')
    expect(promoTermText(promo({ earlyLeft: 0 }))).toBe(
      'The 50 twelve-month spots are taken. Claim now to lock it in for 3 months.',
    )
  })

  it('counts down to endsAt', () => {
    expect(countdownText('2026-12-01T07:59:00Z', NOW)).toBe('3d 19h 59m')
    expect(
      countdownText(
        '2026-12-01T07:59:00Z',
        new Date('2026-12-01T05:58:30Z').getTime(),
      ),
    ).toBe('02h 00m 30s')
    expect(
      countdownText('2026-12-01T07:59:00Z', new Date('2026-12-02').getTime()),
    ).toBeNull()
  })

  it('explains a promo link that does not apply', () => {
    expect(promoUnavailableText(undefined, NOW)).toBeNull()
    expect(promoUnavailableText(promo(), NOW)).toBeNull()
    expect(promoUnavailableText(promo({ active: false }), NOW)).toContain(
      'has ended',
    )
    expect(promoUnavailableText(promo({ eligible: false }), NOW)).toContain(
      "aren't on a paid plan",
    )
  })

  it('turns a signup deal link into the Billing checkout with the promo', () => {
    expect(
      promoIntentPath(new URLSearchParams('plan=pro&promo=bfcm2026')),
    ).toBe('/billing?plan=pro&promo=bfcm2026&from=signup#plans')
    expect(promoIntentPath(new URLSearchParams('promo=bfcm2026'))).toBe(
      '/billing?promo=bfcm2026&from=signup#plans',
    )
    expect(
      promoIntentPath(new URLSearchParams('plan=evil&promo=bfcm2026')),
    ).toBe('/billing?promo=bfcm2026&from=signup#plans')
    // A plain plan link keeps landing in the product.
    expect(promoIntentPath(new URLSearchParams('plan=pro'))).toBeNull()
    expect(promoIntentPath(new URLSearchParams('promo=other'))).toBeNull()
  })
})
