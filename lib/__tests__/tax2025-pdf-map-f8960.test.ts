import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { LINE_KEYS, lineMeta } from "@/lib/tax2025/line-catalog";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { f8960Map } from "@/lib/tax2025/pdf/maps/f8960";
import { formInclusion } from "@/lib/tax2025/pdf/policy";
import type { PdfLine } from "@/lib/tax2025/pdf/types";
import type { LineKey, RuleStatus } from "@/lib/tax2025/types";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { engineLine, required, viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";

const P = "topmostSubform[0].Page1[0].";
const NO_STAMP = { ...DEFAULT_FILL_OPTIONS, stamp: false };
const F8960_KEYS = LINE_KEYS.filter((k) => k.startsWith("f8960."));

type Amounts = Readonly<Record<string, number>>;

/** Row 1: no allocation (the standard deduction: line 9b is 0). Whole-dollar lines of the household stand-in. */
const NO_ALLOCATION: Amounts = {
  "f8960.1": 1138,
  "f8960.2": 4,
  "f8960.4a": -9010,
  "f8960.4b": 9010,
  "f8960.5a": 5557,
  "f8960.5d": 5557,
  "f8960.8": 6699,
  "f8960.nii": 6699,
  "f8960.13": 270980,
  "f8960.14": 250000,
  "f8960.15": 20980,
  "f8960.16": 6699,
  "f8960.niit": 255,
};

/** Row 2: the state income tax allocated on line 9b (itemizing). */
const WITH_ALLOCATION: Amounts = { ...NO_ALLOCATION, "f8960.9b": 385, "f8960.9d": 385, "f8960.11": 385, "f8960.nii": 6314, "f8960.16": 6314, "f8960.niit": 240 };

function lines(amounts: Amounts, over: Partial<Record<LineKey, PdfLine>> = {}): Partial<Record<LineKey, PdfLine>> {
  const out: Partial<Record<LineKey, PdfLine>> = {};
  for (const key of F8960_KEYS) {
    const a = amounts[key];
    out[key] = a === undefined ? engineLine(key, 0, "not_applicable", "not applicable") : engineLine(key, a);
  }
  return { ...out, ...over };
}

const view = (amounts: Amounts = NO_ALLOCATION, over: Partial<Record<LineKey, PdfLine>> = {}) =>
  viewWith({ lines: lines(amounts, over), formsRequired: { f8960: required(true, "The modified adjusted gross income is over the threshold.") } });

const F: Record<string, number> = {
  "f8960.1": 3,
  "f8960.2": 4,
  "f8960.3": 5,
  "f8960.4a": 6,
  "f8960.4b": 7,
  "f8960.4c": 8,
  "f8960.5a": 9,
  "f8960.5b": 10,
  "f8960.5c": 11,
  "f8960.5d": 12,
  "f8960.6": 13,
  "f8960.7": 14,
  "f8960.8": 15,
  "f8960.9a": 16,
  "f8960.9b": 17,
  "f8960.9c": 18,
  "f8960.9d": 19,
  "f8960.10": 20,
  "f8960.11": 21,
  "f8960.nii": 22,
  "f8960.13": 23,
  "f8960.14": 24,
  "f8960.15": 25,
  "f8960.16": 26,
  "f8960.niit": 27,
};

const fmtDollars = (n: number): string => (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("en-US");

/** The hand-formatted read-back of a row: a zero prints only on lines 12, 15, 16 and 17 (the form says enter 0); other zeros are blank. */
function expectedFor(amounts: Amounts): Record<string, string> {
  const out: Record<string, string> = { [`${P}f1_1[0]`]: "Alex Example and Sam Q Example" };
  for (const [key, n] of Object.entries(F)) {
    const a = amounts[key] ?? 0;
    const printsZero = ["f8960.nii", "f8960.15", "f8960.16", "f8960.niit"].includes(key);
    if (a === 0 && !printsZero) continue;
    out[`${P}f1_${n}[0]`] = fmtDollars(a);
  }
  return out;
}

registerCommonMapTests({
  map: f8960Map,
  fieldCount: 38,
  view: view(NO_ALLOCATION),
  expected: expectedFor(NO_ALLOCATION),
  spot: [
    [`${P}f1_3[0]`, /1\. Taxable interest/],
    [`${P}f1_4[0]`, /2\. Ordinary dividends/],
    [`${P}f1_6[0]`, /4a\. Rental real estate, royalties, partnerships, S corporations, trusts, trades or businesses/],
    [`${P}f1_7[0]`, /4b\. Adjustment for net income or loss derived in the ordinary course of a non-section 1411 trade or business/],
    [`${P}f1_9[0]`, /5a\. Net gain or loss from disposition of property/],
    [`${P}f1_13[0]`, /6\. Adjustments to investment income for certain C F Cs and P F I Cs/],
    [`${P}f1_15[0]`, /8\. Total investment income\. Combine lines 1, 2, 3, 4c, 5d, 6, and 7/],
    [`${P}f1_17[0]`, /9b\. State, local, and foreign income tax/],
    [`${P}f1_19[0]`, /9d\. Add lines 9a, 9b, and 9c/],
    [`${P}f1_22[0]`, /12\. Net investment income\. Subtract Part I I, line 11, from Part I, line 8/],
    [`${P}f1_23[0]`, /13\. Modified adjusted gross income/],
    [`${P}f1_25[0]`, /15\. Subtract line 14 from line 13/],
    [`${P}f1_26[0]`, /16\. Enter the smaller of line 12 or line 15/],
    [`${P}f1_27[0]`, /17\. Net investment income tax for individuals\. Multiply line 16 by 3\.8%/],
    [`${P}f1_28[0]`, /18a\. Net investment income \(line 12 above\)/],
    [`${P}f1_35[0]`, /21\. Net investment income tax for estates and trusts/],
  ],
});

describe("Form 8960 map: every individual line is an engine line", () => {
  it("maps exactly the 25 individual lines (1-17) and nothing else; line 12 / 17 keep their keys", () => {
    expect(F8960_KEYS).toHaveLength(25);
    const mapped = f8960Map.lines.flatMap((l) => (l.kind === "money" ? [l.line] : []));
    expect([...mapped].sort()).toEqual([...F8960_KEYS].sort());
    expect(lineMeta("f8960.nii").formLine).toBe("12");
    expect(lineMeta("f8960.niit").formLine).toBe("17");
  });
});

describe("Form 8960 map: golden read-back of both rows", () => {
  it("row 1, no state-tax allocation: 12 = 6,699, 17 = 255; the loss on line 4a prints with a leading minus", async () => {
    const result = await fillForm("f8960", view(NO_ALLOCATION), f8960Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P}f1_6[0]`)).toBe("-9,010"); // 4a
    expect(f.get(`${P}f1_7[0]`)).toBe("9,010"); // 4b
    expect(f.get(`${P}f1_8[0]`)).toBe(""); // 4c computed 0 -> blank
    expect(f.get(`${P}f1_17[0]`)).toBe(""); // 9b: not applicable -> blank
    expect(f.get(`${P}f1_22[0]`)).toBe("6,699");
    expect(f.get(`${P}f1_27[0]`)).toBe("255");
  });

  it("row 2, with the allocation: 9b = 9d = 11 = 385, 12 = 6,314, 17 = 240", async () => {
    const result = await fillForm("f8960", view(WITH_ALLOCATION), f8960Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    for (const n of [17, 19, 21]) expect(f.get(`${P}f1_${n}[0]`), `f1_${n}`).toBe("385");
    expect(f.get(`${P}f1_22[0]`)).toBe("6,314");
    expect(f.get(`${P}f1_26[0]`)).toBe("6,314");
    expect(f.get(`${P}f1_27[0]`)).toBe("240");
  });

  it("line 12 and line 15 print '0' when computed 0 (the form says enter 0); other computed zeros stay blank", async () => {
    const zero = { ...NO_ALLOCATION, "f8960.nii": 0, "f8960.16": 0, "f8960.niit": 0 };
    const result = await fillForm("f8960", view(zero, { "f8960.15": engineLine("f8960.15", 0) }), f8960Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    for (const n of [22, 25, 26, 27]) expect(f.get(`${P}f1_${n}[0]`), `f1_${n}`).toBe("0");
    expect(f.get(`${P}f1_21[0]`)).toBe(""); // line 11
  });
});

describe("Form 8960 map: blanks by design and the blank-not-zero policy", () => {
  it("the SSN / EIN field, the three election boxes and the eight estate / trust fields are empty", async () => {
    const result = await fillForm("f8960", view(), f8960Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P}f1_2[0]`)).toBe("");
    for (const c of ["c1_1", "c1_2", "c1_3"]) expect(f.get(`${P}PartI[0].${c}[0]`), c).toBe(false);
    for (let n = 28; n <= 35; n++) expect(f.get(`${P}f1_${n}[0]`), `f1_${n}`).toBe("");
    expect(result.blankByDesign.ssn).toBe(1);
    expect(result.blankByDesign.form_na).toBe(8);
    expect(result.blankByDesign.not_modeled).toBe(3);
    expect(result.blankNotes.join(" ")).toContain("election boxes");
  });

  it("a missing_input owner statement leaves lines 6, 7 and the tax blank and raises blocking items (never 0)", async () => {
    const reason = "Needs an owner/CPA statement.";
    const over: Partial<Record<LineKey, PdfLine>> = {
      "f8960.6": engineLine("f8960.6", null, "missing_input" satisfies RuleStatus, reason),
      "f8960.niit": engineLine("f8960.niit", null, "missing_input", reason),
    };
    const result = await fillForm("f8960", view(NO_ALLOCATION, over), f8960Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P}f1_13[0]`)).toBe("");
    expect(f.get(`${P}f1_27[0]`)).toBe("");
    const byId = new Map(result.openItems.map((i) => [i.id, i]));
    expect(byId.get("blank:f8960:f8960.6")?.severity).toBe("blocking");
    expect(byId.get("blank:f8960:f8960.niit")?.severity).toBe("blocking");
  });

  it("included when the engine says it is required, omitted when MAGI is under the threshold", () => {
    expect(formInclusion(f8960Map, view()).include).toBe(true);
    const off = viewWith({ lines: lines({}), formsRequired: { f8960: required(false, "No net investment income tax: the modified adjusted gross income is not over the threshold.") } });
    expect(formInclusion(f8960Map, off).include).toBe(false);
  });
});
