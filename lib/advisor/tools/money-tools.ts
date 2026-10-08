// The Phase 1 money tools (accounts, net worth, transactions, spending, budgets, goals, overview). The full list is assembled in all-tools.ts.

import { getBudgetStatusTool } from "@/lib/advisor/tools/get-budget-status";
import { getFinancialOverviewTool } from "@/lib/advisor/tools/get-financial-overview";
import { getNetWorthHistoryTool } from "@/lib/advisor/tools/get-net-worth-history";
import { getSpendSummaryTool } from "@/lib/advisor/tools/get-spend-summary";
import { listAccountsTool } from "@/lib/advisor/tools/list-accounts";
import { listGoalsTool } from "@/lib/advisor/tools/list-goals";
import { searchTransactionsTool } from "@/lib/advisor/tools/search-transactions";
import type { RegisteredTool } from "@/lib/advisor/tools/types";

export const MONEY_TOOLS: readonly RegisteredTool[] = [
  getFinancialOverviewTool,
  listAccountsTool,
  getNetWorthHistoryTool,
  searchTransactionsTool,
  getSpendSummaryTool,
  getBudgetStatusTool,
  listGoalsTool,
];
