import type { ComponentProps, ReactNode } from 'react'
import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { markFloatingLayerPointerDismiss } from '@/components/ui/floating-layer'
import { cn } from '@/lib/utils'

// Re-exported so screens import all form primitives from one place.
export { Input, Label }

// On-brand select (Radix): styled trigger + popup, matching the dropdown-menu
// surface — no OS-default control. Options-based for simple call sites.
export function Select({
  value,
  onValueChange,
  options,
  id,
  placeholder,
  disabled,
  className,
}: {
  value: string
  onValueChange: (value: string) => void
  // A `{ separator: true }` entry renders a divider between groups (e.g. models
  // grouped by provider) rather than a selectable item.
  options: ({ value: string; label: string } | { separator: true })[]
  id?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        data-slot="select-trigger"
        className={cn(
          'border-input focus-visible:border-ring/60 data-placeholder:text-muted-foreground flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-2.5 text-sm transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          // Don't let closing this menu dismiss a parent Dialog (floating-layer.ts).
          onPointerDownOutside={markFloatingLayerPointerDismiss}
          className="bg-popover text-popover-foreground ring-foreground/10 shadow-overlay data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-hidden rounded-lg p-1 ring-1 duration-100"
        >
          <SelectPrimitive.Viewport>
            {options.map((o, i) =>
              'separator' in o ? (
                <SelectPrimitive.Separator
                  key={`sep-${i}`}
                  className="bg-border pointer-events-none -mx-1 my-1 h-px"
                />
              ) : (
                <SelectPrimitive.Item
                  key={o.value}
                  value={o.value}
                  className="focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center rounded-md py-1 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50"
                >
                  <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                  <span className="absolute right-2 flex items-center">
                    <SelectPrimitive.ItemIndicator>
                      <Check className="size-4" />
                    </SelectPrimitive.ItemIndicator>
                  </span>
                </SelectPrimitive.Item>
              ),
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

// Multiline input, styled to match Input (same border / focus tokens).
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring/60 disabled:bg-input/50 aria-invalid:border-destructive flex min-h-20 w-full resize-none rounded-md border bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Plain-props, RHF-agnostic field wrapper: label + control + description/error.
 * A later "form correctness" pass wires react-hook-form + zod into these
 * primitives without changing markup, so inputs are only built once.
 *
 * Pass the same id to `htmlFor` here and to the control's `id`.
 */
export function Field({
  label,
  htmlFor,
  error,
  description,
  required,
  className,
  children,
}: {
  label?: ReactNode
  htmlFor?: string
  error?: ReactNode
  description?: ReactNode
  required?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label ? (
        <Label htmlFor={htmlFor}>
          {label}
          {required ? (
            <span className="text-status-error" aria-hidden>
              {' '}
              *
            </span>
          ) : null}
        </Label>
      ) : null}
      {children}
      {description && !error ? (
        <FieldDescription>{description}</FieldDescription>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  )
}

export function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p className={cn('text-muted-foreground text-xs', className)} {...props} />
  )
}

export function FieldError({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      role="alert"
      className={cn('text-status-error text-xs font-medium', className)}
      {...props}
    />
  )
}
