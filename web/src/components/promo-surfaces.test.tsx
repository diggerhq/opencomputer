// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  getAutumnBilling: vi.fn(),
  getBillingPromo: vi.fn(),
}))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  ...client,
}))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { orgId: 'org_1' } }),
}))
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }))

const { PromoBanner, PromoWelcomeModal } = await import('./promo-surfaces')
const { BillingWarningBanner } = await import('./billing-surfaces')

const trial = {
  creditsRemainingCents: 1_000,
  usagePlan: 'trial',
  isHalted: false,
  haltReason: null,
  warning: null as string | null,
  trialEndsAt: '2099-11-30T00:00:00Z',
  workMinutes: { granted: 600, remaining: 120, resetsAt: null },
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
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  client.getAutumnBilling.mockResolvedValue(trial)
  client.getBillingPromo.mockResolvedValue(promo)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function render(path = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <BillingWarningBanner />
          <PromoBanner />
          <PromoWelcomeModal />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  })
  // Let both queries settle.
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

const text = () => document.body.textContent ?? ''

describe('in-app Black Friday prompts', () => {
  it('shows the banner and the welcome popup to a trial org', async () => {
    await render()
    expect(text()).toContain('Pro $10/mo, Max $100/mo, double the minutes')
    expect(text()).toContain('12-month price lock for the first 50 workspaces')
    expect(text()).not.toContain('spots left')
    expect(text()).toContain('Half price, double the minutes')
    const claim = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'Claim the deal',
    )
    expect(claim?.getAttribute('href')).toBe('/billing?promo=bfcm2026#plans')
  })

  it('shows the popup once per org', async () => {
    await render()
    const notNow = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Not now',
    )
    act(() => notNow!.click())
    expect(text()).not.toContain('Half price, double the minutes')
    act(() => root.unmount())
    root = createRoot(container)
    await render()
    expect(text()).not.toContain('Half price, double the minutes')
    expect(text()).toContain('Claim the deal')
  })

  it('hides the banner for the day once dismissed', async () => {
    localStorage.setItem('oc.promo.bfcm2026.welcome.org_1', '1')
    await render()
    const dismiss = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss for today"]',
    )
    act(() => dismiss!.click())
    expect(text()).not.toContain('Claim the deal')
  })

  it('stays off Billing, which has its own deal panel', async () => {
    await render('/billing')
    expect(text()).not.toContain('Claim the deal')
    expect(text()).not.toContain('Half price, double the minutes')
    expect(localStorage.getItem('oc.promo.bfcm2026.welcome.org_1')).toBe('1')
  })

  it('shows nothing when the org cannot claim the deal', async () => {
    client.getBillingPromo.mockResolvedValue({ ...promo, eligible: false })
    await render()
    expect(text()).not.toContain('Black Friday')
  })

  it('puts the deal into a trial warning instead of a second strip', async () => {
    localStorage.setItem('oc.promo.bfcm2026.welcome.org_1', '1')
    client.getAutumnBilling.mockResolvedValue({
      ...trial,
      warning: 'trial_minutes',
    })
    await render()
    expect(text()).toContain(
      'Your trial has 120 min of work left. Black Friday: Pro is $10/mo with 4,000 min.',
    )
    const links = [...document.querySelectorAll('a')].filter(
      (a) => a.textContent === 'Claim the deal',
    )
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe(
      '/billing?plan=pro&promo=bfcm2026&from=warning#plans',
    )
  })
})
