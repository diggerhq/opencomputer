import { useQuery } from '@tanstack/react-query'
import type { SettingsPatch } from '@opencomputer/sdk/computer'
import { Select } from '@/components/form'
import { useSurface } from '../hooks'
import { oneLayer } from './kit'

// The model, effort and mode a session is started with or changed to, from
// the computer's capabilities. `onChange` gets the one field changed.

const MODES: Record<string, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Full access',
}

const PICKER =
  'text-muted-foreground hover:border-border h-7 w-auto border-transparent px-2 text-xs whitespace-nowrap'

export function SettingsPickers({
  value,
  onChange,
}: {
  value: SettingsPatch
  onChange: (patch: SettingsPatch) => void
}) {
  const surface = useSurface()
  const { data: caps } = useQuery({
    queryKey: ['surface', surface.me, 'capabilities'],
    queryFn: () => surface.capabilities(),
    staleTime: 5 * 60_000,
  })
  if (!caps) return null
  const model =
    caps.models.find((m) => m.id === value.model) ??
    caps.models.find((m) => m.default) ??
    caps.models[0]
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {caps.models.length > 1 && (
        <Select
          value={model?.id ?? ''}
          onValueChange={(m) => onChange({ model: m })}
          options={caps.models.map((m) => ({ value: m.id, label: m.name }))}
          className={PICKER}
          onEscapeKeyDown={oneLayer}
        />
      )}
      {model && model.efforts.length > 1 && (
        <Select
          // Unset runs at the computer's default (DEFAULT_EFFORT in computer/src/tiers.ts).
          value={
            value.effort ??
            (model.efforts.includes('medium') ? 'medium' : model.efforts[0])
          }
          onValueChange={(e) => onChange({ effort: e })}
          options={model.efforts.map((e) => ({ value: e, label: e }))}
          className={`${PICKER} capitalize`}
          onEscapeKeyDown={oneLayer}
        />
      )}
      {caps.modes.length > 1 && (
        <Select
          // A session asked for no mode runs with full access, as from Slack.
          value={value.mode ?? 'bypassPermissions'}
          onValueChange={(m) => onChange({ mode: m })}
          options={caps.modes.map((m) => ({ value: m, label: MODES[m] ?? m }))}
          className={PICKER}
          onEscapeKeyDown={oneLayer}
        />
      )}
    </div>
  )
}
