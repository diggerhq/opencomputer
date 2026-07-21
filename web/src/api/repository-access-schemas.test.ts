import { describe, expect, it } from 'vitest'
import { RepositoryAccessSchema, SessionSourceListSchema } from './schemas'

describe('repository access schemas', () => {
  it('accepts an intentionally empty selected policy and a truncated grant', () => {
    expect(
      RepositoryAccessSchema.parse({
        policy: { mode: 'selected', repository_ids: [] },
        grant: {
          status: 'active',
          account: 'acme',
          repository_selection: 'selected',
          install_url: 'https://github.test/install',
          configure_url: null,
          truncated: true,
        },
        effective_repositories: [],
        unavailable_selected_repositories: [
          { id: 'repo_hidden', full_name: 'acme/hidden' },
        ],
      }).grant.truncated,
    ).toBe(true)
  })

  it('requires null effective repositories when the server reports no list', () => {
    const result = RepositoryAccessSchema.safeParse({
      policy: { mode: 'all' },
      grant: {
        status: 'unavailable',
        account: null,
        repository_selection: null,
        install_url: 'https://github.test/install',
        configure_url: null,
        truncated: false,
      },
      effective_repositories: null,
      unavailable_selected_repositories: [],
    })
    expect(result.success).toBe(true)
  })

  it('keeps new source identity fields optional for older responses', () => {
    expect(
      SessionSourceListSchema.parse([
        {
          name: 'app',
          status: 'ready',
          path: '/workspace/sources/app',
          sha: 'a'.repeat(40),
        },
      ]),
    ).toHaveLength(1)
  })
})
