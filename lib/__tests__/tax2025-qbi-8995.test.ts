import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import { computeQbi8995, type Qbi8995Input } from "@/lib/tax2025/rules/qbi-8995";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}

function input(over: Partial<Qbi8995Input> = {}): Qbi8995Input {
  return {
    scheduleCNetProfit: D(60000),
    deductibleHalfSeTax: D(804),
    seHealthInsurance: D(0),
    seRetirement: D(0),
    taxableIncomeBeforeQbi: D(100000),
    qualifiedDividends: D(0),
    netCapitalGain: D(0),
    section199aDividends: D(0),
    ...over,
  };
}

// Form 8995 (2025 instructions): line 1 QBI is net of the deductible half of SE tax, SE health insurance and
// retirement contributions; line 5 = 20% of line 4; line 10 = 5 + 9; line 11 taxable income before QBI;
// line 12 net capital gain; line 13 = 11 - 12; line 14 = 20% of 13; line 15 = smaller of 10 or 14.
describe("computeQbi8995 (Form 8995)", () => {
  it("base is net of half the SE tax: 60,000 - 804 = 59,196 -> 20% = 11,839", () => {
    const r = computeQbi8995(input());
    expect(r.status).toBe("computed");
    expect(amt(r, "f8995.4")).toBe("59196");
    expect(amt(r, "f8995.5")).toBe("11839");
    expect(amt(r, "f8995.14")).toBe("20000");
    expect(amt(r, "f8995.15")).toBe("11839");
    expect(amt(r, "f1040.13a")).toBe("11839");
  });

  it("D5: SE health insurance and SE retirement reduce the base (60,000 - 804 - 5,000 - 3,000 = 51,196 -> 10,239)", () => {
    const r = computeQbi8995(input({ seHealthInsurance: D(5000), seRetirement: D(3000) }));
    expect(amt(r, "f8995.4")).toBe("51196");
    expect(amt(r, "f1040.13a")).toBe("10239");
  });

  it("D5: the income limit subtracts net capital gain: TI 30,000, qualified dividends 10,000 -> line 14 = 20% x 20,000 = 4,000", () => {
    const r = computeQbi8995(input({ taxableIncomeBeforeQbi: D(30000), qualifiedDividends: D(10000) }));
    expect(amt(r, "f8995.12")).toBe("10000");
    expect(amt(r, "f8995.13")).toBe("20000");
    expect(amt(r, "f8995.14")).toBe("4000");
    expect(amt(r, "f1040.13a")).toBe("4000");
  });

  it("capital gain distributions also reduce the limit base", () => {
    const r = computeQbi8995(input({ taxableIncomeBeforeQbi: D(30000), qualifiedDividends: D(4000), netCapitalGain: D(6000) }));
    expect(amt(r, "f8995.12")).toBe("10000");
    expect(amt(r, "f1040.13a")).toBe("4000");
  });

  it("section 199A dividends (REIT, 1099-DIV box 5) add 20% on line 6/9: 11,839 + 200 = 12,039", () => {
    const r = computeQbi8995(input({ section199aDividends: D(1000) }));
    expect(amt(r, "f8995.10")).toBe("12039");
    expect(amt(r, "f1040.13a")).toBe("12039");
  });

  it("a Schedule C loss: no deduction (line 4 is 0), explained, still computed", () => {
    const r = computeQbi8995(input({ scheduleCNetProfit: D(-5000), deductibleHalfSeTax: D(0) }));
    expect(r.status).toBe("computed");
    expect(amt(r, "f8995.4")).toBe("0");
    expect(amt(r, "f1040.13a")).toBe("0");
    expect(r.reasons.join(" ")).toContain("negative");
  });

  it("zero or negative taxable income before QBI -> $0 deduction", () => {
    const r = computeQbi8995(input({ taxableIncomeBeforeQbi: D(-1000) }));
    expect(amt(r, "f8995.11")).toBe("0");
    expect(amt(r, "f1040.13a")).toBe("0");
  });

  it("exactly $394,600 may still use Form 8995", () => {
    const r = computeQbi8995(input({ taxableIncomeBeforeQbi: D(394600) }));
    expect(r.status).toBe("computed");
    expect(amt(r, "f1040.13a")).toBe("11839");
  });
});

describe("computeQbi8995: above the Form 8995 limit (X3), no interpolation", () => {
  it("$394,601 -> needs_cpa_judgment, no amount, default 8995-A undecided with both alternatives", () => {
    const r = computeQbi8995(input({ taxableIncomeBeforeQbi: D(394601) }));
    expect(r.status).toBe("needs_cpa_judgment");
    expect(amt(r, "f1040.13a")).toBeNull();
    expect(r.decision).toMatchObject({ id: "X3", chosen: "8995a", status: "default_undecided" });
    expect(r.alternatives?.map((a) => a.id)).toEqual(["8995", "8995a"]);
    expect(r.alternatives?.find((a) => a.id === "8995a")?.inForce).toBe(true);
    expect(r.inputsMissing).toContain("UBIA of qualified property");
  });

  it("$450,000 (inside the old phase-in band) is NOT interpolated", () => {
    const r = computeQbi8995(input({ taxableIncomeBeforeQbi: D(450000) }));
    expect(r.status).toBe("needs_cpa_judgment");
    expect(amt(r, "f1040.13a")).toBeNull();
    expect(r.reasons.join(" ")).toContain("no phase-in is interpolated");
  });

  it("a recorded decision is carried on the result", () => {
    const r = computeQbi8995(input({ taxableIncomeBeforeQbi: D(500000), decision: { chosen: "8995a", by: "cpa", at: "2026-10-06T00:00:00Z" } }));
    expect(r.decision).toMatchObject({ status: "decided", decidedBy: "cpa" });
  });
});

describe("computeQbi8995: missing inputs", () => {
  it("SE health insurance not stated -> missing_input (never assumed 0)", () => {
    const r = computeQbi8995(input({ seHealthInsurance: null }));
    expect(r.status).toBe("missing_input");
    expect(amt(r, "f1040.13a")).toBeNull();
    expect(r.inputsMissing[0]).toContain("health insurance");
  });
  it("missing Schedule C net profit -> missing_input", () => {
    expect(computeQbi8995(input({ scheduleCNetProfit: null })).status).toBe("missing_input");
  });
});
