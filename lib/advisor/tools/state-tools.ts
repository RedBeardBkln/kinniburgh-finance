// The Phase 2 state and change tools (tax calendar, recent changes). Registered in all-tools.ts.

import { getRecentChangesTool } from "@/lib/advisor/tools/get-recent-changes";
import { getTaxCalendarTool } from "@/lib/advisor/tools/get-tax-calendar";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const STATE_TOOLS: readonly RegisteredTool[] = [getTaxCalendarTool, getRecentChangesTool];
