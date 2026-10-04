// Wording scan over the surfaces added by the Schedule 1-A / Form 8960 / Form 8829 work (engine ty2025-1b.5): the engine prose of
// rules/schedule-1a.ts, rules/form-8960.ts and return.ts (the Form 8829 verdict reasons and the three advisories), the notes of the
// sch1a / f8960 PDF maps, the niit_other question, the review sheet, the cover, the DRAFT packet's forms and the FINAL package.
// Nothing the owner can see may say that a CPA reviews or prepares the return; routing (who acts on an item) and the wording layer must agree.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 });
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { Ty2025Return } from "@/lib/tax2025/types";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { buildCoverModel, type CoverBlock } from "@/lib/tax2025/pdf/cover";
import { FINAL_INDEX_FILE_NAME, buildFinalPackage } from "@/lib/tax2025/pdf/final-package";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { f8960Map } from "@/lib/tax2025/pdf/maps/f8960";
import { sch1aMap } from "@/lib/tax2025/pdf/maps/sch1a";
import { requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { fillPacketForms } from "@/lib/tax2025/pdf/packet";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { routeOpenItem } from "@/lib/tax2025-sheet";
import { buildCardConclusions } from "@/lib/tax2025-sheet-conclusions";
import { sheetToCsv } from "@/lib/tax2025-sheet-csv";
import { findOwnerBannedWording, ownerWording, ownerWordingDeep } from "@/lib/tax-wording";
import { QUESTIONNAIRES } from "@/lib/tax-questionnaire-content";
import { ERIC_ID, EVA_ID, fullFacts, fullFacts1b, owner, w2 } from "./tax2025-fixtures";

const NOW = new Date("2026-10-04T16:30:00Z");
const OPTS = { generatedAt: "2026-10-04T16:00:00.000Z", generatedBy: "Test User" } as const;

/** Every string leaf of a JSON-like value, skipping identifier-like tokens (status ids, `who`, hrefs ...). */
function proseStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (!/^[a-z0-9_.:/-]+$/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) proseStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) proseStrings(v, out);
  }
  return out;
}

function expectClean(label: string, strings: readonly string[]): void {
  const bad = strings.map((s) => ({ s, hits: findOwnerBannedWording(s) })).filter((x) => x.hits.length > 0);
  expect(
    bad.map((b) => `${b.hits.join("+")}: ${b.s.slice(0, 160)}`),
    `${label}: owner-visible strings with banned wording`,
  ).toEqual([]);
}

const coverStrings = (blocks: readonly CoverBlock[]): string[] =>
  blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text));

/** Eva: tips 4,545.80 on the single W-2 with box 7 of that amount, overtime premium 2,408 (as in tax2025-sch1a-return.test.ts). */
function evaFacts(): Ty2025Facts {
  const f = fullFacts1b();
  f.returnAnswers.magiExclusionsNone = owner(true);
  const eva = f.returnAnswers.people.find((p) => p.userId === EVA_ID)!;
  eva.tipsChoice = owner("some");
  eva.tipsCents = owner(454_580);
  eva.overtimeChoice = owner("premium");
  eva.overtimeCents = owner(240_800);
  eva.validSsn = owner(true);
  f.income.w2s = f.income.w2s.map((x) => (x.personUserId === EVA_ID ? { ...x, socialSecurityTipsCents: 454_580 } : x));
  return f;
}

/** AGI over 250,000 (Eric's wages raised by 100,000), itemizing or not (tax2025-form-8960-return.test.ts). */
function over(itemize: boolean): Ty2025Facts {
  const f = fullFacts();
  f.income.w2s[0]!.wagesCents = 19_000_000;
  f.income.w2s[0]!.socialSecurityWagesCents = 17_610_000;
  f.income.w2s[0]!.medicareWagesCents = 19_000_000;
  f.deductions.mortgages[0]!.interestCents = itemize ? 4_000_000 : 100_000;
  return f;
}

function withHomeOffice(f: Ty2025Facts, eligibility: "yes_exclusive" | "yes_shared" | "no", sqft: number | null = 200): Ty2025Facts {
  f.income.scheduleC.homeOfficeEligibility = owner(eligibility);
  f.income.scheduleC.homeOfficeSqft = sqft === null ? { value: null, basis: null, refs: [] } : owner(sqft);
  return f;
}

const decided = (chosen: "simplified" | "actual") => ({ homeOfficeMethod: { chosen, by: "owner-1", at: "2026-10-04T12:00:00.000Z" } });

interface Scenario {
  name: string;
  facts: Ty2025Facts;
  decisions?: Parameters<typeof computeTy2025Return>[1];
}

