// ── Period balance sheet math ──────────────────────────────────────────────────
// Pure functions — unit tested in lib/__tests__/period-balance-sheet.test.ts.
// Money: integer cents everywhere. Never floats.

export type PeriodKind = "month" | "quarter" | "year";

export interface PeriodRange {
  kind: PeriodKind;
  label: string;      // "August 2026", "Q3 2026", "FY 2026"
  start: string;      // YYYY-MM-DD (inclusive, UTC)
  end: string;        // YYYY-MM-DD (inclusive, UTC)
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parse a period selector like "2026-08" (month), "2026-Q3" (quarter), "2026" (year). */
export function parsePeriodSelector(selector: string): PeriodRange | null {
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(selector);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) return null;
    return monthRange(year, month);
  }

  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(selector);
  if (quarterMatch) {
    return quarterRange(Number(quarterMatch[1]), Number(quarterMatch[2]));
  }

  const yearMatch = /^(\d{4})$/.exec(selector);
  if (yearMatch) {
    return yearRange(Number(yearMatch[1]));
  }

  return null;
}

export function monthRange(year: number, month: number): PeriodRange {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    kind: "month",
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    start: `${year}-${pad2(month)}-01`,
    end: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

export function quarterRange(year: number, quarter: number): PeriodRange {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  return {
    kind: "quarter",
    label: `Q${quarter} ${year}`,
    start: `${year}-${pad2(startMonth)}-01`,
    end: `${year}-${pad2(endMonth)}-${pad2(lastDay)}`,
  };
}

export function yearRange(year: number): PeriodRange {
  return {
    kind: "year",
    label: `FY ${year}`,
    start: `${year}-01-01`,
    end: `${year}-12-31`,
  };
}

// ── Statement → period balance sheet aggregation ──────────────────────────────

export interface StatementSnapshot {
  accountId: string | null;
  accountMask: string | null;
  institutionName: string | null;
  /** closing balance in cents from the statement (signed; negative = liability-style balance) */
  closingBalanceCents: number | null;
  periodEnd: string; // YYYY-MM-DD
}

export interface PeriodBalanceLine {
  key: string;
  label: string;
  mask: string | null;
  balanceCents: number;
  statementCount: number;
  source: "statement";
}

export interface PeriodBalanceSheet {
  period: PeriodRange;
  assets: PeriodBalanceLine[];
  liabilities: PeriodBalanceLine[];
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  equityCents: number;
  hasData: boolean;
}

export interface AccountTypeHint {
  id: string;
  nickname: string;
  accountType: string;
}

const LIABILITY_TYPES = new Set(["credit_card", "mortgage", "loan"]);
const ASSET_TYPES = new Set(["checking", "savings", "investment"]);

/**
 * Picks, per account, the closing balance from the statement whose periodEnd
 * is the latest within the report period (statements may overlap — e.g. a
 * quarterly statement and its monthly statements both covering June).
 * Only a statement's periodEnd is bounds-checked against the report period
 * (periodStart is not) — an annual statement's Dec 31 closing balance is a
 * valid point-in-time value for a December-month query, for example.
 * Unlinked statements (accountId null) are keyed by institution + mask.
 */
export function pickLatestClosingBalances(
  statements: StatementSnapshot[],
  period: PeriodRange
): Map<string, StatementSnapshot> {
  const byAccount = new Map<string, StatementSnapshot>();
  for (const s of statements) {
    if (s.closingBalanceCents === null) continue;
    // statement periodEnd must fall inside the report period
    if (s.periodEnd < period.start || s.periodEnd > period.end) continue;
    const key = s.accountId ?? `unlinked:${s.institutionName ?? ""}:${s.accountMask ?? ""}`;
    const existing = byAccount.get(key);
    if (!existing || s.periodEnd > existing.periodEnd) {
      byAccount.set(key, s);
    }
  }
  return byAccount;
}

/**
 * Builds a period balance sheet from confirmed bank statement closing balances.
 * Asset/liability classification follows the linked Account's accountType.
 * Statements not linked to an Account are treated as assets (bank statements
 * are typically for checking/savings accounts) and labeled by mask+institution.
 */
export function buildPeriodBalanceSheet(
  statements: StatementSnapshot[],
  accounts: AccountTypeHint[],
  period: PeriodRange
): PeriodBalanceSheet {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const byAccount = pickLatestClosingBalances(statements, period);

  const assets: PeriodBalanceLine[] = [];
  const liabilities: PeriodBalanceLine[] = [];

  for (const [key, snap] of byAccount) {
    const account = key.startsWith("unlinked:") ? undefined : accountMap.get(key);
    const label = account?.nickname
      ?? [snap.institutionName, snap.accountMask].filter(Boolean).join(" ···")
      ?? "Unnamed account";
    const type = account?.accountType;
    const isLiability = Boolean(type && LIABILITY_TYPES.has(type));
    const line: PeriodBalanceLine = {
      key,
      label,
      mask: snap.accountMask,
      // Liability balances are extracted/entered as signed cents (negative = amount
      // owed, per lib/bank-statement-extract.ts's STATEMENT_PROMPT). Normalize to a
      // positive magnitude here so totals match the established convention in
      // lib/reports.ts's computeBalanceSheet and actions/net-worth.ts's
      // computeNetWorth, which both Math.abs() liability balances before totaling.
      balanceCents: isLiability
        ? Math.abs(snap.closingBalanceCents as number)
        : (snap.closingBalanceCents as number),
      statementCount: 1,
      source: "statement",
    };
    if (isLiability) {
      liabilities.push(line);
    } else if (type && ASSET_TYPES.has(type)) {
      assets.push(line);
    } else {
      // No linked account / unknown type: bank statement → default to asset.
      assets.push(line);
    }
  }

  assets.sort((a, b) => a.label.localeCompare(b.label));
  liabilities.sort((a, b) => a.label.localeCompare(b.label));

  const totalAssetsCents = assets.reduce((s, a) => s + a.balanceCents, 0);
  const totalLiabilitiesCents = liabilities.reduce((s, l) => s + l.balanceCents, 0);

  return {
    period,
    assets,
    liabilities,
    totalAssetsCents,
    totalLiabilitiesCents,
    equityCents: totalAssetsCents - totalLiabilitiesCents,
    hasData: byAccount.size > 0,
  };
}