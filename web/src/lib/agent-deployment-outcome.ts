import type { AgentDeployment } from '@/api/client'

export type AgentDeploymentOutcome = {
  kind: 'success' | 'error' | 'info' | 'progress'
  title: string
  description: string
}

function revisionLabel(deployment: AgentDeployment): string {
  return deployment.revision?.number
    ? `Revision #${deployment.revision.number}`
    : 'The built revision'
}

function failureMessage(deployment: AgentDeployment): string | undefined {
  return deployment.error?.message
}

/**
 * Describe this immutable attempt against the agent's current live pointer.
 * Historical rows must not claim that they are still active or unverified after
 * a later deployment changed the live truth.
 */
export function agentDeploymentOutcome(
  deployment: AgentDeployment,
): AgentDeploymentOutcome {
  const live = deployment.agent_live
  const liveBelongsToAttempt = live?.deployment_id === deployment.id
  const canStart = deployment.allowed_actions.includes('start_session')

  if (deployment.state === 'ready') {
    if (deployment.active && canStart) {
      return {
        kind: 'success',
        title: 'Deployment ready',
        description: `${revisionLabel(deployment)} is active and ready to run.`,
      }
    }
    if (!deployment.active) {
      return {
        kind: 'info',
        title: 'Deployment succeeded',
        description: `${revisionLabel(deployment)} was created, but another revision is active.`,
      }
    }
    return {
      kind: 'error',
      title: 'Active deployment is not verified',
      description:
        liveBelongsToAttempt && live?.status === 'updating'
          ? 'The live Worker is still updating. New sessions remain paused until verification finishes.'
          : 'The revision is active, but the current live Worker is not verified for new sessions.',
    }
  }

  if (deployment.state === 'failed') {
    const message = failureMessage(deployment)
    if (
      deployment.live_touched &&
      (liveBelongsToAttempt || !live) &&
      live?.status !== 'verified'
    ) {
      return {
        kind: 'error',
        title: 'Live deployment could not be verified',
        description:
          message ??
          'The live Worker may have changed. Check the persisted log before starting new work.',
      }
    }

    const currentTruth =
      live?.status === 'verified'
        ? ' A later verified deployment is now live.'
        : live && !liveBelongsToAttempt
          ? ' A later deployment currently requires attention before new sessions can start.'
          : ''
    return {
      kind: 'error',
      title: 'Deployment failed',
      description:
        (message ??
          (deployment.live_touched
            ? 'This attempt changed the live Worker before it failed.'
            : 'The live agent was not changed. Fix the repository before deploying again.')) +
        currentTruth,
    }
  }

  if (
    deployment.state === 'canceled' ||
    deployment.state === 'superseded' ||
    deployment.state === 'skipped'
  ) {
    return {
      kind: 'info',
      title:
        deployment.state === 'skipped'
          ? 'No changes to deploy'
          : deployment.state === 'canceled'
            ? 'Deployment canceled'
            : 'Deployment superseded',
      description:
        deployment.state === 'skipped'
          ? 'The built result matches the active revision, so the live agent was left unchanged.'
          : 'This attempt ended without producing a new revision.',
    }
  }

  return {
    kind: 'progress',
    title: 'Deployment in progress',
    description: 'This page polls the durable deployment record and build log.',
  }
}
