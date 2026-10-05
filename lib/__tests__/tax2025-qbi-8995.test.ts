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

// Form 8995 (2025) lines 3, 4, 7, 8, 16, 17 as printed: line 4 / 8 = "Combine ... If zero or less, enter -0-"; line 16 / 17 =
// "Combine lines 2 and 3 / 6 and 7. If greater than zero, enter -0-" (the carryforward, a loss, printed inside parentheses).
// Hand-computed, synthetic households (engine ty2025-1b.6; specs/09 "Form 8995 loss carryforward").
describe("computeQbi8995: the loss carryforward (lines 3, 4, 7, 8, 16, 17)", () => {
  /** A loss year shaped like the household this engine was built for: Schedule C -9,010, no half-SE tax, no SE health / retirement. */
  const lossYear = (over: Partial<Qbi8995Input> = {}): Qbi8995Input =>
    input({ scheduleCNetProfit: D(-9010), deductibleHalfSeTax: D(0), taxableIncomeBeforeQbi: D(220025), netCapitalGain: D(5557), ...over });

  it("E1 loss year: line 2 = -9,010; 4 = 0; 5 = 0; 13 = 214,468; 14 = 42,894 (20% of 214,468 = 42,893.6); 15 = 0; 16 = -9,010; 17 = 0; line 13a = 0", () => {
    const r = computeQbi8995(lossYear());
    expect(r.status).toBe("computed");
    const got = (["f8995.1i", "f8995.2", "f8995.4", "f8995.5", "f8995.6", "f8995.8", "f8995.9", "f8995.10", "f8995.11", "f8995.12", "f8995.13", "f8995.14", "f8995.15", "f8995.16", "f8995.17", "f1040.13a"] as const).map((k) => amt(r, k));
    expect(got).toEqual(["-9010", "-9010", "0", "0", "0", "0", "0", "0", "220025", "5557", "214468", "42894", "0", "-9010", "0", "0"]);
    expect(r.reasons.join(" ")).toContain("$9,010 carries forward to 2026");
    expect(r.reasons.join(" ")).toContain("negative");
  });

  it("E2 a carry-in is absorbed by the profit: 10,000 + (-3,000) = 7,000 -> 20% = 1,400; line 14 = 10,000; deduction 1,400; line 16 = 0 (greater than zero -> -0-)", () => {
    const r = computeQbi8995(input({ scheduleCNetProfit: D(10000), deductibleHalfSeTax: D(0), taxableIncomeBeforeQbi: D(50000), priorQbiLossCarryforward: D(-3000) }));
    expect(["f8995.2", "f8995.4", "f8995.5", "f8995.13", "f8995.14", "f8995.15", "f8995.16", "f1040.13a"].map((k) => amt(r, k as LineKey))).toEqual([
      "10000", "7000", "1400", "50000", "10000", "1400", "0", "1400",
    ]);
  });

  it("E3 a carry-in larger than the profit: 2,000 + (-5,000) = -3,000 -> line 4 = 0, line 5 = 0, deduction 0, line 16 = -3,000", () => {
    const r = computeQbi8995(input({ scheduleCNetProfit: D(2000), deductibleHalfSeTax: D(0), taxableIncomeBeforeQbi: D(50000), priorQbiLossCarryforward: D(-5000) }));
    expect(["f8995.2", "f8995.4", "f8995.5", "f8995.15", "f8995.16", "f1040.13a"].map((k) => amt(r, k as LineKey))).toEqual(["2000", "0", "0", "0", "-3000", "0"]);
    expect(r.reasons.join(" ")).toContain("$3,000 carries forward to 2026");
    expect(r.reasons.join(" ")).toContain("Carried in from 2024");
  });

  it("E4 a loss plus REIT dividends (the Line 4 instruction): no QBI component, but 20% of the dividends is allowed: 5 = 0; 6 = 1,000; 8 = 1,000; 9 = 200; 15 = 200; 16 = -9,010", () => {
    const r = computeQbi8995(lossYear({ section199aDividends: D(1000) }));
    expect(["f8995.5", "f8995.6", "f8995.8", "f8995.9", "f8995.10", "f8995.15", "f8995.16", "f8995.17", "f1040.13a"].map((k) => amt(r, k as LineKey))).toEqual([
      "0", "1000", "1000", "200", "200", "200", "-9010", "0", "200",
    ]);
  });

  it("E5 REIT / PTP carry-in: line 6 = 300 and line 7 = -200 -> 8 = 100, 9 = 20, 17 = 0; line 6 = 100 and line 7 = -400 -> 8 = 0, 9 = 0, 17 = -300", () => {
    const a = computeQbi8995(input({ section199aDividends: D(300), priorReitPtpLossCarryforward: D(-200) }));
    expect(["f8995.6", "f8995.8", "f8995.9", "f8995.17"].map((k) => amt(a, k as LineKey))).toEqual(["300", "100", "20", "0"]);
    const b = computeQbi8995(input({ section199aDividends: D(100), priorReitPtpLossCarryforward: D(-400) }));
    expect(["f8995.6", "f8995.8", "f8995.9", "f8995.17"].map((k) => amt(b, k as LineKey))).toEqual(["100", "0", "0", "-300"]);
    expect(b.reasons.join(" ")).toContain("2026 Form 8995 line 7");
  });

  it("a profit year with no carry-in leaves lines 16 and 17 at 0 and does not mention a carryforward", () => {
    const r = computeQbi8995(input());
    expect(amt(r, "f8995.16")).toBe("0");
    expect(amt(r, "f8995.17")).toBe("0");
    expect(r.reasons.join(" ")).not.toContain("carries forward");
    expect(amt(r, "f8995.8")).toBe("0");
  });

  it("E6 over the Form 8995 limit and the missing-input branch emit only line 13a (the assembler's `owns` carries the blocking status to 16 / 17)", () => {
    const over = computeQbi8995(lossYear({ taxableIncomeBeforeQbi: D(394601) }));
    expect(over.lines.map((l) => l.key)).toEqual(["f1040.13a"]);
    const missing = computeQbi8995(lossYear({ seHealthInsurance: null }));
    expect(missing.lines.map((l) => l.key)).toEqual(["f1040.13a"]);
  });

  it("cites the carryforward rule", () => {
    expect(computeQbi8995(input()).citations).toContain("QBI_LOSS_CARRYFORWARD_RULE");
  });
});
