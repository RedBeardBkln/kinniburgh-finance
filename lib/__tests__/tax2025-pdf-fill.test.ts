import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { checkCompleteness } from "@/lib/tax2025/pdf/completeness";
import { fillForm, OVERFLOW_LABEL } from "@/lib/tax2025/pdf/fill";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { getBlankBytes } from "@/lib/tax2025/pdf/registry";
import type { FormMap, PdfTableRow } from "@/lib/tax2025/pdf/types";
import {
  DEFAULT_FILL_OPTIONS,
  assertMapComplete,
  assertMapGolden,
  loadCatalog,
  readAllFields,
} from "./tax2025-pdf-harness";
import { f1040Lines, makeView, pdfLine } from "./fixtures/tax2025-pdf-view.fixture";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";
const FS = `${P1}Checkbox_ReadOrder[0].`;

/** Expected read-back values of the synthetic MFJ fixture on the trial map (hand-formatted). */
const EXPECTED_1040: Record<string, string | boolean> = {
  [`${P1}f1_47[0]`]: "100,000", // 1a
  [`${P1}f1_59[0]`]: "1,234", // 2b
  // 3b computed 0 on a detail line -> blank (not listed)
  [`${P1}f1_72[0]`]: "-1,500", // 8
  [`${P1}f1_73[0]`]: "99,734", // 9
  [`${P1}f1_74[0]`]: "3,000", // 10
  [`${P1}f1_75[0]`]: "96,734", // 11a
  [`${P2}f2_02[0]`]: "31,500", // 12e
  [`${P2}f2_03[0]`]: "5,000", // 13a
  [`${P2}f2_05[0]`]: "36,500", // 14
  [`${P2}f2_06[0]`]: "60,234", // 15
  [`${P2}f2_08[0]`]: "6,800", // 16
  [`${P2}f2_16[0]`]: "9,500", // 24
  [`${P2}f2_20[0]`]: "11,000", // 25d
  [`${P2}f2_29[0]`]: "11,000", // 33
  [`${P2}f2_30[0]`]: "1,500", // 34
  // 37 computed 0 on a detail line -> blank
  [`${FS}c1_8[1]`]: true, // MFJ
  [`${P1}f1_14[0]`]: "Alex",
  [`${P1}f1_15[0]`]: "Example",
  [`${P1}f1_17[0]`]: "Sam Q",
  [`${P1}f1_18[0]`]: "Example",
};

const emptyMap = (extra: Partial<FormMap>): FormMap => ({
  formId: "f1040",
  lines: [],
  tables: [],
  header: [],
  blank: [],
  ...extra,
});

describe("1040 trial map completeness", () => {
  it("claims every one of the 199 fields exactly once", () => {
    expect(loadCatalog("f1040").fields).toHaveLength(199);
    assertMapComplete(f1040Map);
  });

  it("never fills SSN, bank, preparer, address, designee, PIN or dependents fields", () => {
    const names = loadCatalog("f1040").fields.map((f) => f.name);
    const filled = new Set([
      ...f1040Map.lines.map((l) => l.field),
      ...f1040Map.header.map((h) => h.field),
    ]);
    const forbidden = /SSN|RoutingNo|AccountNo|Table_Dependents|Address_ReadOrder|f1_16|f1_19|f2_3[2-3]|f2_3[7-9]|f2_4[0-9]|f2_5[01]|c2_1[6-8]/;
    for (const n of names) if (forbidden.test(n)) expect(filled.has(n), n).toBe(false);
  });
});

