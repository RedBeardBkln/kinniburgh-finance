import { describe, it, expect } from "vitest";
import {
  parsePeriodSelector,
  monthRange,
  quarterRange,
  yearRange,
  pickLatestClosingBalances,
  buildPeriodBalanceSheet,
  type StatementSnapshot,
} from "@/lib/period-balance-sheet";

// ── Period selectors ───────────────────────────────────────────────────────────

describe("parsePeriodSelector", () => {
  it("parses month selectors", () => {
    const p = parsePeriodSelector("2026-08");
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("month");
    expect(p!.label).toBe("August 2026");
    expect(p!.start).toBe("2026-08-01");
    expect(p!.end).toBe("2026-08-31");
  });

  it("parses quarter selectors", () => {
    const p = parsePeriodSelector("2026-Q3");
    expect(p!.kind).toBe("quarter");
    expect(p!.label).toBe("Q3 2026");
    expect(p!.start).toBe("2026-07-01");
    expect(p!.end).toBe("2026-09-30");
  });

  it("handles Q1 spanning Feb (leap-year aware via UTC date math)", () => {
    const p = parsePeriodSelector("2024-Q1");
    expect(p!.end).toBe("2024-03-31");
    const leapFeb = monthRange(2024, 2);
    expect(leapFeb.end).toBe("2024-02-29");
    const normalFeb = monthRange(2026, 2);
    expect(normalFeb.end).toBe("2026-02-28");
  });

  it("parses year selectors", () => {
    const p = parsePeriodSelector("2026");
    expect(p!.kind).toBe("year");
    expect(p!.label).toBe("FY 2026");
    expect(p!.start).toBe("2026-01-01");
    expect(p!.end).toBe("2026-12-31");
  });

  it("rejects invalid selectors", () => {
    expect(parsePeriodSelector("2026-13")).toBeNull();
    expect(parsePeriodSelector("2026-Q5")).toBeNull();
    expect(parsePeriodSelector("august")).toBeNull();
    expect(parsePeriodSelector("26-08")).toBeNull();
    expect(parsePeriodSelector("")).toBeNull();
  });
});

describe("range builders", () => {
  it("monthRange handles 30- and 31-day months", () => {
    expect(monthRange(2026, 4).end).toBe("2026-04-30");
    expect(monthRange(2026, 1).end).toBe("2026-01-31");
    expect(monthRange(2026, 12).end).toBe("2026-12-31");
  });

  it("quarterRange covers correct month spans", () => {
    const q4 = quarterRange(2026, 4);
    expect(q4.start).toBe("2026-10-01");
    expect(q4.end).toBe("2026-12-31");
    const q1 = quarterRange(2026, 1);
    expect(q1.start).toBe("2026-01-01");
    expect(q1.end).toBe("2026-03-31");
  });

  it("yearRange spans the full calendar year", () => {
    const y = yearRange(2027);
    expect(y.start).toBe("2027-01-01");
    expect(y.end).toBe("2027-12-31");
  });
});

// ── Statement → period balance sheet ───────────────────────────────────────────

const ACCOUNTS = [
  { id: "acct-checking", nickname: "JCSB Business Checking", accountType: "checking" },
  { id: "acct-savings", nickname: "JCSB Business Savings", accountType: "savings" },
  { id: "acct-cc", nickname: "Capital One Business Card", accountType: "credit_card" },
];

describe("pickLatestClosingBalances", () => {
  it("keeps only statements inside the period, preferring the latest periodEnd per account", () => {
    const statements: StatementSnapshot[] = [
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 100_000, periodEnd: "2026-08-15" },
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 115_000, periodEnd: "2026-08-31" },
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 120_000, periodEnd: "2026-09-30" }, // outside period
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 90_000, periodEnd: "2026-07-31" }, // outside period
    ];
    const period = monthRange(2026, 8);
    const byAccount = pickLatestClosingBalances(statements, period);
    expect(byAccount.get("acct-checking")!.closingBalanceCents).toBe(115_000);
  });

  it("ignores statements with null closing balance; keys unlinked statements by institution + mask", () => {
    const statements: StatementSnapshot[] = [
      { accountId: null, accountMask: "9999", institutionName: "JCSB", closingBalanceCents: 100_000, periodEnd: "2026-08-31" },
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: null, periodEnd: "2026-08-31" },
      { accountId: null, accountMask: null, institutionName: null, closingBalanceCents: 50_000, periodEnd: "2026-08-31" },
    ];
    const period = monthRange(2026, 8);
    const byAccount = pickLatestClosingBalances(statements, period);
    // null-balance statement excluded; two distinct unlinked keys kept
    expect(byAccount.size).toBe(2);
    expect(byAccount.get("unlinked:JCSB:9999")!.closingBalanceCents).toBe(100_000);
    expect(byAccount.get("unlinked::")!.closingBalanceCents).toBe(50_000);
  });
});

