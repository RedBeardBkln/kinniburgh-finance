import { describe, expect, it } from "vitest";
import { answered, MISSING, UNSURE } from "@/lib/tax2025/answer-state";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { D } from "@/lib/tax2025/money";
import { computeStateRefund, type StateRefundInput } from "@/lib/tax2025/rules/state-refund";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { validateDefinition, visibleNodes, type EffectiveAnswers } from "@/lib/tax-questionnaire";
import { RETURN_COMPLETENESS_ID, SOURCE_IDS, questionnaireById } from "@/lib/tax-questionnaire-content";
import { fullFacts, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

const def = questionnaireById(RETURN_COMPLETENESS_ID)!;

function itemized(over: Partial<StateRefundInput> = {}): StateRefundInput {
  return {
    refund: answered(D(9000)),
    deduction2024: answered("itemized_income"),
    filedJoint2024: answered(true),
    sch5d: answered(D(18000)),
    sch5e: answered(D(10000)),
    sch17: answered(D(35000)),
    boxes2024: answered(0),
    exceptionApplies: answered(false),
    ...over,
  };
}
const amt = (r: ReturnType<typeof computeStateRefund>) => r.lines[0]!.amount?.toString() ?? null;

// State and Local Income Tax Refund Worksheet (2025 Form 1040 instructions, Schedule 1 line 1), MFJ, 2024 figures:
//  Example: refund 9,000; Schedule A 5d 18,000, 5e 10,000 (SALT cap), line 17 35,000, no boxes.
//   1 = min(9,000, 18,000) = 9,000;  2 = 18,000 - 10,000 = 8,000;  3 = 9,000 - 8,000 = 1,000
//   4 = 35,000;  5 = 29,200;  6 = 0;  7 = 29,200;  8 = 35,000 - 29,200 = 5,800;  9 = min(1,000, 5,800) = 1,000
describe("computeStateRefund: the IRS worksheet", () => {
  it("itemized, benefit partly limited by the SALT cap: 1,000 taxable", () => {
    const r = computeStateRefund(itemized());
    expect(r.status).toBe("computed");
    expect(amt(r)).toBe("1000");
    expect(r.reasons[0]).toContain("line 9");
    expect(r.citations).toContain("STATE_REFUND_2024_STANDARD_DEDUCTION_MFJ");
  });
  it("line 8 limits it: itemized 30,000 -> 800; one box (1,550) with 35,000 -> line 8 = 4,250 so 1,000; no cap (5d = 5e) 2,000 of 40,000", () => {
    expect(amt(computeStateRefund(itemized({ sch17: answered(D(30000)) })))).toBe("800");
    expect(amt(computeStateRefund(itemized({ boxes2024: answered(1) })))).toBe("1000");
    expect(amt(computeStateRefund(itemized({ boxes2024: answered(1), sch17: answered(D(30000)) })))).toBe("0"); // line 7 = 30,750 >= 30,000
    expect(amt(computeStateRefund(itemized({ refund: answered(D(2000)), sch5d: answered(D(12000)), sch5e: answered(D(12000)), sch17: answered(D(40000)) })))).toBe("2000");
  });
  it("the refund is capped at Schedule A line 5d; a refund inside the capped-away taxes is not taxable", () => {
    expect(amt(computeStateRefund(itemized({ refund: answered(D(25000)) })))).toBe("5800".replace("5800", "5800")); // line1 18,000 -> line3 10,000 -> line8 5,800
    expect(amt(computeStateRefund(itemized({ refund: answered(D(2500)) })))).toBe("0");
  });
  it("standard deduction in 2024: none taxable, with the citation, even with no refund amount; sales-tax election likewise", () => {
    const std = computeStateRefund(itemized({ deduction2024: answered("standard"), refund: MISSING, sch5d: MISSING, sch17: MISSING }));
    expect(std.status).toBe("computed");
    expect(amt(std)).toBe("0");
    expect(std.reasons[0]).toContain("standard deduction");
    expect(amt(computeStateRefund(itemized({ deduction2024: answered("itemized_sales") })))).toBe("0");
  });
  it("never a guess: unanswered -> missing_input; not sure, an exception, or a non-joint 2024 return -> needs_cpa_judgment", () => {
    expect(computeStateRefund(itemized({ deduction2024: MISSING })).status).toBe("missing_input");
    expect(computeStateRefund(itemized({ sch17: MISSING })).status).toBe("missing_input");
    expect(computeStateRefund(itemized({ deduction2024: UNSURE })).status).toBe("needs_cpa_judgment");
    expect(computeStateRefund(itemized({ exceptionApplies: answered(true) })).status).toBe("needs_cpa_judgment");
    expect(computeStateRefund(itemized({ filedJoint2024: answered(false) })).status).toBe("needs_cpa_judgment");
    expect(computeStateRefund(itemized({ sch5e: answered(D(19000)) })).status).toBe("missing_input");
  });
});

describe("Round 5: questionnaire nodes and mapping", () => {
  const eff = (v: Record<string, string | number | string[]>): EffectiveAnswers =>
    Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value, source: "questionnaire" as const, at: "2026-10-04T00:00:00.000Z", by: null }]));
  const people = [{ userId: "u1", name: "Eric" }, { userId: "u2", name: "Eva" }];
  it("tree validates; follow-ups are shown only after Yes on other income, only on refund, only on itemized", () => {
    expect(validateDefinition(def, SOURCE_IDS)).toEqual([]);
    const shown = (e: EffectiveAnswers) => visibleNodes(def, RC_CONTEXT, e).map((n) => n.id);
    expect(shown({})).not.toContain("oik");
    expect(shown(eff({ g_other_income: "some" }))).toContain("oik");
    expect(shown(eff({ g_other_income: "some", oik: ["unemployment"] }))).not.toContain("rfitem");
    const std = shown(eff({ g_other_income: "some", oik: ["refund"], rfitem: "standard" }));
    expect(std).toContain("rfitem");
    expect(std).not.toContain("rfamt"); // one kind only: its amount is the total
    expect(std).not.toContain("rfdd");
    const item = shown(eff({ g_other_income: "some", oik: ["refund"], rfitem: "itemized_income" }));
    expect(item).toEqual(expect.arrayContaining(["rfdd", "rfee", "rfa17", "rfboxes", "rfexc"]));
    expect(def.nodes.find((n) => n.id === "rfitem")!.prompt).toContain("{prevYear}");
    expect(def.version).toBe(2);
  });
  it("mapping: kinds, the standard-deduction one-click path, itemized figures, and the group amount as the refund when it is the only kind", () => {
    const p = parseCompletenessAnswers(eff({ g_other_income: "some", ga_other_income: 150_000, oik: ["refund"], rfitem: "standard" }), people);
    const oi = p.returnAnswers.otherIncome!;
    expect(oi.kinds.value).toEqual(["refund"]);
    expect(oi.deduction2024.value).toBe("standard");
    expect(oi.refundCents.value).toBe(150_000); // taken from the group amount (rfamt unanswered)
    const many = parseCompletenessAnswers(eff({ g_other_income: "some", ga_other_income: 400_000, oik: ["refund", "gambling"], rfitem: "itemized_income", rfamt: 100_000, rfdd: 1_800_000, rfee: 1_000_000, rfa17: 3_500_000, rfboxes: 0, rfexc: "no" }), people).returnAnswers.otherIncome!;
    expect(many.refundCents.value).toBe(100_000);
    expect([many.sch5dCents.value, many.sch5eCents.value, many.sch17Cents.value, many.boxes2024.value, many.exceptionApplies.value]).toEqual([1_800_000, 1_000_000, 3_500_000, 0, false]);
    expect(parseCompletenessAnswers(eff({ g_other_income: "some", oik: ["unsure"] }), people).returnAnswers.otherIncome!.kinds).toMatchObject({ value: null, basis: "answer_owner" });
  });
});

