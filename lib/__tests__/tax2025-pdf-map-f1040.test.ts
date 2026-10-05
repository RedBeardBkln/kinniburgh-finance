import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { DEFAULT_FILL_OPTIONS, assertMapGolden, loadCatalog, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { coreLines, coreView, withLine } from "./fixtures/tax2025-pdf-mfj-core.fixture";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const FS = `${P1}Checkbox_ReadOrder[0].`;

/** Hand-formatted read-back of the synthetic MFJ fixture on the full 1040 map. */
const EXPECTED: Record<string, string | boolean> = {
  // page 1 income
  [`${P1}f1_47[0]`]: "150,000", // 1a
  [`${P1}f1_57[0]`]: "150,000", // 1z
  [`${P1}f1_59[0]`]: "1,200", // 2b
  [`${P1}f1_60[0]`]: "300", // 3a
  [`${P1}f1_61[0]`]: "800", // 3b
  // 7a computed 0 on a detail line -> blank
  [`${P1}f1_72[0]`]: "52,000", // 8
  [`${P1}f1_73[0]`]: "204,000", // 9
  [`${P1}f1_74[0]`]: "2,315", // 10
  [`${P1}f1_75[0]`]: "201,685", // 11a
  // page 2 tax and credits
  [`${P2}f2_01[0]`]: "201,685", // 11b
  [`${P2}f2_02[0]`]: "31,800", // 12e
  [`${P2}f2_03[0]`]: "9,937", // 13a
  [`${P2}f2_05[0]`]: "41,737", // 14
  [`${P2}f2_06[0]`]: "159,948", // 15
  [`${P2}f2_08[0]`]: "24,013", // 16
  // 17 computed 0 -> blank
  [`${P2}f2_10[0]`]: "24,013", // 18
  // 19 computed 0 -> blank
  [`${P2}f2_12[0]`]: "150", // 20
  [`${P2}f2_13[0]`]: "150", // 21
  [`${P2}f2_14[0]`]: "23,863", // 22
  [`${P2}f2_15[0]`]: "4,844", // 23
  [`${P2}f2_16[0]`]: "28,707", // 24
  // payments
  [`${P2}f2_17[0]`]: "21,000", // 25a
  [`${P2}f2_20[0]`]: "21,000", // 25d
  [`${P2}f2_21[0]`]: "9,000", // 26
  [`${P2}f2_27[0]`]: "3,000", // 31
  [`${P2}f2_28[0]`]: "3,000", // 32
  [`${P2}f2_29[0]`]: "33,000", // 33
  [`${P2}f2_30[0]`]: "4,293", // 34
  [`${P2}f2_31[0]`]: "4,293", // 35a
  // 36 and 37 computed 0 -> blank
  // filing status MFJ, names
  [`${FS}c1_8[1]`]: true,
  [`${P1}f1_14[0]`]: "Alex",
  [`${P1}f1_15[0]`]: "Example",
  [`${P1}f1_17[0]`]: "Sam Q",
  [`${P1}f1_18[0]`]: "Example",
};

registerCommonMapTests({
  map: f1040Map,
  fieldCount: 199,
  view: coreView(),
  expected: EXPECTED,
  spot: [
    [`${P1}f1_47[0]`, /1a\. Total amount from Form\(s\) W-2, box 1/],
    [`${P1}f1_59[0]`, /2b\. Taxable interest/],
    [`${P1}f1_61[0]`, /3b\. Ordinary dividends/],
    [`${P1}f1_72[0]`, /8\. Additional income from Schedule 1, line 10/],
    [`${P1}f1_73[0]`, /9\. Add lines 1z, 2b, 3b, 4b, 5b, 6b, 7a, and 8\. This is your total income/],
    [`${P1}f1_75[0]`, /11a\. Subtract line 10 from line 9\. This is your adjusted gross income/],
    [`${P2}f2_02[0]`, /12e\. Standard deduction or itemized deductions/],
    [`${P2}f2_03[0]`, /13a\. Qualified business income deduction from Form 8995/],
    [`${P2}f2_06[0]`, /15\. Subtract line 14 from line 11b\..*taxable income/],
    [`${P2}f2_16[0]`, /24\. Add lines 22 and 23\. This is your total tax/],
    [`${P2}f2_20[0]`, /25d\. Add lines 25a through 25c/],
    [`${P2}f2_29[0]`, /33\. Add lines 25d, 26, and 32\. These are your total payments/],
    [`${P2}f2_30[0]`, /34\. If line 33 is more than line 24.*overpaid/],
    [`${P2}f2_35[0]`, /37\. Subtract line 33 from line 24\. This is the amount you owe/],
    [`${FS}c1_8[1]`, /Married filing jointly/],
  ],
});

describe("Form 1040 map: filing status, zero-print, privacy", () => {
  it("exactly one filing-status box is checked and it is the MFJ box whose on-value is /2", async () => {
    const result = await fillForm("f1040", coreView(), f1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    const statusBoxes = [`${FS}c1_8[0]`, `${FS}c1_8[1]`, `${FS}c1_8[2]`, `${P1}c1_8[0]`, `${P1}c1_8[1]`];
    expect(statusBoxes.filter((n) => fields.get(n) === true)).toEqual([`${FS}c1_8[1]`]);
    expect(loadCatalog("f1040").fields.find((f) => f.name === `${FS}c1_8[1]`)?.onValue).toBe("2");
  });

  it("no filing-status answer: no box is checked and an 'answer needed' item is raised", async () => {
    const result = await fillForm("f1040", coreView({ answers: {} }), f1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    for (const n of [`${FS}c1_8[0]`, `${FS}c1_8[1]`, `${FS}c1_8[2]`, `${P1}c1_8[0]`, `${P1}c1_8[1]`]) {
      expect(fields.get(n), n).toBe(false);
    }
    expect(result.openItems.some((i) => i.id === "fill:f1040:answer:filingStatus")).toBe(true);
  });

  it("digital assets: both boxes stay unchecked and an open item is raised until an attestation exists", async () => {
    const none = await fillForm("f1040", coreView(), f1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(none.bytes);
    expect(f.get(`${P1}c1_10[0]`)).toBe(false);
    expect(f.get(`${P1}c1_10[1]`)).toBe(false);
    expect(none.openItems.some((i) => i.id === "fill:f1040:answer:digitalAssets")).toBe(true);
    const no = await assertMapGolden(
      f1040Map,
      coreView({ answers: { filingStatus: "mfj", digitalAssets: "no" } }),
      { ...EXPECTED, [`${P1}c1_10[1]`]: true },
    );
    expect(no.openItems.some((i) => i.id === "fill:f1040:answer:digitalAssets")).toBe(false);
  });

  it("zero:'print' is set on exactly lines 9, 11a, 15, 16, 24, 33 and 'expected' on 11a, 15, 24", () => {
    const zero = f1040Map.lines.filter((l) => l.kind === "money" && l.zero === "print").map((l) => (l.kind === "money" ? l.line : ""));
    expect(zero.sort()).toEqual(["f1040.11a", "f1040.15", "f1040.16", "f1040.24", "f1040.33", "f1040.9"]);
    const expected = f1040Map.lines.filter((l) => l.kind === "money" && l.expected).map((l) => (l.kind === "money" ? l.line : ""));
    expect(expected.sort()).toEqual(["f1040.11a", "f1040.15", "f1040.24"]);
  });

  it("a computed 0 prints '0' on lines 9, 11a, 15, 16, 24, 33 and stays blank on detail lines (11b, 12e, 14)", async () => {
    let lines = coreLines();
    for (const key of ["f1040.9", "f1040.11a", "f1040.15", "f1040.16", "f1040.24", "f1040.33", "f1040.11b", "f1040.12e", "f1040.14"] as const) {
      lines = withLine(lines, key, { amount: 0 });
    }
    const result = await fillForm("f1040", coreView({ lines }), f1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_73[0]`)).toBe("0"); // 9
    expect(f.get(`${P1}f1_75[0]`)).toBe("0"); // 11a
    expect(f.get(`${P2}f2_06[0]`)).toBe("0"); // 15
    expect(f.get(`${P2}f2_08[0]`)).toBe("0"); // 16
    expect(f.get(`${P2}f2_16[0]`)).toBe("0"); // 24
    expect(f.get(`${P2}f2_29[0]`)).toBe("0"); // 33
    expect(f.get(`${P2}f2_01[0]`)).toBe(""); // 11b
    expect(f.get(`${P2}f2_02[0]`)).toBe(""); // 12e
    expect(f.get(`${P2}f2_05[0]`)).toBe(""); // 14
  });

  it("a missing_input line is blank (never 0) with a blocking item; an unemitted expected line raises an item", async () => {
    let lines = withLine(coreLines(), "f1040.2b", { status: "missing_input", amount: null, reason: "1099-INT not verified" });
    delete lines["f1040.11a"];
    lines = withLine(lines, "f1040.1a", { status: "not_yet_computed", amount: null, reason: "wages pending" });
    const result = await fillForm("f1040", coreView({ lines }), f1040Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_59[0]`)).toBe("");
    expect(f.get(`${P1}f1_75[0]`)).toBe("");
    expect(f.get(`${P1}f1_47[0]`)).toBe("");
    const byId = new Map(result.openItems.map((i) => [i.id, i]));
    expect(byId.get("blank:f1040:f1040.2b")?.severity).toBe("blocking");
    expect(byId.get("blank:f1040:f1040.1a")?.severity).toBe("advisory");
    expect(byId.has("noemit:f1040:f1040.11a")).toBe(true);
  });

  it("SSN, routing/account, designee, PIN, preparer, address, dependents, Presidential campaign are empty in the output", async () => {
    const result = await fillForm("f1040", coreView({ answers: { filingStatus: "mfj", digitalAssets: "no" } }), f1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    const mustBeEmpty = [
      `${P1}f1_16[0]`, // your SSN
      `${P1}f1_19[0]`, // spouse SSN
      `${P2}SSN_ReadOrder[0].f2_22[0]`,
      `${P2}RoutingNo[0].f2_32[0]`,
      `${P2}AccountNo[0].f2_33[0]`,
      `${P2}c2_16[0]`,
      `${P2}c2_16[1]`,
      `${P2}c2_17[0]`,
      `${P2}c2_17[1]`,
      `${P2}f2_37[0]`,
      `${P2}f2_38[0]`,
      `${P2}f2_39[0]`,
      `${P2}f2_41[0]`,
      `${P2}f2_43[0]`,
      `${P2}f2_44[0]`,
      `${P2}f2_45[0]`,
      `${P2}f2_46[0]`,
      `${P2}f2_47[0]`,
      `${P2}f2_50[0]`,
      `${P2}f2_51[0]`,
      `${P1}c1_6[0]`, // Presidential Election Campaign: you
      `${P1}c1_7[0]`, // spouse
    ];
    for (const n of mustBeEmpty) expect(fields.get(n), n).toBe(typeof fields.get(n) === "boolean" ? false : "");
    // every dependents-table field and every address field
    for (const [name, value] of fields) {
      if (/Table_Dependents|Dependents_ReadOrder|Address_ReadOrder/.test(name)) {
        expect(value, name).toBe(typeof value === "boolean" ? false : "");
      }
    }
    expect([...fields.keys()].filter((n) => /Table_Dependents/.test(n))).toHaveLength(40);
  });

  it("blank-by-design counts: 4 SSN fields (you, spouse, MFS spouse line, former spouse); 41 dependents fields (40 table + the more-than-four box) + the 4 line 16 boxes / code", async () => {
    const result = await fillForm("f1040", coreView(), f1040Map, DEFAULT_FILL_OPTIONS);
    expect(result.blankByDesign.ssn).toBe(4);
    expect(result.blankByDesign.owner_statement_na).toBe(45);
    // the "other tax year" header row (3 fields) is not used by a calendar-year return
    expect(result.blankByDesign.form_na).toBe(3);
    // 1h type (1) + the 4c boxes and code (4) + the 5c boxes and code (4) belong to amount lines that are zero here
    expect(result.blankByDesign.zero_line_entry).toBe(9);
  });
});
