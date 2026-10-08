// "Which page is the person on", as a CLOSED set (advisor-ai-chatbot-phase2 plan, section 6). PURE and client-safe (no imports).
//
// The slide-over sends only `window.location.pathname`; the server re-parses it here, so the client can never inject text into the prompt. The
// result is a fixed label from the table below plus, for Tax Forms style pages, a tax year. Nothing else from the path survives: no entity slug,
// no questionnaire id, no document id, no query string. Anything not in the table (including /advisor itself) is null and adds nothing.

export type AreaId =
  | "tax_forms_hub"
  | "tax_forms_year"
  | "tax_final_review"
  | "tax_return_sheet"
  | "tax_questionnaire"
  | "tax_summary"
  | "tax_facts"
  | "tax_facts_carry"
  | "tax_donations"
  | "tax_fixed_assets"
  | "tax_workspaces"
  | "tax_workspace"
  | "documents"
  | "receipts"
  | "transactions"
  | "budgets"
  | "forecast"
  | "accounts"
  | "net_worth"
  | "tags"
  | "business_index"
  | "business_section"
  | "insurance"
  | "projects";

export interface PageContext {
  area: AreaId;
  /** Fixed label from the table (never derived from the path). */
  label: string;
  taxYear?: number;
}

const BUSINESS_SECTION_LABELS: Readonly<Record<string, string>> = {
  "balance-sheet": "Business balance sheet",
  "cash-flow": "Business cash flow",
  gl: "Business general ledger",
  mileage: "Business mileage",
  pl: "Business profit and loss",
  revenue: "Business revenue",
  statements: "Business statements",
  vendors: "Business vendors",
};

interface Rule {
  area: AreaId;
  label: string;
  /** Matches the path; group 1, when present, is a four-digit tax year. */
  re: RegExp;
}

const Y = "(\\d{4})";
const ID = "[A-Za-z0-9_-]{1,64}";

const RULES: readonly Rule[] = [
  { area: "tax_forms_hub", label: "Tax Forms", re: /^\/tax\/forms$/ },
  { area: "tax_forms_year", label: "Tax Forms", re: new RegExp(`^/tax/forms/${Y}$`) },
  { area: "tax_final_review", label: "Tax Forms, final review", re: new RegExp(`^/tax/forms/${Y}/final-review$`) },
  { area: "tax_return_sheet", label: "Tax Forms, return sheet", re: new RegExp(`^/tax/forms/${Y}/return$`) },
  { area: "tax_questionnaire", label: "Tax Forms, questionnaire", re: new RegExp(`^/tax/forms/${Y}/questionnaire/${ID}$`) },
  { area: "tax_summary", label: "Tax Forms, summary", re: new RegExp(`^/tax/forms/${Y}/cpa-summary$`) },
  { area: "tax_facts", label: "Tax facts", re: /^\/tax\/facts$/ },
  { area: "tax_facts_carry", label: "Tax facts, carry-forward screen", re: new RegExp(`^/tax/facts/carry(?:/${Y})?$`) },
  { area: "tax_donations", label: "Donation log", re: new RegExp(`^/tax/donations(?:/${Y})?$`) },
  { area: "tax_fixed_assets", label: "Fixed assets", re: new RegExp(`^/tax/fixed-assets(?:/${Y})?$`) },
  { area: "tax_workspaces", label: "Tax workspaces", re: /^\/tax$/ },
  { area: "tax_workspace", label: "A tax workspace", re: new RegExp(`^/tax/(?!forms$|facts$|donations$|fixed-assets$|personal$)${ID}$`) },
  { area: "tax_workspace", label: "A tax workspace", re: new RegExp(`^/tax/personal/${Y}$`) },
  { area: "documents", label: "Documents", re: new RegExp(`^/documents(?:/${ID}/review)?$`) },
  { area: "receipts", label: "Receipts", re: new RegExp(`^/receipts(?:/(?:upload|${ID}))?$`) },
  { area: "transactions", label: "Transactions", re: new RegExp(`^/transactions(?:/(?:import|new|${ID}))?$`) },
  { area: "budgets", label: "Budgets", re: /^\/budgets$/ },
  { area: "forecast", label: "Forecast", re: /^\/forecast$/ },
  { area: "accounts", label: "Accounts", re: /^\/accounts(?:\/connect)?$/ },
  { area: "net_worth", label: "Net worth", re: /^\/personal\/net-worth$/ },
  { area: "tags", label: "Tags and tag rules", re: /^\/(?:tag-rules|tags)$/ },
  { area: "business_index", label: "Businesses", re: /^\/business$/ },
  { area: "insurance", label: "Insurance", re: /^\/personal\/insurance$/ },
  { area: "projects", label: "Projects", re: new RegExp(`^/(?:projects|personal/projects)(?:/${ID})?$`) },
];

