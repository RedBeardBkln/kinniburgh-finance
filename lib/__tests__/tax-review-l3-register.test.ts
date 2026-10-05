import { describe, expect, it } from "vitest";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Decisions } from "@/lib/tax2025/types";
import { buildRegister, byImpact } from "@/lib/tax-review/llm/register";
import { findCpaWording } from "@/lib/tax-wording";
import { bill, fullFacts1b, owner } from "./tax2025-fixtures";

// The judgments register (ai-return-reviewer, B3 / B5; plan 5.6): built from the engine's own state, never invented.

function withDecisionsFacts() {
  const f = fullFacts1b();
  f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
  f.income.scheduleC.homeOfficeSqft = owner(300);
  f.deductions.propertyTaxBills = [bill({ docId: "bill-arbor", kind: "other_real_estate", paidInYearCents: 4_000_000, billedCents: 4_000_000 }), ...f.deductions.propertyTaxBills];
  return f;
}

describe("buildRegister", () => {
  it("lists the decisions X1 / X3 / X5 that are still at their default, with recommended position, alternative, source and who decides", () => {
    const f = withDecisionsFacts();
    const ret = computeTy2025Return(f, {});
    const reg = buildRegister({ ret, facts: f });
    const decisions = reg.filter((e) => e.origin === "decision");
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d.whoDecides).toBe("Eric");
      expect(d.status).toBe("undecided");
      expect(d.recommendedPosition).toMatch(/conservative default/i);
      expect(d.sources.some((s) => s.kind === "engine")).toBe(true);
      expect(d.narrated).toBe(false);
      expect(d.id).toMatch(/^decision:X\d$/);
    }
    // the home-office decision shows both methods
    const x1 = reg.find((e) => e.id === "decision:X1");
    expect(x1?.alternative).toBeTruthy();
  });
  it("a recorded decision is 'decided' and shows the recorded choice", () => {
    const f = withDecisionsFacts();
    const decisions: Ty2025Decisions = { homeOfficeMethod: { chosen: "simplified", by: "owner", at: "2026-10-05T00:00:00Z" } };
    const reg = buildRegister({ ret: computeTy2025Return(f, decisions), facts: f });
    const x1 = reg.find((e) => e.id === "decision:X1");
    expect(x1?.status).toBe("decided");
    expect(x1?.recommendedPosition).toMatch(/Recorded choice/);
  });
  it("the dollar impact comes only from the engine's alternative effects; otherwise it says it is not quantified", () => {
    const f = withDecisionsFacts();
    const ret = computeTy2025Return(f, {});
    const reg = buildRegister({ ret, facts: f });
    for (const e of reg) {
      if (e.dollarImpact.amountDollars === null) expect(e.dollarImpact.note).toMatch(/not quantified/);
      else {
        expect(Number.isInteger(e.dollarImpact.amountDollars)).toBe(true);
        expect(e.dollarImpact.amountDollars).toBeGreaterThanOrEqual(0);
      }
    }
    // an optional counterfactual (from the independent recomputation) is used when supplied, and only then
    const cf = buildRegister({ ret, facts: f, counterfactuals: { X1: { actual: 1234 } } });
    expect(cf.find((e) => e.id === "decision:X1")?.dollarImpact.amountDollars).toBe(1234);
    const amounts = byImpact(cf).map((e) => e.dollarImpact.amountDollars ?? -1);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  });
  it("an owner's 'not sure' answer becomes an entry for Eric", () => {
    const f = fullFacts1b();
    const p = f.returnAnswers.people[0];
    if (p === undefined) throw new Error("no person");
    p.tipsChoice = { value: null, basis: "answer_owner", refs: [] };
    const reg = buildRegister({ ret: computeTy2025Return(f, {}), facts: f });
    const e = reg.find((x) => x.origin === "owner_unsure");
    expect(e?.id).toBe("answer:people[a].tipsChoice");
    expect(e?.topic).toMatch(/not sure/);
    expect(e?.whoDecides).toBe("Eric");
  });
  it("informational lines and not-verified law the return touches are listed; untouched ones are not", () => {
    const f = fullFacts1b();
    const base = buildRegister({ ret: computeTy2025Return(f, {}), facts: f });
    expect(base.some((e) => e.origin === "informational")).toBe(true);
    expect(base.some((e) => e.id === "spec09:mortgage_points")).toBe(false);
    const g = fullFacts1b();
    g.deductions.mortgages = [{ docId: "m1", lender: "Bank", basis: "doc_verified", legacyFormat: false, refs: [], interestCents: 1_000_000, principalCents: 30_000_000, originationDate: "2020-01-01", mortgageInsuranceCents: null, pointsCents: 250_000, box10Cents: null, propertyAddress: null }];
    const withPoints = buildRegister({ ret: computeTy2025Return(g, {}), facts: g });
    const pts = withPoints.find((e) => e.id === "spec09:mortgage_points");
    expect(pts?.origin).toBe("unverified_law");
    expect(pts?.sources[0]).toMatchObject({ kind: "spec09", verified: false });
  });
  it("ids are unique, every entry is for Eric, no text says CPA, and the order is stable", () => {
    const f = withDecisionsFacts();
    const reg = buildRegister({ ret: computeTy2025Return(f, {}), facts: f });
    expect(new Set(reg.map((e) => e.id)).size).toBe(reg.length);
    for (const e of reg) {
      expect(e.whoDecides).toBe("Eric");
      expect(findCpaWording(`${e.topic} ${e.recommendedPosition} ${e.alternative ?? ""} ${e.rationale ?? ""} ${e.where}`), e.id).toEqual([]);
    }
    expect(buildRegister({ ret: computeTy2025Return(f, {}), facts: f })).toEqual(reg);
  });
});
