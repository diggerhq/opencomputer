import posthog, {
  type CaptureOptions,
  type EventName,
  type Properties,
} from 'posthog-js'

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

let initialized = false

export function initializeAnalytics(
  projectToken: string | undefined,
  host: string | undefined,
): void {
  if (!projectToken || initialized) return

  posthog.init(projectToken, {
    api_host: host || DEFAULT_POSTHOG_HOST,
    defaults: '2026-06-25',
    capture_pageview: 'history_change',
    capture_pageleave: true,
    person_profiles: 'identified_only',
    mask_personal_data_properties: true,
    custom_personal_data_properties: ['action', 'returnTo'],
    session_recording: {
      maskAllInputs: true,
    },
  })
  initialized = true
}

interface AnalyticsUser {
  id: string
  email: string
  orgId: string
  orgName?: string
}

export function identifyAnalyticsUser(user: AnalyticsUser): void {
  if (!initialized) return

  posthog.identify(user.id, {
    email: user.email,
    org_id: user.orgId,
  })
  posthog.group(
    'organization',
    user.orgId,
    user.orgName ? { name: user.orgName } : undefined,
  )
}

export function captureAnalyticsEvent(
  eventName: EventName,
  properties?: Properties,
  options?: CaptureOptions,
): void {
  if (!initialized) return
  posthog.capture(eventName, properties, options)
}

export function resetAnalytics(): void {
  if (!initialized) return
  posthog.reset()
}