const BUSINESS_RE = new RegExp(`^/business/[a-z0-9][a-z0-9-]{0,59}/(${Object.keys(BUSINESS_SECTION_LABELS).join("|")})$`);

function yearOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const y = Number(raw);
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : undefined;
}

/** True for a plain, safe pathname: bounded, absolute, no traversal, no doubled slash, no query, fragment, escape or control characters. */
function isPlainPath(p: string): boolean {
  if (p.length === 0 || p.length > 200 || !p.startsWith("/")) return false;
  if (p.includes("..") || p.includes("//") || p.includes("\\") || /[?#%\u0000-\u001f\u007f\s]/.test(p)) return false;
  return true;
}

export function parsePageContext(pathname: string): PageContext | null {
  if (typeof pathname !== "string" || !isPlainPath(pathname)) return null;
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path === "/advisor" || path.startsWith("/advisor/")) return null;

  const biz = BUSINESS_RE.exec(path);
  if (biz !== null) return { area: "business_section", label: BUSINESS_SECTION_LABELS[biz[1]!]! };

  for (const rule of RULES) {
    const m = rule.re.exec(path);
    if (m === null) continue;
    const taxYear = yearOf(m[1]);
    // A path that names a year outside 2000-2100 is not a page we describe.
    if (m[1] !== undefined && taxYear === undefined) return null;
    return { area: rule.area, label: rule.label, ...(taxYear !== undefined ? { taxYear } : {}) };
  }
  return null;
}

/** The chip text in the slide-over header: "Tax Forms, tax year 2025". */
export function contextChipText(ctx: PageContext): string {
  return ctx.taxYear !== undefined ? `${ctx.label}, tax year ${ctx.taxYear}` : ctx.label;
}

/** The one sentence added to the volatile system block (<= 200 characters; no query value, id or slug). */
export function describePageContext(ctx: PageContext): string {
  return `The person is looking at: ${contextChipText(ctx)} (page name only; use a tool for any numbers).`;
}

/** One concrete path per rule, for the test that maps each to an existing page.tsx under app. */
export const PAGE_CONTEXT_SAMPLES: readonly string[] = [
  "/tax/forms",
  "/tax/forms/2025",
  "/tax/forms/2025/final-review",
  "/tax/forms/2025/return",
  "/tax/forms/2025/questionnaire/home_office",
  "/tax/forms/2025/cpa-summary",
  "/tax/facts",
  "/tax/facts/carry",
  "/tax/facts/carry/2026",
  "/tax/donations",
  "/tax/donations/2025",
  "/tax/fixed-assets",
  "/tax/fixed-assets/2025",
  "/tax",
  "/tax/personal/2025",
  "/documents",
  "/documents/abc123/review",
  "/receipts",
  "/receipts/upload",
  "/transactions",
  "/transactions/import",
  "/budgets",
  "/forecast",
  "/accounts",
  "/accounts/connect",
  "/personal/net-worth",
  "/tag-rules",
  "/tags",
  "/business",
  "/business/eric-kinniburgh-consulting/pl",
  "/business/eric-kinniburgh-consulting/balance-sheet",
  "/business/eric-kinniburgh-consulting/cash-flow",
  "/business/eric-kinniburgh-consulting/gl",
  "/business/eric-kinniburgh-consulting/mileage",
  "/business/eric-kinniburgh-consulting/revenue",
  "/business/eric-kinniburgh-consulting/statements",
  "/business/eric-kinniburgh-consulting/vendors",
  "/personal/insurance",
  "/projects",
  "/personal/projects",
];
