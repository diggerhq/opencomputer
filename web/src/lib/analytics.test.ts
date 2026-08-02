import { beforeEach, describe, expect, it, vi } from 'vitest'

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  capture: vi.fn(),
  reset: vi.fn(),
}))

vi.mock('posthog-js', () => ({ default: posthog }))

describe('product analytics', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('stays disabled when no project token is configured', async () => {
    const analytics = await import('./analytics')

    analytics.initializeAnalytics(undefined, undefined)
    analytics.identifyAnalyticsUser({
      id: 'user-1',
      email: 'person@example.com',
      orgId: 'org-1',
    })
    analytics.captureAnalyticsEvent('sandbox_created')
    analytics.resetAnalytics()

    expect(posthog.init).not.toHaveBeenCalled()
    expect(posthog.identify).not.toHaveBeenCalled()
    expect(posthog.group).not.toHaveBeenCalled()
    expect(posthog.capture).not.toHaveBeenCalled()
    expect(posthog.reset).not.toHaveBeenCalled()
  })

  it('initializes once with SPA navigation and privacy-safe replay defaults', async () => {
    const analytics = await import('./analytics')

    analytics.initializeAnalytics('phc_project', 'https://eu.i.posthog.com')
    analytics.initializeAnalytics('phc_other', undefined)

    expect(posthog.init).toHaveBeenCalledOnce()
    expect(posthog.init).toHaveBeenCalledWith('phc_project', {
      api_host: 'https://eu.i.posthog.com',
      defaults: '2026-06-25',
      capture_pageview: 'history_change',
      capture_pageleave: true,
      person_profiles: 'identified_only',
      mask_personal_data_properties: true,
      custom_personal_data_properties: ['action', 'returnTo'],
      session_recording: { maskAllInputs: true },
    })
  })

  it('attributes events to both the signed-in user and active organization', async () => {
    const analytics = await import('./analytics')
    analytics.initializeAnalytics('phc_project', undefined)

    analytics.identifyAnalyticsUser({
      id: 'user-1',
      email: 'person@example.com',
      orgId: 'org-1',
      orgName: 'Example Org',
    })
    analytics.captureAnalyticsEvent('sandbox_created', { region: 'us-east' })
    analytics.resetAnalytics()

    expect(posthog.identify).toHaveBeenCalledWith('user-1', {
      email: 'person@example.com',
      org_id: 'org-1',
    })
    expect(posthog.group).toHaveBeenCalledWith('organization', 'org-1', {
      name: 'Example Org',
    })
    expect(posthog.capture).toHaveBeenCalledWith(
      'sandbox_created',
      { region: 'us-east' },
      undefined,
    )
    expect(posthog.reset).toHaveBeenCalledOnce()
  })
})
