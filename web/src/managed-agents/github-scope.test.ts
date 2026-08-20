import { describe, expect, it } from 'vitest'
import {
  defaultProjectGithubScopeMode,
  isNarrowingProjectGithubScope,
  projectGithubQueryKey,
  projectGithubRepositoriesQueryKey,
  projectGithubScopeCandidates,
  sameProjectGithubScopePolicy,
  toggleProjectGithubScopeRepository,
} from './github-scope'

describe('project github scope helpers', () => {
  it('uses project-namespaced query keys', () => {
    expect(projectGithubQueryKey('prj_1')).toEqual(['project-github', 'prj_1'])
    expect(projectGithubRepositoriesQueryKey('prj_1', 'production')).toEqual([
      'project-github-repositories',
      'prj_1',
      'production',
    ])
  })

  it('defaults the shared app to selected and dedicated apps to all', () => {
    expect(defaultProjectGithubScopeMode('oc_app')).toBe('selected')
    expect(defaultProjectGithubScopeMode('dedicated')).toBe('all')
  })

  it('detects narrowing without treating expansion as narrowing', () => {
    expect(
      isNarrowingProjectGithubScope(
        { mode: 'all' },
        { mode: 'selected', repositories: [{ repoId: 1, fullName: 'o/a' }] },
      ),
    ).toBe(true)
    expect(
      isNarrowingProjectGithubScope(
        { mode: 'selected', repositories: [{ repoId: 1, fullName: 'o/a' }] },
        { mode: 'all' },
      ),
    ).toBe(false)
    expect(
      isNarrowingProjectGithubScope(
        {
          mode: 'selected',
          repositories: [
            { repoId: 1, fullName: 'o/a' },
            { repoId: 2, fullName: 'o/dormant' },
          ],
        },
        { mode: 'selected', repositories: [{ repoId: 1, fullName: 'o/a' }] },
      ),
    ).toBe(true)
  })

  it('compares policies by repository id, ignoring order and names', () => {
    expect(
      sameProjectGithubScopePolicy(
        {
          mode: 'selected',
          repositories: [
            { repoId: 2, fullName: 'o/b' },
            { repoId: 1, fullName: 'o/a' },
          ],
        },
        {
          mode: 'selected',
          repositories: [
            { repoId: 1, fullName: 'o/a-renamed' },
            { repoId: 2, fullName: 'o/b' },
          ],
        },
      ),
    ).toBe(true)
    expect(
      sameProjectGithubScopePolicy(
        { mode: 'all' },
        { mode: 'selected', repositories: [] },
      ),
    ).toBe(false)
  })

  it('keeps dormant selected entries visible next to the live grant', () => {
    const candidates = projectGithubScopeCandidates(
      [{ repoId: 1, fullName: 'o/granted', private: true }],
      [
        { repoId: 1, fullName: 'o/granted', granted: true },
        { repoId: 2, fullName: 'o/dormant', granted: false },
      ],
    )
    expect(candidates).toEqual([
      { repoId: 2, fullName: 'o/dormant', granted: false },
      {
        repoId: 1,
        fullName: 'o/granted',
        granted: true,
        private: true,
        defaultBranch: undefined,
      },
    ])
  })

  it('never classifies a truncation omission as revoked', () => {
    // Selected id absent from the (truncated) grant but flagged granted by the
    // server stays granted in the merged view.
    const candidates = projectGithubScopeCandidates(
      [],
      [{ repoId: 9, fullName: 'o/beyond-500', granted: true }],
    )
    expect(candidates).toEqual([
      { repoId: 9, fullName: 'o/beyond-500', granted: true },
    ])
  })

  it('preserves a dormant selection when toggling another repository', () => {
    expect(
      toggleProjectGithubScopeRepository(
        {
          mode: 'selected',
          repositories: [{ repoId: 2, fullName: 'o/dormant' }],
        },
        { repoId: 1, fullName: 'o/a' },
        true,
      ),
    ).toEqual({
      mode: 'selected',
      repositories: [
        { repoId: 1, fullName: 'o/a' },
        { repoId: 2, fullName: 'o/dormant' },
      ],
    })
    expect(
      toggleProjectGithubScopeRepository(
        { mode: 'all' },
        { repoId: 1, fullName: 'o/a' },
        true,
      ),
    ).toEqual({
      mode: 'selected',
      repositories: [{ repoId: 1, fullName: 'o/a' }],
    })
  })
})
