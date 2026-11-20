import { useId, type ComponentProps, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// The anatomy of a settings page: sections with a title and one sentence
// above a single panel, and rows inside it separated by hairlines. Every row
// is the same three columns, so their edges line up across all sections: a
// 10rem label, the value or control, and a trailing action on the panel's
// right edge. On a phone the label stacks above the value and the action
// stays at the right of the value's line. Every section of /settings uses
// it, including ones mounted from elsewhere, so they read as one page.

export function SettingsSection({
  id,
  title,
  description,
  action,
  children,
}: {
  /** On the section, as a link target. */
  id?: string
  title: ReactNode
  description?: ReactNode
  /** On the title's line, on the right (one small button). */
  action?: ReactNode
  children: ReactNode
}) {
  const titleId = useId()
  return (
    <section id={id} aria-labelledby={titleId} className="scroll-mt-6">
      <div className="mb-3">
        <div className="flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          {/* Taller than the title's line; it hangs over it, centred. */}
          {action ? <div className="-my-1 shrink-0">{action}</div> : null}
        </div>
        {description ? (
          <p className="text-muted-foreground mt-0.5 text-sm">{description}</p>
        ) : null}
      </div>
      <div
        data-slot="settings-panel"
        className="bg-panel divide-y rounded-lg border"
      >
        {children}
      </div>
    </section>
  )
}

const rowGrid =
  'grid min-h-13 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:gap-y-0'

export function SettingsRow({
  label,
  htmlFor,
  indent = false,
  action,
  className,
  children,
}: {
  /**
   * Omit for a row that is all value (a member, a note): it then starts at
   * the label's edge, unless `indent` keeps it in the value column.
   */
  label?: ReactNode
  /** Makes the label a <label> for this control. */
  htmlFor?: string
  indent?: boolean
  /** In the trailing column, on the panel's right edge. */
  action?: ReactNode
  className?: string
  children?: ReactNode
}) {
  const Label = htmlFor ? 'label' : 'div'
  return (
    <div data-slot="settings-row" className={cn(rowGrid, className)}>
      {label ? (
        <Label
          data-slot="settings-label"
          htmlFor={htmlFor}
          className="text-muted-foreground col-span-2 sm:col-span-1"
        >
          {label}
        </Label>
      ) : indent ? (
        <div className="hidden sm:block" />
      ) : null}
      <div
        data-slot="settings-value"
        className={cn('min-w-0', !label && !indent && 'sm:col-span-2')}
      >
        {children}
      </div>
      <div
        data-slot="settings-action"
        className="flex items-center justify-end gap-2"
      >
        {action}
      </div>
    </div>
  )
}

/**
 * The one style of a trailing action (Manage billing, Copy, Edit, Open on
 * GitHub): a quiet ghost button, text-sm, its icon 14px.
 */
export function SettingsAction({
  className,
  size = 'sm',
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size={size}
      className={cn(
        'text-muted-foreground hover:text-foreground gap-1.5 text-sm font-normal [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  )
}

/** A loading row in the same anatomy: a label and a value of quiet bars. */
export function SettingsRowSkeleton({ label = true }: { label?: boolean }) {
  return (
    <div className={rowGrid}>
      {label ? (
        <Skeleton className="col-span-2 h-3.5 w-20 sm:col-span-1" />
      ) : null}
      <Skeleton
        className={cn('h-3.5 w-48 max-w-full', !label && 'sm:col-span-2')}
      />
      <div />
    </div>
  )
}
