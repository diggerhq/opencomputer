import { describe, expect, it } from 'vitest'
import { repositoryProblem } from './board'

describe('repository problem', () => {
  const r = {
    installationId: '1',
    owner: 'acme',
    name: 'knowledge',
    branch: 'main',
  }
  it('prefers the server sentence, then words for a known code', () => {
    expect(repositoryProblem({ ...r, problem: null })).toBeNull()
    expect(
      repositoryProblem({
        ...r,
        problem: 'access_denied',
        problemMessage: 'GitHub said no.',
      }),
    ).toBe('GitHub said no.')
    expect(repositoryProblem({ ...r, problem: 'repository_not_found' })).toBe(
      'The repository does not exist, or the GitHub installation no longer grants it.',
    )
    const unknown = repositoryProblem({ ...r, problem: 'something_new' })
    expect(unknown).toBeTruthy()
    expect(unknown).not.toContain('something_new')
  })
})
