import type { ComponentProps } from "react";

export interface ShimmerProps extends ComponentProps<"span"> {
  duration?: number;
  /** Stops the sweep and shows plain text. */
  paused?: boolean;
  spread?: number;
}
