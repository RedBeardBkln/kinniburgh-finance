// Whole-return behavior of CT-1040 Schedule 1 (rules/ct-schedule1.ts wired by return.ts) and of the Form 1098 box 5
// mortgage insurance advisory (ty2025-mip-ct-schedule1).
import { describe, expect, it } from "vitest";
import { TY2025_ENGINE_VERSION, computeTy2025Return, duplicateEmissions } from "@/lib/tax2025/return";
import { CT_SCH1_GROUPS } from "@/lib/tax2025/rules/ct-schedule1";
import { missingLeaf, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts1b, interest, owner } from "@/lib/__tests__/tax2025-fixtures";
import type { Ty2025Facts } from "@/lib/tax2025/facts";

const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const st = (r: Ty2025Return, k: LineKey): string | undefined => r.lines[k]?.status;
const item = (r: Ty2025Return, id: string) => r.openItems.find((o) => o.id === id);

/** fullFacts1b() with the Schedule 1 "other" overrides removed so the six statements decide lines 37 / 49. */
function s1Facts(): Ty2025Facts {
  const f = fullFacts1b();
  f.ct.additions = missingLeaf();
  f.ct.subtractions = missingLeaf();
  return f;
}

describe("engine version", () => {
  it("is ty2025-1b.6 (Form 8995 loss carryforward on lines 16 / 17, Form 6251 lines 1a / 1b / 2a, Schedule A line 14 adds the printed lines)", () => {
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.6");
  });
});

describe("all six statements none and the documents are zero", () => {
  const f = s1Facts();
  const ret = computeTy2025Return(f);
  it("totals are 0, CT AGI = federal AGI, CT tax computed, the headline is complete", () => {
    expect(amt(ret, "ct1040.additions")).toBe(0);
    expect(amt(ret, "ct1040.subtractions")).toBe(0);
    expect(amt(ret, "ct1040.ctAgi")).toBe(amt(ret, "f1040.11a"));
    expect(st(ret, "ct1040.6")).toBe("computed");
    expect(ret.headline.connecticut.balance.amount).toBe(4588);
    expect(ret.headline.complete).toBe(true);
    expect(item(ret, "rule:ct-schedule1")).toBeUndefined();
  });
  it("every detail line is explicit (computed or not_applicable 0) and no key is emitted twice", () => {
    for (const k of Object.keys(ret.lines).filter((x) => x.startsWith("ct1040.s1.")) as LineKey[]) {
      expect(["computed", "not_applicable"], k).toContain(st(ret, k));
      expect(amt(ret, k), k).toBe(0);
    }
    expect(duplicateEmissions(f)).toEqual([]);
  });
});

describe("one statement unanswered", () => {
  const f = s1Facts();
  delete f.statedNone.ct_us_gov_funds;
  const ret = computeTy2025Return(f);
  it("blocks the Schedule 1 rule with an item naming the question; line 40, the totals, CT AGI, tax and balance are blocked (never 0)", () => {
    const it1 = item(ret, "rule:ct-schedule1");
    expect(it1?.severity).toBe("blocking");
    expect(it1?.message).toContain("U.S. government bond funds");
    expect(it1?.action).toContain("U.S. government bond funds");
    expect(st(ret, "ct1040.s1.40")).toBe("missing_input");
    for (const k of ["ct1040.subtractions", "ct1040.ctAgi", "ct1040.6", "ct1040.9", "ct1040.10", "ct1040.11", "ct1040.balance"] as const) {
      expect(amt(ret, k), k).toBeNull();
      expect(["computed", "not_applicable"], k).not.toContain(st(ret, k));
    }
    // additions do not depend on the missing statement: that total is still a number
    expect(amt(ret, "ct1040.additions")).toBe(0);
    expect(item(ret, "rule:ct-tax")?.severity).toBe("blocking");
    expect(item(ret, "rule:ct-property-tax-credit")?.severity).toBe("blocking");
    expect(ret.headline.complete).toBe(false);
  });
  it("the provisional estimate still computes CT AGI and tax and lists line 40 as assumed $0", () => {
    const p = ret.headline.provisional!;
    expect(p).not.toBeNull();
    expect(p.assumedZeroLines).toContain("ct1040.s1.40");
    expect(p.ctTax).not.toBeNull();
    expect(p.ctBalance).not.toBeNull();
  });
});