function scenarios(): Scenario[] {
  const niitNone = over(false);
  delete niitNone.statedNone.niit_other;
  const niitYes = over(false);
  niitYes.statedNone.niit_other = owner(false);
  const ericTips = evaFacts();
  const eric = ericTips.returnAnswers.people.find((p) => p.userId === ERIC_ID)!;
  eric.tipsChoice = owner("some");
  eric.tipsCents = owner(100_000);
  eric.validSsn = owner(true);
  const twoEmployers = evaFacts();
  twoEmployers.income.w2s = [
    ...twoEmployers.income.w2s,
    w2({ docId: "w2-eva-2", employer: "Second Place", personUserId: EVA_ID, wagesCents: 100_000, socialSecurityTipsCents: 10_000 }),
  ];
  const tipsMismatch = evaFacts();
  tipsMismatch.income.w2s = tipsMismatch.income.w2s.map((x) => (x.personUserId === EVA_ID ? { ...x, socialSecurityTipsCents: 111_100 } : x));
  const evaOver = evaFacts();
  evaOver.income.w2s[0]!.wagesCents = 19_000_000;
  const stated1a = evaFacts();
  stated1a.adjustments.sch1a = owner(700_000);
  return [
    { name: "NIIT, itemizing (9b allocation advisory + non-passive advisory)", facts: over(true) },
    { name: "NIIT, standard deduction", facts: over(false) },
    { name: "NIIT, niit_other unanswered (blocking)", facts: niitNone },
    { name: "NIIT, niit_other answered Yes (needs the owner's work)", facts: niitYes },
    { name: "Schedule 1-A: Eva's tips and overtime (owner-statements advisory)", facts: evaFacts() },
    { name: "Schedule 1-A: the Schedule C owner reports tips (line 5 blocked)", facts: ericTips },
    { name: "Schedule 1-A: two employers with box 7", facts: twoEmployers },
    { name: "Schedule 1-A: tips differ from the W-2", facts: tipsMismatch },
    { name: "Schedule 1-A and Form 8960 together", facts: evaOver },
    { name: "Schedule 1-A total stated by the owner", facts: stated1a },
    { name: "Form 8829: simplified default", facts: withHomeOffice(fullFacts1b(), "yes_exclusive") },
    { name: "Form 8829: simplified decided", facts: withHomeOffice(fullFacts1b(), "yes_exclusive"), decisions: decided("simplified") },
    { name: "Form 8829: actual chosen", facts: withHomeOffice(fullFacts1b(), "yes_exclusive"), decisions: decided("actual") },
    { name: "Form 8829: blocking (no square footage)", facts: withHomeOffice(fullFacts1b(), "yes_exclusive", null) },
  ];
}

describe("the Schedule 1-A / Form 8960 / Form 8829 surfaces carry no CPA wording", () => {
  for (const sc of scenarios()) {
    describe(sc.name, () => {
      const ret = computeTy2025Return(sc.facts, sc.decisions);
      const view = toPdfReturnView(ret, sc.facts, OPTS);
      const sheet = buildSheetModel({ ret, documents: [], now: NOW });

      it("the sheet, the CSV and the Forms page conclusions", () => {
        expectClean("sheet", proseStrings(sheet));
        expectClean("csv", sheetToCsv(sheet).split("\r\n"));
        expectClean("conclusions", proseStrings(buildCardConclusions(ret)));
      });

      it("the view prose (items, decisions, lines)", () => {
        expectClean("view", proseStrings({ o: view.openItems, d: view.decisions, l: view.lines, n: view.overrideNotice, a: view.acknowledged }));
      });

      it("the DRAFT packet: cover (fill items, blank reasons, missing forms) and every form tooltip", async () => {
        const filled = await fillPacketForms(view, { maps: FORM_MAPS, stamp: true, final: false, folder: "" });
        const model = buildCoverModel({
          view,
          forms: filled.forms,
          fillItems: filled.openItems,
          continuations: filled.continuations,
          stamp: true,
          missingForms: requiredFormsWithoutPdf(view),
        });
        expectClean("cover", coverStrings(model.blocks));
        const tips: string[] = [];
        for (const f of filled.files) {
          const doc = await PDFDocument.load(f.bytes);
          expectClean(`properties ${f.name}`, [doc.getTitle() ?? "", doc.getSubject() ?? "", doc.getKeywords() ?? "", doc.getAuthor() ?? ""]);
          for (const field of doc.getForm().getFields()) {
            const tu = field.acroField.dict.lookup(PDFName.of("TU"));
            if (tu instanceof PDFString || tu instanceof PDFHexString) tips.push(tu.decodeText());
          }
        }
        expectClean("tooltips", tips);
      });

      it("the routing of each open item (who acts) is the same before and after the wording layer", () => {
        for (const i of ret.openItems) {
          const reworded = ownerWordingDeep(i);
          expect(routeOpenItem(reworded).who, `${i.id} | ${i.action} -> ${reworded.action}`).toBe(routeOpenItem(i).who);
        }
      });
    });
  }
});

