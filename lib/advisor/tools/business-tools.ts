// The Phase 2 business and planning tools (entity P&L, rental income, recurring / scheduled items, forecast). Registered in all-tools.ts.

import { getEntityPnlTool } from "@/lib/advisor/tools/get-entity-pnl";
import { getForecastTool } from "@/lib/advisor/tools/get-forecast";
import { getRentalIncomeTool } from "@/lib/advisor/tools/get-rental-income";
import { listRecurringAndScheduledTool } from "@/lib/advisor/tools/list-recurring-and-scheduled";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const BUSINESS_TOOLS: readonly RegisteredTool[] = [getEntityPnlTool, getRentalIncomeTool, listRecurringAndScheduledTool, getForecastTool];
