// The runtimes the dashboard exposes, with their models + credential provider.
// `claude` and `codex` each pair with one provider (claude→anthropic, codex→openai);
// `pi` drives any provider, so for pi the provider comes from the selected model's
// `provider/` prefix, not the runtime — see providerForModel + keyFieldFor, which the
// create dialog uses so a pi agent's key field follows its model. More runtimes (and
// models) land here as they ship.

export type RuntimeModel = { value: string; label: string }

export type RuntimeOption = {
  value: string // the API `runtime` value
  label: string
  provider: string // credential provider + model-id prefix
  keyLabel: string // label for the inline "new credential" key field
  keyPlaceholder: string
  // Models are listed most-powerful-first within each provider. `defaultModel`
  // is the one a new agent preselects (else models[0]) — so the list can be
  // power-ordered while the default stays a mid-tier pick.
  defaultModel?: string
  models: RuntimeModel[]
}

export const RUNTIMES: RuntimeOption[] = [
  {
    value: 'claude',
    label: 'Claude',
    provider: 'anthropic',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    // Power-ordered; Sonnet 5 is the preselected default for new agents.
    defaultModel: 'anthropic/claude-sonnet-5',
    models: [
      { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' },
      { value: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
      { value: 'anthropic/claude-fable-5', label: 'Claude Fable 5' },
      { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    value: 'codex',
    label: 'Codex',
    provider: 'openai',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    // The API only validates the `openai/` prefix — any model OpenAI serves works;
    // this is UI curation. A range mirroring the Claude tiers: codex-optimized
    // default, frontier, value, fastest. (Verified against OpenAI's model list.)
    models: [
      { value: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
      { value: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { value: 'openai/gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    ],
  },
  {
    value: 'pi',
    label: 'Pi',
    // Pi drives ANY provider — this `provider` is only the default (the first model's
    // prefix) for defaultModelFor/fallbacks. The create form derives the ACTUAL provider
    // from the selected model via providerForModel, since a pi agent's provider (and so
    // its key field + credential list) varies by model.
    provider: 'anthropic',
    keyLabel: 'Model provider API key',
    keyPlaceholder: 'API key',
    // Anthropic-only TODAY (what prod validates for pi). The runtime is built
    // provider-agnostic; other providers' models land here when the platform accepts
    // them (the create dialog already groups by provider via withModelGroups).
    defaultModel: 'anthropic/claude-sonnet-5',
    models: [
      { value: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8' },
      { value: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
      { value: 'anthropic/claude-fable-5', label: 'Claude Fable 5' },
      { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
]

// Key-field copy per provider. Pi mixes providers within one runtime, so the create
// dialog keys the credential field off the selected model's provider, not the runtime.
export const PROVIDER_KEY_FIELDS: Record<string, { keyLabel: string; keyPlaceholder: string }> = {
  anthropic: { keyLabel: 'Anthropic API key', keyPlaceholder: 'sk-ant-…' },
  openai: { keyLabel: 'OpenAI API key', keyPlaceholder: 'sk-…' },
  google: { keyLabel: 'Google AI API key', keyPlaceholder: 'AIza…' },
  openrouter: { keyLabel: 'OpenRouter API key', keyPlaceholder: 'sk-or-…' },
}

export const DEFAULT_RUNTIME = RUNTIMES[0].value

// Display labels for EVERY runtime a session can report — a superset of the create
// picker (RUNTIMES). `flue` is intentionally NOT in RUNTIMES (its behavior ships in a
// deployed artifact — there's no model/key to pick here), but read-only views must
// still label it correctly instead of falling back to "Claude". `hands` is the
// tool-sandbox runtime, shown only if it ever surfaces on a session.
export const RUNTIME_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  pi: 'Pi',
  flue: 'Flue',
  langgraph: 'LangGraph',
  hands: 'Hands',
}

// A stable label for any runtime string (display-only — does NOT gate the create picker).
export function runtimeLabel(runtime: string | null | undefined): string {
  if (!runtime) return '—'
  return RUNTIME_LABELS[runtime] ?? runtime
}

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
  const rt = getRuntime(runtime)
  return rt.defaultModel ?? rt.models[0].value
}

// The provider a model runs on is its `provider/` prefix — the API's source of truth.
// Works for every runtime: claude/codex models all share one prefix; pi's vary.
export function providerForModel(model: string): string {
  return model.split('/')[0] || ''
}

// The key-field copy for a provider, with a generic fallback for uncurated providers.
export function keyFieldFor(provider: string): { keyLabel: string; keyPlaceholder: string } {
  return PROVIDER_KEY_FIELDS[provider] ?? { keyLabel: 'Model provider API key', keyPlaceholder: 'API key' }
}

// A Select option that is either a model or a group divider.
export type ModelSelectOption = RuntimeModel | { separator: true }

// Insert a divider between consecutive models from different providers, so a
// multi-provider runtime's dropdown (pi) reads as grouped without vendor labels.
// Single-provider runtimes (claude/codex) have no boundary, so nothing changes.
export function withModelGroups(models: RuntimeModel[]): ModelSelectOption[] {
  const out: ModelSelectOption[] = []
  let prev: string | null = null
  for (const m of models) {
    const p = providerForModel(m.value)
    if (prev !== null && p !== prev) out.push({ separator: true })
    out.push(m)
    prev = p
  }
  return out
}
