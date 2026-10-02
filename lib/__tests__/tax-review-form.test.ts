import { describe, it, expect } from "vitest";
import { getFieldDef, getTaxSchema } from "@/lib/tax-extraction-schema";
import {
  buildCorrectionFields,
  draftDiffers,
  draftFromValue,
  emptyRow,
  formatValueForDisplay,
  suggestPaidInTaxYear,
  textToScalar,
  valueFromDraft,
  type FieldDraft,
} from "@/lib/tax-review-form";

function def(type: Parameters<typeof getFieldDef>[0], key: string) {
  const d = getFieldDef(type, key);
  if (!d) throw new Error(`missing ${type}.${key}`);
  return d;
}

const W2_AI: Record<string, unknown> = {
  taxYear: 2025,
  employerName: "Acme",
  employerEIN: "12-3456789",
  wagesCents: 5000000,
  federalWithheldCents: 800000,
  retirementPlan: true,
  statutoryEmployee: false,
  thirdPartySickPay: null,
  box12: [{ code: "D", amountCents: 600000 }],
  stateLines: [{ stateCode: "CT", stateEmployerId: null, stateWagesCents: 5000000, stateWithheldCents: 150000 }],
};

function draftsFor(type: Parameters<typeof getTaxSchema>[0], values: Record<string, unknown>) {
  const out: Record<string, FieldDraft> = {};
  for (const f of getTaxSchema(type).fields) out[f.key] = draftFromValue(f, values[f.key]);
  return out;
}

const visibleAll = (type: Parameters<typeof getTaxSchema>[0]) => new Set(getTaxSchema(type).fields.map((f) => f.key));

