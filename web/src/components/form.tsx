import type { ComponentProps, ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// Re-exported so screens import all form primitives from one place.
export { Input, Label }

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
