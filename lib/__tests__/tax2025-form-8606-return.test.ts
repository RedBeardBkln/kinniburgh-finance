// Form 8606 through the return (engine ty2025-1b.8): Eric's shape (7,000 traditional contribution, he is not covered at work, Eva is, MAGI over
// the 246,000 cut-off), the statements that gate lines 2 and 14, forms required, provenance on the lines, the review sheet's document index,
// and that no tax number moves. Pure.

import { describe, expect, it } from "vitest";
import { computeTy2025Return, duplicateEmissions, TY2025_ENGINE_VERSION } from "@/lib/tax2025/return";
import { type Ty2025Facts } from "@/lib/tax2025/facts";
import { LINE_KEYS, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { ERIC_ID, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

const DOC_ID = "ba3c7bda-5498";

/** Eric's shape: Eric (a) not covered at work and 7,000 traditional; Eva (b) covered; Eric's wages raised so the MAGI is far over 246,000. */
function ericFacts(over: { traditionalCents?: number; fmvCents?: number | null; withStatement?: boolean; priorBasisCents?: number | null } = {}): Ty2025Facts {
  const f = fullFacts1b();
  const [a, b] = f.returnAnswers.people;
  a!.traditionalIraCents = owner(over.traditionalCents ?? 700_000);
  // Eric's 2024 Form 8606 line 14 shows 7,300 (7,000 contributed in 2024 plus 300 of earlier basis); null = not answered
  if (over.priorBasisCents !== null) a!.priorBasisCents = owner(over.priorBasisCents ?? 730_000);
  a!.coveredByWorkplacePlan = owner(false);
  a!.age50Plus = owner(false);
  b!.coveredByWorkplacePlan = owner(true);
  f.income.w2s[0]!.wagesCents = 17_000_000;
  f.income.w2s[0]!.socialSecurityWagesCents = 17_000_000;
  f.income.w2s[0]!.medicareWagesCents = 17_000_000;
  if (over.withStatement !== false) {
    f.income.retirementStatements = [
      {
        docId: DOC_ID,
        personUserId: ERIC_ID,
        basis: "doc_verified",
        legacyFormat: false,
        refs: [{ kind: "document", id: DOC_ID, label: "Retirement statement Inspira Financial Trust, LLC" }],
        issuer: "Inspira Financial Trust, LLC",
        traditionalIraCents: 700_000,
        rothIraCents: 0,
        sepCents: null,
        simpleCents: null,
        postponedCents: null,
        postponedForYear: null,
        rolloverCents: 0,
        rothConversionCents: null,
        recharacterizedCents: 0,
        fairMarketValueCents: over.fmvCents === undefined ? 4_914_679 : over.fmvCents,
      },
    ];
  }
  return f;
}

const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const status = (r: Ty2025Return, k: LineKey): string | undefined => r.lines[k]?.status;
const F8606A: LineKey[] = ["f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"];
const F8606B: LineKey[] = ["f8606b.1", "f8606b.2", "f8606b.3", "f8606b.14"];

describe("Form 8606 through the return: Eric's shape", () => {
  const f = ericFacts();
  const r = computeTy2025Return(f);

  it("the engine version is ty2025-1b.9", () => {
    expect(TY2025_ENGINE_VERSION).toBe("ty2025-1b.9");
    expect(r.engineVersion).toBe("ty2025-1b.9");
  });

  it("the MAGI is over 246,000, so the deduction is 0 (Schedule 1 line 20 stays 0) and 7,000 is nondeductible", () => {
    expect(amt(r, "ira.magi")).toBeGreaterThanOrEqual(246_000);
    expect(amt(r, "ira.a.7")).toBe(0);
    expect(amt(r, "sch1.20")).toBe(0);
    expect(amt(r, "ira.a.nd")).toBe(7000);
    expect(status(r, "ira.b.nd")).toBe("not_applicable");
  });

  it("lines 1 / 2 / 3 / 14 are 7,000 / 7,300 / 14,300 / 14,300 (the 2025 contribution plus the 2024 Form 8606 line 14), all computed; taxpayer B's four lines are not applicable", () => {
    expect(F8606A.map((k) => amt(r, k))).toEqual([7000, 7300, 14300, 14300]);
    expect(F8606A.map((k) => status(r, k))).toEqual(["computed", "computed", "computed", "computed"]);
    expect(F8606B.map((k) => status(r, k))).toEqual(["not_applicable", "not_applicable", "not_applicable", "not_applicable"]);
  });

  it("line 2 says where it comes from: the owner's answer from the 2024 Form 8606 line 14, not checked against a document", () => {
    const l2 = r.lines["f8606a.2"]!;
    expect(l2.reason).toContain("Owner answer (from the 2024 Form 8606 line 14): $7,300");
    expect(l2.reason).toContain("not checked against any 2024 document");
    expect(l2.refs.some((x) => x.kind === "planning" && x.id === "fixture")).toBe(true);
  });

  it("zero prior basis (answered 0): 7,000 / 0 / 7,000 / 7,000; a large prior basis (52,000): 7,000 / 52,000 / 59,000 / 59,000", () => {
    expect(F8606A.map((k) => amt(computeTy2025Return(ericFacts({ priorBasisCents: 0 })), k))).toEqual([7000, 0, 7000, 7000]);
    expect(F8606A.map((k) => amt(computeTy2025Return(ericFacts({ priorBasisCents: 5_200_000 })), k))).toEqual([7000, 52000, 59000, 59000]);
  });

  it("Form 8606 is required, with the $50 not-filing penalty in the reason, and it blocks nothing", () => {
    expect(r.formsRequired.f8606).toEqual({ required: true, reason: expect.stringContaining("$50") });
    expect(r.formsRequired.f8606?.reason).toContain("one Form 8606 per person");
    expect(r.openItems.filter((o) => o.severity === "blocking" && o.id.includes("8606"))).toEqual([]);
    expect(r.headline.complete).toBe(true);
  });

  it("provenance: line 1 (and its sources) cite the owner's answer AND the retirement statement; lines 3 and 14 inherit it", () => {
    for (const k of ["ira.a.nd", "f8606a.1", "f8606a.2", "f8606a.3", "f8606a.14"] as LineKey[]) {
      const refs = r.lines[k]!.refs;
      expect(refs.some((x) => x.kind === "document" && x.id === DOC_ID), k).toBe(true);
      expect(refs.some((x) => x.kind === "planning" || x.kind === "questionnaire"), k).toBe(true);
    }
  });

  it("no key is emitted twice and every Form 8606 key is in the line catalog", () => {
    expect(duplicateEmissions(f)).toEqual([]);
    for (const k of [...F8606A, ...F8606B, "ira.a.nd", "ira.b.nd"] as LineKey[]) expect(LINE_KEYS).toContain(k);
  });

  it("no tax number moves: against the same household with no traditional contribution every other line is identical (amount and status)", () => {
    const base = computeTy2025Return(ericFacts({ traditionalCents: 0 }));
    expect(amt(base, "sch1.20")).toBe(0);
    const skip = /^(f8606|ira\.|f8880\.)/;
    const diffs: string[] = [];
    for (const k of LINE_KEYS) {
      if (skip.test(k)) continue;
      if (r.lines[k]?.amount !== base.lines[k]?.amount || r.lines[k]?.status !== base.lines[k]?.status) diffs.push(k);
    }
    expect(diffs).toEqual([]);
    expect(r.headline.federal.totalTax.amount).toBe(base.headline.federal.totalTax.amount);
    expect(r.headline.connecticut.tax.amount).toBe(base.headline.connecticut.tax.amount);
    expect(status(base, "f8606a.1")).toBe("not_applicable");
    expect(base.formsRequired.f8606).toEqual({ required: false, reason: "No nondeductible traditional IRA contribution." });
  });

  it("advisories: next year's starting point (line 14), and the source of line 2 (the owner's 2024 Form 8606 figure; the Form 5498 year-end value is information only)", () => {
    const basis = r.openItems.find((o) => o.id === "f8606-basis-record");
    expect(basis?.severity).toBe("advisory");
    expect(basis?.message).toContain("2026 Form 8606 line 2");
    expect(basis?.message).toContain("$14,300");
    expect(basis?.lineKeys).toEqual(["f8606a.14"]);
    const prior = r.openItems.find((o) => o.id === "f8606-prior-basis-check");
    expect(prior?.severity).toBe("advisory");
    expect(prior?.message).toContain("line 2 is $7,300, your answer from the 2024 Form 8606 line 14");
    expect(prior?.message).toContain("$49,146.79");
    expect(prior?.message).toContain("information only");
    expect(prior?.message).toContain("cannot check the 2024 Form 8606 figure");
    expect(prior?.lineKeys).toEqual(["f8606a.2"]);
    expect(prior?.refs.some((x) => x.id === DOC_ID)).toBe(true);
    for (const o of [basis, prior]) {
      expect(o?.message).not.toMatch(/CPA/);
      expect(o?.action).not.toMatch(/CPA/);
    }
    // an amount that is not 0 gets no "you entered 0" warning, whatever the year-end value
    expect(prior?.message).not.toContain("You entered 0");
    // no Form 5498 value: the advisory still says where line 2 comes from, without the year-end sentence
    const noStatement = computeTy2025Return(ericFacts({ withStatement: false })).openItems.find((o) => o.id === "f8606-prior-basis-check");
    expect(noStatement?.message).toContain("line 2 is $7,300");
    expect(noStatement?.message).not.toContain("Form 5498");
    // an answer of 0 with an IRA that already held more than this year's contribution: a check of earlier returns
    const zero = computeTy2025Return(ericFacts({ priorBasisCents: 0 })).openItems.find((o) => o.id === "f8606-prior-basis-check");
    expect(zero?.message).toContain("You entered 0 although the IRA already held more than this year's contribution");
    // 0 and a year-end value below the contribution: no warning
    const small = computeTy2025Return(ericFacts({ priorBasisCents: 0, fmvCents: 600_000 })).openItems.find((o) => o.id === "f8606-prior-basis-check");
    expect(small?.message).not.toContain("You entered 0");
    // the advisory is only for a computed line 2
    const unanswered = computeTy2025Return(ericFacts({ priorBasisCents: null }));
    expect(unanswered.openItems.some((o) => o.id === "f8606-prior-basis-check")).toBe(false);
  });

  it("the review sheet's document index lists the retirement statement against Form 8606 line 1 (it is no longer 'not used by any line')", () => {
    const model = buildSheetModel({ ret: r, documents: [{ id: DOC_ID, docType: "retirement_contribution", taxYear: 2025, verified: true, legacyFormat: false, subjectType: "person" }], now: new Date("2026-10-05T12:00:00Z") });
    const row = model.documents.find((d) => d.id === DOC_ID);
    expect(row).toBeDefined();
    const keys = row!.fedLines.map((l) => l.key);
    expect(keys).toEqual(expect.arrayContaining(["ira.a.nd", "f8606a.1", "f8606a.3", "f8606a.14"]));
    expect(row!.fedLines.some((l) => /Form 8606/.test(l.text))).toBe(true);
  });
});

describe("Form 8606: the answer and the statements that gate lines 2 and 14", () => {
  it("the 2024 Form 8606 line 14 amount NOT answered: lines 2, 3 and 14 are missing_input, rule:form-8606 is a blocking item asking for it in plain language, the return is not complete", () => {
    const r = computeTy2025Return(ericFacts({ priorBasisCents: null }));
    expect(status(r, "f8606a.1")).toBe("computed");
    expect(amt(r, "f8606a.1")).toBe(7000);
    expect(["f8606a.2", "f8606a.3", "f8606a.14"].map((k) => status(r, k as LineKey))).toEqual(["missing_input", "missing_input", "missing_input"]);
    expect(["f8606a.2", "f8606a.3", "f8606a.14"].map((k) => amt(r, k as LineKey))).toEqual([null, null, null]);
    const item = r.openItems.find((o) => o.id === "rule:form-8606");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain("amount on line 14 of your most recent filed Form 8606 (for 2024)");
    expect(item?.message).toContain("Enter 0 if there was none or you never filed one");
    expect(item?.action).toContain("2024 Form 8606 line 14");
    expect(item?.lineKeys).toEqual(expect.arrayContaining(["f8606a.2", "f8606a.3", "f8606a.14"]));
    expect(r.headline.complete).toBe(false);
    // the form is still required (line 1 is known) and no tax number changed
    expect(r.formsRequired.f8606?.required).toBe(true);
    expect(amt(r, "sch1.20")).toBe(0);
    expect(r.headline.federal.totalTax.amount).toBe(computeTy2025Return(ericFacts()).headline.federal.totalTax.amount);
  });

  it("a 'not sure' answer to the amount blocks the same lines (you look it up); a negative amount in the facts is refused", () => {
    const f = ericFacts();
    f.returnAnswers.people[0]!.priorBasisCents = { value: null, basis: "answer_owner", refs: [] };
    const r = computeTy2025Return(f);
    expect(["f8606a.2", "f8606a.3", "f8606a.14"].map((k) => status(r, k as LineKey))).toEqual(["needs_cpa_judgment", "needs_cpa_judgment", "needs_cpa_judgment"]);
    const neg = computeTy2025Return(ericFacts({ priorBasisCents: -30_000 }));
    expect(["f8606a.2", "f8606a.3", "f8606a.14"].map((k) => amt(neg, k as LineKey))).toEqual([null, null, null]);
    expect(neg.lines["f8606a.2"]?.reason).toContain("cannot be below zero");
    expect(neg.headline.complete).toBe(false);
  });

  it("the statement about 2025 IRA withdrawals, conversions and recharacterizations NOT stated: lines 1-3 compute, line 14 is missing_input and rule:form-8606 names the statement", () => {
    const f = ericFacts();
    delete f.statedNone.ira_basis_other;
    const r = computeTy2025Return(f);
    expect(F8606A.map((k) => amt(r, k))).toEqual([7000, 7300, 14300, null]);
    expect(status(r, "f8606a.14")).toBe("missing_input");
    const item = r.openItems.find((o) => o.id === "rule:form-8606");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain("Needs an owner statement");
    expect(item?.message).toContain("Roth IRA");
    expect(item?.action).toContain("Statement: no IRA withdrawal, Roth conversion");
    expect(r.headline.complete).toBe(false);
  });

  it("the provisional (fill) pass assumes none for the unstated statement and for an unanswered amount, and says so; its lines carry 7,000 / 0 / 7,000 / 7,000", () => {
    const f = ericFacts({ priorBasisCents: null });
    delete f.statedNone.ira_basis_other;
    const p = computeTy2025Return(f).headline.provisional;
    expect(p).not.toBeNull();
    expect(p!.assumedFacts.some((x) => /No IRA distribution, Roth conversion/.test(x) && /Form 8606/.test(x))).toBe(true);
    expect(p!.assumedFacts.some((x) => /No earlier-year basis in traditional IRAs/.test(x) && /2024 Form 8606/.test(x))).toBe(true);
    expect(F8606A.map((k) => p!.lines[k])).toEqual([7000, 0, 7000, 7000]);
  });

  it("Taxpayer F (Eva) with no contribution needs no amount: her four lines stay not applicable and nothing about her blocks", () => {
    const r = computeTy2025Return(ericFacts());
    expect(F8606B.map((k) => status(r, k))).toEqual(["not_applicable", "not_applicable", "not_applicable", "not_applicable"]);
    expect(r.openItems.some((o) => o.severity === "blocking" && /Eva/.test(o.message) && /8606/.test(o.message))).toBe(false);
  });

  it("answered Yes: lines 2, 3 and 14 are blocked with a plain-language reason (no number is printed), line 1 still computes", () => {
    const f = ericFacts();
    f.statedNone.ira_basis_other = owner(false);
    const r = computeTy2025Return(f);
    expect(["f8606a.2", "f8606a.3", "f8606a.14"].map((k) => status(r, k as LineKey))).toEqual(["needs_cpa_judgment", "needs_cpa_judgment", "needs_cpa_judgment"]);
    expect(amt(r, "f8606a.14")).toBeNull();
    expect(r.lines["f8606a.2"]?.reason).toContain("this app does not figure");
    expect(amt(r, "f8606a.1")).toBe(7000);
  });

  it("an IRA distribution (Yes to the retirement / Social Security statement) prints no Form 8606 number at all: with a spouse covered at work the IRA deduction itself stops (Pub. 590-A Appendix B), so line 1 is blocked too", () => {
    const f = ericFacts();
    f.statedNone.retirement_ss_income = owner(false);
    const r = computeTy2025Return(f);
    for (const k of F8606A) {
      expect(status(r, k), k).toBe("needs_cpa_judgment");
      expect(amt(r, k), k).toBeNull();
    }
    expect(r.lines["f8606a.1"]?.reason).toContain("Social Security");
    // the form is still known to be needed (the contribution is recorded), but it cannot be filled in from the answers
    expect(r.formsRequired.f8606?.required).toBe("blocking");
  });
});

describe("Form 8606: when the form is not (yet) decided", () => {
  it("the contribution unanswered: forms required is 'blocking' (cannot tell), never a silent no", () => {
    const f = ericFacts();
    f.returnAnswers.people[0]!.traditionalIraCents = { value: null, basis: null, refs: [] };
    const r = computeTy2025Return(f);
    expect(status(r, "f8606a.1")).toBe("missing_input");
    expect(r.formsRequired.f8606?.required).toBe("blocking");
  });

  it("a STATED IRA deduction (an override of Schedule 1 line 20) replaces the IRA rule: line 1 of a recorded contribution is blocked, not guessed", () => {
    const f = ericFacts();
    f.adjustments.ira = owner(0);
    const r = computeTy2025Return(f);
    expect(status(r, "ira.a.nd")).toBe("needs_cpa_judgment");
    expect(status(r, "f8606a.1")).toBe("needs_cpa_judgment");
    expect(r.lines["ira.a.nd"]?.reason).toContain("You decide it");
    expect(r.formsRequired.f8606?.required).toBe("blocking");
  });

  it("a STATED IRA deduction and an unanswered contribution (the stated-amounts golden): no Form 8606 amount is figured and nothing blocks", () => {
    const f = ericFacts({ withStatement: false });
    f.adjustments.ira = owner(0);
    f.returnAnswers.people[0]!.traditionalIraCents = { value: null, basis: null, refs: [] };
    const r = computeTy2025Return(f);
    expect(status(r, "ira.a.nd")).toBe("not_applicable");
    expect(r.formsRequired.f8606?.required).toBe(false);
    expect(r.openItems.some((o) => o.id === "rule:form-8606")).toBe(false);
  });

  it("a contribution over the yearly limit (7,500) blocks line 1 and the whole form for Eric; nothing prints", () => {
    const r = computeTy2025Return(ericFacts({ traditionalCents: 750_000 }));
    for (const k of F8606A) expect(status(r, k), k).toBe("needs_cpa_judgment");
    expect(r.formsRequired.f8606?.required).toBe("blocking");
    expect(r.openItems.some((o) => o.id === "rule:ira-deduction" && o.severity === "blocking")).toBe(true);
  });
});
