import type {
  ManagedAgentDeployment,
  ManagedAgentEvent,
  ManagedAgentSession,
} from './api'
import type { ProjectEnvironment } from './project-context'

export function sessionsForEnvironment(
  sessions: ManagedAgentSession[],
  deployments: ManagedAgentDeployment[],
  agentId: string,
  environment: ProjectEnvironment,
) {
  const deploymentIds = new Set(
    deployments
      .filter(
        (deployment) =>
          deployment.agentId === agentId && deployment.alias === environment,
      )
      .map((deployment) => deployment.id),
  )
  return sessions.filter((session) => deploymentIds.has(session.deploymentId))
}

export function playgroundSessionIdFromSearch(search: string) {
  return new URLSearchParams(search).get('session') || undefined
}

export function playgroundSessionSearch(search: string, sessionId?: string) {
  const next = new URLSearchParams(search)
  if (sessionId) next.set('session', sessionId)
  else next.delete('session')
  return next.size ? `?${next.toString()}` : ''
}

export function turnAssistantText(events: ManagedAgentEvent[], turnId: string) {
  let streamedText = ''
  let completedText = ''
  for (const event of events) {
    if (event.turnId !== turnId || typeof event.data.text !== 'string') continue
    if (event.type === 'message.delta') streamedText += event.data.text
    if (event.type === 'message.completed') completedText = event.data.text
  }
  return streamedText || completedText
}
