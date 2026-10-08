import { cn } from "@/lib/utils";
import type { CSSProperties } from "react";

import type { ShimmerProps } from "../types/shimmer";

const SHIMMER_GRADIENT =
  "linear-gradient(90deg, transparent calc(50% - var(--shimmer-spread)), var(--shimmer-highlight, var(--color-foreground)) 50%, transparent calc(50% + var(--shimmer-spread))), linear-gradient(currentColor, currentColor)";

export const Shimmer = ({
  className,
  duration = 1.7,
  paused = false,
  spread = 4,
  style,
  ...props
}: ShimmerProps) => (
  <span
    className={cn(
      "animate-shimmer inline-block bg-size-[250%_100%,auto] bg-clip-text bg-no-repeat [-webkit-text-fill-color:transparent] motion-reduce:animate-none motion-reduce:bg-none! motion-reduce:[-webkit-text-fill-color:currentColor]",
      paused && "animate-none bg-none! [-webkit-text-fill-color:currentColor]",
      className
    )}
    data-slot="shimmer"
    style={
      {
        "--shimmer-duration": `${duration}s`,
        "--shimmer-spread": `${spread}ch`,
        backgroundImage: SHIMMER_GRADIENT,
        ...style,
      } as CSSProperties
    }
    {...props}
  />
);
