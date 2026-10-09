'use client'

import { cn } from '@/lib/utils'
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

import { buttonVariants } from '@/components/ui/button'
import { useTheme } from '@/hooks/useTheme'

// Status colours fall back to Notra's values when the project has no
// --success, --warning or --info tokens of its own.
const statusTokens = cn(
  '[--toast-info:var(--info,oklch(0.55_0.13_250))] [--toast-success:var(--success,oklch(0.55_0.109_155))] [--toast-warning:var(--warning,oklch(0.57_0.113_55))]',
  'dark:[--toast-info:var(--info,oklch(0.7_0.12_250))] dark:[--toast-success:var(--success,oklch(0.7_0.125_155))] dark:[--toast-warning:var(--warning,oklch(0.7_0.125_55))]',
)

// The Depth surface of the outline button: squircle corners, a soft vertical
// gradient, an inset top highlight and a layered drop shadow.
const toastClassName = cn(
  'group/toast border-border bg-background from-background to-muted/60 text-popover-foreground flex w-(--width) items-center gap-2.5 rounded-[0.875rem] border bg-linear-to-b p-3 text-sm [corner-shape:squircle]',
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-8px_rgba(0,0,0,0.14)]',
  'dark:border-input dark:bg-muted dark:from-input dark:to-muted dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.4),0_8px_24px_-8px_rgba(0,0,0,0.6)]',
  // Sonner only hides the content of stacked toasts when it styles them itself.
  '*:transition-opacity data-[expanded=false]:data-[front=false]:*:opacity-0',
)

const iconClassName = cn(
  'bg-muted text-muted-foreground relative flex size-6 shrink-0 items-center justify-center rounded-lg [corner-shape:squircle] [&_svg]:size-3.5',
  'group-data-[type=success]/toast:bg-(--toast-success)/12 group-data-[type=success]/toast:text-(--toast-success)',
  'group-data-[type=error]/toast:bg-destructive/12 group-data-[type=error]/toast:text-destructive',
  'group-data-[type=warning]/toast:bg-(--toast-warning)/12 group-data-[type=warning]/toast:text-(--toast-warning)',
  'group-data-[type=info]/toast:bg-(--toast-info)/12 group-data-[type=info]/toast:text-(--toast-info)',
)

const Toaster = ({ className, theme, ...props }: ToasterProps) => {
  const { dark } = useTheme()

  return (
    <Sonner
      className={cn('toaster group', statusTokens, className)}
      gap={8}
      icons={{
        success: <CircleCheckIcon />,
        info: <InfoIcon />,
        warning: <TriangleAlertIcon />,
        error: <OctagonXIcon />,
        loading: <Loader2Icon className="animate-spin" />,
        close: <XIcon />,
      }}
      theme={theme ?? (dark ? 'dark' : 'light')}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: toastClassName,
          icon: iconClassName,
          content: 'flex min-w-0 flex-1 flex-col gap-0.5',
          title: 'font-medium leading-snug',
          description: 'text-[0.8rem] text-muted-foreground leading-snug',
          actionButton: buttonVariants({ size: 'xs' }),
          cancelButton: buttonVariants({ size: 'xs', variant: 'ghost' }),
          closeButton: cn(
            buttonVariants({ size: 'icon-xs', variant: 'outline' }),
            'absolute -top-2 -left-2 size-5 rounded-full opacity-0 transition-opacity group-focus-within/toast:opacity-100 group-hover/toast:opacity-100 [&_svg]:size-2.5',
          ),
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
