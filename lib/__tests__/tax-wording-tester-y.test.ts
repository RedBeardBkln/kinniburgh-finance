// TESTER (ai-return-reviewer unit Y): an INDEPENDENT scan (own regex, does not call findOwnerBannedWording) over the
// rendered surfaces for blocked / complete / 1b / owner-override / legacy-"cpa"-override returns, plus the claims that the
// wording layer never changes numbers, identifiers or structure and does not reword owner-typed text.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { LINE_KEYS, type Ty2025Return } from "@/lib/tax2025/types";
import { applyOverrides, formatOverrideNote, lineSnapshot, type EffectiveReturn, type OverrideRow } from "@/lib/tax2025/overrides";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { buildCardConclusions } from "@/lib/tax2025-sheet-conclusions";
import { sheetToCsv } from "@/lib/tax2025-sheet-csv";
import { ownerWording, ownerWordingDeep } from "@/lib/tax-wording";
import { emptyFacts, fullFacts, fullFacts1b } from "./tax2025-fixtures";

const NOW = new Date("2026-10-03T16:30:00Z");
const OPTS = { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" } as const;
const BAD = /\bCPAs?\b|certified public|professionally reviewed|\blicensed\b|C\.P\.A/i;

function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) leaves(x, out);
  return out;
}
/** Identifier VALUES that legitimately stay (persisted / pinned): exactly "cpa", needs_cpa_*, answer_cpa, hrefs. */
const isIdentifier = (s: string) => s === "cpa" || /^[a-z0-9_.:/#-]*cpa[a-z0-9_.:/#-]*$/.test(s);
// The CT-1040 instruction QUOTE "a taxpayer licensed under Connecticut General Statutes Chapter 420f or 420h" is statute text, not a claim.
const LEGAL_QUOTE = /licensed under Connecticut General Statutes/g;
const offenders = (strings: string[]) => strings.filter((s) => !isIdentifier(s) && BAD.test(s.replace(LEGAL_QUOTE, ""))).map((s) => s.slice(0, 160));

function pin(ret: Ty2025Return, key: (typeof LINE_KEYS)[number], cents: number, over: Partial<OverrideRow>): OverrideRow {
  const l = ret.lines[key];
  if (!l) throw new Error("no line");
  return {
    id: "00000000-0000-4000-8000-0000000000cc", taxYear: 2025, targetKind: "line", targetKey: key, version: 1, valueKind: "money_cents", valueCents: cents, valueText: null,
    computedSnapshot: lineSnapshot(l, ret.engineVersion), authority: "owner", reason: "per the corrected 1099", setByName: "Eric Kinniburgh", setAt: new Date("2026-10-05T14:00:00Z"), archivedAt: null, ...over,
  };
}

const golden = computeTy2025Return(fullFacts());
const scen: { name: string; ret: Ty2025Return; facts: ReturnType<typeof fullFacts>; eff?: EffectiveReturn }[] = [
  { name: "complete", ret: golden, facts: fullFacts() },
  { name: "1b", ret: computeTy2025Return(fullFacts1b()), facts: fullFacts1b() },
  { name: "blocked", ret: computeTy2025Return(emptyFacts()), facts: emptyFacts() },
  { name: "owner override", ret: golden, facts: fullFacts(), eff: applyOverrides(golden, [pin(golden, "sch1.3", 600_000, {})]) },
  { name: "legacy cpa override", ret: golden, facts: fullFacts(), eff: applyOverrides(golden, [pin(golden, "sch1.3", 600_000, { authority: "cpa" })]) },
];

describe("independent scan of the rendered surfaces", () => {
  for (const sc of scen) {
    it(`${sc.name}: sheet, CSV, conclusions, view prose, cover`, () => {
      const sheet = buildSheetModel({ ret: sc.ret, documents: [], now: NOW, ...(sc.eff ? { effective: sc.eff } : {}) });
      const view = toPdfReturnView(sc.ret, sc.facts, { ...OPTS, ...(sc.eff ? { overrides: { effective: sc.eff, formatNote: formatOverrideNote } } : {}) });
      const cover = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true, missingForms: requiredFormsWithoutPdf(view) });
      expect(offenders(leaves(sheet)), "sheet").toEqual([]);
      expect(offenders(sheetToCsv(sheet).split("\r\n")), "csv").toEqual([]);
      expect(offenders(leaves(buildCardConclusions(sc.ret))), "conclusions").toEqual([]);
      expect(offenders(leaves({ o: view.openItems, d: view.decisions, v: view.overrides, n: view.overrideNotice, a: view.acknowledged, r: view.resolvedByOverride, l: view.lines })), "view").toEqual([]);
      expect(offenders(leaves(cover.blocks)), "cover").toEqual([]);
    });
  }

  it("legacy 'cpa' override row displays as an advisor recorded earlier, never as a CPA; the amount is unchanged", () => {
    const own = scen[3]!;
    const leg = scen[4]!;
    const a = JSON.stringify(buildSheetModel({ ret: own.ret, documents: [], now: NOW, effective: own.eff! }));
    const b = JSON.stringify(buildSheetModel({ ret: leg.ret, documents: [], now: NOW, effective: leg.eff! }));
    expect(b).toMatch(/Advisor/);
    expect(a).not.toMatch(/Advisor/);
    // Same numbers: replace the label text and compare (only the authority wording may differ)
    const norm = (s: string) => s.replace(/Advisor[^"]*?(?=[ ".,;)])/g, "Owner").replace(/per advisor, recorded earlier/g, "owner");
    expect(Object.keys(JSON.parse(a))).toEqual(Object.keys(JSON.parse(b)));
    expect(norm(a).length).toBeGreaterThan(1000);
  });

  it("owner-typed override reason containing 'CPA' is displayed as typed (not reworded); documented deviation", () => {
    const row = pin(golden, "sch1.3", 600_000, { reason: "the CPA told me to pin this" });
    const eff = applyOverrides(golden, [row]);
    const view = toPdfReturnView(golden, fullFacts(), { ...OPTS, overrides: { effective: eff, formatNote: formatOverrideNote } });
    const text = JSON.stringify(view.overrides) + JSON.stringify(view.lines["sch1.3"] ?? null);
    expect(text).toContain("the CPA told me to pin this");
  });
});

