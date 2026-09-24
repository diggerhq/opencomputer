export type ProjectEnvironment = 'development' | 'production'

export function projectAgentIdFromPath(pathname: string) {
  const match = pathname.match(
    /^\/projects\/[^/]+\/playground\/([^/]+)(?:\/|$)/,
  )
  if (!match?.[1]) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

export function selectedProjectAgentId(
  pathname: string,
  search: string,
  agents: ReadonlyArray<{ id: string }>,
) {
  const requested =
    new URLSearchParams(search).get('agent') ?? projectAgentIdFromPath(pathname)
  return agents.find((agent) => agent.id === requested)?.id ?? agents[0]?.id
}

/**
 * The agent explicitly chosen in the URL, or undefined when none is — the
 * project Sessions tab treats that as "every agent in the project".
 */
export function requestedProjectAgentId(
  search: string,
  agents: ReadonlyArray<{ id: string }>,
) {
  const requested = new URLSearchParams(search).get('agent')
  return agents.find((agent) => agent.id === requested)?.id
}

export function projectContextSearch(
  search: string,
  agentId: string | undefined,
  environment: ProjectEnvironment,
) {
  const next = new URLSearchParams(search)
  if (agentId) next.set('agent', agentId)
  else next.delete('agent')
  if (environment === 'development') next.delete('environment')
  else next.set('environment', environment)
  return next.size ? `?${next.toString()}` : ''
}

export function projectEnvironmentSearch(
  search: string,
  environment: ProjectEnvironment,
) {
  const next = new URLSearchParams(search)
  if (environment === 'development') next.delete('environment')
  else next.set('environment', environment)
  return next.size ? `?${next.toString()}` : ''
}