describe("the new advisories: routing and wording agree", () => {
  const ADVISORIES = ["sch1a-owner-statements", "niit-sch-c-nonpassive", "niit-allocation-9b"] as const;
  const rets: Ty2025Return[] = [evaFacts(), over(true)].map((f) => computeTy2025Return(f));
  const items = ADVISORIES.map((id) => {
    const item = rets.flatMap((r) => r.openItems).find((o) => o.id === id);
    if (!item) throw new Error(`advisory ${id} not raised by the fixtures`);
    return item;
  });

  it("each starts with the literal prefix routeOpenItem knows and routes to the owner's own decision ('cpa' is a legacy identifier)", () => {
    for (const item of items) {
      expect(item.action, item.id).toMatch(/^CPA to /);
      expect(routeOpenItem(item).who, item.id).toBe("cpa");
    }
  });

  it("the reworded action says no CPA, addresses the owner, and still routes the same way", () => {
    for (const item of items) {
      const action = ownerWording(item.action);
      expect(findOwnerBannedWording(action), item.id).toEqual([]);
      expect(action, item.id).toMatch(/^(You|Confirm|Decide|Check)\b/);
      expect(routeOpenItem({ id: item.id, action }).who, `${item.id}: ${action}`).toBe("cpa");
    }
  });

  it("the sheet shows them with who 'cpa' and reworded text", () => {
    const sheet = buildSheetModel({ ret: rets[0]!, documents: [], now: NOW });
    const s = sheet.openItems.find((o) => o.id === "sch1a-owner-statements");
    expect(s?.who).toBe("cpa");
    expect(s?.action).not.toMatch(/cpa/i);
  });
});

describe("the new engine prose reads as the owner's own decision (spot checks of the rewrites)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["CPA to confirm the occupation, the tip and overtime character and the amounts with the owner.", "You confirm the occupation, the tip and overtime character and the amounts with the owner."],
    ["CPA to confirm the allocation method for Form 8960 line 9b (a CPA override of the line is possible).", "You confirm the allocation method for Form 8960 line 9b (an owner override of the line is possible)."],
    ["The CPA chose the actual home-office method (decision X1): Form 8829 is required.", "You chose the actual home-office method (decision X1): Form 8829 is required."],
    ["so the CPA splits it.", "so you split it."],
    ["so the CPA allocates line 9b.", "so you allocate line 9b."],
    ["so line 5 goes to the CPA.", "so line 5 is yours to decide."],
    ["the CPA reconciles them", "you reconcile them"],
    ["if one applies the CPA enters them.", "if one applies you enter them."],
    ["answer Not sure so the CPA works it out", "answer Not sure so you work it out"],
    ["Needs an owner/CPA statement: foreign stock", "Needs an owner statement: foreign stock"],
    ["is the CPA's call.", "is your decision."],
    ["The CPA may use another method.", "You may use another method."],
  ];
  for (const [input, expected] of cases) {
    it(input.slice(0, 70), () => {
      expect(ownerWording(input)).toBe(expected);
    });
  }
});

describe("the sch1a / f8960 PDF map notes and the niit_other question", () => {
  it("every note, blank reason text and tooltip the two maps can show is clean after the wording layer", () => {
    const strings = proseStrings([sch1aMap, f8960Map].map((m) => JSON.parse(JSON.stringify(m, (_k, v: unknown) => (v instanceof RegExp ? v.source : v))) as unknown));
    expect(strings.length).toBeGreaterThan(20);
    expectClean("map notes", strings.map((s) => ownerWording(s)));
  });

  it("the niit_other prompt and label (Return completeness) say no CPA", () => {
    const strings = proseStrings(QUESTIONNAIRES);
    const hits = strings.filter((s) => /foreign (?:company|corporation)|controlled foreign/i.test(s));
    expect(hits.length).toBeGreaterThan(0);
    expectClean("niit_other", hits);
  });
});

describe("the FINAL package includes Schedule 1-A and Form 8960 and no longer lists them as missing", () => {
  const f = evaFacts();
  f.income.w2s[0]!.wagesCents = 19_000_000;
  const ret = computeTy2025Return(f);
  const view = toPdfReturnView(ret, f, OPTS);

  it("the engine requires both forms, and neither Form 8829 nor these two is 'without a PDF'", () => {
    expect(ret.formsRequired.f8960?.required).toBe(true);
    expect(ret.formsRequired.sch1a?.required).toBe(true);
    const missing = requiredFormsWithoutPdf(view).map((m) => m.formId);
    for (const id of ["sch1a", "f8960", "f8829"]) expect(missing, id).not.toContain(id);
    expect(ret.formsRequired.f8829?.required).toBe(false);
  });

  it("builds, contains f1040s1a and f8960 (IRS order), and the index is clean", async () => {
    const result = await buildFinalPackage(view, { maps: FORM_MAPS });
    if (!result.ok) throw new Error(result.reason);
    expect(result.forms).toContain("f1040s1a");
    expect(result.forms).toContain("f8960");
    expect(result.files.map((x) => x.name)[0]).toBe(FINAL_INDEX_FILE_NAME);
    const order = result.files.filter((x) => x.kind === "form").map((x) => x.formId);
    expect(order.indexOf("f1040s1")).toBeLessThan(order.indexOf("f1040s1a"));
    expect(order.indexOf("f8959")).toBeLessThan(order.indexOf("f8960"));
  });
});
