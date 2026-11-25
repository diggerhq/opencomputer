import type { Repository } from './api'

// Words for the knowledge repository the Work API reads.

// The open-items poll runs this often (tech design 3.11).
export const OPEN_POLL_MS = 15_000

export function repositoryName(r: Repository) {
  return `${r.owner}/${r.name}`
}

// The server's problem codes (its RepositoryProblem), in words, for when it
// sends no `problemMessage`.
const PROBLEM_TEXT: Record<string, string> = {
  installation_removed:
    'The GitHub installation is not connected to this organization.',
  installation_suspended: 'The GitHub installation is suspended.',
  repository_not_found:
    'The repository does not exist, or the GitHub installation no longer grants it.',
  branch_not_found: 'The repository has no such branch.',
  access_denied: "The GitHub installation cannot read the repository's files.",
  github_app_not_configured: 'The GitHub App is not configured.',
}

/**
 * Why the repository cannot be read, as a sentence; null when it can. The
 * server's own message wins; a code is never shown as it is.
 */
export function repositoryProblem(r: Repository): string | null {
  if (!r.problem) return null
  return (
    r.problemMessage?.trim() ||
    PROBLEM_TEXT[r.problem] ||
    'GitHub refused the last read; check the repository setting.'
  )
}
