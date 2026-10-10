"use client";

import { createContext, useContext } from "react";
import type { DrillData, DrillTarget } from "@/lib/dashboard-drill";

export interface DrillContextValue {
  /** null when the month's numbers could not be loaded: every drill trigger then renders as plain content. */
  data: DrillData | null;
  /** Open the drill-down for a target. `trigger` is the element focus returns to when the dialog closes. */
  open: (target: DrillTarget, trigger?: HTMLElement | null) => void;
}

export const DrillContext = createContext<DrillContextValue>({ data: null, open: () => {} });

export function useDrill(): DrillContextValue {
  return useContext(DrillContext);
}
