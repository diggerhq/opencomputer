import type { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { ReactNode } from "react";

export interface IconTabsIndicatorProps {
  /** Active tab value; a change starts the slide. */
  value: string;
}

export interface IconTabsIndicatorBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface IconTabsSlideInIconProps {
  children: ReactNode;
  /** Keeps the icon visible on inactive tabs, e.g. for a live spinner. */
  pinned?: boolean;
}

export type IconTabsListProps = Omit<TabsPrimitive.List.Props, "children"> & {
  /** Active tab value. Must match the `value` of the surrounding `IconTabs`. */
  value: string;
  children: ReactNode;
};

export type IconTabsTriggerProps = TabsPrimitive.Tab.Props & {
  /** Shown only on the active tab, sliding in beside the label. */
  icon: ReactNode;
  /** Keeps the icon visible on inactive tabs, e.g. for a live spinner. */
  iconPinned?: boolean;
};
