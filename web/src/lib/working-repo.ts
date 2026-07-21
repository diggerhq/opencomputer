export interface WorkingRepoValue {
  repo: string
  fullName?: string
  ref: string
}

export interface WorkingRepoOption {
  id?: string | null
  full_name: string
  default_branch?: string | null
}

export function workingRepoValue(
  repo: WorkingRepoOption,
  flue: boolean,
): string {
  return flue ? (repo.id ?? repo.full_name) : repo.full_name
}

export function selectedWorkingRepo(
  repo: WorkingRepoOption,
  flue: boolean,
  current: WorkingRepoValue | null,
): WorkingRepoValue {
  const repoValue = workingRepoValue(repo, flue)
  return {
    repo: repoValue,
    ...(flue ? { fullName: repo.full_name } : {}),
    ref:
      current?.repo === repoValue
        ? current.ref
        : (repo.default_branch ?? 'main'),
  }
}
