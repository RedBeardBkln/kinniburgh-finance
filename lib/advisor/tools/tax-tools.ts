// The Phase 1 TY2025 tax tools (read-only). The full list is assembled in all-tools.ts.

import { getTaxDecisionsTool } from "@/lib/advisor/tools/get-tax-decisions";
import { getTaxFactsTool } from "@/lib/advisor/tools/get-tax-facts";
import { getTaxOpenItemsTool } from "@/lib/advisor/tools/get-tax-open-items";
import { getTaxReturnLinesTool } from "@/lib/advisor/tools/get-tax-return-lines";
import { getTaxReturnSummaryTool } from "@/lib/advisor/tools/get-tax-return-summary";
import { getTaxReviewStatusTool } from "@/lib/advisor/tools/get-tax-review-status";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const TAX_TOOLS: readonly RegisteredTool[] = [
  getTaxReturnSummaryTool,
  getTaxReturnLinesTool,
  getTaxOpenItemsTool,
  getTaxDecisionsTool,
  getTaxFactsTool,
  getTaxReviewStatusTool,
];
