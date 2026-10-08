// Short names for the tool chips under a stored answer. PURE and client-safe (the registry itself is server-only). While a tool runs the
// stream carries the registry's own label; for a reloaded conversation the chip uses this table. A test pins parity with the registry.

export const TOOL_CHIP_NAMES: Readonly<Record<string, string>> = {
  get_budget_status: "Budgets",
  get_document_values: "Document values",
  get_entity_pnl: "Profit and loss",
  get_financial_overview: "Financial snapshot",
  get_forecast: "Forecast",
  get_net_worth_history: "Net worth",
  get_recent_changes: "Recent changes",
  get_rental_income: "Rental income",
  get_spend_summary: "Spending summary",
  get_tax_calendar: "Tax calendar",
  get_tax_decisions: "Return decisions",
  get_tax_facts: "Tax facts",
  get_tax_open_items: "Open items",
  get_tax_return_lines: "Return lines",
  get_tax_return_summary: "TY2025 return",
  get_tax_review_status: "Review status",
  list_accounts: "Accounts",
  list_documents: "Documents",
  list_donations: "Donations",
  list_fixed_assets: "Fixed assets",
  list_goals: "Goals",
  list_insurance: "Insurance",
  list_recurring_and_scheduled: "Recurring items",
  propose_memory_note: "Memory suggestion",
  search_transactions: "Transactions",
};

export function chipNameFor(toolName: string): string {
  return TOOL_CHIP_NAMES[toolName] ?? "Lookup";
}
