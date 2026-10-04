// ai-return-reviewer, plan 7.5: nothing the owner can SEE may say that a CPA reviews, prepares or signs the return.
// Renders the real surfaces (sheet model, CSV, conditional conclusions, cover, stamp, PDF properties and tooltips) for a
// blocked, a complete, a Phase-1b and an overridden return (owner and legacy "cpa" authority), and statically scans the
// strings of the pages and components. Identifiers (needs_cpa_*, who "cpa", /cpa-summary ...) are allowed.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { LINE_KEYS, type Ty2025Return } from "@/lib/tax2025/types";
import { applyOverrides, formatOverrideNote, lineSnapshot, type EffectiveReturn, type OverrideRow } from "@/lib/tax2025/overrides";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { buildCoverModel, type CoverBlock } from "@/lib/tax2025/pdf/cover";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { CT1040_COVER_NOTE } from "@/lib/tax2025/pdf/ct-overlay";
import { DRAFT_SUBJECT, draftStampText } from "@/lib/tax2025/pdf/stamp";
import { buildSheetModel, SHEET_CHECKLIST, SHEET_DRAFT_LABEL, SHEET_STATUS_LABELS } from "@/lib/tax2025-sheet";
import { buildCardConclusions } from "@/lib/tax2025-sheet-conclusions";
import { sheetCsvFilename, sheetToCsv } from "@/lib/tax2025-sheet-csv";
import { findOwnerBannedWording } from "@/lib/tax-wording";
import { QUESTIONNAIRES } from "@/lib/tax-questionnaire-content";
import { OWNER_LINE, UNSURE_LABEL } from "@/lib/tax-questionnaire";
import { emptyFacts, fullFacts, fullFacts1b } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS } from "./tax2025-pdf-harness";

const ROOT = resolve(__dirname, "../..");
const NOW = new Date("2026-10-03T16:30:00Z");
const OPTS = { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" } as const;

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
    bad.map((b) => `${b.hits.join("+")}: ${b.s.slice(0, 140)}`),
    `${label}: owner-visible strings with banned wording`,
  ).toEqual([]);
}

const coverStrings = (blocks: readonly CoverBlock[]): string[] =>
  blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text));

function pinRow(ret: Ty2025Return, key: (typeof LINE_KEYS)[number], valueCents: number, over: Partial<OverrideRow>): OverrideRow {
  const l = ret.lines[key];
  if (!l) throw new Error(`no line ${key}`);
  return {
    id: "00000000-0000-4000-8000-0000000000bb",
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents,
    valueText: null,
    computedSnapshot: lineSnapshot(l, ret.engineVersion),
    authority: "owner",
    reason: "per the corrected 1099",
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-05T14:00:00Z"),
    archivedAt: null,
    ...over,
  };
}

interface Scenario {
  name: string;
  ret: Ty2025Return;
  facts: ReturnType<typeof fullFacts>;
  effective?: EffectiveReturn;
}

function scenarios(): Scenario[] {
  const golden = computeTy2025Return(fullFacts());
  const f1b = fullFacts1b();
  const golden1b = computeTy2025Return(f1b);
  const blocked = computeTy2025Return(emptyFacts());
  const pinKey = "sch1.3" as const;
  const ownerPin = applyOverrides(golden, [pinRow(golden, pinKey, 600_000, {})]);
  const legacyPin = applyOverrides(golden, [pinRow(golden, pinKey, 600_000, { authority: "cpa" })]);
  return [
    { name: "complete", ret: golden, facts: fullFacts() },
    { name: "phase 1b", ret: golden1b, facts: f1b },
    { name: "blocked", ret: blocked, facts: emptyFacts() },
    { name: "owner override", ret: golden, facts: fullFacts(), effective: ownerPin },
    { name: "legacy cpa override", ret: golden, facts: fullFacts(), effective: legacyPin },
  ];
}

