import React, { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Render smoke tests (no DOM): vitest's esbuild uses the classic JSX runtime for .tsx sources.
(globalThis as { React?: typeof React }).React = React;

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/actions/tax-questionnaires", () => ({
  resetQuestionnaire: vi.fn(),
  saveQuestionnaireAnswer: vi.fn(),
  saveQuestionnaireNote: vi.fn(),
}));
vi.mock("@/actions/tax-questionnaire-prefill", () => ({ acceptPrefillSuggestions: vi.fn() }));

import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { resolveFacts, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { computeTy2025Return } from "@/lib/tax2025/return";
import {
  allocationSummary,
  coveringAnswerPaths,
  enumerateAnswerPaths,
  validateDefinition,
  visibleNodes,
  type AnswerValue,
  type Cond,
  type EffectiveAnswers,
} from "@/lib/tax-questionnaire";
import { RC_OTHER_INCOME_KINDS, RETURN_COMPLETENESS_ID, SOURCE_IDS, questionnaireById } from "@/lib/tax-questionnaire-content";
import { defaultFilingTaxYear, yearNotice } from "@/lib/tax-default-year";
import { YearNotice } from "@/components/tax/forms/year-notice";
import { QuestionnaireRunner, type QuestionnaireRunnerProps } from "@/components/tax/forms/questionnaire-runner";
import { ERIC_ID, EVA_ID, fullFacts, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";
import snapshot from "@/lib/__tests__/fixtures/return-completeness-owner-snapshot.json";

const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
const AT = "2026-10-04T00:00:00.000Z";
const eff = (v: Record<string, AnswerValue>): EffectiveAnswers =>
  Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { value, source: "questionnaire" as const, at: AT, by: null }]));
const shown = (e: EffectiveAnswers): string[] => visibleNodes(def, RC_CONTEXT, e).map((n) => n.id);
const PART_IDS = RC_OTHER_INCOME_KINDS.map((k) => k.amountNode);
const people = [
  { userId: "u-eric", name: "Eric Kinniburgh" },
  { userId: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
];

describe("Round 6: other-income question order and tree integrity", () => {
  it("the tree validates and the order is Yes/No, kinds, total, amount per kind, then the refund follow-ups", () => {
    expect(validateDefinition(def, SOURCE_IDS)).toEqual([]);
    const ids = def.nodes.map((n) => n.id);
    const order = ["g_other_income", "oik", "ga_other_income", ...PART_IDS, "rfitem", "rfdd", "rfee", "rfa17", "rfboxes", "rfexc"];
    const at = order.map((id) => ids.indexOf(id));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at.every((i, k) => k === 0 || i === at[k - 1]! + 1)).toBe(true); // one unbroken block
    expect(def.nodes.find((n) => n.id === "oik")!.prompt).toBe("Which kinds of income was it (pick every kind that applies)?");
  });

  it("every showWhen points only at EARLIER nodes", () => {
    const refs = (c: Cond, into: string[]): string[] => {
      if (c.kind === "in" || c.kind === "hidden") into.push(c.node);
      else for (const x of c.of) refs(x, into);
      return into;
    };
    def.nodes.forEach((n, i) => {
      if (n.showWhen === null) return;
      for (const r of refs(n.showWhen, [])) expect(ids(def.nodes.slice(0, i))).toContain(r);
    });
    function ids(ns: readonly { id: string }[]): string[] {
      return ns.map((n) => n.id);
    }
  });

  it("every other-income node is reachable, and a reachable path exists for each per-kind amount", () => {
    const all = new Set<string>();
    for (const p of coveringAnswerPaths(def, RC_CONTEXT)) for (const id of Object.keys(p)) all.add(id);
    for (const id of ["oik", "ga_other_income", ...PART_IDS, "rfitem", "rfdd", "rfee", "rfa17", "rfboxes", "rfexc"]) expect(all.has(id)).toBe(true);
    // the capped full enumeration never loses a node it did reach either
    const { paths } = enumerateAnswerPaths(def, RC_CONTEXT, 50000);
    expect(paths.length).toBeGreaterThan(0);
  });

  it("no kinds picked yet: nothing after the total; exactly one kind: no per-kind amount question (its amount is the total)", () => {
    expect(shown({})).not.toContain("oik");
    const yes = shown(eff({ g_other_income: "some" }));
    expect(yes).toContain("oik");
    expect(yes).toContain("ga_other_income");
    for (const id of PART_IDS) expect(yes).not.toContain(id);
    for (const k of RC_OTHER_INCOME_KINDS) {
      const one = shown(eff({ g_other_income: "some", oik: [k.id] }));
      for (const id of PART_IDS) expect(one).not.toContain(id);
    }
    expect(shown(eff({ g_other_income: "some", oik: ["refund"] }))).toContain("rfitem");
  });

  it("more than one kind: one amount question per SELECTED kind only, placed before the refund follow-ups", () => {
    const two = shown(eff({ g_other_income: "some", oik: ["refund", "gambling"] }));
    expect(two).toEqual(expect.arrayContaining(["rfamt", "okamt_gambling"]));
    for (const id of ["okamt_unemployment", "okamt_canceled_debt", "okamt_crypto", "okamt_alimony", "okamt_other"]) expect(two).not.toContain(id);
    expect(two.indexOf("okamt_gambling")).toBeLessThan(two.indexOf("rfitem"));
    expect(two.indexOf("ga_other_income")).toBeLessThan(two.indexOf("rfamt"));
    const noRefund = shown(eff({ g_other_income: "some", oik: ["gambling", "alimony"] }));
    expect(noRefund).toEqual(expect.arrayContaining(["okamt_gambling", "okamt_alimony"]));
    expect(noRefund).not.toContain("rfamt");
    expect(noRefund).not.toContain("rfitem");
  });

  it("existing node ids and option ids are all still there; the version did not change", () => {
    const stillThere = ["g_other_income", "ga_other_income", "oik", "rfamt", "rfitem", "rfdd", "rfee", "rfa17", "rfboxes", "rfexc"];
    for (const id of stillThere) expect(def.nodes.some((n) => n.id === id)).toBe(true);
    const oik = def.nodes.find((n) => n.id === "oik");
    expect(oik && oik.kind === "multi" ? oik.options.map((o) => o.id) : []).toEqual(["refund", "unemployment", "gambling", "canceled_debt", "crypto", "alimony", "other", "unsure"]);
    expect(def.version).toBe(2);
  });
});

