export const MODEL_ACCESS_RETURN_TO_KEY = 'opencomputer:model-access:return-to'
export const MODEL_ACCESS_PROJECT_KEY = 'opencomputer:model-access:project'

export type ModelRouteProviderChoice =
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'openai_compatible'

export type ModelRouteApiProvider = 'openrouter' | 'openai_compatible'

export interface ModelRouteProviderPreset {
  label: string
  keyLabel: string
  keyHint: string
  apiProvider: ModelRouteApiProvider
  baseUrl?: string
  connectionLabel?: string
  model: string
  suggestions: string[]
}

/**
 * Dashboard provider choices. OpenAI and Anthropic API keys are presets over
 * the OpenAI-compatible connection kind: the base URL is fixed and the
 * provider's native model IDs pass through unchanged.
 */
export const MODEL_ROUTE_PROVIDER_PRESETS: Record<
  ModelRouteProviderChoice,
  ModelRouteProviderPreset
> = {
  openrouter: {
    label: 'OpenRouter API key',
    keyLabel: 'OpenRouter API key',
    keyHint: 'Model IDs use the OpenRouter form, e.g. openai/gpt-5.',
    apiProvider: 'openrouter',
    model: 'openai/gpt-5',
    suggestions: ['openai/gpt-5', 'anthropic/claude-sonnet-4.6'],
  },
  openai: {
    label: 'OpenAI API key (Codex models)',
    keyLabel: 'OpenAI API key',
    keyHint: 'Uses api.openai.com with native model IDs, e.g. gpt-5.',
    apiProvider: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    connectionLabel: 'OpenAI API key',
    model: 'gpt-5',
    suggestions: ['gpt-5', 'gpt-5-mini', 'gpt-5-codex'],
  },
  anthropic: {
    label: 'Anthropic API key (Claude models)',
    keyLabel: 'Anthropic API key',
    keyHint:
      'Uses api.anthropic.com with native model IDs, e.g. claude-sonnet-4-6.',
    apiProvider: 'openai_compatible',
    baseUrl: 'https://api.anthropic.com/v1',
    connectionLabel: 'Anthropic API key',
    model: 'claude-sonnet-4-6',
    suggestions: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
  },
  openai_compatible: {
    label: 'Custom OpenAI-compatible API',
    keyLabel: 'API key',
    keyHint: 'Model IDs are passed to your API unchanged.',
    apiProvider: 'openai_compatible',
    model: '',
    suggestions: [],
  },
}

export const MODEL_ROUTE_PROVIDER_ORDER: ModelRouteProviderChoice[] = [
  'openrouter',
  'openai',
  'anthropic',
  'openai_compatible',
]

export const MODEL_ROUTE_PROVIDER_DEFAULTS: Record<
  ModelRouteProviderChoice,
  { model: string }
> = Object.fromEntries(
  MODEL_ROUTE_PROVIDER_ORDER.map((id) => [
    id,
    { model: MODEL_ROUTE_PROVIDER_PRESETS[id].model },
  ]),
) as Record<ModelRouteProviderChoice, { model: string }>

export const DEFAULT_MODEL_ROUTE_PROVIDER: ModelRouteProviderChoice =
  'openrouter'

export const SUBSCRIPTION_ROUTE_AVAILABILITY = [
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
] as const

export const MODEL_ROUTE_MODEL_SUGGESTIONS: Record<
  ModelRouteProviderChoice,
  string[]
> = Object.fromEntries(
  MODEL_ROUTE_PROVIDER_ORDER.map((id) => [
    id,
    MODEL_ROUTE_PROVIDER_PRESETS[id].suggestions,
  ]),
) as Record<ModelRouteProviderChoice, string[]>

/** Translate a dashboard provider choice into the model-access connection request. */
export function modelRouteConnectionRequest(input: {
  provider: ModelRouteProviderChoice
  apiKey: string
  baseUrl?: string
}): {
  provider: ModelRouteApiProvider
  apiKey: string
  baseUrl?: string
  label?: string
} {
  const preset = MODEL_ROUTE_PROVIDER_PRESETS[input.provider]
  const baseUrl = preset.baseUrl ?? input.baseUrl
  return {
    provider: preset.apiProvider,
    apiKey: input.apiKey,
    ...(preset.apiProvider === 'openai_compatible' && baseUrl
      ? { baseUrl }
      : {}),
    ...(preset.connectionLabel ? { label: preset.connectionLabel } : {}),
  }
}

export function modelRouteNeedsBaseUrl(provider: ModelRouteProviderChoice) {
  const preset = MODEL_ROUTE_PROVIDER_PRESETS[provider]
  return preset.apiProvider === 'openai_compatible' && !preset.baseUrl
}

export function modelConnectionLabel(connection: {
  id: string
  label: string
  baseUrl?: string | null
}) {
  if (connection.baseUrl) {
    try {
      return `${connection.label} · ${new URL(connection.baseUrl).hostname}`
    } catch {
      // The API validates URLs; retain the safe label if older data does not.
    }
  }
  return connection.label || connection.id
}

export function hasBYOKPlanAccess(plan: string | undefined) {
  return plan === 'pro' || plan === 'max'
}