describe("fillForm on the real Form 1040", () => {
  it("golden: re-loaded values equal the hand-formatted expectation, everything else empty/unchecked", async () => {
    const result = await assertMapGolden(f1040Map, makeView(), EXPECTED_1040);
    expect(result.filledFields.length).toBe(Object.keys(EXPECTED_1040).length);
  });

  it("exactly one filing-status box is checked (MFJ)", async () => {
    const result = await fillForm("f1040", makeView(), f1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    const statusBoxes = [`${FS}c1_8[0]`, `${FS}c1_8[1]`, `${FS}c1_8[2]`, `${P1}c1_8[0]`, `${P1}c1_8[1]`];
    expect(statusBoxes.filter((n) => fields.get(n) === true)).toEqual([`${FS}c1_8[1]`]);
  });

  it("output fidelity: 199 fields before and after, /XFA /Perms /Extensions gone, nothing read-only, not flattened", async () => {
    const blank = await PDFDocument.load(getBlankBytes("f1040"));
    // The blank source really carries XFA and Perms (the strip below is doing something).
    // Checked BEFORE getForm(), because pdf-lib strips XFA itself when the form is opened.
    expect(blank.catalog.has(PDFName.of("Perms"))).toBe(true);
    expect(blank.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict)?.has(PDFName.of("XFA"))).toBe(true);
    expect(blank.getForm().getFields()).toHaveLength(199);
    const result = await fillForm("f1040", makeView(), f1040Map, DEFAULT_FILL_OPTIONS);
    const out = await PDFDocument.load(result.bytes);
    const acro = out.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
    expect(acro).toBeDefined();
    expect(acro?.has(PDFName.of("XFA"))).toBe(false);
    expect(out.catalog.has(PDFName.of("Perms"))).toBe(false);
    expect(out.catalog.has(PDFName.of("Extensions"))).toBe(false);
    expect(acro?.has(PDFName.of("NeedAppearances"))).toBe(false);
    const fields = out.getForm().getFields();
    expect(fields).toHaveLength(199);
    for (const f of fields) expect(f.isReadOnly(), f.getName()).toBe(false);
    // Not flattened: widgets still exist on the pages.
    const widgetCount = fields.reduce((n, f) => n + f.acroField.getWidgets().length, 0);
    expect(widgetCount).toBeGreaterThanOrEqual(199);
  });

  it("writes appearance streams for filled text fields and the on-state for the checkbox", async () => {
    const result = await fillForm("f1040", makeView(), f1040Map, DEFAULT_FILL_OPTIONS);
    const out = await PDFDocument.load(result.bytes);
    const form = out.getForm();
    const wages = form.getTextField(`${P1}f1_47[0]`);
    const ap = wages.acroField.getWidgets()[0]?.dict.lookup(PDFName.of("AP"), PDFDict);
    expect(ap?.has(PDFName.of("N"))).toBe(true);
    const mfj = form.getCheckBox(`${FS}c1_8[1]`);
    expect(mfj.isChecked()).toBe(true);
    const state = mfj.acroField.getWidgets()[0]?.dict.lookup(PDFName.of("AS"));
    // The on-state name is per box, NOT always "/1": the five filing-status boxes use 1..5 (MFJ = "/2").
    const onValue = loadCatalog("f1040").fields.find((f) => f.name === `${FS}c1_8[1]`)?.onValue;
    expect(onValue).toBe("2");
    expect(String(state)).toBe(`/${onValue}`);
  });

  it("a missing_input line is an empty field plus a blocking item; a computed 0 prints '0' on zero:print lines", async () => {
    const lines = f1040Lines();
    lines["f1040.2b"] = pdfLine({ key: "f1040.2b", formLabel: "Form 1040", formLine: "2b", label: "Taxable interest", status: "missing_input", amount: null, reason: "1099-INT not verified" });
    lines["f1040.9"] = pdfLine({ key: "f1040.9", formLabel: "Form 1040", formLine: "9", label: "Total income", status: "computed", amount: 0 });
    const result = await assertMapGolden(f1040Map, makeView({ lines }), {
      ...EXPECTED_1040,
      [`${P1}f1_59[0]`]: "", // 2b blank
      [`${P1}f1_73[0]`]: "0", // line 9 computed zero, zero:print
    });
    const item = result.openItems.find((i) => i.id === "blank:f1040:f1040.2b");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain("1099-INT not verified");
  });

  it("a line the engine does not emit stays blank; expected lines raise an advisory item", async () => {
    const lines = f1040Lines();
    delete lines["f1040.11a"];
    delete lines["f1040.8"];
    const result = await assertMapGolden(f1040Map, makeView({ lines }), {
      ...EXPECTED_1040,
      [`${P1}f1_75[0]`]: "",
      [`${P1}f1_72[0]`]: "",
    });
    expect(result.openItems.filter((i) => i.id.startsWith("noemit:")).map((i) => i.id)).toEqual(["noemit:f1040:f1040.11a"]);
  });

  it("unanswered digital-assets Y/N leaves BOTH boxes unchecked with an open item; an answer checks exactly one", async () => {
    const none = await fillForm("f1040", makeView(), f1040Map, DEFAULT_FILL_OPTIONS);
    expect(none.openItems.some((i) => i.id === "fill:f1040:answer:digitalAssets")).toBe(true);
    const yes = await assertMapGolden(f1040Map, makeView({ answers: { filingStatus: "mfj", digitalAssets: "no" } }), {
      ...EXPECTED_1040,
      [`${P1}c1_10[1]`]: true,
    });
    expect(yes.openItems.some((i) => i.id === "fill:f1040:answer:digitalAssets")).toBe(false);
  });

  it("no filing-status answer -> no box checked and an open item (never guesses)", async () => {
    const result = await fillForm("f1040", makeView({ answers: {} }), f1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    expect([...fields.entries()].filter(([n, v]) => n.includes("c1_8") && v === true)).toEqual([]);
    expect(result.openItems.some((i) => i.id === "fill:f1040:answer:filingStatus")).toBe(true);
  });

  it("sets the /TU tooltip for overridden and default-undecided lines", async () => {
    const lines = f1040Lines();
    lines["f1040.10"] = pdfLine({ key: "f1040.10", formLabel: "Form 1040", formLine: "10", label: "Adjustments", status: "overridden", amount: 3000, override: { note: "CPA override: was $2,500 computed, now $3,000, by Test", computedAmount: 2500, stale: false } });
    lines["f1040.13a"] = pdfLine({ key: "f1040.13a", formLabel: "Form 1040", formLine: "13a", label: "QBI", amount: 5000, defaultUndecided: "QBI form: Form 8995" });
    const result = await fillForm("f1040", makeView({ lines }), f1040Map, DEFAULT_FILL_OPTIONS);
    const form = (await PDFDocument.load(result.bytes)).getForm();
    const tu = (name: string): string => {
      const v = form.getTextField(name).acroField.dict.lookup(PDFName.of("TU"));
      return v instanceof PDFHexString ? v.decodeText() : String(v);
    };
    expect(tu(`${P1}f1_74[0]`)).toContain("CPA override: was $2,500");
    expect(tu(`${P2}f2_03[0]`)).toContain("default, undecided: QBI form: Form 8995");
  });
});

describe("blank-by-design fields are never written", () => {
  it("SSN/bank/preparer/address/dependents stay empty even with a hostile view", async () => {
    const result = await fillForm("f1040", makeView({ answers: { filingStatus: "mfj", ssn: "123-45-6789" } }), f1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    const re = /f1_16|f1_19|SSN_ReadOrder|RoutingNo|AccountNo|Address_ReadOrder|Table_Dependents|f2_3[7-9]|f2_4[0-9]|f2_5[01]/;
    for (const [name, value] of fields) if (re.test(name)) expect(value, name).toBe(typeof value === "boolean" ? false : "");
    expect(result.blankByDesign.ssn).toBeGreaterThanOrEqual(4);
    expect(result.blankByDesign.owner_statement_na).toBeGreaterThan(40);
    expect(result.blankByDesign.bank).toBe(4); // routing, account, checking, savings
  });
});

describe("text guards", () => {
  it("refuses SSN-like text and records a blocking item", async () => {
    const map = emptyMap({ header: [{ field: `${P1}f1_14[0]`, source: "household.taxpayer" }] });
    const result = await fillForm("f1040", makeView({ header: { taxpayerName: "Alex 123-45-6789" } }), map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${P1}f1_14[0]`)).toBe("");
    const item = result.openItems.find((i) => i.id.startsWith("fill:f1040:ssnlike:"));
    expect(item?.severity).toBe("blocking");
    expect(item?.message).not.toContain("123");
  });

  it("refuses SSN-like text from a text answer too", async () => {
    const map = emptyMap({ lines: [{ kind: "text", field: `${P1}f1_04[0]`, answer: "note" }] });
    const result = await fillForm("f1040", makeView({ answers: { note: "123 45 6789" } }), map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${P1}f1_04[0]`)).toBe("");
    expect(result.openItems.some((i) => i.id.startsWith("fill:f1040:ssnlike:"))).toBe(true);
  });

  it("sanitizes non-WinAnsi text instead of throwing", async () => {
    const map = emptyMap({ header: [{ field: `${P1}f1_14[0]`, source: "household.taxpayer" }] });
    const result = await fillForm("f1040", makeView({ header: { taxpayerName: "José “Joe” ł 😀" } }), map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${P1}f1_14[0]`)).toBe('José "Joe" ? ?');
  });

  it("does not write an over-wide value (maxLen) and lists an open item", async () => {
    // f1_03 is the 2-digit year field (maxLen 2): "100,000" cannot fit.
    const map = emptyMap({ lines: [{ kind: "money", field: `${P1}f1_03[0]`, line: "f1040.1a" }] });
    const result = await fillForm("f1040", makeView(), map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${P1}f1_03[0]`)).toBe("");
    expect(result.openItems.find((i) => i.id === `fill:f1040:toowide:${P1}f1_03[0]`)?.severity).toBe("blocking");
  });

  it("flags the first/last name split for verification", async () => {
    const result = await fillForm("f1040", makeView(), f1040Map, DEFAULT_FILL_OPTIONS);
    expect(result.openItems.some((i) => i.id === "fill:f1040:namesplit")).toBe(true);
  });

  it("missing header names leave the field blank with an advisory item", async () => {
    const map = emptyMap({ header: [{ field: `${P1}f1_14[0]`, source: "household.taxpayer" }] });
    const result = await fillForm("f1040", makeView({ header: { taxpayerName: null } }), map, DEFAULT_FILL_OPTIONS);
    expect((await readAllFields(result.bytes)).get(`${P1}f1_14[0]`)).toBe("");
    expect(result.openItems.some((i) => i.id === "fill:f1040:header:household.taxpayer")).toBe(true);
  });
});

