// The runtimes the dashboard exposes, with their models + credential provider.
// The v3 API pairs each runtime with a provider (claude→anthropic, codex→openai)
// and requires a provider-prefixed model id, so everything model/credential-related
// keys off this one table — keeping the create dialog and the agent detail screen in
// sync. More runtimes (and models) land here as they ship.

export type RuntimeModel = { value: string; label: string }

export type RuntimeOption = {
  value: string // the API `runtime` value
  label: string
  provider: string // credential provider + model-id prefix
  keyLabel: string // label for the inline "new credential" key field
  keyPlaceholder: string
  models: RuntimeModel[]
}

export const RUNTIMES: RuntimeOption[] = [
  {
    value: 'claude',
    label: 'Claude',
    provider: 'anthropic',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    models: [
      { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' },
      { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    value: 'codex',
    label: 'Codex',
    provider: 'openai',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    models: [{ value: 'openai/gpt-5-codex', label: 'GPT-5 Codex' }],
  },
]

export const DEFAULT_RUNTIME = RUNTIMES[0].value

export const runtimeOptions = RUNTIMES.map((r) => ({
  value: r.value,
  label: r.label,
}))

// Falls back to the first runtime for an unknown/loading value, so callers can pass
// `agent?.runtime` safely.
export function getRuntime(value: string | undefined): RuntimeOption {
  return RUNTIMES.find((r) => r.value === value) ?? RUNTIMES[0]
}

export function defaultModelFor(runtime: string): string {
  return getRuntime(runtime).models[0].value
}
