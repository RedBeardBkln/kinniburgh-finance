// PROPOSED mapping from the Eric Kinniburgh Consulting, LLC chart of accounts
// (data/gl-accounts-ekc-2026.csv, 146 QuickBooks accounts) to Schedule C lines and
// special treatments, for the TY2025 return engine.
//
// THIS IS A PROPOSAL FOR THE OWNER AND THE CPA TO APPROVE. It is a mapping (a
// judgment about where each account's activity is reported), not a tax fact.
// Wrong lines do not change net profit but change meals (50%), vehicle, depreciation
// and "other expenses" reporting. Everything here is plain data: edit an entry's
// `target` to change where an account lands; nothing else in the engine changes.
//
// The map is keyed by the QuickBooks account NAME as exported (a "Parent:Child"
// path), because the app-assigned numeric GL codes are not stored in the repo.
// findGlMapEntry() matches a stored GlCode.name by that full name first, then by its
// leaf name when the leaf is unique in the chart. A name that matches nothing is
// reported as UNMAPPED (an open item that blocks the Schedule C lines).
//
// Targets:
//   line               - a Schedule C line (optionally `meals`: the verified 50% rule applies)
//   cogs               - Part III cost of goods sold (needs_cpa_judgment if any amount: inventory is not modeled)
//   depreciation       - line 13 book depreciation (Form 4562 is Phase 2; blocked if the fixed-asset register has assets)
//   vehicle_actual     - line 9 actual vehicle expenses (cannot be combined with the standard mileage rate)
//   home_office_actual - Form 8829 actual-method inputs (decision X1; excluded from net profit under the simplified method)
//   needs_cpa          - clearing / personal / other-form items: the CPA decides; blocks the profit while non-zero
//   balance_sheet      - assets, liabilities, equity: never part of Schedule C

import { SCHEDULE_C_LINE_IDS, type ScheduleCLineId } from "@/lib/tax2025/line-catalog";

export type GlMapTarget =
  | { kind: "line"; line: ScheduleCLineId; meals?: boolean }
  | { kind: "cogs" }
  | { kind: "depreciation" }
  | { kind: "vehicle_actual" }
  | { kind: "home_office_actual" }
  | { kind: "needs_cpa"; reason: string }
  | { kind: "balance_sheet" };

export interface GlMapEntry {
  /** QuickBooks account name as exported ("Parent:Child"). */
  account: string;
  /** QuickBooks account type column. */
  qboType: string;
  target: GlMapTarget;
  note?: string;
}