describe("map soundness is enforced", () => {
  it("an unknown field name in a map throws", async () => {
    const map = emptyMap({ lines: [{ kind: "money", field: "topmostSubform[0].Page9[0].nope[0]", line: "f1040.1a" }] });
    await expect(fillForm("f1040", makeView(), map, DEFAULT_FILL_OPTIONS)).rejects.toThrow(/unknown field/);
    const report = checkCompleteness(map, loadCatalog("f1040").fields.map((f) => f.name));
    expect(report.unknown).toEqual(["topmostSubform[0].Page9[0].nope[0]"]);
  });

  it("a field claimed twice fails the completeness check and throws on fill", async () => {
    const dup = `${P1}f1_47[0]`;
    const map = emptyMap({
      lines: [{ kind: "money", field: dup, line: "f1040.1a" }],
      blank: [{ field: dup, reason: "not_modeled" }],
    });
    const report = checkCompleteness(map, loadCatalog("f1040").fields.map((f) => f.name));
    expect(report.duplicated).toEqual([dup]);
    await expect(fillForm("f1040", makeView(), map, DEFAULT_FILL_OPTIONS)).rejects.toThrow(/claimed more than once/);
  });

  it("an unclaimed field is reported", () => {
    const report = checkCompleteness(emptyMap({}), loadCatalog("f1040").fields.map((f) => f.name));
    expect(report.unclaimed).toHaveLength(199);
  });

  it("a money entry on a checkbox throws; a map for another form is rejected", async () => {
    const onBox = emptyMap({ lines: [{ kind: "money", field: `${P1}c1_1[0]`, line: "f1040.1a" }] });
    await expect(fillForm("f1040", makeView(), onBox, DEFAULT_FILL_OPTIONS)).rejects.toThrow(/not a text field/);
    await expect(fillForm("f1040s1", makeView(), emptyMap({}), DEFAULT_FILL_OPTIONS)).rejects.toThrow(/map is for f1040/);
  });
});

