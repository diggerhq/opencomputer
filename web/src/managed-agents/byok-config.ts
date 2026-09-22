export const MODEL_ACCESS_RETURN_TO_KEY = 'opencomputer:model-access:return-to'
export const MODEL_ACCESS_PROJECT_KEY = 'opencomputer:model-access:project'

export type ModelRouteProviderChoice = 'openrouter' | 'openai_compatible'

export const MODEL_ROUTE_PROVIDER_DEFAULTS: Record<
  ModelRouteProviderChoice,
  { model: string }
> = {
  openrouter: { model: 'openai/gpt-5' },
  openai_compatible: { model: '' },
}

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
> = {
  openrouter: ['openai/gpt-5', 'anthropic/claude-sonnet-4.6'],
  openai_compatible: [],
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
