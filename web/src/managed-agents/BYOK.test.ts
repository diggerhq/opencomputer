import { describe, expect, it } from 'vitest'
import { hasProjectCodexAccess, modelAccessCLICommand } from './BYOK'

describe('project BYOK presentation', () => {
  it('uses an install-free production CLI command', () => {
    expect(
      modelAccessCLICommand('test', {
        hostname: 'app.opencomputer.dev',
        origin: 'https://app.opencomputer.dev',
      }),
    ).toBe(
      'npx --yes --package=@opencomputer/cli@latest -- opencomputer model-access connect codex --project test',
    )
  })

  it('targets the current API outside production', () => {
    expect(
      modelAccessCLICommand('test', {
        hostname: 'mo-oc-dev.com',
        origin: 'https://mo-oc-dev.com',
      }),
    ).toContain('opencomputer --api-url https://mo-oc-dev.com model-access')
  })

  it('requires enabled Codex bindings in both project environments', () => {
    expect(
      hasProjectCodexAccess([
        {
          provider: 'openai',
          environment: 'development',
          enabled: true,
        },
      ]),
    ).toBe(false)
    expect(
      hasProjectCodexAccess([
        {
          provider: 'openai',
          environment: 'development',
          enabled: true,
        },
        {
          provider: 'openai',
          environment: 'production',
          enabled: true,
        },
      ]),
    ).toBe(true)
  })
})