describe("Round 6: saved answers still parse exactly as before", () => {
  it("the owner's saved answer set parses byte-for-byte the same as with the old tree", () => {
    const stored = snapshot.stored as Record<string, AnswerValue>;
    const parsed = parseCompletenessAnswers(eff(stored), people);
    // The Schedule D capture work added a returnAnswers.capitalGains leaf after the snapshot was taken (unanswered
    // here); everything the owner had already answered must still parse identically.
    const { capitalGains: capitalGainsLeaf, ...returnAnswersWithoutCg } = parsed.returnAnswers as unknown as Record<string, unknown>;
    void capitalGainsLeaf;
    expect(JSON.stringify({ ...parsed, returnAnswers: returnAnswersWithoutCg })).toBe(JSON.stringify(snapshot.parsed));
    // and the saved answers still show the same visible nodes: the single refund kind adds no new question
    expect(shown(eff(stored))).not.toContain("okamt_refund");
  });
});

describe("Round 6: allocation helper", () => {
  const vis = (e: EffectiveAnswers) => new Set(shown(e));
  const gambling = def.nodes.find((n) => n.id === "okamt_gambling")!;
  const base: Record<string, AnswerValue> = { g_other_income: "some", oik: ["refund", "gambling"], ga_other_income: 400_000 };

  it("shows allocated of total and what is left", () => {
    const e = eff({ ...base, rfamt: 100_000 });
    const s = allocationSummary(gambling, e, vis(e))!;
    expect(s.allocatedCents).toBe(100_000);
    expect(s.leftCents).toBe(300_000);
    expect(s.text).toContain("Allocated $1,000.00 of $4,000.00");
    expect(s.text).toContain("$3,000.00 left to allocate");
  });
  it("fully allocated, and a clear mismatch message when too much", () => {
    const ok = eff({ ...base, rfamt: 100_000, okamt_gambling: 300_000 });
    expect(allocationSummary(gambling, ok, vis(ok))!.text).toContain("Fully allocated");
    const over = eff({ ...base, rfamt: 100_000, okamt_gambling: 400_000 });
    const s = allocationSummary(gambling, over, vis(over))!;
    expect(s.leftCents).toBe(-100_000);
    expect(s.text).toContain("Too much");
    expect(s.text).toContain("$1,000.00 over");
  });
  it("only counts the kinds that are showing; no allocation on other questions", () => {
    const e = eff({ ...base, rfamt: 100_000, okamt_alimony: 999_999 }); // alimony not selected -> hidden -> ignored
    expect(allocationSummary(gambling, e, vis(e))!.allocatedCents).toBe(100_000);
    expect(allocationSummary(def.nodes.find((n) => n.id === "fe1")!, e, vis(e))).toBeNull();
  });
  it("the runner prints the helper under the amount question", () => {
    const e = eff({ ...base, rfamt: 100_000 });
    const props: QuestionnaireRunnerProps = {
      year: 2025,
      def,
      entityId: "22222222-2222-4222-8222-222222222222",
      ctx: RC_CONTEXT,
      effective: e,
      bound: {},
      note: null,
      noteMeta: null,
      stale: false,
      userNames: {},
      meId: "u1",
      planningLinks: [],
    };
    const html = renderToStaticMarkup(createElement(QuestionnaireRunner, props));
    expect(html).toContain("left to allocate");
  });
});

