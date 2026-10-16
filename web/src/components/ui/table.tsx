"use client";

import { cn } from "@/lib/utils";
import type * as React from "react";

/**
 * Dualtone chrome for a single `<table>`: the header sits on the grey shell,
 * the body cells form the lifted white card. `border-separate` is required
 * because row borders and radii only render on cells in that model.
 */
const TABLE_CARD_CELLS_CLASS = [
  "[&>tbody>tr>td]:bg-background [&>tbody>tr>td]:border-border/60 [&>tbody>tr>td]:border-b [&>tbody>tr>td]:transition-colors",
  "[&>tbody>tr:hover>td]:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]",
  "[&>tbody>tr:first-child>td]:border-t-border [&>tbody>tr:first-child>td]:border-t",
  "[&>tbody>tr:last-child>td]:border-b-border",
  "[&>tbody>tr>td:first-child]:border-l-border [&>tbody>tr>td:first-child]:border-l",
  "[&>tbody>tr>td:last-child]:border-r-border [&>tbody>tr>td:last-child]:border-r",
  "[&>tbody>tr:first-child>td:first-child]:rounded-tl-[14px] [&>tbody>tr:first-child>td:last-child]:rounded-tr-[14px]",
  "[&>tbody>tr:last-child>td:first-child]:rounded-bl-[14px] [&>tbody>tr:last-child>td:last-child]:rounded-br-[14px]",
].join(" ");

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      className="border-shell-border bg-shell relative w-full min-w-0 rounded-2xl border p-0.5"
      data-slot="table-container"
    >
      <div className="w-full overflow-x-auto rounded-[14px]">
        <table
          className={cn(
            "w-full caption-bottom border-separate border-spacing-0 text-sm tabular-nums",
            TABLE_CARD_CELLS_CLASS,
            className
          )}
          data-slot="table"
          {...props}
        />
      </div>
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={className} data-slot="table-header" {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={className} data-slot="table-body" {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      className={cn("text-muted-foreground font-medium", className)}
      data-slot="table-footer"
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn("group/row transition-colors", className)}
      data-slot="table-row"
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "text-muted-foreground h-10 px-4 text-left align-middle font-medium whitespace-nowrap",
        className
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "text-foreground h-12 px-4 align-middle whitespace-nowrap",
        className
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      className={cn("text-muted-foreground px-4 py-2.5 text-sm", className)}
      data-slot="table-caption"
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
