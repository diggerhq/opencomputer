import { describe, expect, it } from 'vitest'
import {
  isNarrowingRepositoryAccess,
  repositoryAccessCandidates,
  repositoryAccessQueryKey,
  showRepositoryAccessDuringSetup,
  toggleSelectedRepository,
} from './repository-access'

describe('repository access helpers', () => {
  it('uses the documented agent-scoped query key', () => {
    expect(repositoryAccessQueryKey('agt_1')).toEqual([
      'agent-repository-access',
      'agt_1',
    ])
  })

  it('shows built-in repository access before Slack while preserving Flue setup order', () => {
    expect(showRepositoryAccessDuringSetup('claude', 'disconnected')).toBe(true)
    expect(showRepositoryAccessDuringSetup('codex', undefined)).toBe(true)
    expect(showRepositoryAccessDuringSetup('pi', null)).toBe(true)
    expect(showRepositoryAccessDuringSetup('flue', 'disconnected')).toBe(false)
    expect(showRepositoryAccessDuringSetup('flue', 'active')).toBe(true)
  })

  it('detects narrowing without treating expansion as narrowing', () => {
    expect(
      isNarrowingRepositoryAccess(
        { mode: 'all' },
        { mode: 'selected', repository_ids: ['repo_1'] },
      ),
    ).toBe(true)
    expect(
      isNarrowingRepositoryAccess(
        { mode: 'selected', repository_ids: ['repo_1'] },
        { mode: 'all' },
      ),
    ).toBe(false)
    expect(
      isNarrowingRepositoryAccess(
        { mode: 'selected', repository_ids: ['repo_1', 'repo_hidden'] },
        { mode: 'selected', repository_ids: ['repo_1'] },
      ),
    ).toBe(true)
  })

  it('preserves a hidden selection when toggling a visible repository', () => {
    expect(
      toggleSelectedRepository(
        {
          mode: 'selected',
          repository_ids: ['repo_hidden', 'repo_visible'],
        },
        'repo_new',
        true,
      ),
    ).toEqual({
      mode: 'selected',
      repository_ids: ['repo_hidden', 'repo_new', 'repo_visible'],
    })
  })

  it('merges candidates by stable id and ignores unregistered rows', () => {
    const candidates = repositoryAccessCandidates(
      {
        policy: { mode: 'selected', repository_ids: ['repo_1'] },
        grant: {
          status: 'active',
          account: 'acme',
          repository_selection: 'selected',
          install_url: 'https://github.test/install',
          configure_url: null,
          truncated: false,
        },
        effective_repositories: [
          {
            id: 'repo_1',
            full_name: 'acme/renamed',
            default_branch: 'main',
            private: true,
          },
        ],
        unavailable_selected_repositories: [],
      },
      {
        installed: true,
        install_url: null,
        configure_url: null,
        account: 'acme',
        repository_selection: 'selected',
        repositories: [
          {
            id: 'repo_1',
            full_name: 'acme/old-name',
            default_branch: 'trunk',
            private: true,
            linked_sources: [],
          },
          {
            id: null,
            full_name: 'acme/unregistered',
            default_branch: 'main',
            private: false,
            linked_sources: [],
          },
        ],
      },
    )
    expect(candidates).toEqual([
      {
        id: 'repo_1',
        full_name: 'acme/renamed',
        default_branch: 'main',
        private: true,
      },
    ])
  })
})