function multiKind(parts: Record<string, number>, total: number | null = 150_000, kinds = Object.keys(parts)) {
  const f = fullFacts1b();
  f.statedNone.other_income = owner(false);
  const ra = f.returnAnswers;
  if (total === null) delete ra.statedSomeAmounts.other_income;
  else ra.statedSomeAmounts.other_income = owner(total);
  const oi = ra.otherIncome!;
  oi.kinds = owner(kinds);
  oi.kindAmountsCents = owner(parts);
  oi.refundCents = owner(parts.refund ?? 0);
  oi.deduction2024 = owner("standard");
  return f;
}
function rawFor(f: ReturnType<typeof fullFacts1b>): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC_ID, name: "Eric K" },
      { userId: EVA_ID, name: "Eva" },
    ],
    scheduleCOwner: null,
    documents: [],
    planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    answers: { statedNone: {}, returnAnswers: f.returnAnswers },
    primaryResidence: null,
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}
const alloc = (f: ReturnType<typeof multiKind>) => resolveFacts(rawFor(f)).openItems.find((o) => o.id === "other-income-allocation");

describe("Round 6: the amounts by kind must add up to the total", () => {
  it("adding up exactly: no allocation item", () => {
    expect(alloc(multiKind({ refund: 100_000, unemployment: 50_000 }))).toBeUndefined();
  });
  it("within a cent: no item; two cents off: a BLOCKING item with the numbers", () => {
    expect(alloc(multiKind({ refund: 100_000, unemployment: 49_999 }))).toBeUndefined();
    expect(alloc(multiKind({ refund: 100_000, unemployment: 50_001 }))).toBeUndefined();
    const two = alloc(multiKind({ refund: 100_000, unemployment: 49_998 }))!;
    expect(two.severity).toBe("blocking");
    expect(two.message).toContain("add up to $1499.98");
    expect(two.message).toContain("total is $1500.00");
  });
  it("under and over say which way", () => {
    const under = alloc(multiKind({ refund: 100_000, unemployment: 20_000 }))!;
    expect(under.severity).toBe("blocking");
    expect(under.message).toContain("$300.00 left to allocate");
    expect(alloc(multiKind({ refund: 100_000, unemployment: 80_000 }))!.message).toContain("$300.00 over");
  });
  it("a picked kind with no amount, or no total, is blocking too", () => {
    const missing = alloc(multiKind({ refund: 100_000 }, 150_000, ["refund", "unemployment"]))!;
    expect(missing.severity).toBe("blocking");
    expect(missing.message).toContain("unemployment");
    expect(alloc(multiKind({ refund: 100_000, unemployment: 50_000 }, null))?.severity).toBe("blocking");
  });
  it("one kind only: never an allocation item (its amount is the total)", () => {
    expect(alloc(multiKind({ refund: 150_000 }))).toBeUndefined();
  });
});

