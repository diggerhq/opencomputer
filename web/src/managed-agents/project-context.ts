export type ProjectEnvironment = 'default' | 'development' | 'production'
export type ProjectEnvironmentMode = 'single' | 'legacy'

export const SINGLE_ENVIRONMENT: ProjectEnvironment = 'default'
export const LEGACY_ENVIRONMENTS = ['development', 'production'] as const

/** A project without a stored mode is a legacy Development/Production project. */
export function projectEnvironmentMode(
  project: { environmentMode?: string } | undefined,
): ProjectEnvironmentMode {
  return project?.environmentMode === 'single' ? 'single' : 'legacy'
}

export function projectEnvironments(
  mode: ProjectEnvironmentMode,
): readonly ProjectEnvironment[] {
  return mode === 'single' ? [SINGLE_ENVIRONMENT] : LEGACY_ENVIRONMENTS
}

export type ResolvedProjectEnvironment =
  | { ok: true; environment: ProjectEnvironment; canonicalSearch?: string }
  | { ok: false; requested: string }

/**
 * Resolve the `?environment=` query for a project. Legacy projects read
 * Development unless Production is asked for. Single-mode projects have one
 * `default` scope: an older `environment=development` bookmark resolves to it
 * and reports the environmentless URL to redirect to; `environment=production`
 * is incompatible and is reported rather than shown as the single scope.
 */
export function resolveProjectEnvironment(
  mode: ProjectEnvironmentMode,
  search: string,
): ResolvedProjectEnvironment {
  const params = new URLSearchParams(search)
  const requested = params.get('environment')
  if (mode === 'legacy') {
    return {
      ok: true,
      environment: requested === 'production' ? 'production' : 'development',
    }
  }
  if (requested === null || requested === '' || requested === 'default') {
    return { ok: true, environment: SINGLE_ENVIRONMENT }
  }
  if (requested === 'development') {
    params.delete('environment')
    return {
      ok: true,
      environment: SINGLE_ENVIRONMENT,
      canonicalSearch: params.size ? `?${params.toString()}` : '',
    }
  }
  return { ok: false, requested }
}

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

/**
 * The project's working scope (legacy Development, single `default`) is the
 * URL default and is never written to the query, so single-mode URLs stay
 * environmentless and cross-project links carry no legacy environment.
 */
function isUrlDefault(environment: ProjectEnvironment) {
  return environment === 'development' || environment === 'default'
}

export function projectContextSearch(
  search: string,
  agentId: string | undefined,
  environment: ProjectEnvironment,
) {
  const next = new URLSearchParams(search)
  if (agentId) next.set('agent', agentId)
  else next.delete('agent')
  if (isUrlDefault(environment)) next.delete('environment')
  else next.set('environment', environment)
  return next.size ? `?${next.toString()}` : ''
}

export function projectEnvironmentSearch(
  search: string,
  environment: ProjectEnvironment,
) {
  const next = new URLSearchParams(search)
  if (isUrlDefault(environment)) next.delete('environment')
  else next.set('environment', environment)
  return next.size ? `?${next.toString()}` : ''
}