export const GL_SCHEDULE_C_MAP: readonly GlMapEntry[] = [
  { account: "Cash", qboType: "Bank", target: { kind: "balance_sheet" } },
  { account: "QuickBooks Checking Account", qboType: "Bank", target: { kind: "balance_sheet" } },
  { account: "Accounts Receivable (A/R)", qboType: "Accounts receivable (A/R)", target: { kind: "balance_sheet" } },
  { account: "Inventory Asset", qboType: "Other Current Assets", target: { kind: "balance_sheet" } },
  { account: "Loans to others", qboType: "Other Current Assets", target: { kind: "balance_sheet" } },
  { account: "Payments to deposit", qboType: "Other Current Assets", target: { kind: "balance_sheet" } },
  { account: "Prepaid expenses", qboType: "Other Current Assets", target: { kind: "balance_sheet" } },
  { account: "Uncategorized Asset", qboType: "Other Current Assets", target: { kind: "balance_sheet" } },
  { account: "Buildings", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Land", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Long-term office equipment", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Long-term office equipment:Computers & tablets", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Long-term office equipment:Copiers", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Long-term office equipment:Custom software or app", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Long-term office equipment:Furniture", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Long-term office equipment:Phones", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Long-term office equipment:Photo & video equipment", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Tools, machinery, and equipment", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Vehicles", qboType: "Fixed Assets", target: { kind: "balance_sheet" } },
  { account: "Accounts Payable (A/P)", qboType: "Accounts payable (A/P)", target: { kind: "balance_sheet" } },
  { account: "XXXX1909 - 3", qboType: "Credit Card", target: { kind: "balance_sheet" } },
  { account: "Connecticut Department of Revenue Services Payable", qboType: "Other Current Liabilities", target: { kind: "balance_sheet" } },
  { account: "Customer prepayments", qboType: "Other Current Liabilities", target: { kind: "balance_sheet" } },
  { account: "Deferred Revenue", qboType: "Other Current Liabilities", target: { kind: "balance_sheet" } },
  { account: "Due to Owner", qboType: "Other Current Liabilities", target: { kind: "balance_sheet" } },
  { account: "Lines of credit", qboType: "Other Current Liabilities", target: { kind: "balance_sheet" } },
  { account: "Out Of Scope Agency Payable", qboType: "Other Current Liabilities", target: { kind: "balance_sheet" } },
  { account: "Sales tax to pay", qboType: "Other Current Liabilities", target: { kind: "balance_sheet" } },
  { account: "Short-term business loans", qboType: "Other Current Liabilities", target: { kind: "balance_sheet" } },
  { account: "Long-term business loans", qboType: "Long Term Liabilities", target: { kind: "balance_sheet" } },
  { account: "Mortgages", qboType: "Long Term Liabilities", target: { kind: "balance_sheet" } },
  { account: "Federal estimated taxes", qboType: "Equity", target: { kind: "balance_sheet" }, note: "Estimated tax payments: not an expense. Payment totals come from the payments answers; the books can corroborate them." },
  { account: "Opening balance equity", qboType: "Equity", target: { kind: "balance_sheet" } },
  { account: "Owner draws", qboType: "Equity", target: { kind: "balance_sheet" }, note: "Equity: never an expense." },
  { account: "Owner investments", qboType: "Equity", target: { kind: "balance_sheet" } },
  { account: "Personal expenses", qboType: "Equity", target: { kind: "balance_sheet" } },
  { account: "Personal expenses:Federal taxes", qboType: "Equity", target: { kind: "balance_sheet" } },
  { account: "Personal expenses:Owner retirement plans", qboType: "Equity", target: { kind: "balance_sheet" }, note: "Possible Schedule 1 line 16 (SEP / SIMPLE / qualified plan) input; eligibility rules are not verified here." },
  { account: "Personal expenses:State taxes", qboType: "Equity", target: { kind: "balance_sheet" } },
  { account: "Personal healthcare", qboType: "Equity", target: { kind: "balance_sheet" } },
  { account: "Personal healthcare:Health insurance premiums", qboType: "Equity", target: { kind: "balance_sheet" }, note: "Possible Schedule 1 line 17 (SE health insurance) input; eligibility rules are not verified here." },
  { account: "Personal healthcare:HSA contributions", qboType: "Equity", target: { kind: "balance_sheet" }, note: "Possible Schedule 1 line 13 (HSA) input." },
  { account: "Retained Earnings", qboType: "Equity", target: { kind: "balance_sheet" } },
  { account: "State estimated taxes", qboType: "Equity", target: { kind: "balance_sheet" }, note: "Estimated tax payments: not an expense. Payment totals come from the payments answers; the books can corroborate them." },
  { account: "Billable Expense Income", qboType: "Income", target: { kind: "line", line: "1" } },
  { account: "Refunds to customers", qboType: "Income", target: { kind: "line", line: "2" } },
  { account: "Sales", qboType: "Income", target: { kind: "line", line: "1" } },
  { account: "Sales of Product Income", qboType: "Income", target: { kind: "line", line: "1" } },
  { account: "Services", qboType: "Income", target: { kind: "line", line: "1" } },
  { account: "Shipping Income", qboType: "Income", target: { kind: "line", line: "1" } },
  { account: "Unapplied Cash Payment Income", qboType: "Income", target: { kind: "needs_cpa", reason: "Clearing account for unapplied customer payments: apply them to the right income account first." } },
  { account: "Uncategorized Income", qboType: "Income", target: { kind: "needs_cpa", reason: "Uncategorized income: classify the receipts before they are reported as Schedule C income." } },
  { account: "Cost of goods sold", qboType: "Cost of Goods Sold", target: { kind: "cogs" } },
  { account: "Cost of goods sold:Equipment rental", qboType: "Cost of Goods Sold", target: { kind: "cogs" } },
  { account: "Cost of goods sold:Subcontractor expenses", qboType: "Cost of Goods Sold", target: { kind: "cogs" } },
  { account: "Cost of goods sold:Supplies & materials", qboType: "Cost of Goods Sold", target: { kind: "cogs" } },
  { account: "Advertising & marketing", qboType: "Expenses", target: { kind: "line", line: "8" } },
  { account: "Advertising & marketing:Listing fees", qboType: "Expenses", target: { kind: "line", line: "8" } },
  { account: "Advertising & marketing:Social media", qboType: "Expenses", target: { kind: "line", line: "8" } },
  { account: "Advertising & marketing:Website ads", qboType: "Expenses", target: { kind: "line", line: "8" } },
  { account: "Building & property rent", qboType: "Expenses", target: { kind: "line", line: "20b" } },
  { account: "Business licences", qboType: "Expenses", target: { kind: "line", line: "23" } },
  { account: "Commissions & fees", qboType: "Expenses", target: { kind: "line", line: "10" } },
  { account: "Contract labor", qboType: "Expenses", target: { kind: "line", line: "11" } },
  { account: "Contributions to charities", qboType: "Expenses", target: { kind: "needs_cpa", reason: "Charitable gifts are a personal Schedule A item for a disregarded LLC, not a Schedule C expense: move them to the donation log." } },
  { account: "Employee benefits", qboType: "Expenses", target: { kind: "line", line: "14" } },
  { account: "Employee benefits:Employee retirement plans", qboType: "Expenses", target: { kind: "line", line: "19" } },
  { account: "Employee benefits:Group term life insurance", qboType: "Expenses", target: { kind: "line", line: "14" } },
  { account: "Employee benefits:Health & accident plans", qboType: "Expenses", target: { kind: "line", line: "14" } },
  { account: "Employee benefits:Worker's compensation insurance", qboType: "Expenses", target: { kind: "line", line: "15" } },
  { account: "Entertainment with clients", qboType: "Expenses", target: { kind: "needs_cpa", reason: "Client entertainment: whether any part is deductible is not verified here (the verified instructions cover meals at 50% only)." } },
  { account: "Equipment rental", qboType: "Expenses", target: { kind: "line", line: "20a" } },
  { account: "General business expenses", qboType: "Expenses", target: { kind: "line", line: "27b" } },
  { account: "General business expenses:Bad Debt", qboType: "Expenses", target: { kind: "line", line: "27b" } },
  { account: "General business expenses:Bank fees & service charges", qboType: "Expenses", target: { kind: "line", line: "27b" } },
  { account: "General business expenses:Continuing education", qboType: "Expenses", target: { kind: "line", line: "27b" } },
  { account: "General business expenses:Memberships & subscriptions", qboType: "Expenses", target: { kind: "line", line: "27b" } },
  { account: "General business expenses:Uniforms", qboType: "Expenses", target: { kind: "line", line: "27b" } },
  { account: "Insurance", qboType: "Expenses", target: { kind: "line", line: "15" } },
  { account: "Insurance:Business insurance", qboType: "Expenses", target: { kind: "line", line: "15" } },
  { account: "Insurance:Liability insurance", qboType: "Expenses", target: { kind: "line", line: "15" } },
  { account: "Insurance:Property insurance", qboType: "Expenses", target: { kind: "line", line: "15" } },
  { account: "Insurance:Rental insurance", qboType: "Expenses", target: { kind: "line", line: "15" } },
  { account: "Interest paid", qboType: "Expenses", target: { kind: "line", line: "16b" } },
  { account: "Interest paid:Business loan interest", qboType: "Expenses", target: { kind: "line", line: "16b" } },
  { account: "Interest paid:Credit card interest", qboType: "Expenses", target: { kind: "line", line: "16b" } },
  { account: "Interest paid:Mortgage interest", qboType: "Expenses", target: { kind: "line", line: "16a" } },
  { account: "Legal & accounting services", qboType: "Expenses", target: { kind: "line", line: "17" } },
  { account: "Legal & accounting services:Accounting fees", qboType: "Expenses", target: { kind: "line", line: "17" } },
  { account: "Legal & accounting services:Legal fees", qboType: "Expenses", target: { kind: "line", line: "17" } },
  { account: "Legal & Professional Fees", qboType: "Expenses", target: { kind: "line", line: "17" } },
  { account: "Meals", qboType: "Expenses", target: { kind: "line", line: "24b", meals: true }, note: "Meals are generally 50% deductible; the 50% is applied to the booked amount." },
  { account: "Meals:Meals with clients", qboType: "Expenses", target: { kind: "line", line: "24b", meals: true }, note: "Meals are generally 50% deductible; the 50% is applied to the booked amount." },
  { account: "Meals:Travel meals", qboType: "Expenses", target: { kind: "line", line: "24b", meals: true }, note: "Meals are generally 50% deductible; the 50% is applied to the booked amount." },
  { account: "Office expenses", qboType: "Expenses", target: { kind: "line", line: "18" } },
  { account: "Office expenses:Merchant account fees", qboType: "Expenses", target: { kind: "line", line: "10" } },
  { account: "Office expenses:Office supplies", qboType: "Expenses", target: { kind: "line", line: "18" } },
  { account: "Office expenses:Printing & photocopying", qboType: "Expenses", target: { kind: "line", line: "18" } },
  { account: "Office expenses:Shipping & postage", qboType: "Expenses", target: { kind: "line", line: "18" } },
  { account: "Office expenses:Small tools and equipment", qboType: "Expenses", target: { kind: "line", line: "22" } },
  { account: "Office expenses:Software & apps", qboType: "Expenses", target: { kind: "line", line: "18" } },
  { account: "Payroll expenses", qboType: "Expenses", target: { kind: "line", line: "26" } },
  { account: "Payroll expenses:Wages", qboType: "Expenses", target: { kind: "line", line: "26" } },
  { account: "Professional Services", qboType: "Expenses", target: { kind: "line", line: "17" } },
  { account: "Repairs & maintenance", qboType: "Expenses", target: { kind: "line", line: "21" } },
  { account: "Supplies", qboType: "Expenses", target: { kind: "line", line: "22" } },
  { account: "Supplies:Supplies & materials", qboType: "Expenses", target: { kind: "line", line: "22" } },
  { account: "Taxes paid", qboType: "Expenses", target: { kind: "line", line: "23" } },
  { account: "Taxes paid:Payroll taxes", qboType: "Expenses", target: { kind: "line", line: "23" } },
  { account: "Taxes paid:Property taxes", qboType: "Expenses", target: { kind: "line", line: "23" } },
  { account: "Travel", qboType: "Expenses", target: { kind: "line", line: "24a" } },
  { account: "Travel:Airfare", qboType: "Expenses", target: { kind: "line", line: "24a" } },
  { account: "Travel:Hotels", qboType: "Expenses", target: { kind: "line", line: "24a" } },
  { account: "Travel:Taxis or shared rides", qboType: "Expenses", target: { kind: "line", line: "24a" } },
  { account: "Travel:Vehicle rental", qboType: "Expenses", target: { kind: "line", line: "24a" } },
  { account: "Unapplied Cash Bill Payment Expense", qboType: "Expenses", target: { kind: "needs_cpa", reason: "Clearing account for unapplied bill payments: apply them to the right expense account first." } },
  { account: "Utilities", qboType: "Expenses", target: { kind: "line", line: "25" } },
  { account: "Utilities:Disposal & waste fees", qboType: "Expenses", target: { kind: "line", line: "25" } },
  { account: "Utilities:Electricity", qboType: "Expenses", target: { kind: "line", line: "25" } },
  { account: "Utilities:Heating & cooling", qboType: "Expenses", target: { kind: "line", line: "25" } },
  { account: "Utilities:Internet & TV services", qboType: "Expenses", target: { kind: "line", line: "25" } },
  { account: "Utilities:Phone service", qboType: "Expenses", target: { kind: "line", line: "25" } },
  { account: "Utilities:Water & sewer", qboType: "Expenses", target: { kind: "line", line: "25" } },
  { account: "Other income", qboType: "Other Income", target: { kind: "line", line: "6" } },
  { account: "Other income:Credit card rewards", qboType: "Other Income", target: { kind: "line", line: "6" } },
  { account: "Other income:Insurance claims", qboType: "Other Income", target: { kind: "line", line: "6" } },
  { account: "Other income:Interest earned", qboType: "Other Income", target: { kind: "needs_cpa", reason: "Interest earned belongs on Form 1040 line 2b / Schedule B, not on Schedule C line 6." } },
  { account: "Other income:Sale of an asset", qboType: "Other Income", target: { kind: "needs_cpa", reason: "Sale of a business asset goes to Form 4797 / Schedule D, not Schedule C line 6." } },
  { account: "Depreciation", qboType: "Other Expense", target: { kind: "depreciation" } },
  { account: "Home office", qboType: "Other Expense", target: { kind: "home_office_actual" } },
  { account: "Home office:Home utilities", qboType: "Other Expense", target: { kind: "home_office_actual" } },
  { account: "Home office:Homeowner & rental insurance", qboType: "Other Expense", target: { kind: "home_office_actual" } },
  { account: "Home office:Mortgage interest", qboType: "Other Expense", target: { kind: "home_office_actual" } },
  { account: "Home office:Property taxes", qboType: "Other Expense", target: { kind: "home_office_actual" } },
  { account: "Home office:Rent", qboType: "Other Expense", target: { kind: "home_office_actual" } },
  { account: "Home office:Repairs & maintenance", qboType: "Other Expense", target: { kind: "home_office_actual" } },
  { account: "Reconciliation Discrepancies", qboType: "Other Expense", target: { kind: "needs_cpa", reason: "Reconciliation clean-up account: the CPA decides what these entries are." } },
  { account: "Vehicle expenses", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
  { account: "Vehicle expenses:Parking & tolls", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
  { account: "Vehicle expenses:Vehicle gas & fuel", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
  { account: "Vehicle expenses:Vehicle insurance", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
  { account: "Vehicle expenses:Vehicle leases", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
  { account: "Vehicle expenses:Vehicle loan interest paid", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
  { account: "Vehicle expenses:Vehicle registration", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
  { account: "Vehicle expenses:Vehicle repairs", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
  { account: "Vehicle expenses:Vehicle wash & road services", qboType: "Other Expense", target: { kind: "vehicle_actual" } },
];

/** Lines the map may target (sanity-checked by a test against the catalog). */
export const MAPPED_SCHEDULE_C_LINES: readonly string[] = SCHEDULE_C_LINE_IDS;

function normalizeName(name: string): string {
  return name
    .split(":")
    .map((part) => part.trim().replace(/\s+/g, " ").toLowerCase())
    .join(":");
}

const BY_FULL_NAME: ReadonlyMap<string, GlMapEntry> = new Map(GL_SCHEDULE_C_MAP.map((e) => [normalizeName(e.account), e]));

/** Leaf name -> entries having that leaf (a leaf match is only used when exactly one entry has it). */
const BY_LEAF: ReadonlyMap<string, GlMapEntry[]> = (() => {
  const m = new Map<string, GlMapEntry[]>();
  for (const e of GL_SCHEDULE_C_MAP) {
    const leaf = normalizeName(e.account).split(":").pop() ?? "";
    m.set(leaf, [...(m.get(leaf) ?? []), e]);
  }
  return m;
})();

/**
 * Finds the proposed target for a GL code's stored name: full "Parent:Child" name
 * first, then the leaf name when exactly one account in the chart has that leaf.
 * Returns null when nothing (or an ambiguous leaf) matches: the caller reports it
 * as UNMAPPED.
 */
export function findGlMapEntry(name: string): GlMapEntry | null {
  const norm = normalizeName(name);
  const full = BY_FULL_NAME.get(norm);
  if (full) return full;
  if (!norm.includes(":")) {
    const leafMatches = BY_LEAF.get(norm) ?? [];
    if (leafMatches.length === 1) return leafMatches[0] ?? null;
  }
  return null;
}
