import * as React from "react";
import { cn } from "@/lib/utils";

// A wide table scrolls sideways inside this box on a phone instead of pushing the whole page wider than the screen
// (mobile-layout-cleanup). Server-safe (no "use client"). With a `label` the box is a focusable, named region so a
// keyboard user can scroll it too.
export function TableScroll({
  className,
  label,
  children,
}: {
  className?: string;
  label?: string;
  children: React.ReactNode;
}) {
  if (label) {
    return (
      <div role="region" aria-label={label} tabIndex={0} className={cn("w-full overflow-x-auto", className)}>
        {children}
      </div>
    );
  }
  return <div className={cn("w-full overflow-x-auto", className)}>{children}</div>;
}
