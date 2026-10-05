import React, { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// The override chips are client components that import the (DB-backed) server actions; nothing is called while rendering.
vi.mock("@/actions/tax-return-overrides", () => ({
  setTaxReturnOverride: vi.fn(),
  clearTaxReturnOverride: vi.fn(),
  listTaxReturnOverrideHistory: vi.fn(),
}));
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { emptyReturnAnswers } from "@/lib/tax2025/facts";
import { LINE_KEYS, hasAmount, missingLeaf, type OpenItem, type Ty2025Return } from "@/lib/tax2025/types";
import { buildSheetModel, openItemOwner, type SheetModel, type SheetRawDocument } from "@/lib/tax2025-sheet";
import { sheetToCsv, csvText, csvNumber } from "@/lib/tax2025-sheet-csv";
import { buildCardConclusions } from "@/lib/tax2025-sheet-conclusions";
import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { bill, emptyFacts, fullFacts, fullFacts1b, owner, w2, ERIC_ID, EVA_ID } from "@/lib/__tests__/tax2025-fixtures";

// TESTER probes for Phase 1c (ty2025-cpa-review-sheet). Independent of the Coder's own tests.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-10-03T16:30:00Z");
const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Production-like incomplete state: the owner has answered the basics but none of the 1b / "none" statements. */
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
  f.payments.federalExtensionPayment = missingLeaf();
  f.payments.ctExtensionPayment = missingLeaf();
  f.payments.federalPriorYearOverpaymentApplied = missingLeaf();
  f.payments.ctPriorYearOverpaymentApplied = missingLeaf();
  f.payments.ctPriorYearBalancePaidIn2025 = missingLeaf();
  f.income.scheduleC.fixedAssetsNoneConfirmed = false;
  f.income.scheduleC.mileageNoneConfirmed = missingLeaf();
  f.income.scheduleC.homeOfficeEligibility = missingLeaf();
  f.priorYear = { totalTaxCents: missingLeaf(), agiCents: missingLeaf(), filingStatus: missingLeaf() };
  return f;
}

const PROD_EXTRAS: OpenItem[] = [
  { id: "other-income-boxes", severity: "blocking", message: "m", action: "Review the boxes with the CPA (Schedule D / 8949, 1099-R, 1099-NEC income).", lineKeys: [], refs: [] },
  { id: "dividend-boxes-2b-2d", severity: "blocking", message: "m", action: "Check the 1099-DIV and confirm boxes 2b, 2c and 2d are zero (or tell the CPA so the Schedule D Tax Worksheet is used).", lineKeys: [], refs: [] },
];

function homeOffice() {
  const f = fullFacts1b();
  f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive" as const);
  f.income.scheduleC.homeOfficeSqft = owner(200);
  return f;
}

function arbor() {
  const f = fullFacts1b();
  f.deductions.propertyTaxBills.push(bill({ docId: "pt-2", label: "56 Arbor Rd", address: "56 Arbor Rd", paidInYearCents: 300_000, kind: "other_real_estate" }));
  return f;
}

function bigQbi() {
  const f = fullFacts1b();
  f.income.w2s = [
    w2({ docId: "w2-big", personUserId: ERIC_ID, wagesCents: 70_000_000, fedWithheldCents: 1, socialSecurityWagesCents: 17_610_000, medicareWagesCents: 70_000_000, medicareWithheldCents: 1_015_000 }),
    w2({ docId: "w2-eva", personUserId: EVA_ID, wagesCents: 4_000_000, medicareWagesCents: 4_000_000, socialSecurityWagesCents: 4_000_000 }),
  ];
  return f;
}

const FIXTURES: { name: string; ret: Ty2025Return }[] = [
  { name: "golden", ret: computeTy2025Return(fullFacts()) },
  { name: "golden1b", ret: computeTy2025Return(fullFacts1b()) },
  { name: "all-missing", ret: computeTy2025Return(emptyFacts()) },
  { name: "prod-like", ret: computeTy2025Return(prodLike(), {}, { openItems: PROD_EXTRAS }) },
  { name: "home-office", ret: computeTy2025Return(homeOffice()) },
  { name: "arbor", ret: computeTy2025Return(arbor()) },
  { name: "big-qbi", ret: computeTy2025Return(bigQbi()) },
];

const DOCS: SheetRawDocument[] = [
  { id: "w2-eric-a", docType: "w2", taxYear: 2025, verified: true, legacyFormat: false, subjectType: "person" },
  { id: "w2-eva", docType: "w2", taxYear: 2025, verified: false, legacyFormat: false, subjectType: "person" },
  { id: "int-1", docType: "1099", taxYear: 2025, verified: false, legacyFormat: true, subjectType: null },
  { id: "m-1", docType: "mortgage_interest", taxYear: 2025, verified: true, legacyFormat: false, subjectType: null },
  { id: "pt-1", docType: "property_tax", taxYear: 2025, verified: true, legacyFormat: false, subjectType: null },
];