describe("no statements at all", () => {
  it("every statement-driven line is missing_input and the item lists the questions it needs", () => {
    const f = s1Facts();
    for (const g of CT_SCH1_GROUPS) delete f.statedNone[g];
    const ret = computeTy2025Return(f);
    const msg = item(ret, "rule:ct-schedule1")?.message ?? "";
    for (const name of ["Connecticut bond sales", "U.S. government bond funds", "CHET and ABLE accounts", "earlier Connecticut depreciation add-backs", "other Connecticut additions", "other Connecticut subtractions"]) {
      expect(msg, name).toContain(name);
    }
    expect(amt(ret, "ct1040.additions")).toBeNull();
    expect(st(ret, "ct1040.ctAgi")).toBe("missing_input");
  });
});

describe("a stated Other total (lines 37 / 49) overrides the statements", () => {
  it("override 0 for both with every statement absent: computed; a positive override moves CT AGI and raises the 'Other - specify' advisory", () => {
    const f = s1Facts();
    for (const g of CT_SCH1_GROUPS) delete f.statedNone[g];
    f.ct.additions = owner(0);
    f.ct.subtractions = owner(0);
    expect(computeTy2025Return(f).lines["ct1040.s1.37"]?.status).toBe("computed");
    // the other detail lines (35, 40, 47, 48 ...) still need their statements
    expect(computeTy2025Return(f).lines["ct1040.s1.40"]?.status).toBe("missing_input");

    const g = s1Facts();
    g.ct.additions = owner(200_000);
    g.ct.subtractions = owner(50_000);
    const r = computeTy2025Return(g);
    expect(amt(r, "ct1040.additions")).toBe(2000);
    expect(amt(r, "ct1040.subtractions")).toBe(500);
    expect(amt(r, "ct1040.ctAgi")).toBe((amt(r, "f1040.11a") ?? 0) + 2000 - 500);
    expect(item(r, "ct-schedule1-other-specify")?.severity).toBe("advisory");
    expect(item(r, "ct-schedule1-other-specify")?.message).toContain("line 37 and line 49");
    // an advisory never counts as blocking
    expect(r.headline.blockingItemCount).toBe(0);
  });
});

describe("document-derived lines", () => {
  it("1099-INT box 3 = 50.00 -> line 39 = 50, federal 2b includes it, CT AGI = federal AGI - 50", () => {
    const f = s1Facts();
    const plain = computeTy2025Return(f);
    f.income.interest = [interest({ docId: "int-1", box1Cents: 50_000, box3Cents: 5_000 })];
    const r = computeTy2025Return(f);
    expect(amt(r, "f1040.2b")).toBe(550);
    expect(amt(r, "ct1040.s1.39")).toBe(50);
    expect(amt(r, "ct1040.subtractions")).toBe(50);
    expect(amt(r, "ct1040.ctAgi")).toBe((amt(r, "f1040.11a") ?? 0) - 50);
    expect(amt(plain, "f1040.2b")).toBe(500);
  });
  it("box 3 > 0 without the savings-bond 'none' statement -> line 39 needs_cpa_judgment and the CT AGI is blocked", () => {
    const f = s1Facts();
    f.income.interest = [interest({ docId: "int-1", box1Cents: 50_000, box3Cents: 5_000 })];
    f.statedNone.savings_bond_exclusion = owner(false);
    const r = computeTy2025Return(f);
    expect(st(r, "ct1040.s1.39")).toBe("needs_cpa_judgment");
    expect(amt(r, "ct1040.ctAgi")).toBeNull();
  });
  it("box 8 > 0 -> line 31 needs_cpa_judgment; unread box 8 (null) -> missing_input", () => {
    const f = s1Facts();
    f.income.interest = [interest({ docId: "int-1", box1Cents: 50_000, box8Cents: 12_000 })];
    expect(st(computeTy2025Return(f), "ct1040.s1.31")).toBe("needs_cpa_judgment");
    const g = s1Facts();
    g.income.interest = [interest({ docId: "int-1", box1Cents: 50_000, box8Cents: null })];
    expect(st(computeTy2025Return(g), "ct1040.s1.31")).toBe("missing_input");
  });
  it("exempt-interest dividends > 0 -> line 32 needs_cpa_judgment", () => {
    const f = s1Facts();
    f.income.dividends = f.income.dividends.map((d) => ({ ...d, box11Cents: 4_000 }));
    expect(st(computeTy2025Return(f), "ct1040.s1.32")).toBe("needs_cpa_judgment");
  });
  it("no interest documents and no 'no interest' confirmation -> lines 31 and 39 missing_input (not zero)", () => {
    const f = s1Facts();
    f.income.interest = [];
    const r = computeTy2025Return(f);
    expect(st(r, "ct1040.s1.31")).toBe("missing_input");
    expect(st(r, "ct1040.s1.39")).toBe("missing_input");
    f.income.noInterestConfirmed = owner(true);
    const known = computeTy2025Return(f);
    expect(st(known, "ct1040.s1.31")).toBe("computed");
    expect(amt(known, "ct1040.s1.39")).toBe(0);
  });
});

