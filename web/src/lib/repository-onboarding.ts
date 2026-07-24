import { ApiError, type RepositorySourceInspection } from '@/api/client'

export type RepositoryReviewPresentation = {
  heading: string
  explanation: string
  primaryAction: 'deploy' | 'review_again' | 'choose_folder'
}

export type RepositorySeed = {
  repo: string
  path: string
  productionRef: string
}

export function isValidRepositoryRoot(root: string): boolean {
  if (
    root.length > 1024 ||
    root.includes('\0') ||
    root.includes('\\') ||
    root.startsWith('/')
  )
    return false
  return !root
    .split('/')
    .filter(Boolean)
    .some((part) => part === '.' || part === '..')
}

/** Mirrors the server's repository-root canonicalization for local conflict
 * presentation only. Review/import still re-normalize and enforce it. */
export function normalizeRepositoryRoot(root: string): string {
  return root.trim().split('/').filter(Boolean).join('/')
}

/** Read the bounded same-origin handoff used after a confirmed source unlink. */
export function repositorySeedFromState(
  value: unknown,
): RepositorySeed | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const seed = (value as { repositoryImport?: unknown }).repositoryImport
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return
  const candidate = seed as Record<string, unknown>
  if (
    typeof candidate.repo !== 'string' ||
    !/^repo_[a-z0-9]{24}$/.test(candidate.repo) ||
    typeof candidate.path !== 'string' ||
    !isValidRepositoryRoot(candidate.path) ||
    typeof candidate.productionRef !== 'string' ||
    !candidate.productionRef.trim() ||
    candidate.productionRef.length > 255
  ) {
    return
  }
  return {
    repo: candidate.repo,
    path: candidate.path,
    productionRef: candidate.productionRef,
  }
}

/** Canonical user-facing state for the server's repository interpretation. */
export function repositoryReviewPresentation(
  inspection: RepositorySourceInspection,
): RepositoryReviewPresentation {
  switch (inspection.interpretation.disposition) {
    case 'exact':
      return inspection.interpretation.source_profile === 'flue-prompt-v1'
        ? {
            heading: 'Prompt-defined Flue agent',
            explanation:
              'OpenComputer will turn this prompt and its skills into a Flue app at build time.',
            primaryAction: 'deploy',
          }
        : {
            heading: 'Flue app detected',
            explanation:
              'Review the detected entrypoint, model, and agent name.',
            primaryAction: 'deploy',
          }
    case 'invalid':
      return {
        heading: 'This Flue agent needs a fix',
        explanation:
          'OpenComputer found a Flue definition, but it is not deployable yet. It was not treated as another agent type.',
        primaryAction: 'review_again',
      }
    case 'unrecognized':
      return inspection.candidate_roots.length
        ? {
            heading: 'Agent definitions found in other folders',
            explanation:
              'Choose a repository root to review. OpenComputer will never select one for you.',
            primaryAction: 'choose_folder',
          }
        : {
            heading: "We couldn't find an agent definition in this folder",
            explanation:
              'Add an agent.toml next to prompt.md, choose another folder, or start from the Flue app template.',
            primaryAction: 'choose_folder',
          }
  }
}

export function sourceChangedRequiresReview(error: unknown): boolean {
  return error instanceof ApiError && error.type === 'source_changed_re_review'
}