describe("Round 6: the refund amount comes from the answers, not a guess", () => {
  const stored = { g_other_income: "some" as const, ga_other_income: 1_200_000 };
  it("one kind: the total is the refund; an older saved refund amount is still honoured", () => {
    const one = parseCompletenessAnswers(eff({ ...stored, oik: ["refund"], rfitem: "standard" }), people).returnAnswers.otherIncome!;
    expect(one.refundCents.value).toBe(1_200_000);
    const legacy = parseCompletenessAnswers(eff({ ...stored, oik: ["refund"], rfamt: 900_000, rfitem: "standard" }), people).returnAnswers.otherIncome!;
    expect(legacy.refundCents.value).toBe(900_000);
  });
  it("several kinds: the refund is its own per-kind amount and the split is carried to the engine", () => {
    const many = parseCompletenessAnswers(eff({ ...stored, oik: ["refund", "unemployment"], rfamt: 900_000, okamt_unemployment: 300_000, rfitem: "standard" }), people).returnAnswers.otherIncome!;
    expect(many.refundCents.value).toBe(900_000);
    expect(many.kindAmountsCents?.value).toEqual({ refund: 900_000, unemployment: 300_000 });
  });
  it("several kinds, itemized in 2024: Schedule 1 line 1 uses the refund part (9,000 -> 1,000), not the total (12,000 would give 4,000)", () => {
    const f = multiKind({ refund: 900_000, unemployment: 300_000 }, 1_200_000);
    const oi = f.returnAnswers.otherIncome!;
    oi.deduction2024 = owner("itemized_income");
    oi.sch5dCents = owner(1_800_000);
    oi.sch5eCents = owner(1_000_000);
    oi.sch17Cents = owner(3_500_000);
    oi.boxes2024 = owner(0);
    oi.exceptionApplies = owner(false);
    const r = computeTy2025Return(f);
    expect(r.lines["sch1.1"]?.amount).toBe(1000);
    expect(alloc(f)).toBeUndefined();
  });
  it("golden return unchanged: federal 27,015, CT 8,788", () => {
    const g = computeTy2025Return(fullFacts());
    expect(g.headline.federal.totalTax.amount).toBe(27015);
    expect(g.headline.connecticut.tax.amount).toBe(8788);
  });
});

describe("Round 6: wrong-year notice", () => {
  it("none for the filing year; otherwise says the viewed year, the due date and links to the same page for the filing year", () => {
    expect(defaultFilingTaxYear(new Date("2026-10-04T12:00:00Z"))).toBe(2025);
    expect(yearNotice(2025, 2025, "/tax/forms/2025")).toBeNull();
    const n = yearNotice(2024, 2025, "/tax/forms/2025")!;
    expect(n.message).toBe("You are viewing 2024. The return due Oct 15, 2026 is for 2025:");
    expect(n.href).toBe("/tax/forms/2025");
  });
  it("renders on a non-filing year, with the link, and renders nothing for the filing year", () => {
    const html = renderToStaticMarkup(createElement(YearNotice, { viewedYear: 2024, defaultYear: 2025, hrefForDefaultYear: "/tax/forms/2025/questionnaire/return-completeness?entity=e1" }));
    expect(html).toContain("You are viewing 2024. The return due Oct 15, 2026 is for 2025:");
    expect(html).toContain('href="/tax/forms/2025/questionnaire/return-completeness?entity=e1"');
    expect(html).toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(YearNotice, { viewedYear: 2025, defaultYear: 2025, hrefForDefaultYear: "/x" }))).toBe("");
  });
  it("both pages render the notice", async () => {
    const { readFileSync } = await import("node:fs");
    for (const p of ["app/tax/forms/[year]/page.tsx", "app/tax/forms/[year]/questionnaire/[questionnaireId]/page.tsx"]) {
      expect(readFileSync(p, "utf8")).toContain("<YearNotice");
    }
  });
});
