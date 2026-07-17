import { describe, expect, it } from 'vitest'
import {
  agentSetupPresentation,
  agentSetupStage,
} from './agent-setup-presentation'

describe('agentSetupPresentation', () => {
  it('keeps a fetch error distinct from a failed deployment', () => {
    expect(
      agentSetupStage({
        hasDeployment: true,
        loadFailed: true,
        canStartSession: false,
        agentReady: true,
      }),
    ).toBe('preparing')
  })

  it('requires session admission before treating ready as usable', () => {
    const base = {
      hasDeployment: true,
      state: 'ready',
      terminal: true,
      loadFailed: false,
      agentReady: true,
    }

    expect(agentSetupStage({ ...base, canStartSession: false })).toBe(
      'preparing',
    )
    expect(agentSetupStage({ ...base, canStartSession: true })).toBe('ready')
  })

  it('makes Slack the next action while deployment continues', () => {
    const view = agentSetupPresentation({
      agentName: 'Support triage',
      stage: 'preparing',
      managedStatus: null,
      connecting: false,
    })

    expect(view.title).toBe('Connect Slack while we prepare Support triage')
    expect(view.action).toBe('connect')
    expect(view.label).toBe('Connect Slack')
  })

  it('waits for readiness after Slack connects', () => {
    const view = agentSetupPresentation({
      agentName: 'Support triage',
      stage: 'preparing',
      managedStatus: 'active',
      openUrl: 'https://slack.com/app_redirect?app=A1&team=T1',
      connecting: false,
    })

    expect(view.title).toBe('Slack is connected')
    expect(view.action).toBeNull()
    expect(view.description).toContain('Open Slack will appear')
  })

  it('promotes the first message only when both resources are ready', () => {
    const view = agentSetupPresentation({
      agentName: 'Support triage',
      stage: 'ready',
      managedStatus: 'active',
      openUrl: 'https://slack.com/app_redirect?app=A1&team=T1',
      connecting: false,
    })

    expect(view.title).toBe('Send your first message')
    expect(view.action).toBe('open')
    expect(view.label).toBe('Open Slack')
  })

  it('hands a real first Slack session into continued conversation', () => {
    const view = agentSetupPresentation({
      agentName: 'Support triage',
      stage: 'ready',
      managedStatus: 'active',
      openUrl: 'https://slack.com/app_redirect?app=A1&team=T1',
      connecting: false,
      activated: true,
    })

    expect(view.title).toBe('Support triage is live in Slack')
    expect(view.action).toBe('open')
    expect(view.label).toBe('Continue in Slack')
  })

  it('makes deployment recovery primary after a failure', () => {
    const view = agentSetupPresentation({
      agentName: 'Support triage',
      stage: 'failed',
      managedStatus: 'active',
      connecting: false,
    })

    expect(view.title).toBe('The deployment needs attention')
    expect(view.action).toBeNull()
    expect(view.description).toContain('Review the failed deployment')
  })
})
