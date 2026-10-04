// Unit tests for the CT-1040 derived-line rules (ty2025-ct1040-derived-lines): the credit gates for lines 7 / 13 / 20a-20d
// (rules/ct-credits.ts), the Schedule 3 detail lines and phase-out handling (rules/ct.ts), and lines 25 / 27-30
// (rules/ct-settlement.ts).
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { K } from "@/lib/tax2025/constants";
import { NONE_GROUP_TEXT, type LineKey } from "@/lib/tax2025/line-catalog";
import { D } from "@/lib/tax2025/money";
import { CT_CREDIT_LINES, computeCtOtherCredits } from "@/lib/tax2025/rules/ct-credits";
import { computeCtSettlement } from "@/lib/tax2025/rules/ct-settlement";
import { computeCtPropertyTaxCredit, type CtCreditBill } from "@/lib/tax2025/rules/ct";
import type { RuleResult } from "@/lib/tax2025/types";

function line(r: RuleResult, key: LineKey) {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`rule did not emit ${key}`);
  return l;
}
const amt = (r: RuleResult, key: LineKey): string | null => {
  const l = line(r, key);
  return l.amount === null ? null : l.amount.toString();
};

describe("computeCtOtherCredits (lines 7, 13, 20a-20d)", () => {
  const base = { otherStateTax: true, otherCredits: true, nonCtStateWithholdingPresent: false };

  it("both stated none: every line is a not_applicable 0 carrying the statement", () => {
    const r = computeCtOtherCredits(base);
    expect(r.status).toBe("not_applicable");
    expect(r.lines.map((l) => l.key).sort()).toEqual([...CT_CREDIT_LINES].sort());
    for (const l of r.lines) {
      expect(l.status, l.key).toBe("not_applicable");
      expect(l.amount?.toString(), l.key).toBe("0");
    }
    expect(line(r, "ct1040.7").reason).toContain(NONE_GROUP_TEXT.ct_other_state_tax);
    expect(line(r, "ct1040.13").reason).toContain(NONE_GROUP_TEXT.ct_other_credits);
  });

  it("unanswered: missing_input (blocking), no amount, one reason per question, never a 0", () => {
    const r = computeCtOtherCredits({ ...base, otherStateTax: undefined, otherCredits: undefined });
    expect(r.status).toBe("missing_input");
    for (const l of r.lines) {
      expect(l.status, l.key).toBe("missing_input");
      expect(l.amount, l.key).toBeNull();
    }
    expect(r.reasons).toHaveLength(2);
    expect(r.reasons[0]).toContain("needs an owner / CPA statement");
    expect(r.inputsMissing).toHaveLength(2);
  });

  it("only one question unanswered: only its lines are blocked", () => {
    const r = computeCtOtherCredits({ ...base, otherCredits: undefined });
    expect(line(r, "ct1040.7").status).toBe("not_applicable");
    for (const k of ["ct1040.13", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"] as const) expect(line(r, k).status, k).toBe("missing_input");
  });

  it("answered Yes: needs_cpa_judgment (amounts are not computed), no amount", () => {
    const r = computeCtOtherCredits({ ...base, otherCredits: false });
    expect(r.status).toBe("needs_cpa_judgment");
    for (const k of ["ct1040.13", "ct1040.20a", "ct1040.20b", "ct1040.20c", "ct1040.20d"] as const) {
      expect(line(r, k).status, k).toBe("needs_cpa_judgment");
      expect(line(r, k).amount, k).toBeNull();
      expect(line(r, k).reason, k).toContain("not computed here");
    }
    expect(line(r, "ct1040.7").status).toBe("not_applicable");
    const yes7 = computeCtOtherCredits({ ...base, otherStateTax: false });
    expect(line(yes7, "ct1040.7").status).toBe("needs_cpa_judgment");
  });

  it("a W-2 with another state's withholding sends line 7 to the CPA even when the owner stated none", () => {
    const r = computeCtOtherCredits({ ...base, nonCtStateWithholdingPresent: true });
    expect(line(r, "ct1040.7").status).toBe("needs_cpa_judgment");
    expect(line(r, "ct1040.7").reason).toContain("a state other than Connecticut");
    expect(line(r, "ct1040.13").status).toBe("not_applicable");
    expect(r.status).toBe("needs_cpa_judgment");
  });

  it("refs are attached to the lines of their own question", () => {
    const refs = { otherStateTax: [{ kind: "answer" as const, id: "q7", label: "answer" }], otherCredits: [{ kind: "answer" as const, id: "q13", label: "answer" }] };
    const r = computeCtOtherCredits({ ...base, refs });
    expect(line(r, "ct1040.7").refs?.[0]?.id).toBe("q7");
    expect(line(r, "ct1040.20d").refs?.[0]?.id).toBe("q13");
  });
});

describe("Schedule 3 detail lines (63 / 65 / 67) and line 11", () => {
  const bill = (kind: CtCreditBill["kind"], paid: string | null, label = "bill"): CtCreditBill => ({ docId: `b-${label}`, label, kind, paid: paid === null ? null : D(paid) });
  const run = (ctAgi: number, bills: CtCreditBill[], tax: number | null = 9000) =>
    computeCtPropertyTaxCredit({ ctAgi: D(ctAgi), bills, ctTaxBeforeCredits: tax === null ? null : D(tax) });
  const s3 = (r: RuleResult) => [amt(r, "ct1040.s3.63"), amt(r, "ct1040.s3.65"), amt(r, "ct1040.s3.67"), amt(r, "ct1040.11")];

  it("decimal 0 (CT AGI 70,500): 63 = paid, 65 = min(63, 300), 67 = 0, credit = 65", () => {
    expect(s3(run(70500, [bill("primary_residence", "4000")]))).toEqual(["4000", "300", "0", "300"]);
    expect(s3(run(70500, [bill("primary_residence", "120")]))).toEqual(["120", "120", "0", "120"]);
  });

  it("partial decimal (CT AGI 125,000 -> .90): credit 300 - 270 = 30", () => {
    const r = run(125000, [bill("primary_residence", "4000")]);
    expect(s3(r)).toEqual(["4000", "300", "270", "30"]);
    expect(r.conclusion).toBe("partial");
  });

  it("form-order rounding: 65 = 10 and decimal .15 give 67 = round(1.5) = 2 and 68 = 8 (not 10 x .85 = 8.5 -> 9)", () => {
    const r = run(75000, [bill("primary_residence", "10")]);
    expect(s3(r)).toEqual(["10", "10", "2", "8"]);
  });

  it("line 63 adds the printed whole-dollar rows: 1000.50 + 100.50 = 1,001 + 101 = 1,102 (not 1,101)", () => {
    const r = run(70500, [bill("primary_residence", "1000.50", "home"), bill("motor_vehicle", "100.50", "car")], 9000);
    expect(amt(r, "ct1040.s3.63")).toBe("1102");
    // two bills on the home are ONE row, added in cents first and rounded once
    const home = run(70500, [bill("primary_residence", "500.25", "a"), bill("primary_residence", "500.25", "b")]);
    expect(amt(home, "ct1040.s3.63")).toBe("1001");
  });

  it("only the two largest vehicles are rows; other real estate is excluded", () => {
    const r = run(70500, [bill("motor_vehicle", "100", "a"), bill("motor_vehicle", "90", "b"), bill("motor_vehicle", "80", "c"), bill("other_real_estate", "3000", "arbor")]);
    expect(amt(r, "ct1040.s3.63")).toBe("190");
    expect(r.reasons.join(" ")).toContain("arbor");
  });

  it("fully phased out (CT AGI 270,980): 63 / 65 / 67 not_applicable 0, line 11 a computed 0, reason says why", () => {
    const r = run(270980, [bill("primary_residence", "6000")]);
    for (const k of ["ct1040.s3.63", "ct1040.s3.65", "ct1040.s3.67"] as const) {
      expect(line(r, k).status, k).toBe("not_applicable");
      expect(amt(r, k), k).toBe("0");
    }
    expect(line(r, "ct1040.11").status).toBe("computed");
    expect(amt(r, "ct1040.11")).toBe("0");
    expect(line(r, "ct1040.s3.63").reason).toContain("fully phased out");
    expect(`${K.CT_PROPERTY_TAX_CREDIT_PHASEOUT_MFJ.value.at(-2)?.upTo}`).toBe("130500");
  });

  it("line 10 = 0: the form skips lines 11 and 12; Schedule 3 is not_applicable", () => {
    const r = run(70500, [bill("primary_residence", "4000")], 0);
    expect(amt(r, "ct1040.11")).toBe("0");
    expect(line(r, "ct1040.s3.63").status).toBe("not_applicable");
    expect(line(r, "ct1040.11").reason).toContain("skip lines 11 and 12");
  });

  it("the credit is limited to line 10 (68 then differs from 65 - 67; the reason says so)", () => {
    const r = run(70500, [bill("primary_residence", "4000")], 50);
    expect(amt(r, "ct1040.11")).toBe("50");
    expect(r.reasons.join(" ")).toContain("Limited to the CT income tax");
  });

  it("unclassified / unpaid bills, unknown line 10 and unknown CT AGI block every Schedule 3 line (missing_input)", () => {
    const cases: RuleResult[] = [
      run(70000, [bill("unclassified", "4000")]),
      run(70000, [bill("primary_residence", null)]),
      run(70000, [bill("primary_residence", "4000")], null),
      computeCtPropertyTaxCredit({ ctAgi: null, bills: [], ctTaxBeforeCredits: null }),
    ];
    for (const r of cases) {
      expect(r.status).toBe("missing_input");
      for (const k of ["ct1040.11", "ct1040.s3.63", "ct1040.s3.65", "ct1040.s3.67"] as const) {
        expect(line(r, k).status, k).toBe("missing_input");
        expect(line(r, k).amount, k).toBeNull();
      }
    }
  });

  it("every branch emits all four keys exactly once", () => {
    const rs = [run(70500, [bill("primary_residence", "100")]), run(270980, []), run(70500, [bill("primary_residence", "100")], 0), run(70000, [bill("unclassified", "1")])];
    for (const r of rs) expect(r.lines.map((l) => l.key).sort()).toEqual(["ct1040.11", "ct1040.s3.63", "ct1040.s3.65", "ct1040.s3.67"]);
  });
});

describe("computeCtSettlement (lines 25, 27, 28, 29, 30)", () => {
  const input = (over: Partial<Record<"line14" | "line18" | "line20c" | "line22" | "line26", number>> = {}) => ({
    line14: D(over.line14 ?? 14609),
    line18: D(over.line18 ?? 15591),
    line20c: D(over.line20c ?? 0),
    line22: D(over.line22 ?? 982),
    line26: D(over.line26 ?? 0),
  });
  const keys: LineKey[] = ["ct1040.25", "ct1040.27", "ct1040.28", "ct1040.29", "ct1040.30"];

  it("Eric's overpayment: 25 informational with line 22's amount and the rule; 27-29 are 0; 30 is 0", () => {
    const r = computeCtSettlement(input());
    expect(r.lines.map((l) => l.key).sort()).toEqual([...keys].sort());
    const l25 = line(r, "ct1040.25");
    expect(l25.status).toBe("not_yet_computed");
    expect(l25.informational).toBe(true);
    expect(l25.reason).toContain("$982");
    expect(l25.reason).toContain("line 22 less lines 23, 24 and 24a");
    for (const k of ["ct1040.27", "ct1040.28", "ct1040.29"] as const) expect(line(r, k).status, k).toBe("not_applicable");
    expect(amt(r, "ct1040.30")).toBe("0");
    expect(r.status).toBe("computed");
  });

  it("no overpayment: 25 is a not_applicable 0", () => {
    expect(line(computeCtSettlement(input({ line22: 0, line26: 100 })), "ct1040.25").status).toBe("not_applicable");
  });

  it("tax due: 27 / 28 are informational needs_cpa_rule_unverified; 30 waits (informational)", () => {
    const r = computeCtSettlement(input({ line22: 0, line26: 400, line18: 14500 }));
    for (const k of ["ct1040.27", "ct1040.28"] as const) {
      expect(line(r, k).status, k).toBe("needs_cpa_rule_unverified");
      expect(line(r, k).informational, k).toBe(true);
      expect(line(r, k).amount, k).toBeNull();
    }
    expect(line(r, "ct1040.30").amount).toBeNull();
    expect(line(r, "ct1040.30").informational).toBe(true);
    expect(r.status).not.toBe("needs_cpa_rule_unverified"); // informational lines never decide the rule status
  });

  it("line 29 threshold: 14 - 18 - 20c under 1,000 is 0 (CT-2210), 1,000 or more is informational", () => {
    const min = K.CT_ESTIMATED_TAX_INTEREST_MIN.value;
    expect(min).toBe(1000);
    const under = computeCtSettlement(input({ line14: 10999, line18: 10000, line22: 0, line26: 999 }));
    expect(line(under, "ct1040.29").status).toBe("not_applicable");
    expect(line(under, "ct1040.29").reason).toContain("Form CT-2210 Part 2 line 4");
    const at = computeCtSettlement(input({ line14: 11000, line18: 10000, line22: 0, line26: 1000 }));
    expect(line(at, "ct1040.29").status).toBe("needs_cpa_rule_unverified");
    expect(line(at, "ct1040.29").informational).toBe(true);
    expect(line(at, "ct1040.29").reason).toContain("may leave line 29 blank");
    // line 20c (pass-through entity tax credit) counts like withholding
    const withPe = computeCtSettlement(input({ line14: 11000, line18: 10000, line20c: 1, line22: 0, line26: 1000 }));
    expect(line(withPe, "ct1040.29").status).toBe("not_applicable");
  });

  it("line 30 = 26 + 27 + 28 + 29 once every part is a 0 (an overpayment return: 0)", () => {
    const r = computeCtSettlement(input({ line22: 0, line26: 0, line14: 100, line18: 100 }));
    expect(amt(r, "ct1040.30")).toBe("0");
    expect(new Decimal(amt(r, "ct1040.27") ?? "x").isZero()).toBe(true);
  });
});
