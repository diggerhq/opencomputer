import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRepositoryAccess,
  getSessionSources,
  updateRepositoryAccess,
} from './client'

const access = {
  policy: { mode: 'selected' as const, repository_ids: ['repo_1'] },
  grant: {
    status: 'active' as const,
    account: 'acme',
    repository_selection: 'selected' as const,
    install_url: 'https://github.test/install',
    configure_url: 'https://github.test/configure',
    truncated: false,
  },
  effective_repositories: [
    {
      id: 'repo_1',
      full_name: 'acme/app',
      default_branch: 'main',
      private: true,
    },
  ],
  unavailable_selected_repositories: [],
}

afterEach(() => vi.unstubAllGlobals())

describe('repository access client', () => {
  it('reads and atomically replaces an agent policy', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        calls.push({ input: url, init })
        return Promise.resolve(Response.json(access))
      }),
    )

    await expect(getRepositoryAccess('agt_/unsafe')).resolves.toEqual(access)
    await expect(
      updateRepositoryAccess('agt_/unsafe', {
        mode: 'selected',
        repository_ids: ['repo_1'],
      }),
    ).resolves.toEqual(access)

    expect(calls[0]?.input).toBe(
      '/api/dashboard/v3/agents/agt_%2Funsafe/repository-access',
    )
    expect(calls[1]?.init?.method).toBe('PUT')
    expect(calls[1]?.init?.body).toBe(
      JSON.stringify({ mode: 'selected', repository_ids: ['repo_1'] }),
    )
  })

  it('reads source identity and the pinned ref from session detail', async () => {
    const sources = [
      {
        name: 'app',
        repo_id: 'repo_1',
        full_name: 'acme/app',
        requested_ref: 'main',
        status: 'ready',
        path: '/workspace/sources/app',
        sha: 'a'.repeat(40),
        resolved_sha: 'b'.repeat(40),
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(sources))),
    )

    await expect(getSessionSources('ses_1')).resolves.toEqual(sources)
  })
})
