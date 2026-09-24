import { describe, expect, it } from 'vitest'
import { SandboxDetailSchema } from './schemas'

const base = {
  id: 'ses_1',
  sandboxId: 'sb-1',
  template: 'base',
  status: 'running',
  startedAt: '2026-01-01T00:00:00Z',
}

describe('SandboxDetailSchema secrets visibility', () => {
  it('accepts the value-free secrets view and env names', () => {
    const parsed = SandboxDetailSchema.parse({
      ...base,
      config: { timeout: 300, envNames: ['ALPHA', 'ZED'] },
      secrets: {
        sandboxID: 'sb-1',
        secretStore: 'primary',
        baseSecretStore: 'base',
        secretEnvNames: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
        egressAllowlist: ['api.anthropic.com'],
        perSecretAllowedHosts: { ANTHROPIC_API_KEY: ['api.anthropic.com'] },
      },
    })
    expect(parsed.config?.envNames).toEqual(['ALPHA', 'ZED'])
    expect(parsed.secrets?.secretStore).toBe('primary')
    expect(parsed.secrets?.secretEnvNames).toHaveLength(2)
  })

  it('accepts a sandbox with no secret store attached', () => {
    const parsed = SandboxDetailSchema.parse({
      ...base,
      secrets: {
        sandboxID: 'sb-1',
        secretEnvNames: [],
        egressAllowlist: [],
        perSecretAllowedHosts: {},
      },
    })
    expect(parsed.secrets?.secretStore).toBeUndefined()
  })

  it('does not carry env var values into the typed detail', () => {
    const parsed = SandboxDetailSchema.parse({
      ...base,
      config: { envs: { LEAK: 'value' }, envNames: ['LEAK'] },
    })
    expect(parsed.config).not.toHaveProperty('envs')
  })
})
