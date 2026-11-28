import type { ResultRow } from '@opencomputer/sdk/computer'
import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { useSurface } from '../hooks'
import { mergeable, pullNumber } from '../store/pulls'

// Merge, wherever a pull request result is drawn (work 118): one click, nothing
// asked, and nothing at all where the pull request cannot merge. It sits
// inside rows and cards that are themselves clicked, so its click and its
// Enter are its own.
export function MergeButton({
  result,
  variant = 'secondary',
  size = 'xs',
  className,
}: { result: ResultRow } & Pick<ComponentProps<typeof Button>, 'variant' | 'size' | 'className'>) {
  const surface = useSurface()
  if (!mergeable(result)) return null
  return (
    <Button
      variant={variant}
      size={size}
      data-merge
      className={className}
      title={`Merge #${pullNumber(result)} into its base branch`}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        surface.merge(result.id)
      }}
    >
      Merge
    </Button>
  )
}
