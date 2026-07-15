export type AgentCreationMode = 'github' | 'manual'

export function resolveAgentCreationMode(
  requestedMode: string | null,
): AgentCreationMode {
  return requestedMode === 'manual' ? 'manual' : 'github'
}
