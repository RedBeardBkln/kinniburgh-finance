import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { LINE_KEYS, lineMeta } from "@/lib/tax2025/line-catalog";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { sch1aMap } from "@/lib/tax2025/pdf/maps/sch1a";
import { formInclusion } from "@/lib/tax2025/pdf/policy";
import type { LineKey, RuleStatus } from "@/lib/tax2025/types";
import type { PdfLine } from "@/lib/tax2025/pdf/types";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { engineLine, required, viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";

const P1 = "form1[0].Page1[0].";
const P2 = "form1[0].Page2[0].";
const NO_STAMP = { ...DEFAULT_FILL_OPTIONS, stamp: false };

/** Every Schedule 1-A key the engine emits (all 41 printed money lines except 2a-2e and 22), straight from the catalog. */
const S1A_KEYS: LineKey[] = LINE_KEYS.filter((k) => k.startsWith("sch1a."));

/** The golden stand-in for the household's facts: tips 4,546 (one employer), overtime premium 2,408, MAGI 270,980, nothing else. */
const GOLDEN: Readonly<Record<string, number>> = {
  "sch1a.1": 270980,
  "sch1a.3": 270980,
  "sch1a.4a": 4546,
  "sch1a.4c": 4546,
  "sch1a.6": 4546,
  "sch1a.7": 4546,
  "sch1a.8": 270980,
  "sch1a.9": 300000,
  "sch1a.13": 4546,
  "sch1a.14a": 2408,
  "sch1a.14c": 2408,
  "sch1a.15": 2408,
  "sch1a.16": 270980,
  "sch1a.17": 300000,
  "sch1a.21": 2408,
  "sch1a.38": 6954,
};

function s1aLines(amounts: Readonly<Record<string, number>>, over: Partial<Record<LineKey, PdfLine>> = {}): Partial<Record<LineKey, PdfLine>> {
  const out: Partial<Record<LineKey, PdfLine>> = {};
  for (const key of S1A_KEYS) {
    const a = amounts[key];
    out[key] = a === undefined ? engineLine(key, 0, "not_applicable", "part not used") : engineLine(key, a);
  }
  return { ...out, ...over };
}

const view = (over: Partial<Record<LineKey, PdfLine>> = {}, amounts: Readonly<Record<string, number>> = GOLDEN) =>
  viewWith({ lines: s1aLines(amounts, over), formsRequired: { sch1a: required(true, "A Schedule 1-A deduction is claimed.") } });

const EXPECTED: Record<string, string> = {
  [`${P1}f1_01[0]`]: "Alex Example and Sam Q Example",
  [`${P1}f1_03[0]`]: "270,980", // 1
  [`${P1}f1_09[0]`]: "270,980", // 3
  [`${P1}f1_10[0]`]: "4,546", // 4a
  [`${P1}f1_12[0]`]: "4,546", // 4c
  [`${P1}f1_14[0]`]: "4,546", // 6
  [`${P1}f1_15[0]`]: "4,546", // 7
  [`${P1}f1_16[0]`]: "270,980", // 8
  [`${P1}f1_17[0]`]: "300,000", // 9
  [`${P1}f1_21[0]`]: "4,546", // 13
  [`${P1}f1_22[0]`]: "2,408", // 14a
  [`${P1}f1_24[0]`]: "2,408", // 14c
  [`${P1}f1_25[0]`]: "2,408", // 15
  [`${P1}f1_26[0]`]: "270,980", // 16
  [`${P1}f1_27[0]`]: "300,000", // 17
  [`${P1}f1_31[0]`]: "2,408", // 21
  [`${P2}f2_23[0]`]: "6,954", // 38
};

registerCommonMapTests({
  map: sch1aMap,
  fieldCount: 54,
  // the first field of Parts II, III and V quotes the part caution ("must have a valid social security number"); lines 4c and 5 say "more than one occupation", lines 36a and 36b "valid social security number"
  moneyFieldsWithPartCaption: [`${P1}f1_10[0]`, `${P1}f1_12[0]`, `${P1}f1_13[0]`, `${P1}f1_22[0]`, `${P2}f2_15[0]`, `${P2}f2_20[0]`, `${P2}f2_21[0]`],
  view: view(),
  expected: EXPECTED,
  spot: [
    [`${P1}f1_03[0]`, /1\. Enter the amount from Form 1040, 1040-S R, or 1040-N R, line 11b/],
    [`${P1}f1_04[0]`, /2a\. Enter any income from Puerto Rico/],
    [`${P1}f1_08[0]`, /2e\. Add lines 2a, 2b, 2c, and 2d/],
    [`${P1}f1_09[0]`, /3\. Add lines 1 and 2e/],
    [`${P1}f1_10[0]`, /a\. Enter qualified tips included on Form W-2, box 7/],
    [`${P1}f1_11[0]`, /4b\. Qualified tips included on Form 4137/],
    [`${P1}f1_13[0]`, /5\. Qualified tips received in the course of a trade or business/],
    [`${P1}f1_15[0]`, /7\. Enter the smaller of the amount on line 6 or \$25,000/],
    [`${P1}f1_21[0]`, /13\. Qualified tips deduction/],
    [`${P1}f1_22[0]`, /14a\. Qualified overtime compensation included in Form W-2, box 1/],
    [`${P1}f1_25[0]`, /15\. Enter the smaller of the amount on line 14c or \$12,500/],
    [`${P1}f1_31[0]`, /21\. Qualified overtime compensation deduction/],
    [`${P2}f2_07[0]`, /23\. Add lines 22a and 22b, column/],
    [`${P2}f2_14[0]`, /30\. Qualified passenger vehicle loan interest deduction/],
    [`${P2}f2_18[0]`, /34\. Multiply line 33 by 6% \(0\.06\)/],
    [`${P2}f2_20[0]`, /36a\. If you have a valid social security number/],
    [`${P2}f2_23[0]`, /38\. Add lines 13, 21, 30, and 37/],
  ],
});

describe("Schedule 1-A map: every printed money line is an engine line", () => {
  it("maps exactly the 41 keyed lines, 2a-2e and 22 are blank by design (a note on each)", () => {
    expect(S1A_KEYS).toHaveLength(41);
    const mapped = sch1aMap.lines.flatMap((l) => (l.kind === "money" ? [l.line] : []));
    expect([...mapped].sort()).toEqual([...S1A_KEYS].sort());
    expect(S1A_KEYS.every((k) => lineMeta(k).form === "Schedule 1-A")).toBe(true);
    const notes = sch1aMap.blank.filter((b) => "field" in b && b.note !== undefined);
    expect(notes).toHaveLength(11); // 2a-2e (5) + 22 (6)
  });
});

describe("Schedule 1-A map: policy details", () => {
  it("a part that is not used prints nothing: the no-tips, no-overtime, no-car, no-senior household prints Part I only", async () => {
    const result = await fillForm("f1040s1a", view({}, { "sch1a.1": 200000, "sch1a.3": 200000 }), sch1aMap, NO_STAMP);
    const f = await readAllFields(result.bytes);
    const filled = [...f.entries()].filter(([, v]) => v !== "" && v !== false).map(([k]) => k);
    expect(filled.sort()).toEqual([`${P1}f1_01[0]`, `${P1}f1_03[0]`, `${P1}f1_09[0]`]);
  });

  it("the SSN field and lines 2a-2e / 22 are empty even with a full return", async () => {
    const result = await fillForm("f1040s1a", view(), sch1aMap, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_02[0]`)).toBe("");
    for (const n of ["04", "05", "06", "07", "08"]) expect(f.get(`${P1}f1_${n}[0]`), `f1_${n}`).toBe("");
    for (const name of [...f.keys()].filter((k) => k.includes("Table_Line22"))) expect(f.get(name), name).toBe("");
    expect(result.blankByDesign.ssn).toBe(1);
    expect(result.blankByDesign.owner_statement_na).toBe(5);
    expect(result.blankByDesign.not_modeled).toBe(6);
    expect(result.blankNotes.join(" ")).toContain("vehicle identification number");
  });

  it("a computed zero deduction (fully phased out) prints blank, never a bare 0", async () => {
    const result = await fillForm("f1040s1a", view({ "sch1a.13": engineLine("sch1a.13", 0), "sch1a.38": engineLine("sch1a.38", 2408) }), sch1aMap, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_21[0]`)).toBe("");
    expect(f.get(`${P2}f2_23[0]`)).toBe("2,408");
  });

  it("line 3 missing_input leaves line 3 and the total blank and raises blocking items (never 0)", async () => {
    const reason = "Form 1040 line 11b is not computed yet.";
    const over: Partial<Record<LineKey, PdfLine>> = {
      "sch1a.3": engineLine("sch1a.3", null, "missing_input" satisfies RuleStatus, reason),
      "sch1a.8": engineLine("sch1a.8", null, "missing_input", reason),
      "sch1a.38": engineLine("sch1a.38", null, "missing_input", reason),
    };
    const result = await fillForm("f1040s1a", view(over), sch1aMap, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_09[0]`)).toBe("");
    expect(f.get(`${P1}f1_16[0]`)).toBe("");
    expect(f.get(`${P2}f2_23[0]`)).toBe("");
    const byId = new Map(result.openItems.map((i) => [i.id, i]));
    expect(byId.get("blank:f1040s1a:sch1a.3")?.severity).toBe("blocking");
    expect(byId.get("blank:f1040s1a:sch1a.38")?.severity).toBe("blocking");
  });

  it("an informational line 4a (more than one employer) stays blank with an advisory, not a blocking, item", async () => {
    const info = { ...engineLine("sch1a.4a", null, "not_yet_computed", "more than one employer"), informational: true };
    const result = await fillForm("f1040s1a", view({ "sch1a.4a": info as PdfLine }), sch1aMap, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_10[0]`)).toBe("");
    expect(result.openItems.find((i) => i.id === "blank:f1040s1a:sch1a.4a")?.severity).toBe("advisory");
  });

  it("included when the engine says it is required, omitted when it says no deduction", () => {
    expect(formInclusion(sch1aMap, view()).include).toBe(true);
    const off = viewWith({ lines: s1aLines({}), formsRequired: { sch1a: required(false, "No Schedule 1-A deduction.") } });
    expect(formInclusion(sch1aMap, off)).toEqual({ include: false, reason: "the engine reports it is not required: No Schedule 1-A deduction." });
  });
});
