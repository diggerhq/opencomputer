import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_ROUTE_PROVIDER,
  hasBYOKPlanAccess,
  MODEL_ROUTE_MODEL_SUGGESTIONS,
  MODEL_ROUTE_PROVIDER_DEFAULTS,
  MODEL_ROUTE_PROVIDER_ORDER,
  MODEL_ROUTE_PROVIDER_PRESETS,
  modelConnectionLabel,
  modelRouteConnectionRequest,
  modelRouteNeedsBaseUrl,
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

  it('offers OpenAI and Anthropic API keys as fixed-URL presets', () => {
    expect(MODEL_ROUTE_PROVIDER_ORDER).toEqual([
      'openrouter',
      'openai',
      'anthropic',
      'openai_compatible',
    ])
    expect(MODEL_ROUTE_PROVIDER_PRESETS.openai.baseUrl).toBe(
      'https://api.openai.com/v1',
    )
    expect(MODEL_ROUTE_PROVIDER_PRESETS.anthropic.baseUrl).toBe(
      'https://api.anthropic.com/v1',
    )
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS.openai.model).toBe('gpt-5')
    expect(MODEL_ROUTE_PROVIDER_DEFAULTS.anthropic.model).toBe(
      'claude-sonnet-4-6',
    )
    expect(MODEL_ROUTE_MODEL_SUGGESTIONS.anthropic).toContain(
      'claude-sonnet-4-6',
    )
    expect(modelRouteNeedsBaseUrl('openai')).toBe(false)
    expect(modelRouteNeedsBaseUrl('anthropic')).toBe(false)
    expect(modelRouteNeedsBaseUrl('openai_compatible')).toBe(true)
    expect(modelRouteNeedsBaseUrl('openrouter')).toBe(false)
  })

  it('maps presets onto the existing connection providers', () => {
    expect(
      modelRouteConnectionRequest({
        provider: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://ignored.example.com/v1',
      }),
    ).toEqual({
      provider: 'openai_compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      label: 'OpenAI API key',
    })
    expect(
      modelRouteConnectionRequest({ provider: 'anthropic', apiKey: 'sk-ant' }),
    ).toEqual({
      provider: 'openai_compatible',
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      label: 'Anthropic API key',
    })
    expect(
      modelRouteConnectionRequest({
        provider: 'openai_compatible',
        apiKey: 'k',
        baseUrl: 'https://api.example.com/v1',
      }),
    ).toEqual({
      provider: 'openai_compatible',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
    })
    expect(
      modelRouteConnectionRequest({
        provider: 'openrouter',
        apiKey: 'k',
        baseUrl: 'https://ignored.example.com/v1',
      }),
    ).toEqual({ provider: 'openrouter', apiKey: 'k' })
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
