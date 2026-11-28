// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'

const client = vi.hoisted(() => ({
  getBilling: vi.fn(),
  getAutumnBilling: vi.fn(),
  getBillingPromo: vi.fn(),
  getAgentSessionUsage: vi.fn(),
  autumnSubscribeUsagePlan: vi.fn(),
}))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  ...client,
}))
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }))

const { default: Billing } = await import('./Billing')

const trial = {
  creditsRemainingCents: 1_000,
  creditBreakdown: {
    available: true,
    planRemainingCents: 1_000,
    topupRemainingCents: 0,
    otherRemainingCents: 0,
    planResetsAt: null,
  },
  concurrencyPlan: 'base',
  usagePlan: 'trial',
  isHalted: false,
  haltReason: null,
  warning: null,
  trialEndsAt: '2026-11-30T00:00:00Z',
  workMinutes: { granted: 600, remaining: 412, resetsAt: null },
  periodEndsAt: null,
  scheduledChange: null,
  hasToppedUp: false,
  hasPaidSubscription: false,
  autoTopup: null,
}

const promo = {
  id: 'bfcm2026',
  active: true,
  endsAt: '2099-12-01T07:59:00Z',
  earlyCap: 50,
  earlyLeft: 37,
  plans: {
    pro: { price: 10, minutes: 4000, normalPrice: 20, normalMinutes: 2000 },
    max: { price: 100, minutes: 50000, normalPrice: 200, normalMinutes: 25000 },
  },
  eligible: true,
  claim: null,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  client.getBilling.mockResolvedValue({
    plan: 'free',
    billingProvider: 'autumn',
    stripeCreditCents: 0,
    hasPaymentMethod: false,
    freeCreditsRemainingCents: 0,
  })
  client.getAutumnBilling.mockResolvedValue(trial)
  client.getAgentSessionUsage.mockResolvedValue({ sessions: [] })
  client.autumnSubscribeUsagePlan.mockResolvedValue({ url: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function render(path = '/billing') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Billing />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  })
  for (let i = 0; i < 20; i++) await flush()
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const button = (text: string) =>
  [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )
const plans = () => container.querySelector('#plans')!.textContent

describe('billing page Black Friday deal', () => {
  it('shows deal prices struck through against normal, with the price lock and a countdown', async () => {
    client.getBillingPromo.mockResolvedValue(promo)
    await render()
    expect(container.textContent).toContain(
      'Pro and Max at half price with double the minutes.',
    )
    expect(container.textContent).toContain('12-month price lock')
    expect(container.textContent).not.toContain('spots left')
    expect(container.textContent).toContain('Ends in')
    const struck = [...container.querySelectorAll('#plans s')].map(
      (s) => s.textContent,
    )
    expect(struck).toEqual(['$20', '2,000 min', '$200', '25,000 min'])
    expect(plans()).toContain('$10/mo')
    expect(plans()).toContain('4,000 min')
    expect(plans()).toContain('$100/mo')
  })

  it('sends the promo with the plan checkout', async () => {
    client.getBillingPromo.mockResolvedValue(promo)
    await render()
    act(() => button('Upgrade to Pro')!.click())
    await flush()
    expect(document.body.textContent).toContain('Black Friday price: $10/mo')
    act(() => button('Pro — $10/mo')!.click())
    await flush()
    expect(client.autumnSubscribeUsagePlan).toHaveBeenCalledWith(
      'pro',
      'billing_page',
      'bfcm2026',
    )
  })

  it('opens the deal checkout from a signup link and carries the promo', async () => {
    client.getBillingPromo.mockResolvedValue(promo)
    await render('/billing?plan=max&promo=bfcm2026&from=signup')
    act(() => button('Max — $100/mo')!.click())
    await flush()
    expect(client.autumnSubscribeUsagePlan).toHaveBeenCalledWith(
      'max',
      'signup',
      'bfcm2026',
    )
  })

  it('shows normal pricing and no promo when the endpoint fails', async () => {
    client.getBillingPromo.mockRejectedValue(new ApiError('Not found', 404))
    await render('/billing?promo=bfcm2026')
    expect(container.textContent).not.toContain('Black Friday')
    expect(container.querySelectorAll('#plans s')).toHaveLength(0)
    expect(plans()).toContain('$20/mo')
    act(() => button('Upgrade to Pro')!.click())
    await flush()
    act(() => button('Pro — $20/mo')!.click())
    await flush()
    expect(client.autumnSubscribeUsagePlan).toHaveBeenCalledWith(
      'pro',
      'billing_page',
      undefined,
    )
  })

  it("shows the org's claim and keeps the deal price on the claimed plan", async () => {
    client.getAutumnBilling.mockResolvedValue({
      ...trial,
      usagePlan: 'pro',
      hasPaidSubscription: true,
      periodEndsAt: '2026-12-27T00:00:00Z',
      workMinutes: { granted: 4000, remaining: 3900, resetsAt: null },
    })
    client.getBillingPromo.mockResolvedValue({
      ...promo,
      eligible: false,
      claim: { plan: 'pro', months: 12, endsAt: '2099-11-27T00:00:00Z' },
    })
    await render()
    expect(container.textContent).toContain('Black Friday deal claimed')
    expect(container.textContent).toContain('locked for 12 months')
    const struck = [...container.querySelectorAll('#plans s')].map(
      (s) => s.textContent,
    )
    expect(struck).toEqual(['$20', '2,000 min'])
    expect(plans()).toContain('$200/mo')
  })

  it('explains why a promo link does not apply to an ineligible org', async () => {
    client.getBillingPromo.mockResolvedValue({ ...promo, eligible: false })
    await render('/billing?promo=bfcm2026')
    expect(container.textContent).toContain(
      "The Black Friday deal is for workspaces that aren't on a paid plan yet",
    )
    expect(container.querySelectorAll('#plans s')).toHaveLength(0)
  })
})
