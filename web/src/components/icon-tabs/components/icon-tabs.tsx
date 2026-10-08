"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";
import { useLayoutEffect, useRef } from "react";

import { ICON_TABS_INDICATOR_MS } from "../constants/icon-tabs";
import {
  applyIndicatorBox,
  easeOutQuint,
  measureActiveTab,
} from "../lib/icon-tabs";
import type {
  IconTabsIndicatorBox,
  IconTabsIndicatorProps,
  IconTabsListProps,
  IconTabsSlideInIconProps,
  IconTabsTriggerProps,
} from "../types/icon-tabs";

function IconTabs({
  className,
  ...props
}: Omit<TabsPrimitive.Root.Props, "orientation">) {
  return (
    <TabsPrimitive.Root
      className={cn("flex flex-col gap-2", className)}
      data-slot="icon-tabs"
      {...props}
    />
  );
}

/**
 * Icon that only shows on the active tab: it widens and fades in beside the
 * label, so inactive tabs stay text-only. `pinned` keeps it visible anyway,
 * e.g. for a live scan spinner.
 */
function SlideInIcon({ children, pinned = false }: IconTabsSlideInIconProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "-me-1.5 flex w-0 shrink-0 items-center justify-center overflow-hidden opacity-0 transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-active/tab:me-0 group-data-active/tab:w-4 group-data-active/tab:opacity-100 motion-reduce:transition-none",
        pinned && "me-0 w-4 opacity-100"
      )}
    >
      <span
        className={cn(
          "flex scale-50 items-center transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-active/tab:scale-100 motion-reduce:transition-none",
          pinned && "scale-100"
        )}
      >
        {children}
      </span>
    </span>
  );
}

/**
 * Indicator for triggers whose width animates when they turn active. A CSS
 * transition measures its target once, so it lags and overshoots while the
 * tabs resize. This one re-measures the active tab every frame and
 * interpolates from where it started, so it lands with the resize in one
 * motion and never leaves the space between the two tabs.
 */
function IconTabsIndicator({ value }: IconTabsIndicatorProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<IconTabsIndicatorBox | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const list = element?.parentElement;
    if (!(element && list)) {
      return;
    }

    const from = boxRef.current;
    const animate =
      from !== null &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      frame = 0;
      const target = measureActiveTab(list);
      if (!target) {
        // The active tab can be marked a frame after this effect runs.
        if (now - start < ICON_TABS_INDICATOR_MS) {
          frame = requestAnimationFrame(tick);
        }
        return;
      }
      // rAF timestamps mark the frame start and can predate `start`.
      const elapsed = Math.max(0, now - start);
      const progress = animate
        ? Math.min(1, elapsed / ICON_TABS_INDICATOR_MS)
        : 1;
      const eased = easeOutQuint(progress);
      const box =
        from && progress < 1
          ? {
              left: from.left + (target.left - from.left) * eased,
              top: target.top,
              width: from.width + (target.width - from.width) * eased,
              height: target.height,
            }
          : target;
      boxRef.current = box;
      applyIndicatorBox(element, box);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    tick(start);

    // Keep following the tab once settled, e.g. when a count changes.
    const observer = new ResizeObserver(() => {
      if (frame !== 0) {
        return;
      }
      const target = measureActiveTab(list);
      if (target) {
        boxRef.current = target;
        applyIndicatorBox(element, target);
      }
    });
    observer.observe(list);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [value]);

  return (
    <span
      aria-hidden="true"
      className="bg-background dark:bg-foreground/10 pointer-events-none absolute top-0 left-0 z-0 rounded-md shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
      ref={ref}
    />
  );
}

function IconTabsList({
  className,
  value,
  children,
  ...props
}: IconTabsListProps) {
  return (
    <TabsPrimitive.List
      className={cn(
        "bg-muted text-muted-foreground relative z-0 inline-flex h-8 w-fit items-center justify-center gap-0.5 rounded-lg p-0.5",
        className
      )}
      data-slot="icon-tabs-list"
      {...props}
    >
      <IconTabsIndicator value={value} />
      {children}
    </TabsPrimitive.List>
  );
}

function IconTabsTrigger({
  className,
  icon,
  iconPinned,
  children,
  ...props
}: IconTabsTriggerProps) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "group/tab text-muted-foreground/75 hover:text-muted-foreground data-active:text-foreground focus-visible:outline-ring relative z-1 inline-flex h-full flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium whitespace-nowrap outline-2 outline-transparent transition-colors duration-200 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-slot="icon-tabs-trigger"
      {...props}
    >
      <SlideInIcon pinned={iconPinned}>{icon}</SlideInIcon>
      {children}
    </TabsPrimitive.Tab>
  );
}

function IconTabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("flex-1 text-sm", className)}
      data-slot="icon-tabs-content"
      tabIndex={-1}
      {...props}
    />
  );
}

export { IconTabs, IconTabsContent, IconTabsList, IconTabsTrigger };