describe("stamp", () => {
  const hex = (s: string): string => Buffer.from(s, "latin1").toString("hex").toUpperCase();

  async function contentText(bytes: Uint8Array): Promise<string> {
    const doc = await PDFDocument.load(bytes);
    let all = "";
    for (const page of doc.getPages()) {
      const contents = page.node.Contents();
      const streams: unknown[] = [];
      if (contents instanceof PDFArray) {
        for (let i = 0; i < contents.size(); i++) streams.push(contents.lookup(i));
      } else {
        streams.push(contents);
      }
      for (const s of streams) {
        if (s instanceof PDFRawStream) all += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      }
    }
    return all;
  }

  it("stamp ON draws the DRAFT footer on every page; OFF omits it; fields are identical either way", async () => {
    const on = await fillForm("f1040", makeView(), f1040Map, { ...DEFAULT_FILL_OPTIONS, stamp: true });
    const off = await fillForm("f1040", makeView(), f1040Map, { ...DEFAULT_FILL_OPTIONS, stamp: false });
    const needle = hex("DRAFT computed by Banana Stand for CPA review - not filed - 2026-10-03 - fp abcdef012345");
    const onText = await contentText(on.bytes);
    expect(onText.split(needle).length - 1).toBe(2); // one per page (1040 has 2 pages)
    expect(await contentText(off.bytes)).not.toContain(hex("DRAFT computed"));
    const a = await readAllFields(on.bytes);
    const b = await readAllFields(off.bytes);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("the alternative label is stamped even when stamp is off", async () => {
    const r = await fillForm("f1040", makeView(), f1040Map, { ...DEFAULT_FILL_OPTIONS, stamp: false, alternativeLabel: "ALTERNATIVE - not included in return totals" });
    expect(await contentText(r.bytes)).toContain(hex("ALTERNATIVE - not included in return totals"));
  });
});

describe("tables and overflow", () => {
  // Synthetic table on Schedule B interest rows: capacity 3 (payer, amount) pairs from the real catalog.
  const cat = loadCatalog("f1040sb").fields.filter((f) => f.type === "text");
  const rows = [0, 1, 2].map((i) => ({ payer: cat[2 + i * 2]?.name ?? "", amount: cat[3 + i * 2]?.name ?? "" }));
  const map: FormMap = {
    formId: "f1040sb",
    lines: [],
    tables: [{ table: "schb.interest", rows, amountColumn: "amount", labelColumn: "payer", overflow: "summary_row_and_statement" }],
    header: [],
    blank: [],
  };
  const payers = (n: number): PdfTableRow[] =>
    Array.from({ length: n }, (_, i) => ({ cells: { payer: `Bank ${i + 1}`, amount: (i + 1) * 100 } }));
  const read = async (n: number) => {
    const result = await fillForm("f1040sb", makeView({ tables: { "schb.interest": payers(n) } }), map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    return { result, fields };
  };

  it("fewer, equal rows than capacity: every row on the form, no continuation", async () => {
    for (const n of [0, 1, 3]) {
      const { result, fields } = await read(n);
      expect(result.continuations).toEqual([]);
      for (let i = 0; i < 3; i++) {
        const row = rows[i];
        if (!row) continue;
        expect(fields.get(row.payer), `n=${n} row ${i}`).toBe(i < n ? `Bank ${i + 1}` : "");
        expect(fields.get(row.amount), `n=${n} row ${i}`).toBe(i < n ? `${(i + 1) * 100}` : "");
      }
    }
  });

  it("more rows than capacity: last row is 'Other (see statement)' with the remainder total; continuation lists every row", async () => {
    const { result, fields } = await read(5);
    expect(fields.get(rows[0]?.payer ?? "")).toBe("Bank 1");
    expect(fields.get(rows[1]?.payer ?? "")).toBe("Bank 2");
    expect(fields.get(rows[2]?.payer ?? "")).toBe(OVERFLOW_LABEL);
    // rows 3,4,5 -> 300 + 400 + 500
    expect(fields.get(rows[2]?.amount ?? "")).toBe("1,200");
    // total on the form equals the engine total (sum of all five)
    const total = ["100", "200", "1,200"].map((s) => Number(s.replace(",", ""))).reduce((a, b) => a + b, 0);
    expect(total).toBe(100 + 200 + 300 + 400 + 500);
    expect(result.continuations).toHaveLength(1);
    expect(result.continuations[0]?.rows).toHaveLength(5);
    expect(result.openItems.some((i) => i.id === "fill:f1040sb:schb.interest:overflow")).toBe(true);
  });
});