describe("buildPeriodBalanceSheet", () => {
  it("classifies accounts by accountType and computes totals in cents", () => {
    const statements: StatementSnapshot[] = [
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 1_250_000, periodEnd: "2026-08-31" },
      { accountId: "acct-savings", accountMask: "5678", institutionName: "JCSB", closingBalanceCents: 800_000, periodEnd: "2026-08-31" },
      { accountId: "acct-cc", accountMask: "9999", institutionName: "Capital One", closingBalanceCents: 320_000, periodEnd: "2026-08-31" },
    ];
    const result = buildPeriodBalanceSheet(statements, ACCOUNTS, monthRange(2026, 8));

    expect(result.hasData).toBe(true);
    expect(result.assets).toHaveLength(2);
    expect(result.liabilities).toHaveLength(1);
    expect(result.totalAssetsCents).toBe(2_050_000);
    expect(result.totalLiabilitiesCents).toBe(320_000);
    expect(result.equityCents).toBe(2_050_000 - 320_000);
  });

  it("treats statements without a linked account as assets labeled by institution + mask", () => {
    const statements: StatementSnapshot[] = [
      { accountId: null, accountMask: "4444", institutionName: "JCSB", closingBalanceCents: 50_000, periodEnd: "2026-08-31" },
    ];
    const result = buildPeriodBalanceSheet(statements, ACCOUNTS, monthRange(2026, 8));

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.label).toBe("JCSB ···4444");
    expect(result.totalAssetsCents).toBe(50_000);
  });

  it("returns empty sheet with hasData=false when no statements match the period", () => {
    const statements: StatementSnapshot[] = [
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 100_000, periodEnd: "2026-07-31" },
    ];
    const result = buildPeriodBalanceSheet(statements, ACCOUNTS, monthRange(2026, 8));

    expect(result.hasData).toBe(false);
    expect(result.assets).toHaveLength(0);
    expect(result.liabilities).toHaveLength(0);
    expect(result.equityCents).toBe(0);
  });

  it("handles negative balances (overdraft) as signed cents", () => {
    const statements: StatementSnapshot[] = [
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: -15_000, periodEnd: "2026-08-31" },
    ];
    const result = buildPeriodBalanceSheet(statements, ACCOUNTS, monthRange(2026, 8));
    expect(result.totalAssetsCents).toBe(-15_000);
    expect(result.equityCents).toBe(-15_000);
  });

  it("normalizes a liability's signed closing balance so equity is reduced, not inflated (matches lib/reports.ts computeBalanceSheet and actions/net-worth.ts computeNetWorth, which both Math.abs() liability balances before subtracting)", () => {
    // Per lib/bank-statement-extract.ts's own STATEMENT_PROMPT: "All dollar amounts in
    // integer cents (negative = negative balance, e.g. credit cards)." — a card with
    // $3,200 owed is expected to be extracted as closingBalanceCents = -320_000.
    const statements: StatementSnapshot[] = [
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 1_000_000, periodEnd: "2026-08-31" }, // $10,000 checking
      { accountId: "acct-cc", accountMask: "9999", institutionName: "Capital One", closingBalanceCents: -320_000, periodEnd: "2026-08-31" }, // $3,200 owed
    ];
    const result = buildPeriodBalanceSheet(statements, ACCOUNTS, monthRange(2026, 8));

    expect(result.totalAssetsCents).toBe(1_000_000);
    // A $3,200 debt must reduce equity, not add to it: 10,000 - 3,200 = 6,800.
    expect(result.totalLiabilitiesCents).toBe(320_000);
    expect(result.equityCents).toBe(680_000);
  });

  it("uses the latest statement when a monthly and quarterly statement both cover period end", () => {
    const statements: StatementSnapshot[] = [
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 300_000, periodEnd: "2026-09-30" }, // quarterly stmt
      { accountId: "acct-checking", accountMask: "1234", institutionName: "JCSB", closingBalanceCents: 280_000, periodEnd: "2026-08-31" }, // monthly stmt
    ];
    const q3 = buildPeriodBalanceSheet(statements, ACCOUNTS, quarterRange(2026, 3));
    expect(q3.assets[0]!.balanceCents).toBe(300_000);

    const aug = buildPeriodBalanceSheet(statements, ACCOUNTS, monthRange(2026, 8));
    expect(aug.assets[0]!.balanceCents).toBe(280_000);
  });
});