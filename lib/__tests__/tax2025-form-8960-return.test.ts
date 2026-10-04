// Form 8960 through the whole return: line 17 = Schedule 2 line 12 = part of Form 1040 line 23, the forms-required verdict,
// the advisories, the provisional (fill) pass and the CPA-statement gate (niit_other).

import { describe, expect, it } from "vitest";
import { computeFormsRequired, computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const st = (r: Ty2025Return, k: LineKey): string | undefined => r.lines[k]?.status;

/** AGI over 250,000: Eric's wages raised by 100,000 (fullFacts has interest 500, dividends 1,000 and a 50,000 Schedule C profit). */
function over(itemize: boolean): Ty2025Facts {
  const f = fullFacts();
  f.income.w2s[0]!.wagesCents = 19_000_000;
  f.income.w2s[0]!.socialSecurityWagesCents = 17_610_000;
  f.income.w2s[0]!.medicareWagesCents = 19_000_000;
  f.deductions.mortgages[0]!.interestCents = itemize ? 4_000_000 : 100_000;
  return f;
}

describe("Form 8960 through the return", () => {
  it("standard deduction: line 9b is 0, line 12 = 1,500, line 17 = 57 = Schedule 2 line 12, and Form 1040 line 23 includes it", () => {
    const r = computeTy2025Return(over(false));
    expect((amt(r, "f1040.11a") ?? 0) > 250000).toBe(true);
    expect([amt(r, "f8960.1"), amt(r, "f8960.2"), amt(r, "f8960.4c"), amt(r, "f8960.5d")]).toEqual([500, 1000, 0, 0]);
    expect([amt(r, "f8960.8"), amt(r, "f8960.9b"), amt(r, "f8960.nii")]).toEqual([1500, 0, 1500]);
    expect(amt(r, "f8960.niit")).toBe(57); // 1,500 x 3.8% = 57.0
    expect(amt(r, "sch2.12")).toBe(57);
    expect(amt(r, "sch2.21") ?? 0).toBeGreaterThanOrEqual(57);
    expect(amt(r, "f1040.23")).toBe(amt(r, "sch2.21"));
    expect(r.formsRequired.f8960?.required).toBe(true);
    expect(r.openItems.some((o) => o.id === "niit-allocation-9b")).toBe(false);
  });

  it("itemizing: line 9b = CT income tax withheld (Schedule A line 5a) x line 8 / AGI; the allocation advisory shows the no-allocation tax", () => {
    const r = computeTy2025Return(over(true));
    const agi = amt(r, "f1040.11a") ?? 0;
    const a5a = amt(r, "scha.5a") ?? 0;
    expect(a5a).toBeGreaterThan(0);
    expect(amt(r, "f8960.9b")).toBe(Math.round((a5a * 1500) / agi));
    expect(amt(r, "f8960.9d")).toBe(amt(r, "f8960.9b"));
    expect(amt(r, "f8960.nii")).toBe(1500 - (amt(r, "f8960.9b") ?? 0));
    const item = r.openItems.find((o) => o.id === "niit-allocation-9b");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("any reasonable method");
    expect(item?.message).toContain("With no allocation (line 9b = 0) line 17 would be $57");
  });

  it("the Schedule C result is reversed on line 4b (a non-passive trade or business) and the assumption is an advisory for the CPA", () => {
    const r = computeTy2025Return(over(false));
    expect(amt(r, "f8960.4a")).toBe(50000);
    expect(amt(r, "f8960.4b")).toBe(-50000);
    expect(amt(r, "f8960.4c")).toBe(0);
    const item = r.openItems.find((o) => o.id === "niit-sch-c-nonpassive");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("materially participates");
  });

  it("MAGI not over the threshold: NIIT 0, the form is not required, no advisory, and nothing blocks", () => {
    const r = computeTy2025Return(fullFacts());
    expect((amt(r, "f1040.11a") ?? 0) < 250000).toBe(true);
    expect([amt(r, "f8960.15"), amt(r, "f8960.niit"), amt(r, "sch2.12")]).toEqual([0, 0, 0]);
    expect(r.formsRequired.f8960?.required).toBe(false);
    expect(r.openItems.some((o) => o.id.startsWith("niit-"))).toBe(false);
    expect(r.openItems.filter((o) => o.severity === "blocking")).toEqual([]);
  });

  it("an unanswered niit_other statement blocks the tax over the threshold (rule:niit-8960) but not under it", () => {
    const f = over(false);
    delete f.statedNone.niit_other;
    const r = computeTy2025Return(f);
    expect(st(r, "f8960.niit")).toBe("missing_input");
    expect(st(r, "sch2.12")).toBe("missing_input");
    expect(r.openItems.find((o) => o.id === "rule:niit-8960")?.severity).toBe("blocking");
    expect(r.formsRequired.f8960?.required).toBe("blocking"); // line 8 waits for the statement too
    // the provisional estimate assumes none and says so
    expect(r.headline.provisional?.assumedFacts.join(" ")).toContain("Form 8960 lines 6, 7 and 10");
    expect(r.headline.provisional?.lines["sch2.12"]).toBe(57);
    // under the threshold the statement is never asked
    const under = fullFacts();
    delete under.statedNone.niit_other;
    expect(computeTy2025Return(under).openItems.filter((o) => o.severity === "blocking")).toEqual([]);
  });

  it("answering Yes to the niit_other statement is a CPA matter on lines 6, 7, 10 and the tax", () => {
    const f = over(false);
    f.statedNone.niit_other = owner(false);
    const r = computeTy2025Return(f);
    expect(st(r, "f8960.6")).toBe("needs_cpa_judgment");
    expect(st(r, "f8960.niit")).toBe("needs_cpa_judgment");
  });

  it("the answers-driven fixture agrees: stated none on every group, MAGI over the threshold", () => {
    const f = fullFacts1b();
    f.income.w2s[0]!.wagesCents = 19_000_000;
    f.returnAnswers.magiExclusionsNone = owner(true);
    const r = computeTy2025Return(f);
    expect((amt(r, "f1040.11a") ?? 0) > 250000).toBe(true);
    expect(st(r, "f8960.niit")).toBe("computed");
    expect(r.openItems.filter((o) => o.severity === "blocking").map((o) => o.id)).toEqual([]);
  });
});

describe("formsRequired.f8960", () => {
  const verdict = (agi: number | null, line8: number | null) => {
    const f = fullFacts();
    const lines = {
      "f8960.15": { status: agi === null ? "missing_input" : "computed", amount: agi === null ? null : Math.max(0, agi - 250000) },
      "f8960.8": { status: line8 === null ? "missing_input" : "computed", amount: line8 },
    };
    return computeFormsRequired({ lines: lines as never, results: [], decisions: [] }, f).f8960;
  };
  it("over the threshold with investment income: required, even when the tax rounds to 0 (MAGI 250,001)", () => {
    expect(verdict(250001, 6699)?.required).toBe(true);
  });
  it("MAGI not over the threshold: not required; no investment income: not required", () => {
    expect(verdict(250000, 6699)?.required).toBe(false);
    expect(verdict(300000, 0)?.required).toBe(false);
    expect(verdict(300000, -1500)?.required).toBe(false);
  });
  it("MAGI not final: blocking; over the threshold but line 8 unresolved: blocking", () => {
    expect(verdict(null, 100)?.required).toBe("blocking");
    expect(verdict(300000, null)?.required).toBe("blocking");
  });
});
