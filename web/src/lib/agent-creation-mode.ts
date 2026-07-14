export type AgentCreationMode = 'github' | 'manual'

export function resolveAgentCreationMode(
  requestedMode: string | null,
  repositoryDeploysAvailable: boolean,
): AgentCreationMode {
  if (!repositoryDeploysAvailable) return 'manual'
  return requestedMode === 'manual' ? 'manual' : 'github'
}
