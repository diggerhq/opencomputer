import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_ROUTE_PROVIDER,
  hasBYOKPlanAccess,
  MODEL_ROUTE_MODEL_SUGGESTIONS,
  MODEL_ROUTE_PROVIDER_DEFAULTS,
  modelConnectionLabel,
  SUBSCRIPTION_ROUTE_AVAILABILITY,
} from './byok-config'

describe('project BYOK presentation', () => {
  it('uses mainstream defaults and leaves custom providers explicit', () => {
    expect(DEFAULT_MODEL_ROUTE_PROVIDER).toBe('openrouter')
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS.openrouter.model).toBe('openai/gpt-5')
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS.openai_compatible.model).toBe('')
    expect(JSON.stringify(MODEL_ROUTE_PROVIDER_DEFAULTS)).not.toContain(
      'scx.ai',
    )
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS).not.toHaveProperty('claude')
    expect(MODEL_ROUTE_MODEL_SUGGESTIONS.openrouter).toContain(
      'anthropic/claude-sonnet-4.6',
    )
    expect(SUBSCRIPTION_ROUTE_AVAILABILITY).toEqual([
      {
        id: 'codex',
        label: 'Codex subscription — Coming soon',
        disabled: true,
      },
      {
        id: 'claude',
        label: 'Claude subscription — Coming soon',
        disabled: true,
      },
    ])
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
})
