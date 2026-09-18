import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_ROUTE_PROVIDER,
  hasBYOKPlanAccess,
  MODEL_ROUTE_MODEL_SUGGESTIONS,
  MODEL_ROUTE_PROVIDER_DEFAULTS,
  modelConnectionLabel,
  modelAccessCLICommand,
} from './BYOK'

describe('project BYOK presentation', () => {
  it('uses mainstream defaults and leaves custom providers explicit', () => {
    expect(DEFAULT_MODEL_ROUTE_PROVIDER).toBe('codex')
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS.codex.model).toBe('gpt-5.6-sol')
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS.openrouter.model).toBe('openai/gpt-5')
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS.openai_compatible.model).toBe('')
    expect(JSON.stringify(MODEL_ROUTE_PROVIDER_DEFAULTS)).not.toContain(
      'scx.ai',
    )
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS).not.toHaveProperty('claude')
    expect(MODEL_ROUTE_MODEL_SUGGESTIONS.codex).toContain('gpt-5.6-sol')
  })

  it('shows a safe custom-provider origin instead of an opaque id', () => {
    expect(
      modelConnectionLabel({
        id: 'mac_1',
        label: 'OpenAI-compatible API',
        baseUrl: 'https://api.example.com/v1',
      }),
    ).toBe('OpenAI-compatible API · api.example.com')
  })

  it('limits BYOK to Pro and Max plans', () => {
    expect(hasBYOKPlanAccess('base')).toBe(false)
    expect(hasBYOKPlanAccess('pro')).toBe(true)
    expect(hasBYOKPlanAccess('max')).toBe(true)
  })

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
})
