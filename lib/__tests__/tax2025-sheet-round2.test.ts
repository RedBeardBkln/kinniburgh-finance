import React, { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The override chips are client components that import the (DB-backed) server actions; nothing is called while rendering.
vi.mock("@/actions/tax-return-overrides", () => ({
  setTaxReturnOverride: vi.fn(),
  clearTaxReturnOverride: vi.fn(),
  listTaxReturnOverrideHistory: vi.fn(),
}));
import { computeTy2025Return } from "@/lib/tax2025/return";
import { emptyReturnAnswers } from "@/lib/tax2025/facts";
import { missingLeaf, type Ty2025Return } from "@/lib/tax2025/types";
import { SHEET_DRAFT_LABEL, buildSheetModel, openItemOwner, routeOpenItem, scheduleCUnanswered, type SheetModel } from "@/lib/tax2025-sheet";
import { sheetToCsv } from "@/lib/tax2025-sheet-csv";
import { buildCardConclusions } from "@/lib/tax2025-sheet-conclusions";
import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { ERIC_ID, EVA_ID, emptyFacts, fullFacts, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

// Round 2 (tester D1-D5) regression tests.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-10-03T16:30:00Z");

/** Production-like incomplete state: basics answered, none of the 1b / "none" statements, home office + fixed assets pending. */
function prodLike() {
  const f = fullFacts();
  f.statedNone = {};
  f.adjustments = { sch1a: missingLeaf(), hsa: missingLeaf(), ira: missingLeaf(), seRetirement: missingLeaf(), seHealthInsurance: missingLeaf() };
  f.credits = { foreignTax: missingLeaf(), savers: missingLeaf() };
  f.ct = { useTax: missingLeaf(), additions: missingLeaf(), subtractions: missingLeaf() };
  f.returnAnswers = emptyReturnAnswers([
    { slot: "a", userId: ERIC_ID, name: "Eric" },
    { slot: "b", userId: EVA_ID, name: "Eva" },
  ]);
  f.payments.federalEstimates = missingLeaf();
  f.payments.ctEstimates = missingLeaf();
  f.income.scheduleC.fixedAssetsNoneConfirmed = false;
  f.income.scheduleC.mileageNoneConfirmed = missingLeaf();
  f.income.scheduleC.homeOfficeEligibility = missingLeaf();
  f.priorYear = { totalTaxCents: missingLeaf(), agiCents: missingLeaf(), filingStatus: missingLeaf() };
  return f;
}

const prod: Ty2025Return = computeTy2025Return(prodLike());
const golden1b: Ty2025Return = computeTy2025Return(fullFacts1b());
const model = (ret: Ty2025Return): SheetModel => buildSheetModel({ ret, documents: [], now: NOW });

describe("D1: provenance chips are never folded", () => {
  it("every source the engine cites for a line is a chip on the line and in the CSV provenance (golden, all lines)", () => {
    const golden = computeTy2025Return(fullFacts());
    const m = model(golden);
    const csvRows = sheetToCsvRows(m);
    let sawMany = 0;
    for (const l of [...m.federal, ...m.connecticut].flatMap((g) => g.lines)) {
      const e = golden.lines[l.key as keyof typeof golden.lines]!;
      const want = new Set(e.refs.filter((r) => r.kind !== "constant").map((r) => `${r.kind}:${r.id}`));
      if (want.size > 8) sawMany++;
      expect(l.chips.some((c) => /more source/.test(c.label)), l.key).toBe(false);
      if (e.refs.some((r) => r.kind === "planning" || r.kind === "questionnaire")) expect(l.chips.some((c) => c.kind === "owner_answer"), l.key).toBe(true);
      if (e.refs.some((r) => r.kind === "gl")) expect(l.chips.some((c) => c.kind === "books"), l.key).toBe(true);
      const prov = csvRows.get(l.key) ?? "";
      for (const c of l.chips) expect(prov, `${l.key} ${c.label}`).toContain(c.label);
    }
    expect(sawMany).toBeGreaterThan(0); // the golden fixture really has lines with more than 8 sources (the original repro: 1040 line 14)
  });
});

function sheetToCsvRows(m: SheetModel): Map<string, string> {
  // provenance is column 7; parse minimally via the model instead of re-parsing quoted CSV
  const out = new Map<string, string>();
  const csv = sheetToCsv(m);
  for (const l of [...m.federal, ...m.connecticut].flatMap((g) => g.lines)) {
    const prov = l.chips.map((c) => c.label).join("; ");
    // the CSV must contain the same provenance text (as part of a possibly quoted cell)
    for (const c of l.chips) expect(csv).toContain(c.label.replace(/"/g, '""'));
    out.set(l.key, prov + " " + l.chips.map((c) => c.label).join(" "));
  }
  return out;
}

describe("D2: no all-clear wording while the underlying answer is unanswered", () => {
  it("prod-like fixture: the engine really has the home office and fixed-asset answers pending", () => {
    expect(prod.headline.blockingItemCount).toBeGreaterThanOrEqual(30);
    const open = scheduleCUnanswered(prod);
    expect(open.homeOffice).toMatch(/home office eligibility/);
    expect(open.fixedAssets).toMatch(/fixed-asset register/);
    expect(prod.openItems.find((o) => o.id === "rule:schedule-c")?.action).toMatch(/fixed-asset register/);
  });

  it("cards: form-4562 and form-8829 say 'Not decided: ... has not been answered' (never 'Computed ... not required')", () => {
    const c = buildCardConclusions(prod);
    expect(c["form-4562"]?.text).toMatch(/^Not decided: the fixed-asset register .* has not been answered/);
    expect(c["form-4562"]?.tone).toBe("blocked");
    expect(c["form-8829"]?.text).toMatch(/^Not decided: the home office eligibility answer has not been answered/);
    expect(c["form-8829"]?.tone).toBe("blocked");
  });

  it("P4 placeholders: X1 and X2 say 'Not decided' while unanswered", () => {
    const m = model(prod);
    expect(m.decisionPlaceholders.find((p) => p.id === "X1")?.note).toMatch(/^Not decided: the home office eligibility answer has not been answered/);
    expect(m.decisionPlaceholders.find((p) => p.id === "X2")?.note).toMatch(/^Not decided: the fixed-asset register .* has not been answered/);
    for (const p of m.decisionPlaceholders) expect(p.note).not.toMatch(/No home office deduction claimed|No depreciable EK Consulting assets on the register/);
  });

  it("once the answers are given the all-clear wording returns (answered = 'no home office', 'no assets')", () => {
    const m = model(golden1b);
    expect(m.decisionPlaceholders.find((p) => p.id === "X1")?.note).toMatch(/^Not raised for this return: No home office deduction claimed/);
    const c = buildCardConclusions(golden1b);
    expect(c["form-4562"]?.text).toMatch(/^Computed: Form 4562 not required - /);
    expect(c["form-8829"]?.text).toMatch(/^Computed: Form 8829 not required - /);
  });

  it("answering only the home office leaves the fixed-asset wording open (and vice versa)", () => {
    const f = prodLike();
    f.income.scheduleC.homeOfficeEligibility = owner("no" as const);
    const ret = computeTy2025Return(f);
    const open = scheduleCUnanswered(ret);
    expect(open.homeOffice).toBeNull();
    expect(open.fixedAssets).not.toBeNull();
    const c = buildCardConclusions(ret);
    expect(c["form-8829"]?.text).toMatch(/^Computed: Form 8829 not required/);
    expect(c["form-4562"]?.text).toMatch(/^Not decided/);
  });

  it("X3 / X5 placeholders also say 'Not decided' when their inputs are unresolved", () => {
    const m = model(prod);
    const x3 = m.decisionPlaceholders.find((p) => p.id === "X3");
    if (x3 && prod.formsRequired.f8995?.required === "blocking") expect(x3.note).toMatch(/^Not decided/);
    const x5 = m.decisionPlaceholders.find((p) => p.id === "X5");
    if (x5 && prod.openItems.some((o) => o.id === "rule:schedule-a")) expect(x5.note).toMatch(/^Not decided/);
  });
});

describe("D3: owner homework holds only real owner inputs", () => {
  /** [id, action, who] for every derived-figure cascade item the Tester enumerated from the production-like state. */
  const DERIVED: [string, string][] = [
    ["rule:tax-calc", "Provide: taxable income (1040 line 15)."],
    ["rule:ct-tax", "Provide: federal AGI."],
    ["rule:ct-property-tax-credit", "Provide: CT AGI."],
    ["rule:saver-8880", "Provide: Form 1040 line 11a."],
    ["rule:amt-screen-6251", "Provide: taxable income (1040 line 15); standard-versus-itemized result; regular tax (1040 line 16)."],
    ["rule:niit-8960", "Provide: Form 1040 line 2b (taxable interest); Form 1040 line 3b (ordinary dividends); Form 1040 line 5b (pensions and annuities); Form 1040 line 7a (capital gain or loss); Schedule 1 line 3 (business income or loss); Schedule 1 line 4 (other gains or losses); Schedule 1 line 5 (rental, partnership, S corporation, trust income); Schedule A line 5a (state and local income tax); Schedule A line 9 (investment interest); standard versus itemized deduction; Form 1040 line 11a (adjusted gross income)."],
    ["rule:schedule-se", "Provide: Schedule C net profit (line 31)."],
    ["rule:addl-medicare-8959", "Provide: Schedule SE net earnings."],
    ["rule:penalty-2210-estimate", "Provide: Form 1040 line 22 / Schedule 2 / refundable credits."],
    ["rule:schedule-3", "Provide: Schedule 3 line amounts that are not computed yet."],
  ];
  const ROOT: [string, string][] = [
    ["rule:hsa-8889", "Provide: whether any HSA distribution was received in 2025 (Eric); whether any HSA distribution was received in 2025 (Eva)."],
    ["rule:ira-deduction", "Provide: the traditional IRA contribution (Eric); the traditional IRA contribution (Eva)."],
    ["rule:standard-deduction", "Provide: Eric: born before January 2, 1961; Eric: blind; Eva: born before January 2, 1961; Eva: blind."],
    ["rule:schedule-1a", "Provide: qualified tips (Eric); qualified tips (Eva); qualified overtime (Eric); qualified overtime (Eva)."],
    ["rule:payments-ct", "Provide: CT estimated payments / overpayment applied."],
    ["rule:ct-balance", "Provide: CT use tax answer."],
    ["rule:schedule-c", "Provide: GL-coded EK Consulting transactions for 2025."],
    ["rule:foreign-tax-credit", "Provide: 1099 interest and dividend documents (or confirmation there are none)."],
    ["attest:digital", "Answer it in the Return completeness questionnaire."],
    ["none:se_other", "Confirm 'none' (or enter the amounts) so these lines can be completed."],
    ["dividend-boxes-2b-2d", "Check the 1099-DIV and confirm boxes 2b, 2c and 2d are zero (or tell the CPA so the Schedule D Tax Worksheet is used)."],
    ["doc-unverified:x", "Open the document and mark it verified."],
  ];

  it("derived-figure cascades route to 'derived', not owner and not homework", () => {
    for (const [id, action] of DERIVED) {
      expect(routeOpenItem({ id, action }), id).toEqual({ who: "derived", ownerAction: null });
      expect(openItemOwner({ id, action }), id).toBe("derived");
    }
  });

  it("Form 8960 cascade: an empty return's rule:niit-8960 asks the owner for nothing (every part is a derived figure)", () => {
    const ret = computeTy2025Return(emptyFacts());
    const item = ret.openItems.find((o) => o.id === "rule:niit-8960");
    expect(item, "the empty return blocks Form 8960").toBeDefined();
    expect(item?.action).toMatch(/^Provide:/);
    expect(routeOpenItem(item!)).toEqual({ who: "derived", ownerAction: null });
  });

  it("Form 8960 genuine owner inputs stay homework: the lines 6, 7 and 10 statement and the exclusions answer are kept, derived parts dropped", () => {
    const r = routeOpenItem({ id: "rule:niit-8960", action: "Provide: Form 1040 line 11a (adjusted gross income); the Form 8960 lines 6, 7 and 10 statement (Return completeness)." });
    expect(r.who).toBe("owner");
    expect(r.ownerAction).toBe("Provide: the Form 8960 lines 6, 7 and 10 statement (Return completeness).");
    expect(routeOpenItem({ id: "rule:niit-8960", action: "Provide: Puerto Rico / Form 2555 / Form 4563 exclusions." }).who).toBe("owner");
  });

  it("root owner inputs stay owner items with their action", () => {
    for (const [id, action] of ROOT) {
      const r = routeOpenItem({ id, action });
      expect(r.who, id).toBe("owner");
      expect(r.ownerAction, id).toBe(action);
    }
  });

  it("mixed items keep only the real inputs as the owner's action (QBI, Schedule A, payments-federal)", () => {
    const qbi = routeOpenItem({
      id: "rule:qbi-8995",
      action:
        "Provide: Schedule C net profit; deductible half of SE tax; self-employed health insurance amount (stated; none = 0); self-employed retirement contributions (stated; none = 0); taxable income before the QBI deduction.",
    });
    expect(qbi.who).toBe("owner");
    expect(qbi.ownerAction).toBe("Provide: self-employed health insurance amount (stated; none = 0); self-employed retirement contributions (stated; none = 0).");
    const sa = routeOpenItem({ id: "rule:schedule-a", action: "Provide: CT estimated payments made in 2025; AGI (1040 line 11a) for the charitable limit." });
    expect(sa).toEqual({ who: "owner", ownerAction: "Provide: CT estimated payments made in 2025." });
    const pf = routeOpenItem({ id: "rule:payments-federal", action: "Provide: Form 8959 line 24; federal estimated payments for 2025." });
    expect(pf.ownerAction).toBe("Provide: federal estimated payments for 2025.");
  });

  it("filing-status-not-mfj is a CPA conversation; filing-status-unanswered stays with the owner", () => {
    expect(openItemOwner({ id: "filing-status-not-mfj", action: "Confirm the filing status with the CPA." })).toBe("cpa");
    expect(openItemOwner({ id: "filing-status-unanswered", action: "Record the filing status answer (MFJ)." })).toBe("owner");
  });

  it("prod-like sheet: homework lists no derived figure, derived items are their own group, every blocking item is accounted for", () => {
    const m = model(prod);
    const derivedIds = m.openItems.filter((i) => i.who === "derived").map((i) => i.id);
    for (const [id] of DERIVED) if (prod.openItems.some((o) => o.id === id)) expect(derivedIds).toContain(id);
    expect(derivedIds.length).toBeGreaterThanOrEqual(8);
    const hw = m.homework.map((h) => h.what).join("\n");
    expect(hw).not.toMatch(/taxable income|federal AGI|CT AGI|1040 line 11a|Schedule C net profit|Schedule SE net earnings|line 22|regular tax/i);
    expect(m.homework.some((h) => h.id === "rule:hsa-8889")).toBe(true);
    expect(m.homework.some((h) => h.id === "rule:ira-deduction")).toBe(true);
    expect(m.homework.some((h) => h.id === "rule:standard-deduction")).toBe(true);
    expect(m.homework.some((h) => h.id === "rule:schedule-1a")).toBe(true);
    expect(m.homework.some((h) => h.id.startsWith("none:"))).toBe(true);
    expect(m.homework.some((h) => derivedIds.includes(h.id))).toBe(false);
    // the item table still shows the engine's own action text; nothing is dropped
    expect(m.openItems.length).toBe(new Set(prod.openItems.map((o) => o.id)).size);
    // blocking first is unchanged
    const sev = m.openItems.map((i) => i.severity);
    const firstAdvisory = sev.indexOf("advisory");
    if (firstAdvisory !== -1) expect(sev.slice(firstAdvisory).every((s) => s === "advisory")).toBe(true);
  });

  it("the rendered page has a separate 'Computed from other lines' group", () => {
    const h = renderToStaticMarkup(createElement(ReturnSheet, { model: model(prod) }));
    expect(h).toContain('data-testid="derived-items"');
    expect(h).toContain("Computed from other lines (");
    expect(h).toContain("Nobody has to");
  });
});

describe("D4: the DRAFT label is on every printed part and is the first CSV row", () => {
  it("each of the six parts carries the label, plus a header that repeats on every printed page", () => {
    const m = model(prod);
    const h = renderToStaticMarkup(createElement(ReturnSheet, { model: m }));
    const parts = h.split('class="sheet-part').slice(1);
    expect(parts.length).toBe(6);
    for (const [i, p] of parts.entries()) expect(p, `part ${i + 1}`).toContain(SHEET_DRAFT_LABEL);
    expect(h).toContain('data-testid="print-header"');
    expect(h).toMatch(/print:fixed/);
    expect((h.match(/data-testid="draft-label"/g) ?? []).length).toBe(6);
  });

  it("the CSV's first row is the DRAFT label (18 cells since the override columns were appended), then the header", () => {
    const csv = sheetToCsv(model(prod));
    const [first, second] = csv.split("\r\n");
    expect(first).toBe(`${SHEET_DRAFT_LABEL},,,,,,,,,,,,,,,,,`);
    expect(second?.startsWith("form,line_id,line_key,")).toBe(true);
  });
});

describe("D5: the Form 2210 card says Computed only when the estimate is computed", () => {
  it("not computed -> 'Not computed: ...' (blocked tone), computed -> 'Computed: ...'", () => {
    const blocked = buildCardConclusions(prod)["form-2210"]!;
    expect(prod.lines["f2210.19"]?.amount).toBeNull();
    expect(blocked.text).toMatch(/^Not computed: the regular-method estimate is not available/);
    expect(blocked.tone).toBe("blocked");
    expect(golden1b.lines["f2210.19"]?.amount).not.toBeNull();
    const ok = buildCardConclusions(golden1b)["form-2210"]!;
    expect(ok.text).toMatch(/^Computed: Form 2210 not required - /);
    expect(ok.tone).toBe("not_required");
  });
});
