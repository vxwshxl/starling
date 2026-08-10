import type { ComponentProps, ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A bento cell.
 *
 * Wraps Card with the staggered entrance and a hairline top highlight, so the
 * grid reads as one panel of instruments rather than a pile of unrelated
 * boxes. `delay` is the stagger index in milliseconds.
 */
export function Tile({
  className,
  delay = 0,
  ...props
}: ComponentProps<typeof Card> & { delay?: number }) {
  return (
    <Card
      style={{ animationDelay: `${delay}ms` }}
      className={cn(
        "tile-rise relative isolate overflow-hidden",
        // The highlight is a 1px inset line, not a border, so it does not
        // fight the ring Card already carries.
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px",
        "before:bg-gradient-to-r before:from-transparent before:via-foreground/15 before:to-transparent",
        className,
      )}
      {...props}
    />
  );
}

/** Small caps label used for every field name on the panel. */
export function TileLabel({
  icon,
  children,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase",
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