describe("draft <-> value round trip", () => {
  it("money shows as dollars and parses back to the same integer cents", () => {
    const wages = def("w2", "wagesCents");
    const draft = draftFromValue(wages, 5000000);
    expect(draft.text).toBe("50000.00");
    expect(valueFromDraft(wages, draft)).toEqual({ ok: true, value: 5000000 });
    expect(valueFromDraft(wages, { ...draft, text: "$51,234.50" })).toEqual({ ok: true, value: 5123450 });
  });

  it("an empty input is 'blank on the form' (null) for every scalar kind", () => {
    for (const key of ["wagesCents", "employerName", "employerEIN", "taxYear", "retirementPlan"]) {
      expect(valueFromDraft(def("w2", key), { text: "", rows: [], checked: [] })).toEqual({ ok: true, value: null });
    }
  });

  it("bad money is rejected with a readable message, not NaN", () => {
    const wages = def("w2", "wagesCents");
    const r = valueFromDraft(wages, { text: "12.345", rows: [], checked: [] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/Wages/);
    expect(valueFromDraft(wages, { text: "-5", rows: [], checked: [] }).ok).toBe(false); // not signed
    expect(valueFromDraft(def("k1", "ordinaryIncomeCents"), { text: "-5", rows: [], checked: [] })).toEqual({
      ok: true,
      value: -500,
    });
  });

  it("booleans, ints and enum round trip", () => {
    const plan = def("w2", "retirementPlan");
    expect(draftFromValue(plan, true).text).toBe("true");
    expect(draftFromValue(plan, false).text).toBe("false");
    expect(valueFromDraft(plan, draftFromValue(plan, false))).toEqual({ ok: true, value: false });
    expect(valueFromDraft(def("w2", "taxYear"), { text: "2025", rows: [], checked: [] })).toEqual({ ok: true, value: 2025 });
    expect(valueFromDraft(def("w2", "taxYear"), { text: "20x5", rows: [], checked: [] }).ok).toBe(false);
  });

  it("list rows round trip, drop empty rows, and an empty list is null", () => {
    const box12 = def("w2", "box12");
    const draft = draftFromValue(box12, [{ code: "D", amountCents: 600000 }]);
    expect(draft.rows).toEqual([{ code: "D", amountCents: "6000.00" }]);
    expect(valueFromDraft(box12, draft)).toEqual({ ok: true, value: [{ code: "D", amountCents: 600000 }] });
    expect(valueFromDraft(box12, { ...draft, rows: [...draft.rows, emptyRow(box12)] })).toEqual({
      ok: true,
      value: [{ code: "D", amountCents: 600000 }],
    });
    expect(valueFromDraft(box12, { text: "", rows: [], checked: [] })).toEqual({ ok: true, value: null });
    const bad = valueFromDraft(box12, { text: "", rows: [{ code: "D", amountCents: "abc" }], checked: [] });
    expect(bad.ok).toBe(false);
  });

  it("enum lists use checked options", () => {
    const variants = def("1099", "variantsPresent");
    expect(draftFromValue(variants, ["1099-INT", "1099-DIV"]).checked).toEqual(["1099-INT", "1099-DIV"]);
    expect(valueFromDraft(variants, { text: "", rows: [], checked: ["1099-INT"] })).toEqual({
      ok: true,
      value: ["1099-INT"],
    });
    expect(valueFromDraft(variants, { text: "", rows: [], checked: [] })).toEqual({ ok: true, value: null });
  });
});

describe("buildCorrectionFields", () => {
  it("an untouched form produces NO corrections (round trip equals the AI values)", () => {
    const built = buildCorrectionFields("w2", draftsFor("w2", W2_AI), W2_AI, visibleAll("w2"));
    expect(built.errors).toEqual({});
    expect(built.fields).toEqual({});
  });

  it("includes only the fields the owner changed, as typed values in integer cents", () => {
    const drafts = draftsFor("w2", W2_AI);
    drafts.wagesCents = { ...drafts.wagesCents!, text: "51,000.00" };
    drafts.employerName = { ...drafts.employerName!, text: "Acme Inc" };
    drafts.federalWithheldCents = { ...drafts.federalWithheldCents!, text: "" }; // blank on the form
    const built = buildCorrectionFields("w2", drafts, W2_AI, visibleAll("w2"));
    expect(built.fields).toEqual({ wagesCents: 5100000, employerName: "Acme Inc", federalWithheldCents: null });
  });

  it("collects unparseable fields as errors and does not include them", () => {
    const drafts = draftsFor("w2", W2_AI);
    drafts.wagesCents = { ...drafts.wagesCents!, text: "lots" };
    const built = buildCorrectionFields("w2", drafts, W2_AI, visibleAll("w2"));
    expect(Object.keys(built.errors)).toEqual(["wagesCents"]);
    expect(built.fields).not.toHaveProperty("wagesCents");
  });

  it("hidden fields are never submitted", () => {
    const drafts = draftsFor("w2", W2_AI);
    drafts.wagesCents = { ...drafts.wagesCents!, text: "1.00" };
    const visible = visibleAll("w2");
    visible.delete("wagesCents");
    expect(buildCorrectionFields("w2", drafts, W2_AI, visible).fields).toEqual({});
  });

  it("treats null and an empty list as the same 'nothing'", () => {
    const ai = { ...W2_AI, box14: [] };
    const built = buildCorrectionFields("w2", draftsFor("w2", ai), ai, visibleAll("w2"));
    expect(built.fields).toEqual({});
  });

  it("a changed list is submitted whole", () => {
    const drafts = draftsFor("w2", W2_AI);
    const box12 = def("w2", "box12");
    drafts.box12 = { ...drafts.box12!, rows: [...drafts.box12!.rows, { ...emptyRow(box12), code: "w", amountCents: "100" }] };
    const built = buildCorrectionFields("w2", drafts, W2_AI, visibleAll("w2"));
    expect(built.fields.box12).toEqual([
      { code: "D", amountCents: 600000 },
      { code: "w", amountCents: 10000 },
    ]);
  });
});

describe("draftDiffers / display", () => {
  it("flags a draft that differs from the compare value", () => {
    const wages = def("w2", "wagesCents");
    expect(draftDiffers(wages, draftFromValue(wages, 5), 5)).toBe(false);
    expect(draftDiffers(wages, draftFromValue(wages, 6), 5)).toBe(true);
    expect(draftDiffers(wages, { text: "oops", rows: [], checked: [] }, 5)).toBe(true);
  });

  it("formats AI values for display", () => {
    expect(formatValueForDisplay(def("w2", "wagesCents"), 5000000)).toBe("$50,000.00");
    expect(formatValueForDisplay(def("w2", "wagesCents"), null)).toBe("-");
    expect(formatValueForDisplay(def("w2", "retirementPlan"), true)).toBe("Yes");
    expect(formatValueForDisplay(def("w2", "box12"), [{ code: "D", amountCents: 600000 }])).toBe("D $6,000.00");
    expect(formatValueForDisplay(def("w2", "box12"), [])).toBe("-");
    expect(formatValueForDisplay(def("1099", "variantsPresent"), ["1099-INT", "1099-DIV"])).toBe("1099-INT, 1099-DIV");
  });

  it("textToScalar: ein/mask/date are plain trimmed text (the server validates the shape)", () => {
    expect(textToScalar({ key: "x", kind: "ein", label: "EIN" }, " 12-3456789 ")).toEqual({ ok: true, value: "12-3456789" });
  });
});

describe("property tax helper", () => {
  const installmentsDef = def("property_tax", "installments");
  const installments = [
    { label: "July", dueDate: "2025-07-01", amountCents: 300000, status: "unknown" },
    { label: "January", dueDate: "2026-01-01", amountCents: 300000, status: "unknown" },
  ];

  it("suggests the sum of installments due in the tax year as a dollars string (never auto-saved)", () => {
    const draft = draftFromValue(installmentsDef, installments);
    expect(suggestPaidInTaxYear(installmentsDef, draft, 2025)).toEqual({ cents: 300000, dollars: "3000.00" });
    expect(suggestPaidInTaxYear(installmentsDef, draft, 2024)).toBeNull();
  });

  it("returns null when the installment drafts are unparseable", () => {
    const draft: FieldDraft = { text: "", checked: [], rows: [{ label: "x", dueDate: "2025-07-01", amountCents: "abc", status: "" }] };
    expect(suggestPaidInTaxYear(installmentsDef, draft, 2025)).toBeNull();
  });

  it("paidInTaxYearCents starts blank (the AI never fills it) so a bill alone never feeds Schedule A", () => {
    const drafts = draftsFor("property_tax", { totalTaxBilledCents: 600000, paidInTaxYearCents: null });
    expect(drafts.paidInTaxYearCents?.text).toBe("");
    const built = buildCorrectionFields("property_tax", drafts, { totalTaxBilledCents: 600000 }, visibleAll("property_tax"));
    expect(built.fields).toEqual({});
  });
});
