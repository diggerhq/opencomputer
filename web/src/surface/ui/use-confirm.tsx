import { useState, type ReactNode } from 'react'
import { ConfirmDialog } from '@/components/confirm-dialog'

// ---- asking before something that cannot be taken back ----

export interface Ask {
  title: string
  description?: string
  confirmLabel: string
  destructive?: boolean
  onConfirm(): void
}

// `ask(...)` opens the dialog; render `dialog` once in the component.
export function useConfirm(): [(a: Ask) => void, ReactNode] {
  const [a, setA] = useState<Ask | null>(null)
  const dialog = (
    <ConfirmDialog
      open={!!a}
      onOpenChange={(open) => !open && setA(null)}
      title={a?.title ?? ''}
      description={a?.description}
      confirmLabel={a?.confirmLabel}
      destructive={a?.destructive}
      onConfirm={() => {
        a?.onConfirm()
        setA(null)
      }}
    />
  )
  return [setA, dialog]
}
