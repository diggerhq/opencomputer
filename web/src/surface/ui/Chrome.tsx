import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useS, useSurface } from '../hooks'
import { oneLayer } from './bits'

// What the surface says, through sonner: the store decides when a toast comes
// and goes; what can be undone carries Undo (Z).
export function Toasts() {
  const surface = useSurface()
  const toasts = useS((s) => s.toasts)
  const shown = useRef(new Set<string>())
  useEffect(() => {
    const now = new Set(toasts.map((t) => t.id))
    for (const id of shown.current) if (!now.has(id)) toast.dismiss(id)
    for (const t of toasts) {
      if (shown.current.has(t.id)) continue
      const undo = t.undo
      ;(t.tone === 'error' ? toast.error : undo ? toast.success : toast)(
        t.text,
        {
          id: t.id,
          duration: Infinity,
          onDismiss: () => surface.dismissToast(t.id),
          action: undo
            ? {
                label: (
                  <>
                    Undo{' '}
                    <Kbd className="bg-transparent text-inherit opacity-60">
                      Z
                    </Kbd>
                  </>
                ),
                onClick: () => {
                  undo()
                  surface.dismissToast(t.id)
                },
              }
            : undefined,
        },
      )
    }
    shown.current = now
  }, [surface, toasts])
  useEffect(() => () => shown.current.forEach((id) => toast.dismiss(id)), [])
  return null
}

// Spec section 12.
const KEYS: [string, string[]][] = [
  ['Move in the list', ['J', 'K']],
  ['New', ['N']],
  ['Start from anywhere', ['⌘K']],
  ['Reply', ['R']],
  ['Done', ['E']],
  ['Undo', ['Z']],
  ['Track it', ['T']],
  ['Review changes', ['Space']],
  ['Summary or full diff, in a review', ['F']],
  ['Layout', ['1', '2', '3']],
  ['Hide or show the list', ['[']],
  ['Close one layer', ['Esc']],
  ['This sheet', ['?']],
]

export function KeysSheet() {
  const surface = useSurface()
  const on = useS((s) => s.keysSheet)
  return (
    <Dialog open={on} onOpenChange={(open) => surface.setKeysSheet(open)}>
      <DialogContent className="sm:max-w-130" onEscapeKeyDown={oneLayer}>
        <DialogHeader>
          <DialogTitle>Shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            Keys for the frequent actions
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 max-[700px]:grid-cols-1">
          {KEYS.map(([what, keys]) => (
            <div key={what} className="flex items-center gap-2">
              <dt className="text-muted-foreground">{what}</dt>
              <dd className="ml-auto">
                <KbdGroup>
                  {keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </KbdGroup>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
