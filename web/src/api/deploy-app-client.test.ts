import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDeployApp } from './client'

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
  it('preserves an explicit repository-deploy availability grant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            ...deployAppResponse,
            repository_deploys_available: true,
          }),
        ),
      ),
    )

    await expect(getDeployApp()).resolves.toMatchObject({
      repository_deploys_available: true,
    })
  })

  it('fails closed when an older response omits availability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(deployAppResponse))),
    )

    await expect(getDeployApp()).resolves.toMatchObject({
      repository_deploys_available: false,
    })
  })
})
