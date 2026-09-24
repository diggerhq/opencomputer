import { describe, expect, it } from 'vitest'
import {
  FIRST_SESSION_DEPLOY_COMMAND,
  firstSessionGuideVisible,
  firstSessionSteps,
} from './first-session-guide'

describe('first session guide', () => {
  it('appears once the only session has an answer and nothing is running', () => {
    expect(
      firstSessionGuideVisible({
        sessionCount: 1,
        hasResponse: true,
        agentWorking: false,
      }),
    ).toBe(true)
    // The sessions list may not have caught up with the session just created.
    expect(
      firstSessionGuideVisible({
        sessionCount: 0,
        hasResponse: true,
        agentWorking: false,
      }),
    ).toBe(true)
  })

  it('stays hidden while the agent works, before any answer, and after a second session', () => {
    expect(
      firstSessionGuideVisible({
        sessionCount: 1,
        hasResponse: true,
        agentWorking: true,
      }),
    ).toBe(false)
    expect(
      firstSessionGuideVisible({
        sessionCount: 1,
        hasResponse: false,
        agentWorking: false,
      }),
    ).toBe(false)
    expect(
      firstSessionGuideVisible({
        sessionCount: 2,
        hasResponse: true,
        agentWorking: false,
      }),
    ).toBe(false)
  })

  it('links each step into the project and keeps the environment', () => {
    const steps = firstSessionSteps('proj 1', 'production')
    expect(steps.map((step) => step.id)).toEqual([
      'slack',
      'schedules',
      'webhooks',
      'code',
    ])
    expect(steps.map((step) => step.to)).toEqual([
      '/projects/proj%201/connections?environment=production',
      '/projects/proj%201/schedules?environment=production',
      '/projects/proj%201/webhooks?environment=production',
      undefined,
    ])
    expect(steps[3]?.command).toBe(FIRST_SESSION_DEPLOY_COMMAND)
  })

  it('omits the environment query for development', () => {
    expect(firstSessionSteps('p', 'development')[0]?.to).toBe(
      '/projects/p/connections',
    )
  })
})