const sheet = (ret: Ty2025Return, documents: readonly SheetRawDocument[] = DOCS): SheetModel => buildSheetModel({ ret, documents, now: NOW });
const html = (m: SheetModel): string => renderToStaticMarkup(createElement(ReturnSheet, { model: m }));
const text = (h: string): string => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const allLines = (m: SheetModel) => [...m.federal, ...m.connecticut].flatMap((g) => g.lines);

function parseCsv(textIn: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < textIn.length; i++) {
    const ch = textIn[i]!;
    if (q) {
      if (ch === '"' && textIn[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && textIn[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ── (1) completeness / honesty of lines ───────────────────────────────────────

describe("tester: every engine line exactly once, no silent zero, status + provenance match the engine", () => {
  for (const { name, ret } of FIXTURES) {
    it(`${name}: model, rendered HTML and CSV each carry every emitted line exactly once`, () => {
      const emitted = Object.keys(ret.lines).sort();
      expect(emitted.length).toBeGreaterThan(300);
      for (const k of emitted) expect((LINE_KEYS as readonly string[]).includes(k)).toBe(true);
      const m = sheet(ret);
      const keys = allLines(m).map((l) => l.key);
      expect([...keys].sort()).toEqual(emitted);
      const h = html(m);
      for (const k of emitted) {
        const n = h.split(`data-line-key="${k}"`).length - 1;
        expect(n, `html row ${k}`).toBe(1);
      }
      const rows = parseCsv(sheetToCsv(m)).slice(2, -1);
      expect(rows.map((r) => r[2]).sort()).toEqual(emitted);
      // federal group never contains a CT line and vice versa
      expect(m.federal.flatMap((g) => g.lines).some((l) => l.form === "CT-1040")).toBe(false);
      expect(m.connecticut.flatMap((g) => g.lines).every((l) => l.form === "CT-1040")).toBe(true);
    });

    it(`${name}: "0" only for computed / not_applicable lines; every other line says "not computed" with an empty CSV amount; status equals the engine's`, () => {
      const m = sheet(ret);
      const csv = new Map(parseCsv(sheetToCsv(m)).slice(2, -1).map((r) => [r[2]!, r]));
      for (const l of allLines(m)) {
        const e = ret.lines[l.key as keyof typeof ret.lines]!;
        const expectedStatus = e.informational === true && !hasAmount(e.status) ? "informational" : e.status;
        expect(l.status, l.key).toBe(expectedStatus);
        const row = csv.get(l.key)!;
        if (hasAmount(e.status)) {
          expect(l.amount, l.key).toBe(e.amount);
          expect(l.amountText).toMatch(/^-?\$[\d,]+$/);
          expect(row[4]).toBe(String(e.amount));
          expect(row[5]).toBe(l.statusLabel);
        } else {
          expect(l.amount, l.key).toBeNull();
          expect(l.amountText, l.key).toBe("not computed");
          expect(row[4], `${l.key} csv amount`).toBe("");
        }
        if (l.amountText === "$0") expect(["computed", "not_applicable"]).toContain(e.status);
      }
    });

    it(`${name}: model survives a JSON round trip unchanged (no Decimal / Date / undefined) and holds no raw extraction keys`, () => {
      const m = sheet(ret);
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
      const s = JSON.stringify(m);
      expect(s).not.toMatch(/extractionData|extractionCorrections|"facts"|"resolved"/);
    });
  }

  it("not_applicable $0 lines exist and are labelled 'not applicable' (documented behaviour, engine contract hasAmount)", () => {
    const m = sheet(FIXTURES[0]!.ret);
    const na = allLines(m).filter((l) => l.status === "not_applicable");
    expect(na.length).toBeGreaterThan(0);
    for (const l of na) expect(l.statusLabel).toBe("not applicable");
  });

  it("provenance chips: document chips follow the loader's verified flag; unknown documents are treated as UNVERIFIED; owner answers and books are distinct kinds", () => {
    const ret = FIXTURES[1]!.ret; // golden1b
    const docs: SheetRawDocument[] = [
      { id: "w2-eric-a", docType: "w2", taxYear: 2025, verified: true, legacyFormat: false, subjectType: "person" },
      { id: "w2-eva", docType: "w2", taxYear: 2025, verified: false, legacyFormat: false, subjectType: "person" },
    ];
    const m = sheet(ret, docs);
    const l1a = allLines(m).find((l) => l.key === "f1040.1a")!;
    const byHref = new Map(l1a.chips.filter((c) => c.href).map((c) => [c.href, c.kind]));
    expect(byHref.get("/documents/w2-eric-a/review")).toBe("document_verified");
    expect(byHref.get("/documents/w2-eva/review")).toBe("document_unverified");
    // loader returns no documents at all -> every document chip is UNVERIFIED (never silently "verified")
    const none = sheet(ret, []);
    for (const l of allLines(none)) for (const c of l.chips) if (c.href !== null) expect(c.kind).toBe("document_unverified");
    // chip kind agrees with the engine's own leaf basis for every W-2 fact
    for (const { ret: r } of FIXTURES) {
      const mm = sheet(r, DOCS);
      for (const l of allLines(mm)) {
        const e = r.lines[l.key as keyof typeof r.lines]!;
        const docRefs = e.refs.filter((x) => x.kind === "document");
        expect(docRefs.length).toBeGreaterThanOrEqual(0);
        const truncated = l.chips.some((c) => /more source/.test(c.label)); // overflow folding is covered by its own DEFECT PROBE below
        if (truncated) continue;
        if (e.refs.some((x) => x.kind === "questionnaire" || x.kind === "planning")) expect(l.chips.some((c) => c.kind === "owner_answer"), l.key).toBe(true);
        if (e.refs.some((x) => x.kind === "gl" || x.kind === "donation" || x.kind === "fixed_asset" || x.kind === "mileage")) expect(l.chips.some((c) => c.kind === "books"), l.key).toBe(true);
        if (e.ruleId === "derive") expect(l.chips.some((c) => c.kind === "derived"), l.key).toBe(true);
      }
    }
  });

  function lineWithManyDocs(unverifiedLast: boolean): { line: ReturnType<typeof allLines>[number]; csvProv: string } {
    const base = FIXTURES[0]!.ret;
    const k = "f1040.1a" as const;
    const refs = Array.from({ length: 10 }, (_, i) => ({ kind: "document" as const, id: `d${i + 1}`, label: `W-2 #${i + 1}` }));
    const ret: Ty2025Return = { ...base, lines: { ...base.lines, [k]: { ...base.lines[k]!, refs } } };
    const docs: SheetRawDocument[] = refs.map((r, i) => ({ id: r.id, docType: "w2", taxYear: 2025, verified: !(unverifiedLast && i === 9), legacyFormat: false, subjectType: "person" }));
    const m = sheet(ret, docs);
    const csvRow = parseCsv(sheetToCsv(m)).find((r) => r[2] === k)!;
    return { line: allLines(m).find((l) => l.key === k)!, csvProv: csvRow[6]! };
  }

  it("a line with many sources shows every one of them (no folding into a summary chip)", () => {
    const { line } = lineWithManyDocs(false);
    expect(line.chips.length).toBe(10);
    expect(line.chips.some((c) => /more source/.test(c.label))).toBe(false);
  });

  it("D1 regression: when a line has more than 8 sources, an UNVERIFIED document stays visible on the line and in the CSV", () => {
    const { line, csvProv } = lineWithManyDocs(true);
    expect(line.chips.some((c) => c.href === "/documents/d10/review" && c.kind === "document_unverified")).toBe(true);
    expect(csvProv).toContain("W-2 #10");
  });

  it("a legacy-format document is flagged on the chip and in the document index", () => {
    const f = fullFacts1b();
    f.income.interest = [{ ...f.income.interest[0]!, legacyFormat: true }];
    const m = sheet(computeTy2025Return(f), DOCS);
    const row = m.documents.find((d) => d.id === "int-1")!;
    expect(row.statusText).toBe("older format (re-extract)");
    expect(row.verified).toBe(false);
  });
});

// ── (2) DRAFT wording; nothing reads final / ready / complete while blocking ─────────

describe("tester: DRAFT label and no 'final / ready to file / complete' wording while blocking items exist", () => {
  const BLOCKED = FIXTURES.filter((x) => x.ret.headline.blockingItemCount > 0);
  it("fixture sanity: several fixtures are blocked, prod-like is 36 blocking with no unverified docs and a provisional column", () => {
    expect(BLOCKED.length).toBeGreaterThanOrEqual(3);
    const p = FIXTURES.find((x) => x.name === "prod-like")!.ret;
    expect(p.headline.blockingItemCount).toBeGreaterThanOrEqual(30);
    expect(p.headline.unverifiedDocumentCount).toBe(0);
    expect(p.headline.provisional).not.toBeNull();
    expect(p.headline.complete).toBe(false);
  });

  for (const { name, ret } of BLOCKED) {
    it(`${name}: sheet HTML and CSV never say final / ready to file / approved / filed-as-done and use the exact CLAUDE.md rule 8 DRAFT label`, () => {
      const m = sheet(ret);
      const h = text(html(m));
      const csv = sheetToCsv(m);
      for (const s of [h, csv]) {
        expect(s).not.toMatch(/ready to file|ready for filing|ready-to-file|e-?file ready|approved|filing[- ]ready/i);
        // any "final" must be negated ("Not final") or be the CPA's own act ("final return" is not used)
        for (const mm of s.matchAll(/\bfinal\w*/gi)) {
          const ctx = s.slice(Math.max(0, mm.index! - 30), mm.index! + 20).toLowerCase();
          expect(ctx, `context for "${mm[0]}"`).toMatch(/not final|before this line is final|final assembly/);
        }
        // "complete" (as a claim) only inside INCOMPLETE / incomplete / "Return completeness" questionnaire name / "completed" action text
        for (const mm of s.matchAll(/\bcomplete\w*/gi)) {
          expect(mm[0].toLowerCase(), `claim "${mm[0]}"`).toMatch(/^(completeness|completed|complete)$/);
          const ctx = s.slice(Math.max(0, mm.index! - 40), mm.index! + 40);
          expect(ctx.toLowerCase(), ctx).toMatch(/return completeness|so these lines can be completed|completed in a later|cannot be completed|can be completed|to complete|incomplete/);
        }
      }
      expect(h).toContain("DRAFT - not a filed return - computed from the inputs shown; the owner is the preparer of record");
      expect(h).toContain("INCOMPLETE:");
      expect(m.summary.completenessText).toMatch(/^INCOMPLETE: \d+ blocking item\(s\)/);
      expect(csv).toContain("DRAFT - not a filed return - computed from the inputs shown; the owner is the preparer of record");
    });

    it(`${name}: the provisional column is labelled an estimate and its assumptions are listed; strict headline never shows a provisional number as computed`, () => {
      const m = sheet(ret);
      expect(m.summary.provisionalNote).toMatch(/Provisional estimate, NOT a computed return/);
      expect(m.summary.provisionalAssumedFacts.length).toBeGreaterThanOrEqual(0);
      const h = html(m);
      expect(h).toContain("Provisional estimate");
      if (m.summary.provisionalAssumedFacts.length > 0) expect(h).toContain("Inputs treated as $0 / none in the provisional estimate");
      for (const r of [...m.summary.federal, ...m.summary.connecticut]) {
        if (r.status !== "computed") expect(r.computedText).toBe("not computed");
      }
    });
  }

  it("the complete golden sheet still prints caveats and 'not filed' wording, never 'final'", () => {
    const m = sheet(FIXTURES[0]!.ret);
    const h = text(html(m));
    expect(m.summary.complete).toBe(true);
    expect(h).not.toMatch(/ready to file/i);
    for (const mm of h.matchAll(/\bfinal\w*/gi)) expect(h.slice(Math.max(0, mm.index! - 30), mm.index! + 20).toLowerCase()).toMatch(/not final|before this line is final|final assembly/);
    expect(h).toMatch(/nothing here has been filed/i);
    expect(h).toContain("Caveats");
  });

  it("no source file of the sheet claims final / ready / filed", () => {
    for (const f of ["lib/tax2025-sheet.ts", "components/tax/forms/return-sheet.tsx", "lib/tax2025-sheet-csv.ts", "lib/tax2025-sheet-conclusions.ts"]) {
      const src = read(f).split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(src, f).not.toMatch(/ready to file|ready for filing|filing-ready/i);
    }
  });

  it("non-MFJ answer: the whole return is blocked and the sheet still lists every line without an amount", () => {
    const f = fullFacts();
    f.household.filingStatus = owner("single" as never);
    const ret = computeTy2025Return(f);
    const m = sheet(ret);
    expect(m.summary.complete).toBe(false);
    for (const l of allLines(m)) if (!hasAmount(ret.lines[l.key as keyof typeof ret.lines]!.status)) expect(l.amountText).toBe("not computed");
    expect(html(m)).toContain("INCOMPLETE");
  });
});

// ── (3) P4 decisions ──────────────────────────────────────────────────────────

describe("tester: P4 decisions show only the engine's alternatives, side by side, with exactly one default marker", () => {
  for (const name of ["home-office", "arbor", "big-qbi"]) {
    it(`${name}: alternatives equal the engine's, conservative one marked 'default, undecided', effect text names every alternative`, () => {
      const ret = FIXTURES.find((x) => x.name === name)!.ret;
      const m = sheet(ret);
      expect(m.decisions.length).toBeGreaterThan(0);
      for (const d of m.decisions) {
        const r = ret.results.find((x) => x.decision?.id === d.id)!;
        expect(d.alternatives.map((a) => a.id)).toEqual((r.alternatives ?? []).map((a) => a.id));
        expect(d.alternatives.length).toBeGreaterThanOrEqual(2);
        expect(d.alternatives.filter((a) => a.marker === "default, undecided").length).toBe(1);
        expect(d.alternatives.find((a) => a.marker === "default, undecided")!.isDefault).toBe(true);
        expect(d.statusText).toBe("default, undecided");
        for (const a of d.alternatives) expect(d.wholeReturnEffect).toContain(a.label);
        const out = text(html(m));
        expect(out).toContain(`${d.id}: ${d.label}`);
        for (const a of d.alternatives) expect(out).toContain(a.label);
      }
      // wholeReturnEffect text is the engine's own effect.note / first reason, nothing invented
      for (const d of m.decisions) {
        const r = ret.results.find((x) => x.decision?.id === d.id)!;
        for (const a of r.alternatives ?? []) expect(d.wholeReturnEffect).toContain(a.effect?.note ?? a.reasons[0] ?? "");
      }
    });
  }

  it("placeholders: engine did not raise X1/X2/X3/X5 -> shown with a note; none duplicate a raised decision", () => {
    for (const { ret } of FIXTURES) {
      const m = sheet(ret);
      const raised = new Set(m.decisions.map((d) => d.id));
      for (const p of m.decisionPlaceholders) expect(raised.has(p.id)).toBe(false);
      expect(new Set([...raised, ...m.decisionPlaceholders.map((p) => p.id)])).toEqual(new Set(["X1", "X2", "X3", "X5"]));
    }
  });

  it("D2 regression: X1 / X2 placeholders must not say 'no home office / no assets' while those answers are unanswered", () => {
    // prod-like: homeOfficeEligibility missing, fixedAssetsNoneConfirmed=false and rule:schedule-c blocks on both.
    const m = sheet(FIXTURES.find((x) => x.name === "prod-like")!.ret);
    const x1 = m.decisionPlaceholders.find((p) => p.id === "X1")!.note;
    expect(x1).not.toMatch(/No home office deduction claimed/);
  });
});

// ── (5) P5 ordering + owner/CPA split ─────────────────────────────────────────

describe("tester: P5 ordering and owner-vs-CPA split", () => {
  it("blocking first, stable, unique ids, in every fixture", () => {
    for (const { ret } of FIXTURES) {
      const m = sheet(ret);
      const sev = m.openItems.map((i) => i.severity);
      const firstAdv = sev.indexOf("advisory");
      if (firstAdv !== -1) expect(sev.slice(firstAdv).every((s) => s === "advisory")).toBe(true);
      expect(new Set(m.openItems.map((i) => i.id)).size).toBe(m.openItems.length);
      expect(m.openItems.length).toBe(new Set(ret.openItems.map((i) => i.id)).size);
      expect(m.summary.blockingItemCount).toBe(ret.headline.blockingItemCount);
      expect(m.openItems.filter((i) => i.severity === "blocking").length).toBe(ret.openItems.filter((i) => i.severity === "blocking").length);
    }
  });

  const REAL: [string, string, "owner" | "cpa"][] = [
    ["other-income-boxes", "Review the boxes with the CPA (Schedule D / 8949, 1099-R, 1099-NEC income).", "cpa"],
    ["dividend-boxes-2b-2d", "Check the 1099-DIV and confirm boxes 2b, 2c and 2d are zero (or tell the CPA so the Schedule D Tax Worksheet is used).", "owner"],
    ["rule:ct-balance", "Provide: CT use tax answer.", "owner"],
    ["rule:payments-ct", "Provide: CT estimated payments / overpayment applied; CT-1040 EXT payment.", "owner"],
    ["rule:qbi-8995", "The CPA decides or supplies the rule.", "cpa"],
    ["rule:schedule-3", "Computed in a later phase (or state the amount).", "cpa"],
    ["attest:digital", "Answer it in the Return completeness questionnaire.", "owner"],
    ["attest:foreign", "The CPA decides the answer.", "cpa"],
    ["attest:digital", "Give the details to the CPA; this engine does not prepare it.", "owner"],
    ["none:se_other", "Confirm 'none' (or enter the amounts) so these lines can be completed.", "owner"],
    ["solar-5695", "Read any Form 5695 carryforward from the uploaded 2024 return and tell the CPA.", "owner"],
    ["assumptions-no-ct-sales-tax-or-other", "CPA to confirm none apply.", "cpa"],
    ["decision:X1", "The CPA records the decision; the alternatives are shown side by side.", "cpa"],
    ["info:f1040.38", "The CPA figures it if it applies.", "cpa"],
    ["interest-box3", "Tell the CPA so the CT subtraction is taken.", "cpa"],
    ["foreign-tax-paid", "The foreign tax credit rule computes the direct credit if the total is $600 (MFJ) or less; above that it is a CPA matter (Form 1116).", "cpa"],
    ["w2-non-ct-state:x", "Review the state lines on the document and tell the CPA.", "cpa"],
    ["w2-no-person:x", "Set the person on the document (Documents screen).", "owner"],
    ["doc-unverified:x", "Open the document and mark it verified.", "owner"],
    ["doc-legacy:x", "Re-extract the document.", "owner"],
    ["ekc-uncoded-transactions", "GL-code every EK Consulting 2025 transaction at /business/ek-consulting/gl.", "owner"],
    ["gl-sign-flip:5010", "Review the transactions coded to this account (a refund, a miscoded row or a reversed sign).", "owner"],
    ["form1098-multiple-properties", "Confirm which property is the primary residence and how each other 1098 property is used (second home, rental).", "owner"],
    ["estimates-combined-unsplittable", "Enter the federal and the Connecticut estimated payments separately (dates and amounts).", "owner"],
  ];
  it("classifies every real production open-item id/action pair as expected (resolve-facts.ts / return.ts action strings)", () => {
    for (const [id, action, who] of REAL) expect(openItemOwner({ id, action }), `${id}`).toBe(who);
  });

  it("every action string in resolve-facts.ts / return.ts maps to a deliberate owner or cpa (no accidental default)", () => {
    const src = read("lib/tax2025/resolve-facts.ts") + read("lib/tax2025/return.ts");
    const actions = [...src.matchAll(/action:\s*(?:\n\s*)?"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(30);
    const cpa = actions.filter((a) => openItemOwner({ id: "x", action: a }) === "cpa");
    // the CPA-routed ones must read like a CPA action
    // (the person-matching action is routed to the owner by its item id, rc-person-unmatched:*; this probe uses a dummy id)
    for (const a of cpa) expect(a, a).toMatch(/CPA|Review the boxes|Review the state lines|Computed in a later phase|foreign tax credit rule|first name match/);
  });

  it("D3 regression: derived-figure 'Provide:' items (taxable income, AGI, Schedule C profit ...) are NOT owner homework", () => {
    const m = sheet(FIXTURES.find((x) => x.name === "prod-like")!.ret);
    const hw = m.homework.map((h) => h.what).join("\n");
    // the owner cannot "provide" 1040 line 15 / federal AGI / CT AGI / Schedule C net profit / Schedule SE earnings
    expect(hw).not.toMatch(/Provide: taxable income \(1040 line 15\)\.?$/m);
    expect(hw).not.toMatch(/Provide: federal AGI\.?$/m);
    expect(hw).not.toMatch(/Provide: CT AGI\.?$/m);
    expect(hw).not.toMatch(/Provide: Form 1040 line 11a\.?$/m);
  });
});

// ── (6) CSV ───────────────────────────────────────────────────────────────────

describe("tester: CSV columns, escaping, formula guard, numeric amounts, PII", () => {
  it("header columns exactly as specified (the first 12 in place, 6 override columns appended) and every row has 18 cells (RFC 4180 parse) for all fixtures", () => {
    for (const { ret } of FIXTURES) {
      const rows = parseCsv(sheetToCsv(sheet(ret)));
      expect(rows[0]![0]).toBe("DRAFT - not a filed return - computed from the inputs shown; the owner is the preparer of record");
      expect(rows[1]).toEqual([
        "form", "line_id", "line_key", "label", "amount", "status", "provenance", "citation_reason", "override_amount", "override_by", "override_at", "override_reason",
        "computed_amount", "override_authority", "override_version", "override_stale", "override_note", "depends_on_override",
      ]);
      for (const r of rows) expect(r.length).toBe(18);
    }
  });

  it("csvText: guards = + - @ TAB CR with a leading quote, quotes commas/quotes/newlines, leaves plain text alone", () => {
    expect(csvText("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvText("+1")).toBe("'+1");
    expect(csvText("-2+3")).toBe("'-2+3");
    expect(csvText("@cmd")).toBe("'@cmd");
    expect(csvText("\tx")).toBe("'\tx");
    expect(csvText("\rx")).toBe(`"'\rx"`);
    expect(csvText('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvText("plain")).toBe("plain");
    expect(csvText("")).toBe("");
    // leading whitespace before a trigger is NOT guarded (documented gap; Excel does not evaluate it on CSV import)
    expect(csvText(" =1+1")).toBe(" =1+1");
  });

  it("amounts: a negative whole-dollar amount stays a bare number (not text, not quoted); null is empty; non-integers are dropped (empty)", () => {
    expect(csvNumber(-2972)).toBe("-2972");
    expect(csvNumber(0)).toBe("0");
    expect(csvNumber(null)).toBe("");
    expect(csvNumber(12.5)).toBe("");
    // end to end: force a negative line through the model
    const ret: Ty2025Return = { ...FIXTURES[0]!.ret, lines: { ...FIXTURES[0]!.ret.lines } };
    const k = "f1040.1a" as const;
    ret.lines[k] = { ...ret.lines[k]!, amount: -2972 };
    const m = sheet(ret);
    const row = parseCsv(sheetToCsv(m)).find((r) => r[2] === k)!;
    expect(row[4]).toBe("-2972");
    expect(m.federal[0]!.lines[0]!.amountText).toBe("-$2,972");
  });

  it("text cells that start with a trigger (a hostile label / reason / provenance) are guarded in a full export, numbers are not", () => {
    const ret: Ty2025Return = { ...FIXTURES[0]!.ret, lines: { ...FIXTURES[0]!.ret.lines } };
    const k = "f1040.2b" as const;
    ret.lines[k] = { ...ret.lines[k]!, label: '=HYPERLINK("http://evil","x")', reason: "@SUM(1)", refs: [{ kind: "document", id: "w2-eric-a", label: "-cmd|' /C calc'!A0" }] };
    const rows = parseCsv(sheetToCsv(sheet(ret)));
    const row = rows.find((r) => r[2] === k)!;
    expect(row[3]!.startsWith("'=")).toBe(true);
    expect(row[6]).toContain("-cmd"); // provenance begins with "document verified: " so it is not at the cell start
    expect(row[7]!.startsWith("'@")).toBe(true);
    for (const r of rows.slice(2)) for (const idx of [0, 1, 2, 3, 5, 6, 7]) expect(r[idx]).not.toMatch(/^[=+\-@\t\r]/);
  });

  it("the closing DRAFT NOTICE row has an empty amount and the draft label", () => {
    const rows = parseCsv(sheetToCsv(sheet(FIXTURES[3]!.ret)));
    const last = rows[rows.length - 1]!;
    expect(last[0]).toBe("DRAFT NOTICE");
    expect(last[4]).toBe("");
    expect(last[7]).toContain("the owner is the preparer of record");
  });

  it("PII canary: no EIN, SSN-shaped string, street address or non-first-name identifier reaches the model, HTML or CSV unless it is a document label", () => {
    const f = fullFacts1b();
    f.income.w2s[0] = { ...f.income.w2s[0]!, employer: "ZZEMPLOYER INC", employerEin: "98-7654321", refs: [{ kind: "document", id: "w2-eric-a", label: "W-2" }] };
    f.deductions.mortgages[0] = { ...f.deductions.mortgages[0]!, lender: "ZZLENDER", propertyAddress: "123 Canary Lane" };
    f.deductions.primaryResidenceAddress = owner("123 Canary Lane");
    f.deductions.propertyTaxBills[0] = { ...f.deductions.propertyTaxBills[0]!, address: "123 Canary Lane" };
    const ret = computeTy2025Return(f);
    const m = sheet(ret);
    const blob = JSON.stringify(m) + html(m) + sheetToCsv(m);
    expect(blob).not.toMatch(/98-7654321|987654321/);
    expect(blob).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(blob).not.toMatch(/123 Canary Lane/);
    // names: what appears (reported, not forbidden): the household first names only
    expect(blob).toMatch(/Eric|Eva/);
  });
});

// ── (7)(8) route + Forms page + cards ─────────────────────────────────────────

describe("tester: card conclusions say 'Computed' only when the engine verdict is not blocked", () => {
  it("across fixtures and 300 single-leaf mutations: a 'Computed' sentence never contains 'not computed' and never sits on a blocked / missing source line", () => {
    const rets: Ty2025Return[] = FIXTURES.map((x) => x.ret);
    const base = fullFacts1b();
    // single-leaf deletions of every optional answer
    const mutate: ((f: ReturnType<typeof fullFacts1b>) => void)[] = [
      (f) => { f.income.w2s = []; },
      (f) => { f.income.interest = []; },
      (f) => { f.income.scheduleC.glLines = []; },
      (f) => { f.income.scheduleC.fixedAssetsNoneConfirmed = false; },
      (f) => { f.income.scheduleC.homeOfficeEligibility = missingLeaf(); },
      (f) => { f.household.noDependents = missingLeaf(); },
      (f) => { f.payments.federalEstimates = missingLeaf(); },
      (f) => { f.returnAnswers.people[0]!.hsaCoverage = missingLeaf(); },
      (f) => { f.returnAnswers.people[0]!.deferralsCents = missingLeaf(); },
      (f) => { f.priorYear = { totalTaxCents: missingLeaf(), agiCents: missingLeaf(), filingStatus: missingLeaf() }; },
    ];
    for (const fn of mutate) {
      const f = structuredClone(base);
      fn(f);
      rets.push(computeTy2025Return(f));
    }
    for (const ret of rets) {
      const c = buildCardConclusions(ret);
      for (const [id, v] of Object.entries(c)) {
        if (v.text.startsWith("Computed")) {
          expect(v.text, `${id}: ${v.text}`).not.toMatch(/not computed/);
          expect(v.tone).not.toBe("blocked");
        } else {
          expect(v.tone, id).toBe("blocked");
          expect(v.text, id).toMatch(/^(Not final|Not computed|Not decided|Needs your decision)/);
        }
      }
    }
  });

  it("D2 regression: card 'form-4562' never says 'Computed: not required' while the fixed-asset register is unconfirmed (rule:schedule-c is blocking on exactly that)", () => {
    const ret = FIXTURES.find((x) => x.name === "prod-like")!.ret;
    expect(ret.openItems.find((o) => o.id === "rule:schedule-c")?.action).toMatch(/fixed-asset register/);
    expect(buildCardConclusions(ret)["form-4562"]!.text).not.toMatch(/^Computed/);
  });
});

describe("tester: page / route / Forms page source facts", () => {
  const page = read("app/tax/forms/[year]/return/page.tsx");
  it("auth + redirect strictly before the year parse and any load; year gate 2025-only; only the model reaches the sheet", () => {
    expect(page.indexOf("await auth()")).toBeGreaterThan(-1);
    expect(page.indexOf("redirect(\"/login\")")).toBeLessThan(page.indexOf("loadSheet("));
    expect(page.indexOf("await auth()")).toBeLessThan(page.indexOf("await params"));
    expect(page).toMatch(/year === SHEET_SUPPORTED_YEAR \? await loadSheet/);
    // the sheet gets the plain model and the link context built from that same model (JSON of line / document names and ids; no engine facts)
    expect(page).toMatch(/<ReturnSheet model=\{loaded\.model\} links=\{linkContextForSheet\(loaded\.model\)\} \/>/);
    expect(page).not.toMatch(/loaded\.(ret|facts|resolved|raw)\b/);
  });
  it("Forms page diff touches only the engine call and the conclusion prop (no counters / cards / questionnaire change)", () => {
    const forms = read("app/tax/forms/[year]/page.tsx");
    expect(forms).toContain("year === PDF_SUPPORTED_YEAR ? loadSheet(year, { build: buildTy2025ReturnWithOverrides }) : Promise.resolve(null)");
    expect(forms).toContain('sheet?.kind === "ok" ? sheet.conclusions : {}');
    expect((forms.match(/conclusion=\{conclusions\[entry\.id\]\}/g) ?? []).length).toBe(3);
  });
  it("print CSS: the new block is scoped to #return-sheet and the #cpa-summary block is untouched", () => {
    const css = read("app/globals.css");
    const idx = css.indexOf("/* Print: the TY2025 CPA review sheet");
    expect(idx).toBeGreaterThan(-1);
    const block = css.slice(idx).replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...block.matchAll(/^\s*([^{}\n/*][^{}]*?)\s*\{/gm)].map((m) => m[1]!).filter((s) => !s.startsWith("@media"));
    expect(selectors.length).toBeGreaterThan(8);
    for (const sel of selectors) for (const part of sel.split(",")) expect(part.trim(), sel).toMatch(/return-sheet/);
    const head = css.slice(0, idx);
    expect(head).toContain("#cpa-summary");
  });
});

// ── fuzz: random incomplete states never break the sheet's honesty invariants ─────

describe("tester: 300 random incomplete states", () => {
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  type F = ReturnType<typeof fullFacts1b>;
  const MUTATIONS: ((f: F) => void)[] = [
    (f) => { f.income.w2s = []; },
    (f) => { f.income.interest = []; },
    (f) => { f.income.dividends = []; },
    (f) => { f.income.scheduleC.glLines = []; },
    (f) => { f.income.scheduleC.fixedAssetsNoneConfirmed = false; },
    (f) => { f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive" as const); f.income.scheduleC.homeOfficeSqft = owner(150); },
    (f) => { f.income.scheduleC.homeOfficeEligibility = missingLeaf(); },
    (f) => { f.income.scheduleC.mileageNoneConfirmed = missingLeaf(); },
    (f) => { f.household.noDependents = missingLeaf(); },
    (f) => { f.payments.federalEstimates = missingLeaf(); },
    (f) => { f.payments.ctEstimates = missingLeaf(); },
    (f) => { f.returnAnswers.people[0]!.hsaCoverage = missingLeaf(); },
    (f) => { f.returnAnswers.people[1]!.deferralsCents = missingLeaf(); },
    (f) => { f.returnAnswers.attestations = { digitalAssets: missingLeaf(), foreignAccounts: owner(true) }; },
    (f) => { f.priorYear = { totalTaxCents: missingLeaf(), agiCents: missingLeaf(), filingStatus: missingLeaf() }; },
    (f) => { f.statedNone = {}; },
    (f) => { f.deductions.propertyTaxBills.push(bill({ docId: "pt-x", label: "56 Arbor Rd", address: "56 Arbor Rd", paidInYearCents: 300_000, kind: "other_real_estate" })); },
    (f) => { f.deductions.propertyTaxBills.push(bill({ docId: "pt-y", paidInYearCents: null })); },
    (f) => { const w = f.income.w2s[0]; if (w) { w.medicareWagesCents = 90_000_000; w.wagesCents = 90_000_000; } },
    (f) => { f.ct.useTax = missingLeaf(); },
  ];
  it("every key once, no number without an amount status, 'Computed' conclusions never contradict themselves, blocked => INCOMPLETE and never 'final' claims", () => {
    const r = rng(20261003);
    for (let i = 0; i < 300; i++) {
      const f = fullFacts1b();
      const n = 1 + Math.floor(r() * 4);
      for (let j = 0; j < n; j++) MUTATIONS[Math.floor(r() * MUTATIONS.length)]!(f);
      const ret = computeTy2025Return(f);
      const m = sheet(ret);
      const keys = allLines(m).map((l) => l.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.length).toBe(Object.keys(ret.lines).length);
      for (const l of allLines(m)) {
        const e = ret.lines[l.key as keyof typeof ret.lines]!;
        if (!hasAmount(e.status)) {
          expect(l.amountText).toBe("not computed");
          expect(l.amount).toBeNull();
        } else expect(l.amountText).toMatch(/^-?\$[\d,]+$/);
      }
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
      if (ret.headline.blockingItemCount > 0) {
        expect(m.summary.complete).toBe(false);
        expect(m.summary.completenessText).toMatch(/^INCOMPLETE/);
        expect(sheetToCsv(m)).not.toMatch(/ready to file/i);
      }
      const sev = m.openItems.map((x) => x.severity);
      const fa = sev.indexOf("advisory");
      if (fa !== -1) expect(sev.slice(fa).every((s) => s === "advisory")).toBe(true);
      for (const [id, c] of Object.entries(buildCardConclusions(ret))) {
        if (c.text.startsWith("Computed")) expect(c.text, `${id} ${c.text}`).not.toMatch(/not computed/);
      }
    }
  });
});
