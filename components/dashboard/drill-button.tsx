"use client";

import type { ReactNode } from "react";
import { useDrill } from "./drill-context";
import type { DrillTarget } from "@/lib/dashboard-drill";

/**
 * Wraps a card, bar label or row so it opens the drill-down for `target`. It is a real <button> (keyboard focusable,
 * Enter and Space work, visible focus ring). When the month's numbers are unavailable it renders the content as-is,
 * never a dead button.
 */
export function DrillButton({
  target,
  label,
  className = "",
  children,
}: {
  target: DrillTarget;
  /** Accessible name, e.g. "Show what makes up Spent". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const { data, open } = useDrill();
  if (!data) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={label}
      onClick={(e) => open(target, e.currentTarget)}
      className={`${className} cursor-pointer text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      {children}
    </button>
  );
}
