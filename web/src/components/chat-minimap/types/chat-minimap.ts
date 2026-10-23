import type { ComponentProps, ReactNode } from "react";

import type { Button } from "@/components/ui/button";

export type ChatMinimapSide = "left" | "right";

export interface ChatMinimapPayload {
  description?: ReactNode;
  title: ReactNode;
}

export interface ChatMinimapProps extends ComponentProps<"nav"> {
  /** Which side of the rail the preview card opens on. */
  side?: ChatMinimapSide;
}

export interface ChatMinimapItemProps extends Omit<
  ComponentProps<typeof Button>,
  "title"
> {
  active?: boolean;
  description?: ReactNode;
  title: ReactNode;
}

export interface ChatMinimapNavButtonProps extends ComponentProps<
  typeof Button
> {
  direction: "previous" | "next";
  label?: string;
}

export interface ChatMinimapDemoTurn {
  description: string;
  id: string;
  title: string;
}

export interface ChatMinimapExampleProps {
  initialStart?: number;
  side?: ChatMinimapSide;
  turns?: readonly ChatMinimapDemoTurn[];
}
