import { describe, expect, it } from 'vitest'
import {
  deploymentSlackPresentation,
  deploymentStage,
} from '@/lib/deployment-slack-cta'

function presentation(
  patch: Partial<Parameters<typeof deploymentSlackPresentation>[0]> = {},
) {
  return deploymentSlackPresentation({
    deploymentState: 'building',
    deploymentTerminal: false,
    managedStatus: null,
    openUrl: null,
    connecting: false,
    ...patch,
  })
}

describe('deployment and managed Slack composition', () => {
  it('derives running, ready, and failed from deployment truth', () => {
    expect(deploymentStage('building', false)).toBe('running')
    expect(deploymentStage('ready', true)).toBe('ready')
    expect(deploymentStage('failed', true)).toBe('failed')
  })

  it('offers Slack setup immediately while a deployment runs', () => {
    expect(presentation()).toMatchObject({
      action: 'connect',
      label: 'Connect Slack',
      disclosure: true,
    })
    expect(presentation({ connecting: true })).toMatchObject({
      action: 'connecting',
      label: 'Connecting…',
    })
  })

  it('keeps an active connection quiet until the deployment is ready', () => {
    expect(presentation({ managedStatus: 'active' })).toMatchObject({
      action: null,
      status: 'Slack connected. Open Slack when this deployment is ready.',
    })
  })

  it('promotes Open Slack only when ready and active', () => {
    expect(
      presentation({
        deploymentState: 'ready',
        deploymentTerminal: true,
        managedStatus: 'active',
        openUrl: 'https://slack.com/app_redirect?app=A123',
      }),
    ).toMatchObject({
      action: 'open',
      label: 'Open Slack',
      announcement: 'Deployment ready. Open Slack is now available.',
    })
  })

  it('offers setup from ready and keeps dashboard chat secondary', () => {
    expect(
      presentation({
        deploymentState: 'ready',
        deploymentTerminal: true,
      }),
    ).toMatchObject({ action: 'connect', label: 'Connect Slack' })
  })

  it('makes deployment recovery primary after failure', () => {
    expect(
      presentation({
        deploymentState: 'failed',
        deploymentTerminal: true,
      }),
    ).toMatchObject({ action: null, status: null })
    expect(
      presentation({
        deploymentState: 'failed',
        deploymentTerminal: true,
        managedStatus: 'active',
      }),
    ).toMatchObject({
      action: null,
      status: 'Slack remains connected while you fix this deployment.',
    })
  })

  it('does not mistake loading for a never-connected result', () => {
    expect(presentation({ managedStatus: undefined })).toMatchObject({
      action: null,
      label: null,
    })
  })

  it('keeps reconnect a connector-local action', () => {
    for (const managedStatus of ['disconnected', 'error', 'revoked'] as const) {
      expect(presentation({ managedStatus })).toMatchObject({
        action: 'reconnect',
        label: 'Reconnect Slack',
      })
    }
  })
})
