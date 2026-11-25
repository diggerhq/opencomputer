import { useState } from 'react'
import { Building2, Lock, Users } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  ACCESS_MODES,
  type AccessInput,
  type AccessMode,
} from '../computer-sessions-api'
import {
  accessLabel,
  MODE_LABEL,
  normalizeAccess,
  sameAccess,
  shareWarning,
  widens,
} from './access'
import { useOrgPeople } from './members'

const MODE_HINT: Record<AccessMode, string> = {
  owner: 'Nobody else can see or drive it.',
  org: 'Every member of the organization can see and drive it.',
  people: 'Only the people you choose can see and drive it.',
}

const MODE_ICON = { owner: Lock, org: Building2, people: Users }

/**
 * Who can see and drive a session: only its owner, the whole organization, or
 * specific people. A change that lets anyone new in is confirmed first.
 * `onSave` may be async; the picker closes once it resolves.
 */
export function AccessPicker({
  value,
  onSave,
  isOwner,
  ownerIds = [],
  pending,
  disabled,
  className,
}: {
  value: AccessInput
  onSave: (next: AccessInput) => unknown
  /** The caller owns the session (or will: the new-session form). */
  isOwner: boolean
  /** The owner's member ids, never listed: the owner always has access. */
  ownerIds?: string[]
  pending?: boolean
  disabled?: boolean
  className?: string
}) {
  const people = useOrgPeople()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AccessInput>(value)
  const [filter, setFilter] = useState('')
  const [confirming, setConfirming] = useState<AccessInput | null>(null)

  const nameOf = (id: string) => {
    const p = people?.find((x) => x.ids.includes(id))
    return p ? p.name || p.email : 'someone'
  }
  const Icon = MODE_ICON[value.mode]
  const choices = (people ?? []).filter(
    (p) => !p.ids.some((id) => ownerIds.includes(id)),
  )
  const q = filter.trim().toLowerCase()
  const shown = q
    ? choices.filter(
        (p) =>
          p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q),
      )
    : choices
  const picked = new Set(draft.people ?? [])
  // A listed id may be another of a person's ids: match on any.
  const has = (ids: string[]) => ids.some((id) => picked.has(id))

  const commit = async (next: AccessInput) => {
    try {
      await onSave(next)
      setConfirming(null)
      setOpen(false)
    } catch {
      // The caller says what went wrong; the picker stays as it was.
    }
  }
  const save = () => {
    const next = normalizeAccess(draft, ownerIds)
    if (sameAccess(next, normalizeAccess(value, ownerIds))) setOpen(false)
    else if (widens(value, next)) setConfirming(next)
    else void commit(next)
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setDraft(value)
            setFilter('')
          }
          setOpen(next)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label="Who can access this session"
            title="Who can access this session"
            className={cn('text-muted-foreground h-7 px-2 text-xs', className)}
          >
            <Icon className="size-3.5" aria-hidden />
            {accessLabel(
              { mode: value.mode, people: value.people ?? [] },
              { isOwner, nameOf },
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0">
          <div role="radiogroup" aria-label="Access" className="p-1">
            {ACCESS_MODES.map((mode) => {
              const ModeIcon = MODE_ICON[mode]
              const on = draft.mode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setDraft({ ...draft, mode })}
                  className={cn(
                    'hover:bg-accent flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left',
                    on && 'bg-accent',
                  )}
                >
                  <ModeIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {mode === 'owner' && !isOwner
                        ? 'Only the owner'
                        : MODE_LABEL[mode]}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {MODE_HINT[mode]}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          {draft.mode === 'people' ? (
            <div className="border-t p-2">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Find people"
                aria-label="Find people"
                className="mb-1 h-8"
              />
              <ul className="max-h-48 overflow-y-auto">
                {!people ? (
                  <li className="text-muted-foreground px-2 py-1.5 text-xs">
                    Loading members…
                  </li>
                ) : !shown.length ? (
                  <li className="text-muted-foreground px-2 py-1.5 text-xs">
                    {choices.length ? 'Nobody matches.' : 'No other members.'}
                  </li>
                ) : (
                  shown.map((p) => (
                    <li key={p.id}>
                      <label className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                        <Checkbox
                          checked={has(p.ids)}
                          onCheckedChange={(checked) => {
                            const rest = (draft.people ?? []).filter(
                              (id) => !p.ids.includes(id),
                            )
                            setDraft({
                              mode: 'people',
                              people: checked ? [...rest, p.id] : rest,
                            })
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {p.name || p.email}
                          {p.name ? (
                            <span className="text-muted-foreground">
                              {' '}
                              {p.email}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ) : null}
          <div className="flex justify-end gap-2 border-t p-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={pending} onClick={save}>
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(next) => {
          if (!next) setConfirming(null)
        }}
        title={
          confirming?.mode === 'org'
            ? 'Share with the whole organization?'
            : 'Share with these people?'
        }
        description={shareWarning(isOwner)}
        confirmLabel="Share"
        pending={pending}
        onConfirm={() => confirming && void commit(confirming)}
      />
    </>
  )
}
