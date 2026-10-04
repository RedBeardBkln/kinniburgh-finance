// The review screen's handling of the sales summary rows: the same registry machinery as every other field
// (draft <-> value conversion, corrections overlay), with the plain-language labels.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { crossFieldWarnings, getFieldDef, getTaxSchema, validateCorrections } from "@/lib/tax-extraction-schema";
import {
  buildCorrectionFields,
  draftDiffers,
  draftFromValue,
  emptyRow,
  formatValueForDisplay,
  valueFromDraft,
} from "@/lib/tax-review-form";
import { resolveEffectiveExtraction } from "@/lib/extraction-effective";
import { ROBINHOOD_2025_ROWS } from "@/lib/__tests__/broker-summary-fixtures";

const def = getFieldDef("1099", "bSummary")!;
const ai = ROBINHOOD_2025_ROWS.map((r) => ({ ...r }));
const keys = new Set(getTaxSchema("1099").fields.map((f) => f.key));

describe("review form: sales summary rows", () => {
  it("shows the dollar amounts as editable text and the form / box as the enum values", () => {
    const draft = draftFromValue(def, ai);
    expect(draft.rows).toHaveLength(2);
    expect(draft.rows[0]).toEqual({
      form: "1099-B",
      box: "A",
      proceedsCents: "5872.31",
      costCents: "5285.50",
      accruedMarketDiscountCents: "0.00",
      washSaleLossDisallowedCents: "5.99",
      gainLossCents: "592.80",
    });
    expect(draft.rows[1]!.proceedsCents).toBe("17001.68");
  });

  it("round-trips unchanged: no correction is produced, and the row is not marked changed", () => {
    const draft = draftFromValue(def, ai);
    const back = valueFromDraft(def, draft);
    expect(back).toEqual({ ok: true, value: ai });
    expect(draftDiffers(def, draft, ai)).toBe(false);
    expect(buildCorrectionFields("1099", { bSummary: draft }, { bSummary: ai }, keys)).toEqual({ fields: {}, errors: {} });
  });

  it("an edited amount becomes an integer-cents correction of the whole list (the AI rows are never edited)", () => {
    const draft = draftFromValue(def, ai);
    draft.rows[0] = { ...draft.rows[0]!, proceedsCents: "5,872.41" };
    const built = buildCorrectionFields("1099", { bSummary: draft }, { bSummary: ai }, keys);
    expect(built.errors).toEqual({});
    const fixed = built.fields.bSummary as Record<string, unknown>[];
    expect(fixed[0]).toMatchObject({ proceedsCents: 587241 });
    expect(fixed[1]).toEqual(ai[1]);
    // the server validator (strict) accepts exactly what the form sends
    expect(validateCorrections("1099", built.fields).ok).toBe(true);
    // and the effective data the engine reads carries the corrected row while the AI value is untouched
    const eff = resolveEffectiveExtraction({
      docType: "1099",
      extractionData: { data: { bSummary: ai } },
      extractionCorrections: { version: 1, fields: { bSummary: { value: fixed, aiValue: ai } }, events: [] },
      extractionConfirmedAt: null,
    });
    expect((eff.extractionData as { data: { bSummary: unknown[] } }).data.bSummary).toEqual(fixed);
    expect(ai[0]!.proceedsCents).toBe(587231);
  });

  it("a malformed amount is an error on the field, not a silent zero", () => {
    const draft = draftFromValue(def, ai);
    draft.rows[0] = { ...draft.rows[0]!, costCents: "abc" };
    expect(buildCorrectionFields("1099", { bSummary: draft }, { bSummary: ai }, keys).errors.bSummary).toMatch(/Cost or other basis/);
    const neg = draftFromValue(def, ai);
    neg.rows[0] = { ...neg.rows[0]!, proceedsCents: "-5" };
    expect(buildCorrectionFields("1099", { bSummary: neg }, { bSummary: ai }, keys).errors.bSummary).toMatch(/not negative/);
  });

  it("the gain column accepts a loss; an added row can be typed by hand when the AI read nothing (aiData null)", () => {
    const draft = draftFromValue(def, null);
    expect(draft.rows).toEqual([]);
    draft.rows.push({ ...emptyRow(def), form: "1099-B", box: "D", proceedsCents: "25.56", costCents: "1000.00", gainLossCents: "-974.44" });
    const built = buildCorrectionFields("1099", { bSummary: draft }, { bSummary: null }, keys);
    expect(built.fields.bSummary).toEqual([
      { form: "1099-B", box: "D", proceedsCents: 2556, costCents: 100000, accruedMarketDiscountCents: null, washSaleLossDisallowedCents: null, gainLossCents: -97444 },
    ]);
    expect(validateCorrections("1099", built.fields).ok).toBe(true);
  });

  it("removing every row is the same as 'nothing' for change detection", () => {
    const empty = draftFromValue(def, []);
    expect(draftDiffers(def, empty, null)).toBe(false);
    expect(draftDiffers(def, empty, [])).toBe(false);
  });

  it("the 'AI read' line is readable and lists both rows", () => {
    const text = formatValueForDisplay(def, ai);
    expect(text).toContain("$5,872.31");
    expect(text).toContain("$17,001.68");
    expect(text.split(";")).toHaveLength(2);
  });

  it("the rows show beside their cross-field warnings (a wrong cost is called out)", () => {
    const bad = ai.map((r, i) => (i === 0 ? { ...r, costCents: 528560 } : r));
    expect(crossFieldWarnings("1099", { variantsPresent: ["1099-B"], bSummary: bad }).join("\n")).toMatch(/1099-B box A: the printed gain/);
  });
});

describe("review form: plain-language labels", () => {
  it("the group and the box options read in plain language, with the Form 8949 box in brackets", () => {
    expect(getTaxSchema("1099").groups.find((g) => g.id === "b")?.label).toBe("1099-B / 1099-DA sales summary (totals by Form 8949 category)");
    const box = def.itemFields!.find((i) => i.key === "box")!;
    expect(box.optionLabels?.A).toBe("Short-term, basis reported to the IRS (Form 8949 box A)");
    expect(box.optionLabels?.B).toBe("Short-term, basis NOT reported to the IRS (Form 8949 box B)");
    expect(box.optionLabels?.D).toBe("Long-term, basis reported to the IRS (Form 8949 box D)");
    expect(def.itemFields!.find((i) => i.key === "form")?.optionLabels?.["1099-DA"]).toMatch(/digital assets/);
    expect(def.label).toBe("Sales summary rows");
  });

  it("the review client renders enum cells through optionLabels (so the owner sees the plain-language text)", () => {
    const src = readFileSync(resolve(__dirname, "../../components/documents/tax-review-client.tsx"), "utf8");
    expect(src).toMatch(/spec\.optionLabels\?\.\[o\] \?\? o/);
  });
});