describe("federal lines feeding Schedule 1", () => {
  it("a fixed asset on the register -> 36 / 36a not_yet_computed (Form 4562 is not built) and the CT AGI is blocked", () => {
    const f = s1Facts();
    f.income.scheduleC.fixedAssets = [
      { id: "fa-1", description: "Barn", placedInServiceIso: "2025-07-01", costBasisCents: 5_000_000, isRealProperty: true, landValueCents: 500_000, businessUsePercent: 25 },
    ];
    const r = computeTy2025Return(f);
    expect(st(r, "ct1040.s1.36")).toBe("not_yet_computed");
    expect(st(r, "ct1040.s1.36a")).toBe("not_yet_computed");
    expect(r.lines["ct1040.s1.36"]?.reason).toContain("100% of bonus depreciation and 80% of Section 179");
    expect(amt(r, "ct1040.ctAgi")).toBeNull();
  });
  it("other income answered Yes for something other than a refund -> Schedule 1 line 5 is blocked, so 34 / 46 / 36 / 36a go to the CPA", () => {
    const f = s1Facts();
    f.statedNone.other_income = owner(false);
    const r = computeTy2025Return(f);
    for (const k of ["ct1040.s1.34", "ct1040.s1.46", "ct1040.s1.36", "ct1040.s1.36a"] as const) expect(st(r, k), k).toBe("needs_cpa_judgment");
  });
  it("retirement / Social Security answered Yes -> 33 / 41 / 43 / 44 / 45 / 48b needs_cpa_judgment", () => {
    const f = s1Facts();
    f.statedNone.retirement_ss_income = owner(false);
    const r = computeTy2025Return(f);
    for (const k of ["ct1040.s1.33", "ct1040.s1.41", "ct1040.s1.43", "ct1040.s1.44", "ct1040.s1.45", "ct1040.s1.48b"] as const) expect(st(r, k), k).toBe("needs_cpa_judgment");
  });
  it("a 1099-R document present -> the same lines needs_cpa_judgment", () => {
    const f = s1Facts();
    f.income.otherIncomeBoxes = [{ docId: "d1", payer: "Fund", basis: "doc_verified", variant: "1099-R", box: "2a", label: "Taxable amount", amountCents: 100_000 }];
    const r = computeTy2025Return(f);
    for (const k of ["ct1040.s1.33", "ct1040.s1.41", "ct1040.s1.48b"] as const) expect(st(r, k), k).toBe("needs_cpa_judgment");
  });
});

describe("Form 1098 box 5 mortgage insurance (Eric-shaped)", () => {
  function eric(): Ty2025Facts {
    const f = s1Facts();
    f.deductions.mortgages = f.deductions.mortgages.map((m) => ({
      ...m,
      interestCents: 1_888_269,
      principalCents: 37_787_263,
      mortgageInsuranceCents: 122_196,
      pointsCents: 0,
    }));
    return f;
  }
  const ret = computeTy2025Return(eric());
  it("line 8a is the interest (computed), Schedule A and the standard-vs-itemized line are computed, and nothing blocks", () => {
    expect(amt(ret, "scha.8a")).toBe(18883);
    for (const k of ["scha.8e", "scha.10", "scha.17", "f1040.12e"] as const) expect(st(ret, k), k).toBe("computed");
    expect(item(ret, "rule:schedule-a")).toBeUndefined();
    expect(ret.headline.blockingItemCount).toBe(0);
    expect(ret.headline.complete).toBe(true);
  });
  it("an advisory item (not blocking) carries the amount and the Pub. 936 citation", () => {
    const a = item(ret, "scha-mortgage-insurance-not-deductible");
    expect(a?.severity).toBe("advisory");
    expect(a?.message).toContain("$1,221.96");
    expect(a?.message).toContain("Pub. 936 (2025)");
    expect(a?.message).toContain("https://www.irs.gov/publications/p936");
    expect(a?.lineKeys).toEqual(["scha.8a"]);
    expect(a?.refs.length).toBeGreaterThan(0);
  });
  it("box 6 points > 0 still blocks line 8a; no box 5 means no advisory", () => {
    const f = eric();
    f.deductions.mortgages = f.deductions.mortgages.map((m) => ({ ...m, pointsCents: 300_000 }));
    expect(st(computeTy2025Return(f), "scha.8a")).toBe("needs_cpa_rule_unverified");
    const g = eric();
    g.deductions.mortgages = g.deductions.mortgages.map((m) => ({ ...m, mortgageInsuranceCents: 0 }));
    expect(item(computeTy2025Return(g), "scha-mortgage-insurance-not-deductible")).toBeUndefined();
  });
});
