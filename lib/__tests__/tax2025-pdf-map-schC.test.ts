import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { schCMap } from "@/lib/tax2025/pdf/maps/schC";
import type { PdfLine } from "@/lib/tax2025/pdf/types";
import { DEFAULT_FILL_OPTIONS, assertMapGolden, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { PART_V_ITEMS, coreLines, coreView, partVRows, withLine } from "./fixtures/tax2025-pdf-mfj-core.fixture";
import { pdfLine } from "./fixtures/tax2025-pdf-view.fixture";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const L817 = `${P1}Lines8-17[0].`;
const L1827 = `${P1}Lines18-27[0].`;
const PV = (n: number, col: "label" | "amount"): string =>
  `${P2}PartVTable[0].Item${n}[0].f2_${col === "label" ? 15 + (n - 1) * 2 : 16 + (n - 1) * 2}[0]`;

/** Hand-formatted read-back of the synthetic MFJ fixture on the Schedule C map. */
const EXPECTED: Record<string, string | boolean> = {
  [`${P1}f1_1[0]`]: "Alex Example", // proprietor
  [`${P1}f1_5[0]`]: "Example Consulting, LLC", // C. business name
  [`${P1}c1_1[0]`]: true, // F. accounting method: cash (on-value 1)
  [`${P1}c1_2[0]`]: true, // G. materially participated: Yes
  [`${P1}f1_10[0]`]: "98,000", // 1
  // 2 computed 0 -> blank
  [`${P1}f1_12[0]`]: "98,000", // 3
  // 4 computed 0 -> blank
  [`${P1}f1_14[0]`]: "98,000", // 5
  // 6 computed 0 -> blank
  [`${P1}f1_16[0]`]: "98,000", // 7
  [`${L817}f1_17[0]`]: "1,200", // 8 advertising
  // 9 car and truck: computed confirmed 0 (no business mileage) -> blank
  [`${L817}f1_20[0]`]: "4,500", // 11 contract labor
  [`${L817}f1_24[0]`]: "2,100", // 15 insurance
  [`${L817}f1_27[0]`]: "3,200", // 17 legal and professional services
  [`${L1827}f1_28[0]`]: "1,850", // 18 office expense
  [`${L1827}f1_33[0]`]: "640", // 22 supplies
  [`${L1827}f1_34[0]`]: "410", // 23 taxes and licenses
  [`${L1827}f1_35[0]`]: "2,750", // 24a travel
  [`${L1827}f1_36[0]`]: "975", // 24b deductible meals
  [`${L1827}f1_37[0]`]: "1,320", // 25 utilities
  [`${L1827}f1_39[0]`]: "25,555", // 27b other expenses
  [`${P1}f1_41[0]`]: "44,500", // 28
  [`${P1}f1_42[0]`]: "53,500", // 29
  [`${P1}f1_45[0]`]: "1,500", // 30 business use of home
  [`${P1}f1_46[0]`]: "52,000", // 31 net profit
  // Part V (8 items, 9th row blank) and line 48
  [PV(1, "label")]: "Software subscriptions",
  [PV(1, "amount")]: "9,800",
  [PV(2, "label")]: "Professional dues",
  [PV(2, "amount")]: "1,255",
  [PV(3, "label")]: "Bank and merchant fees",
  [PV(3, "amount")]: "2,400",
  [PV(4, "label")]: "Telephone and internet",
  [PV(4, "amount")]: "3,100",
  [PV(5, "label")]: "Education and training",
  [PV(5, "amount")]: "2,200",
  [PV(6, "label")]: "Postage and delivery",
  [PV(6, "amount")]: "1,800",
  [PV(7, "label")]: "Website and hosting",
  [PV(7, "amount")]: "3,000",
  [PV(8, "label")]: "Subcontracted lab services",
  [PV(8, "amount")]: "2,000",
  [`${P2}f2_33[0]`]: "25,555", // 48 total other expenses
};

registerCommonMapTests({
  map: schCMap,
  fieldCount: 105,
  view: coreView(),
  expected: EXPECTED,
  spot: [
    [`${P1}f1_1[0]`, /Name of proprietor/],
    [`${P1}f1_5[0]`, /C\. Business name\. If no separate business name, leave blank/],
    [`${P1}f1_10[0]`, /1\. Gross receipts or sales\./],
    [`${P1}f1_14[0]`, /5\. Gross profit\. Subtract line 4 from line 3/],
    [`${P1}f1_16[0]`, /7\. Gross income\. Add lines 5 and 6/],
    [`${L817}f1_18[0]`, /9\. Car and truck expenses \(see instructions\)/],
    [`${L817}f1_20[0]`, /11\. Contract labor \(see instructions\)/],
    [`${L817}f1_27[0]`, /17\. Legal and professional services/],
    [`${L1827}f1_28[0]`, /18\. Office expense \(see instructions\)/],
    [`${L1827}f1_36[0]`, /24b\. Deductible meals \(see instructions\)/],
    [`${L1827}f1_39[0]`, /27b\. Other expenses \(from line 48\)/],
    [`${L1827}f1_40[0]`, /27a\. Energy efficient commercial bldgs deduction/],
    [`${P1}f1_41[0]`, /28\. Total expenses before expenses for business use of home\. Add lines 8 through 27b/],
    [`${P1}f1_42[0]`, /29\. Tentative profit or \(loss\)\. Subtract line 28 from line 7/],
    [`${P1}f1_45[0]`, /30\. Use the Simplified Method Worksheet in the instructions to figure the amount to enter on line 30/],
    [`${P1}f1_46[0]`, /31\. Net profit or \(loss\)\. Subtract line 30 from line 29/],
    [`${P2}f2_6[0]`, /40\. Add lines 35 through 39/],
    [`${P2}f2_33[0]`, /48\. Total other expenses\. Enter here and on line 27b/],
    [PV(1, "label"), /Part V\. Other Expenses\..*1\. Business expense/],
    [PV(9, "amount"), /9\. Amount/],
  ],
});

describe("Schedule C map: line 9, line 30, accounting method, Part V", () => {
  it("line 9 (car and truck) computed $0 prints blank; Part IV (vehicle information) is blank by owner statement", async () => {
    const result = await fillForm("f1040sc", coreView(), schCMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${L817}f1_18[0]`)).toBe("");
    for (const [name, value] of f) {
      if (/Page2\[0\]\.(f2_(9|1[0-4])|c2_[5-8])\[\d\]$/.test(name)) expect(value, name).toBe(typeof value === "boolean" ? false : "");
    }
    expect(result.blankByDesign.owner_statement_na).toBe(14);
    expect(result.openItems.some((i) => i.lineKey === "schc.9")).toBe(false);
  });

  it("a Schedule C line 9 that is missing_input stays blank (never 0) with a blocking item", async () => {
    const lines = withLine(coreLines(), "schc.9", { status: "missing_input", amount: null, reason: "No mileage answer" });
    const result = await fillForm("f1040sc", coreView({ lines }), schCMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${L817}f1_18[0]`)).toBe("");
    expect(result.openItems.find((i) => i.id === "blank:f1040sc:schc.9")?.severity).toBe("blocking");
  });

  it("line 13 (depreciation) not_yet_computed stays blank with an advisory item", async () => {
    const lines = withLine(coreLines(), "schc.13", { status: "not_yet_computed", amount: null, reason: "Form 4562 phase" });
    const result = await fillForm("f1040sc", coreView({ lines }), schCMap, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${L817}f1_22[0]`)).toBe("");
    expect(result.openItems.find((i) => i.id === "blank:f1040sc:schc.13")?.severity).toBe("advisory");
  });

  it("line 30 under the undecided default home-office method carries the tooltip 'default, undecided: ...'", async () => {
    const label = "Home office: simplified method or actual expenses (Form 8829)";
    const line: PdfLine = pdfLine({
      key: "schc.30",
      formLabel: "Schedule C",
      formLine: "30",
      label: "Expenses for business use of your home",
      amount: 1500,
      defaultUndecided: label,
    });
    const result = await fillForm("f1040sc", coreView({ lines: { ...coreLines(), "schc.30": line } }), schCMap, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(result.bytes);
    const tu = doc.getForm().getTextField(`${P1}f1_45[0]`).acroField.dict.lookup(PDFName.of("TU"));
    const text = tu instanceof PDFHexString || tu instanceof PDFString ? tu.decodeText() : "";
    expect(text).toContain(`default, undecided: ${label}`);
    expect((await readAllFields(result.bytes)).get(`${P1}f1_45[0]`)).toBe("1,500");
  });

  it("accounting method and material participation: unanswered = nothing checked + two advisory items; answered = exactly that box", async () => {
    const none = await fillForm("f1040sc", coreView({ answers: { filingStatus: "mfj" } }), schCMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(none.bytes);
    for (const n of [`${P1}c1_1[0]`, `${P1}c1_1[1]`, `${P1}c1_1[2]`, `${P1}c1_2[0]`, `${P1}c1_2[1]`]) expect(f.get(n), n).toBe(false);
    const ids = new Set(none.openItems.map((i) => i.id));
    expect(ids.has("fill:f1040sc:answer:schC.accountingMethod")).toBe(true);
    expect(ids.has("fill:f1040sc:answer:schC.materialParticipation")).toBe(true);

    await assertMapGolden(
      schCMap,
      coreView({ answers: { filingStatus: "mfj", "schC.accountingMethod": "accrual", "schC.materialParticipation": "no" } }),
      { ...EXPECTED, [`${P1}c1_1[0]`]: false, [`${P1}c1_1[1]`]: true, [`${P1}c1_2[0]`]: false, [`${P1}c1_2[1]`]: true },
    );
  });

  it("principal business, business code and the line 30 square footages print only when answers exist; EIN and address stay blank", async () => {
    const view = coreView({
      answers: {
        filingStatus: "mfj",
        "schC.accountingMethod": "cash",
        "schC.materialParticipation": "yes",
        "schC.principalBusiness": "Scientific consulting",
        "schC.businessCode": "541990",
        "schC.homeSqft": "2400",
        "schC.officeSqft": "300",
      },
    });
    await assertMapGolden(schCMap, view, {
      ...EXPECTED,
      [`${P1}f1_3[0]`]: "Scientific consulting",
      [`${P1}BComb[0].f1_4[0]`]: "541990",
      [`${P1}Line30_ReadOrder[0].f1_43[0]`]: "2400",
      [`${P1}Line30_ReadOrder[0].f1_44[0]`]: "300",
    });
  });

  it("an SSN-like answer is refused (never written) and flagged", async () => {
    const view = coreView({
      answers: { filingStatus: "mfj", "schC.accountingMethod": "cash", "schC.materialParticipation": "yes", "schC.principalBusiness": "123-45-6789" },
    });
    const result = await fillForm("f1040sc", view, schCMap, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${P1}f1_3[0]`)).toBe("");
    expect(result.openItems.some((i) => /Social Security/i.test(i.message))).toBe(true);
  });

  it("EIN, SSN and business address fields are empty in the output", async () => {
    const result = await fillForm("f1040sc", coreView(), schCMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    for (const n of [`${P1}f1_2[0]`, `${P1}DComb[0].f1_6[0]`, `${P1}f1_7[0]`, `${P1}f1_8[0]`]) expect(f.get(n), n).toBe("");
    expect(result.blankByDesign.ein).toBe(1);
    expect(result.blankByDesign.ssn).toBe(1);
    expect(result.blankByDesign.contact_address).toBe(2);
  });

  it("Part V with more than 9 items: rows 1-8 as-is, row 9 'Other (see statement)' with the sum of the rest, continuation list lists all", async () => {
    const items: Array<readonly [string, number]> = [...PART_V_ITEMS, ["Item nine", 100], ["Item ten", 200], ["Item eleven", 300], ["Item twelve", 400]];
    const view = coreView({ tables: { "schc.otherExpenses": partVRows(items) } });
    const result = await fillForm("f1040sc", view, schCMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(PV(8, "label"))).toBe("Subcontracted lab services");
    expect(f.get(PV(9, "label"))).toBe("Other (see statement)");
    expect(f.get(PV(9, "amount"))).toBe("1,000"); // items 9..12: 100 + 200 + 300 + 400
    expect(result.continuations).toHaveLength(1);
    expect(result.continuations[0]?.rows).toHaveLength(12);
  });

  it("Part V with no item data: rows stay blank and only the engine's line 48 total prints", async () => {
    const result = await fillForm("f1040sc", coreView({ tables: {} }), schCMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    for (let n = 1; n <= 9; n++) {
      expect(f.get(PV(n, "label")), `row ${n}`).toBe("");
      expect(f.get(PV(n, "amount")), `row ${n}`).toBe("");
    }
    expect(f.get(`${P2}f2_33[0]`)).toBe("25,555");
  });

  it("Part V item labels with non-WinAnsi characters are sanitized, not thrown on", async () => {
    const view = coreView({ tables: { "schc.otherExpenses": partVRows([["Café “meetings” – team", 500]]) } });
    const result = await fillForm("f1040sc", view, schCMap, DEFAULT_FILL_OPTIONS);
    const label = (await readAllFields(result.bytes)).get(PV(1, "label"));
    expect(typeof label).toBe("string");
    expect(String(label)).toContain("meetings");
  });
});