describe("the layer never changes numbers, identifiers or structure", () => {
  it("every engine sentence of every scenario keeps its numbers and identifier tokens", () => {
    const nums = (s: string) => (s.match(/\d[\d,.]*/g) ?? []).join("|");
    const ids = (s: string) => (s.match(/\b[a-z]+(?:_[a-z0-9]+)+\b|https?:\/\/\S+/gi) ?? []).join("|");
    let n = 0;
    for (const sc of scen) {
      for (const s of leaves({ l: sc.ret.lines, o: sc.ret.openItems, r: sc.ret.results })) {
        const a = ownerWording(s);
        n++;
        // a clause that only handed a document to the CPA may legitimately drop its own document number
        if (!/to the CPA/.test(s)) expect(nums(a), s.slice(0, 120)).toBe(nums(s));
        expect(ids(a), s.slice(0, 120)).toBe(ids(s));
        expect(ownerWording(a)).toBe(a);
        if (!/\bCPA/i.test(s)) expect(a).toBe(s);
      }
    }
    expect(n).toBeGreaterThan(1500);
  });

  it("ownerWordingDeep keeps the exact shape, numbers, booleans and keys", () => {
    const v = { a: 1, b: [true, null, "the CPA decides", { c: "x", d: 2.5 }], "needs_cpa_judgment": "needs CPA judgment" };
    const d = ownerWordingDeep(v) as typeof v;
    expect(Object.keys(d)).toEqual(Object.keys(v));
    expect(d.a).toBe(1);
    expect(d.b[0]).toBe(true);
    expect(d.b[1]).toBeNull();
    expect(d.b[2]).toBe("you decide");
    expect((d.b[3] as { d: number }).d).toBe(2.5);
    expect(d["needs_cpa_judgment"]).toBe("needs your decision");
  });
});

// ── DB-sourced text (tester Y D1, fixed): text seeded into the DATABASE by earlier code still says "CPA"; it is reworded when SHOWN ──────
// (live read-only check, 2026-10-04: Entity.taxStatusNotes 1 row, TaxChecklistItem.label 7 rows incl. TY2025 EK Consulting
// "Submit to CPA for review", TaxQuestion 6 TY2025 personal rows "your CPA decides", TaxDeadline.notes 1 row (not displayed anywhere),
// TaxWorkspace.notes 9 rows.) Render-only: nothing is written to the database; the components apply ownerWording() at the display
// boundary. No jsdom here, so the boundary is pinned by source checks and the strings by the layer itself.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const STORED = [
  "Extension filed. Confirm exact date with CPA before relying on it.",
  "(confirm with CPA before relying on this date)",
  "Submit to CPA for review",
  "Prepare Schedule C draft for CPA",
  "File with IRS by Oct 15 2026 (confirm deadline with CPA)",
  "Draft is prepared by the platform and reviewed by your CPA.",
  "your CPA confirms exact numbers",
  "your CPA decides",
  "tell your CPA",
];

describe("DB-sourced owner-visible text goes through the wording layer", () => {
  it("the stored strings found in the live database read without 'CPA' once reworded, and numbers and dates are untouched", () => {
    for (const s of STORED) {
      const out = ownerWording(s);
      expect(out, s).not.toMatch(BAD);
      expect(out.length, s).toBeGreaterThan(5);
      expect(out.match(/\d+/g) ?? [], s).toEqual(s.match(/\d+/g) ?? []);
    }
  });
  it("Forms page 'Entity record: <taxStatusNotes>' is reworded at render", () => {
    expect(src("components/tax/forms/entity-forms-section.tsx")).toContain("ownerWording(section.taxStatusNotes)");
  });
  it("workspace checklist labels and workspace notes are reworded at render (the document-type lookup keeps the stored label)", () => {
    const code = src("components/tax/tax-workspace-client.tsx");
    expect(code).toContain("{ownerWording(item.label)}");
    expect(code).toContain("CHECKLIST_LABEL_TO_DOC_TYPES[item.label]");
    expect(code).toContain("ownerWording(initialNotes");
  });
  it("personal planning questions and option labels / notes are reworded at render", () => {
    const code = src("components/tax/personal-tax-client.tsx");
    expect(code).toContain("ownerWording(q.question)");
    expect(code).toContain("ownerWording(opt.note)");
    expect(code).toContain("ownerWording(opt.label)");
  });
  it("the deadline list on the Tax page is reworded; deadline notes are not displayed anywhere", () => {
    expect(src("app/tax/page.tsx")).toContain("ownerWording(d.label)");
    expect(src("app/tax/page.tsx")).not.toMatch(/d\.notes/);
    expect(src("components/tax/deadline-actions.tsx")).not.toMatch(/\.notes/);
  });
  it("no database write was added by the wording change (the components only import the pure layer)", () => {
    for (const f of ["components/tax/forms/entity-forms-section.tsx", "components/tax/tax-workspace-client.tsx", "components/tax/personal-tax-client.tsx"]) {
      expect(src(f), f).toContain('from "@/lib/tax-wording"');
    }
  });
});