function withRefund(kinds: string[], over: (oi: NonNullable<ReturnType<typeof fullFacts1b>["returnAnswers"]["otherIncome"]>) => void) {
  const f = fullFacts1b();
  f.statedNone.other_income = owner(false);
  f.returnAnswers.statedSomeAmounts.other_income = owner(150_000);
  const oi = f.returnAnswers.otherIncome!;
  oi.kinds = owner(kinds);
  oi.refundCents = owner(150_000);
  over(oi);
  return f;
}

describe("Round 5: engine wiring", () => {
  it("2024 standard deduction: Schedule 1 line 1 = 0 with the citation, the group is satisfied, headline unchanged, no 'needs a statement' item", () => {
    const r = computeTy2025Return(withRefund(["refund"], (oi) => { oi.deduction2024 = owner("standard"); }));
    expect(r.lines["sch1.1"]?.status).toBe("not_applicable");
    expect(r.lines["sch1.1"]?.reason).toContain("standard deduction");
    expect(r.lines["sch1.2a"]?.status).toBe("not_applicable"); // rest of the group: only the refund was reported
    expect(r.headline.federal.agi.amount).toBe(177967);
    expect(r.headline.federal.totalTax.amount).toBe(27015);
    expect(r.headline.connecticut.tax.amount).toBe(8788);
    expect(r.openItems.some((o) => o.id === "none:other_income")).toBe(false);
    expect(r.openItems.find((o) => o.id === "state-refund-worksheet")?.severity).toBe("advisory");
  });
  it("2024 itemized (worked example): line 1 = 1,000 raises federal AGI by 1,000; CT subtracts it on Schedule 1 line 42 so CT AGI and tax are unchanged", () => {
    const r = computeTy2025Return(
      withRefund(["refund"], (oi) => {
        oi.deduction2024 = owner("itemized_income");
        oi.refundCents = owner(900_000);
        oi.sch5dCents = owner(1_800_000);
        oi.sch5eCents = owner(1_000_000);
        oi.sch17Cents = owner(3_500_000);
        oi.boxes2024 = owner(0);
        oi.exceptionApplies = owner(false);
      })
    );
    expect(r.lines["sch1.1"]?.amount).toBe(1000);
    expect(r.lines["sch1.10"]?.amount).toBe(51000);
    expect(r.headline.federal.agi.amount).toBe(178967);
    expect(r.lines["ct1040.subtractions"]?.amount).toBe(1000);
    expect(r.headline.connecticut.ctAgi.amount).toBe(177967);
    expect(r.headline.connecticut.tax.amount).toBe(8788);
    expect(r.openItems.find((o) => o.id === "state-refund-worksheet")?.message).toContain("Schedule 1 line 42");
  });
  it("other kinds stay with the CPA, the amount carried; the refund part is still classified", () => {
    const r = computeTy2025Return(withRefund(["refund", "unemployment"], (oi) => { oi.deduction2024 = owner("standard"); }));
    expect(r.lines["sch1.1"]?.status).toBe("not_applicable");
    expect(r.lines["sch1.7"]?.status).toBe("needs_cpa_judgment");
    expect(r.lines["sch1.7"]?.reason).toContain("$1,500");
    expect(r.openItems.find((o) => o.id === "none:other_income")?.message).toContain("answered Yes");
  });
  it("the wording: Yes with an amount and no classification reads 'owner answered Yes ... CPA must classify', never 'Needs an owner/CPA statement'", () => {
    const f = fullFacts1b();
    f.statedNone.other_income = owner(false);
    f.returnAnswers.statedSomeAmounts.other_income = owner(150_000);
    const item = computeTy2025Return(f).openItems.find((o) => o.id === "none:other_income")!;
    expect(item.message).toContain("answered Yes (about $1,500)");
    expect(item.message).not.toContain("Needs an owner/CPA statement");
    expect(item.action).toContain("CPA");
  });
  it("an unanswered 2024 deduction method blocks line 1 (missing_input); golden return unchanged", () => {
    expect(computeTy2025Return(withRefund(["refund"], () => undefined)).lines["sch1.1"]?.status).toBe("missing_input");
    const g = computeTy2025Return(fullFacts());
    expect(g.headline.federal.totalTax.amount).toBe(27015);
    expect(g.headline.connecticut.tax.amount).toBe(8788);
  });
});
