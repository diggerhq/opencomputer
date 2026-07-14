import type { Agent } from '@/api/client'

type AgentDeploymentHealth = Pick<
  Agent,
  'runtime' | 'revision' | 'active_revision_id' | 'deployment_status' | 'flue'
>

/**
 * The latest deployment is the primary status. A successful row is only
 * healthy when a live-touching Flue deploy also left the live pointer verified.
 */
export function agentDeploymentDisplayStatus(
  agent: AgentDeploymentHealth,
): string {
  const deployment = agent.deployment_status
  const liveStatus = deployment?.live_status ?? agent.flue?.live?.status ?? null
  const hasActiveRevision =
    !!agent.active_revision_id || (agent.revision ?? 0) > 0
  const status =
    deployment?.state ?? (hasActiveRevision ? 'ready' : 'not_deployed')
  const liveWasTouched = deployment?.live_touched ?? agent.flue?.live != null

  if (status === 'ready' && liveWasTouched && liveStatus !== 'verified') {
    return liveStatus === 'updating' ? 'updating' : 'unverified'
  }

  return status
}
