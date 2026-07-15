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
  it('returns GitHub installation state without a separate capability fork', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(deployAppResponse))),
    )

    await expect(getDeployApp()).resolves.toEqual(deployAppResponse)
  })
})
