import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import {
  Children,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

import { ButtonContent } from "@/components/ui/button-content";

const buttonVariants = cva(
  "group/button focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 relative inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:ring-3 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-primary/60 text-primary-foreground bg-linear-to-b from-[color-mix(in_oklab,var(--color-primary),black_8%)] to-[color-mix(in_oklab,var(--color-primary),black_20%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_1px_2px_rgba(0,0,0,0.18)] [corner-shape:squircle] hover:brightness-110 supports-[corner-shape:squircle]:rounded-[0.75rem]",
        outline:
          "border-border from-background to-muted text-foreground aria-expanded:from-secondary aria-expanded:to-secondary dark:from-input dark:to-muted bg-linear-to-b shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_2px_rgba(0,0,0,0.06)] [corner-shape:squircle] hover:brightness-[0.97] supports-[corner-shape:squircle]:rounded-[0.75rem] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.4)] dark:hover:brightness-125",
        secondary:
          "border-foreground/60 from-foreground/85 to-foreground text-background hover:from-foreground/70 hover:to-foreground/85 bg-linear-to-b shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_1px_2px_rgba(0,0,0,0.18)] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[0.75rem]",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50 bg-clip-padding",
        destructive:
          "border-destructive/60 from-destructive focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 bg-linear-to-b to-[color-mix(in_oklab,var(--color-destructive),black_12%)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28),0_1px_2px_rgba(0,0,0,0.18)] [corner-shape:squircle] hover:brightness-110 supports-[corner-shape:squircle]:rounded-[0.75rem] dark:from-[color-mix(in_oklab,var(--color-destructive),black_20%)] dark:to-[color-mix(in_oklab,var(--color-destructive),black_30%)]",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Swaps the label for bouncing dots while an action runs. */
    loading?: boolean;
    /**
     * Fills the button from the left, from 0 to 100, e.g. while a file
     * uploads. Set it back to `undefined` when the work is done: the bar fills
     * up and fades out. For work you can't measure, use `loading`.
     */
    progress?: number;
    /** Render the single child element (e.g. a router Link) with button
        styles. Maps to Base UI's `render` prop. */
    asChild?: boolean;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  progress,
  disabled,
  focusableWhenDisabled,
  "aria-describedby": ariaDescribedBy,
  children,
  asChild = false,
  ...props
}: ButtonProps) {
  const hasProgress = progress !== undefined;
  const busy = loading || hasProgress;
  const progressTextId = useId();

  // asChild compat: the child element becomes the rendered host (Base UI
  // merges our props into it) and the child's own children stay the label.
  const slotChild =
    asChild && isValidElement(children)
      ? (Children.only(children) as ReactElement<{ children?: ReactNode }>)
      : null;

  return (
    <ButtonPrimitive
      render={slotChild ?? undefined}
      aria-busy={busy || undefined}
      // Announces the upload percentage without changing the button's name.
      aria-describedby={
        hasProgress
          ? [ariaDescribedBy, progressTextId].filter(Boolean).join(" ")
          : ariaDescribedBy
      }
      className={cn(
        buttonVariants({ variant, size, className }),
        "has-data-[clip]:overflow-hidden",
        busy && "cursor-progress"
      )}
      data-loading={loading ? "" : undefined}
      data-slot="button"
      disabled={disabled || busy}
      focusableWhenDisabled={focusableWhenDisabled ?? busy}
      {...props}
    >
      <ButtonContent
        loading={loading}
        progress={progress}
        progressTextId={progressTextId}
      >
        {slotChild ? slotChild.props.children : children}
      </ButtonContent>
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
