import type {
  DeployApp,
  RepositoryAccess,
  RepositoryAccessPolicy,
  RepositoryAccessRepository,
} from '@/api/client'

export const repositoryAccessQueryKey = (agentId: string) =>
  ['agent-repository-access', agentId] as const

/** Built-in runtimes can configure repository scope before Slack. Flue keeps
 * its established guided order, which reveals repository access after managed
 * Slack is active. */
export function showRepositoryAccessDuringSetup(
  runtime: string | null | undefined,
  managedSlackStatus: string | null | undefined,
): boolean {
  return runtime !== 'flue' || managedSlackStatus === 'active'
}

export function selectedRepositoryIds(
  policy: RepositoryAccessPolicy,
): string[] {
  return policy.mode === 'selected' ? policy.repository_ids : []
}

export function isNarrowingRepositoryAccess(
  previous: RepositoryAccessPolicy,
  next: RepositoryAccessPolicy,
): boolean {
  if (previous.mode === 'all') return next.mode === 'selected'
  if (next.mode === 'all') return false
  const nextIds = new Set(next.repository_ids)
  return previous.repository_ids.some((id) => !nextIds.has(id))
}

export function sameRepositoryAccessPolicy(
  left: RepositoryAccessPolicy,
  right: RepositoryAccessPolicy,
): boolean {
  if (left.mode !== right.mode) return false
  if (left.mode === 'all' || right.mode === 'all') return true
  if (left.repository_ids.length !== right.repository_ids.length) return false
  const rightIds = new Set(right.repository_ids)
  return left.repository_ids.every((id) => rightIds.has(id))
}

/**
 * Repository-access is authoritative for policy and effective access. The
 * org-scoped deploy-app response only fills the editor's candidate catalog so
 * selected mode can be expanded. Identity is always the stable repo id.
 */
export function repositoryAccessCandidates(
  access: RepositoryAccess,
  deployApp?: DeployApp,
): RepositoryAccessRepository[] {
  const byId = new Map<string, RepositoryAccessRepository>()
  for (const repo of deployApp?.repositories ?? []) {
    if (!repo.id) continue
    byId.set(repo.id, {
      id: repo.id,
      full_name: repo.full_name,
      default_branch: repo.default_branch ?? 'main',
      private: repo.private ?? true,
    })
  }
  for (const repo of access.effective_repositories ?? [])
    byId.set(repo.id, repo)
  for (const repo of access.unavailable_selected_repositories) {
    if (!byId.has(repo.id)) {
      byId.set(repo.id, {
        ...repo,
        default_branch: 'main',
        private: true,
      })
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.full_name.localeCompare(b.full_name),
  )
}

export function toggleSelectedRepository(
  policy: RepositoryAccessPolicy,
  repositoryId: string,
  checked: boolean,
): RepositoryAccessPolicy {
  const ids = new Set(selectedRepositoryIds(policy))
  if (checked) ids.add(repositoryId)
  else ids.delete(repositoryId)
  return { mode: 'selected', repository_ids: [...ids].sort() }
}
