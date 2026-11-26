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
  const { data: caps, isError } = useQuery({
    queryKey: ['surface', surface.me, 'capabilities'],
    queryFn: () => surface.capabilities(),
    staleTime: 5 * 60_000,
  })
  // The row keeps its height while the capabilities load, so the composer does not jump.
  if (!caps) return isError ? null : <div className="h-7" aria-hidden />
  const model =
    caps.models.find((m) => m.id === value.model) ??
    caps.models.find((m) => m.default) ??
    caps.models[0]
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {caps.models.length > 1 && (
        <Select
          value={model?.id ?? ''}
          onValueChange={(m) => {
            const next = caps.models.find((x) => x.id === m)
            // An effort the new model does not take is dropped, or a start is refused.
            const keep = !value.effort || !!next?.efforts.includes(value.effort)
            onChange(keep ? { model: m } : { model: m, effort: undefined })
          }}
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
