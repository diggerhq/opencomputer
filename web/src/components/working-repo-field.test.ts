import { describe, expect, it } from 'vitest'
import { selectedWorkingRepo } from '@/lib/working-repo'

describe('working repository selection', () => {
  const repo = {
    id: 'repo_123',
    full_name: 'acme/renamed-app',
    default_branch: 'trunk',
  }

  it('submits stable repository identity for Flue and keeps the slug for display', () => {
    expect(selectedWorkingRepo(repo, true, null)).toEqual({
      repo: 'repo_123',
      fullName: 'acme/renamed-app',
      ref: 'trunk',
    })
  })

  it('preserves legacy slug behavior for non-Flue agents', () => {
    expect(selectedWorkingRepo(repo, false, null)).toEqual({
      repo: 'acme/renamed-app',
      ref: 'trunk',
    })
  })

  it('keeps an explicitly edited branch when the same repository is reselected', () => {
    expect(
      selectedWorkingRepo(repo, true, {
        repo: 'repo_123',
        fullName: 'acme/renamed-app',
        ref: 'feature/test',
      }),
    ).toMatchObject({ ref: 'feature/test' })
  })
})
