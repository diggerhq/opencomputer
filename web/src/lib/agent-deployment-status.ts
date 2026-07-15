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

/**
 * Session admission is stricter than the display status. New Flue deployments
 * require a verified live pointer. Existing CLI-created Flue agents can carry
 * a server-computed compatibility proof while their physical live status is
 * intentionally unknown; that proof enables admission only and must never be
 * projected as a live/verified label.
 */
export function agentCanStartNewSession(agent: AgentDeploymentHealth): boolean {
  const hasActiveRevision =
    !!agent.active_revision_id || (agent.revision ?? 0) > 0
  if (!hasActiveRevision) return false
  if (agent.runtime !== 'flue') return true

  const liveStatus =
    agent.deployment_status?.live_status ?? agent.flue?.live?.status ?? null
  return (
    liveStatus === 'verified' ||
    agent.deployment_status?.legacy_live_compatible === true
  )
}
