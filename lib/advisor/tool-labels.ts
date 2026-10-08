// Short names for the tool chips under a stored answer. PURE and client-safe (the registry itself is server-only). While a tool runs the
// stream carries the registry's own label; for a reloaded conversation the chip uses this table. A test pins parity with the registry.

export const TOOL_CHIP_NAMES: Readonly<Record<string, string>> = {
  get_budget_status: "Budgets",
  get_financial_overview: "Financial snapshot",
  get_net_worth_history: "Net worth",
  get_spend_summary: "Spending summary",
  get_tax_decisions: "Return decisions",
  get_tax_facts: "Tax facts",
  get_tax_open_items: "Open items",
  get_tax_return_lines: "Return lines",
  get_tax_return_summary: "TY2025 return",
  get_tax_review_status: "Review status",
  list_accounts: "Accounts",
  list_goals: "Goals",
  search_transactions: "Transactions",
};

export function chipNameFor(toolName: string): string {
  return TOOL_CHIP_NAMES[toolName] ?? "Lookup";
}
