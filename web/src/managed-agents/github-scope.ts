import type {
  ProjectGithubGrantRepository,
  ProjectGithubSelectedRepository,
} from './api'

export const projectGithubQueryKey = (projectId: string) =>
  ['project-github', projectId] as const

export const projectGithubRepositoriesQueryKey = (
  projectId: string,
  environment: 'development' | 'production',
) => ['project-github-repositories', projectId, environment] as const

/** A repository pinned by `selected` scope. Identity is the numeric GitHub
 * repo id; the name rides along only because the PUT contract wants it. */
export type ProjectGithubScopeRepository = {
  repoId: number
  fullName: string
}

export type ProjectGithubScopePolicy =
  | { mode: 'all' }
  | { mode: 'selected'; repositories: ProjectGithubScopeRepository[] }

/** A row in the selected-mode editor: the live grant plus dormant retained
 * selections (`granted: false` — still stored, no longer reachable). */
export type ProjectGithubScopeCandidate = {
  repoId: number
  fullName: string
  granted: boolean
  private?: boolean
  defaultBranch?: string
}

/** Shared OC app → breadth must be a visible choice (`selected`); a dedicated
 * app is the project's own and the install screen already picked repos (`all`). */
export function defaultProjectGithubScopeMode(
  appMode: 'oc_app' | 'dedicated',
): 'all' | 'selected' {
  return appMode === 'oc_app' ? 'selected' : 'all'
}

export function selectedProjectGithubRepoIds(
  policy: ProjectGithubScopePolicy,
): number[] {
  return policy.mode === 'selected'
    ? policy.repositories.map((repository) => repository.repoId)
    : []
}

export function isNarrowingProjectGithubScope(
  previous: ProjectGithubScopePolicy,
  next: ProjectGithubScopePolicy,
): boolean {
  if (previous.mode === 'all') return next.mode === 'selected'
  if (next.mode === 'all') return false
  const nextIds = new Set(selectedProjectGithubRepoIds(next))
  return selectedProjectGithubRepoIds(previous).some((id) => !nextIds.has(id))
}

export function sameProjectGithubScopePolicy(
  left: ProjectGithubScopePolicy,
  right: ProjectGithubScopePolicy,
): boolean {
  if (left.mode !== right.mode) return false
  if (left.mode === 'all' || right.mode === 'all') return true
  const leftIds = selectedProjectGithubRepoIds(left)
  const rightIds = new Set(selectedProjectGithubRepoIds(right))
  return (
    leftIds.length === rightIds.size && leftIds.every((id) => rightIds.has(id))
  )
}

/**
 * Merge the live grant enumeration with every stored selected entry so dormant
 * selections stay visible instead of being silently dropped. The server's
 * `granted` flag is authoritative for dormancy — a selected repository omitted
 * from a truncated grant view is never classified as revoked here.
 */
export function projectGithubScopeCandidates(
  grant: ProjectGithubGrantRepository[],
  selected: ProjectGithubSelectedRepository[],
): ProjectGithubScopeCandidate[] {
  const byId = new Map<number, ProjectGithubScopeCandidate>()
  for (const repository of grant) {
    byId.set(repository.repoId, {
      repoId: repository.repoId,
      fullName: repository.fullName,
      granted: true,
      private: repository.private,
      defaultBranch: repository.defaultBranch,
    })
  }
  for (const repository of selected) {
    if (!byId.has(repository.repoId)) {
      byId.set(repository.repoId, {
        repoId: repository.repoId,
        fullName: repository.fullName,
        granted: repository.granted,
      })
    }
  }
  return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName))
}

export function toggleProjectGithubScopeRepository(
  policy: ProjectGithubScopePolicy,
  repository: ProjectGithubScopeRepository,
  checked: boolean,
): ProjectGithubScopePolicy {
  const byId = new Map(
    (policy.mode === 'selected' ? policy.repositories : []).map(
      (entry) => [entry.repoId, entry] as const,
    ),
  )
  if (checked) byId.set(repository.repoId, repository)
  else byId.delete(repository.repoId)
  return {
    mode: 'selected',
    repositories: [...byId.values()].sort((a, b) => a.repoId - b.repoId),
  }
}