describe("rendered surfaces carry no CPA wording", () => {
  for (const sc of scenarios()) {
    describe(sc.name, () => {
      const sheet = buildSheetModel({ ret: sc.ret, documents: [], now: NOW, ...(sc.effective ? { effective: sc.effective } : {}) });
      const view = toPdfReturnView(sc.ret, sc.facts, {
        ...OPTS,
        ...(sc.effective ? { overrides: { effective: sc.effective, formatNote: formatOverrideNote } } : {}),
      });

      it("the sheet model (every line reason, item, decision, chip, checklist)", () => {
        expectClean("sheet", proseStrings(sheet));
      });

      it("the CSV text and file name", () => {
        const csv = sheetToCsv(sheet);
        expectClean("csv", csv.split("\r\n"));
        expect(sheetCsvFilename(sheet)).not.toMatch(/cpa/i);
      });

      it("the Forms page card conclusions", () => {
        expectClean("conclusions", proseStrings(buildCardConclusions(sc.ret)));
      });

      it("the cover blocks (engine items, fill notes, override notes, missing forms)", () => {
        const cover = buildCoverModel({
          view,
          forms: [],
          fillItems: [],
          continuations: [],
          stamp: true,
          missingForms: requiredFormsWithoutPdf(view),
        });
        expectClean("cover", coverStrings(cover.blocks));
      });

      it("the view's prose (open items, decisions, overrides, line reasons)", () => {
        expectClean("view", proseStrings({ o: view.openItems, d: view.decisions, v: view.overrides, n: view.overrideNotice, a: view.acknowledged, r: view.resolvedByOverride, l: view.lines }));
      });
    });
  }

  it("the static labels: draft label, status labels, checklist, stamp, PDF subject, CT note", () => {
    expectClean("static", [
      SHEET_DRAFT_LABEL,
      ...Object.values(SHEET_STATUS_LABELS),
      ...SHEET_CHECKLIST,
      draftStampText("2026-10-03", "abcdef012345"),
      DRAFT_SUBJECT,
      CT1040_COVER_NOTE,
    ]);
  });

  it("the questionnaires: every title, intro, question, option, help text, outcome sentence and the Not sure label", () => {
    const strings = proseStrings(QUESTIONNAIRES);
    expect(strings.length).toBeGreaterThan(300); // not vacuous
    expectClean("questionnaires", [...strings, UNSURE_LABEL, ...Object.values(OWNER_LINE)]);
  });

  it("the filled form: document properties and every field tooltip, with an override note present", async () => {
    const golden = computeTy2025Return(fullFacts());
    const eff = applyOverrides(golden, [pinRow(golden, "sch1.3", 600_000, { authority: "cpa" })]);
    const view = toPdfReturnView(golden, fullFacts(), { ...OPTS, overrides: { effective: eff, formatNote: formatOverrideNote } });
    const res = await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(res.bytes);
    expectClean("properties", [doc.getTitle() ?? "", doc.getSubject() ?? "", doc.getKeywords() ?? "", doc.getAuthor() ?? ""]);
    const tips: string[] = [];
    for (const f of doc.getForm().getFields()) {
      const tu = f.acroField.dict.lookup(PDFName.of("TU"));
      if (tu instanceof PDFString || tu instanceof PDFHexString) tips.push(tu.decodeText());
    }
    expectClean("tooltips", tips);
  });
});

// ── Static scan of the pages and components ───────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Source without comments (block comments and whole-line / trailing `//` comments; a `://` URL is kept). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(,])\/\/[^\n]*/g, "$1");
}

describe("pages and components: no CPA in the rendered text", () => {
  const roots = ["components/tax", "app/tax", "app/business", "components/donations", "components/fixed-assets"].map((r) => join(ROOT, r));
  const files = roots.flatMap((r) => walk(r));

  // The bookkeeping pages ("Export accountant bundle", "confirm with your accountant or tax preparer") are scanned too (tester Y D3);
  // nothing is allowed any more: identifiers such as the exportCpaBundle action name are not part of a line the scan flags.
  const ALLOWED_LINES: readonly RegExp[] = [];

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("no standalone upper-case CPA outside identifiers and the allowed bookkeeping button", () => {
    const hits: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
      src.split("\n").forEach((line, i) => {
        if (ALLOWED_LINES.some((re) => re.test(line))) return;
        if (/(?<![A-Za-z0-9_-])CPA(?![A-Za-z0-9_-])/.test(line)) hits.push(`${f.replace(ROOT, "")}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
