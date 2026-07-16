export type ManagedSlackStatus =
  | 'active'
  | 'disconnected'
  | 'error'
  | 'revoked'
  | null
  | undefined

export type DeploymentSlackAction =
  | 'connect'
  | 'connecting'
  | 'reconnect'
  | 'open'
  | null

export interface DeploymentSlackPresentation {
  action: DeploymentSlackAction
  label: string | null
  disclosure: boolean
  status: string | null
  announcement: string
}

export function deploymentStage(
  state: string,
  terminal: boolean,
): 'running' | 'ready' | 'failed' {
  if (state === 'ready') return 'ready'
  return terminal ? 'failed' : 'running'
}

/**
 * Compose two independent resources without inventing a combined backend
 * state: durable deployment readiness and the managed Slack connection.
 * `undefined` means the connection query has not produced a trustworthy result;
 * `null` is the durable "never connected" result.
 */
export function deploymentSlackPresentation(input: {
  deploymentState: string
  deploymentTerminal: boolean
  managedStatus: ManagedSlackStatus
  openUrl?: string | null
  connecting: boolean
}): DeploymentSlackPresentation {
  const stage = deploymentStage(input.deploymentState, input.deploymentTerminal)

  if (stage === 'failed') {
    return {
      action: null,
      label: null,
      disclosure: false,
      status:
        input.managedStatus === 'active'
          ? 'Slack remains connected while you fix this deployment.'
          : null,
      announcement:
        input.managedStatus === 'active'
          ? 'Deployment failed. Slack remains connected.'
          : 'Deployment failed.',
    }
  }

  if (input.managedStatus === undefined) {
    return {
      action: null,
      label: null,
      disclosure: false,
      status: null,
      announcement: '',
    }
  }

  if (input.managedStatus === 'active') {
    if (stage === 'ready' && input.openUrl) {
      return {
        action: 'open',
        label: 'Open Slack',
        disclosure: false,
        status: null,
        announcement: 'Deployment ready. Open Slack is now available.',
      }
    }
    return {
      action: null,
      label: null,
      disclosure: false,
      status:
        stage === 'running'
          ? 'Slack connected. Open Slack when this deployment is ready.'
          : 'Slack is connected.',
      announcement:
        stage === 'running'
          ? 'Slack connected. Open Slack will be available when the deployment is ready.'
          : 'Slack connected.',
    }
  }

  const reconnect =
    input.managedStatus === 'disconnected' ||
    input.managedStatus === 'error' ||
    input.managedStatus === 'revoked'

  if (input.connecting) {
    return {
      action: 'connecting',
      label: 'Connecting…',
      disclosure: input.managedStatus === null,
      status: null,
      announcement: 'Opening Slack authorization.',
    }
  }

  if (reconnect) {
    return {
      action: 'reconnect',
      label: 'Reconnect Slack',
      disclosure: false,
      status: 'The OpenComputer Slack app needs authorization.',
      announcement: 'The Slack connection needs authorization.',
    }
  }

  return {
    action: 'connect',
    label: 'Connect Slack',
    disclosure: true,
    status: null,
    announcement:
      stage === 'ready'
        ? 'Connect Slack to use this ready agent.'
        : 'Connect Slack while the deployment continues.',
  }
}
