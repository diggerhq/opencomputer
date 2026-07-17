import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDeployApp, importAgentFromGithub } from './client'

const deployAppResponse = {
  installed: false,
  install_url: null,
  configure_url: null,
  account: null,
  repository_selection: null,
  repositories: [],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deploy app client', () => {
  it('returns GitHub installation state without a separate capability fork', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(deployAppResponse))),
    )

    await expect(getDeployApp()).resolves.toEqual(deployAppResponse)
  })

  it('submits the exact review receipt and preserves source-change recovery', async () => {
    let captured: RequestInit | undefined
    const fetchMock = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) => {
        captured = init
        return Promise.resolve(
          Response.json(
            {
              error: {
                type: 'source_changed_re_review',
                message: 'repository source changed since review',
              },
            },
            { status: 409 },
          ),
        )
      },
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      importAgentFromGithub(
        {
          name: 'Support triage',
          credential: 'managed',
          source: {
            type: 'github',
            repo: 'repo_0123456789abcdef01234567',
            path: 'agents/support',
            production_ref: 'main',
          },
          review: {
            sha: 'a'.repeat(40),
            source_profile: 'flue-app-v1',
            fingerprint: `sha256:${'b'.repeat(64)}`,
          },
        },
        'import-command-1',
      ),
    ).rejects.toMatchObject({
      status: 409,
      type: 'source_changed_re_review',
    })

    expect(captured?.method).toBe('POST')
    expect(new Headers(captured?.headers).get('Idempotency-Key')).toBe(
      'import-command-1',
    )
    const requestBody = captured?.body
    if (typeof requestBody !== 'string') {
      throw new Error('import request body must be JSON')
    }
    const parsedBody = JSON.parse(requestBody) as unknown
    expect(parsedBody).toMatchObject({
      review: {
        sha: 'a'.repeat(40),
        source_profile: 'flue-app-v1',
        fingerprint: `sha256:${'b'.repeat(64)}`,
      },
    })
  })
})
