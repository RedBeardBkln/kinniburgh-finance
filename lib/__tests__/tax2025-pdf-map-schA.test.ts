import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { schAMap } from "@/lib/tax2025/pdf/maps/schA";
import { formInclusion } from "@/lib/tax2025/pdf/policy";
import { DEFAULT_FILL_OPTIONS, assertMapGolden, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { coreView, withLine } from "./fixtures/tax2025-pdf-mfj-core.fixture";

const P1 = "form1[0].Page1[0].";

/** Hand-formatted read-back of the synthetic MFJ fixture on the Schedule A map. */
const EXPECTED: Record<string, string | boolean> = {
  [`${P1}f1_1[0]`]: "Alex Example and Sam Q Example",
  // lines 1, 3, 4 (medical): not applicable -> blank
  [`${P1}Line2_ReadOrder[0].f1_4[0]`]: "201,685", // line 2 = Form 1040 line 11b
  [`${P1}f1_7[0]`]: "9,000", // 5a state and local income taxes
  [`${P1}f1_8[0]`]: "6,000", // 5b real estate taxes
  [`${P1}f1_9[0]`]: "800", // 5c personal property taxes
  [`${P1}f1_10[0]`]: "15,800", // 5d
  [`${P1}f1_11[0]`]: "15,800", // 5e after the $40,000 cap
  [`${P1}f1_14[0]`]: "15,800", // 7
  [`${P1}f1_15[0]`]: "12,000", // 8a mortgage interest (Form 1098)
  [`${P1}f1_20[0]`]: "12,000", // 8e
  [`${P1}f1_22[0]`]: "12,000", // 10
  [`${P1}f1_23[0]`]: "4,000", // 11 gifts by cash or check
  // 12 computed 0 -> blank
  [`${P1}f1_26[0]`]: "4,000", // 14
  [`${P1}f1_30[0]`]: "31,800", // 17 total itemized deductions
};

registerCommonMapTests({
  map: schAMap,
  fieldCount: 33,
  view: coreView(),
  expected: EXPECTED,
  spot: [
    [`${P1}f1_3[0]`, /1\. Medical and dental expenses \(see instructions\)/],
    [`${P1}Line2_ReadOrder[0].f1_4[0]`, /2\. Enter amount from Form 1040 or 1040-S R, line 11b/],
    [`${P1}f1_7[0]`, /5a\. Amount/],
    [`${P1}f1_8[0]`, /5b\. State and local real estate taxes/],
    [`${P1}f1_9[0]`, /5c\. State and local personal property taxes/],
    [`${P1}f1_10[0]`, /5d\. Add lines 5a through 5c/],
    [`${P1}f1_11[0]`, /5e\. Enter the smaller of line 5d or \$40,000/],
    [`${P1}f1_14[0]`, /7\. Add lines 5e and 6/],
    [`${P1}f1_15[0]`, /8a\. Home mortgage interest and points reported to you on Form 1098/],
    [`${P1}f1_18[0]`, /8c\. Points not reported to you on Form 1098/],
    [`${P1}f1_20[0]`, /8e\. Add lines 8a through 8c/],
    [`${P1}f1_23[0]`, /11\. Gifts by cash or check/],
    [`${P1}f1_24[0]`, /12\. Other than by cash or check/],
    [`${P1}f1_26[0]`, /14\. Add lines 11 through 13/],
    [`${P1}f1_30[0]`, /17\. Add the amounts in the far right column for lines 4 through 16\..*line 12e/],
  ],
});

describe("Schedule A map: SALT, charity, inclusion", () => {
  it("SALT is printed exactly as the engine computed it: 5d is the sum, 5e the capped amount (never recomputed here)", async () => {
    let lines = withLine(coreView().lines, "scha.5d", { amount: 52000 });
    lines = withLine(lines, "scha.5e", { amount: 40000 });
    await assertMapGolden(schAMap, coreView({ lines }), {
      ...EXPECTED,
      [`${P1}f1_10[0]`]: "52,000",
      [`${P1}f1_11[0]`]: "40,000",
    });
  });

  it("charitable lines 12 / 13 / 14 show the engine's noncash, carryover and total", async () => {
    let lines = withLine(coreView().lines, "scha.12", { amount: 1250 });
    lines = withLine(lines, "scha.13", { amount: 300 });
    lines = withLine(lines, "scha.14", { amount: 5550 });
    await assertMapGolden(schAMap, coreView({ lines }), {
      ...EXPECTED,
      [`${P1}f1_24[0]`]: "1,250",
      [`${P1}f1_25[0]`]: "300",
      [`${P1}f1_26[0]`]: "5,550",
    });
  });

  it("a missing_input SALT component stays blank with a blocking item; the sales-tax box and line 18 stay unchecked", async () => {
    const lines = withLine(coreView().lines, "scha.5a", { status: "missing_input", amount: null, reason: "CT payments not confirmed" });
    const result = await fillForm("f1040sa", coreView({ lines }), schAMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_7[0]`)).toBe("");
    expect(f.get(`${P1}c1_1[0]`)).toBe(false);
    expect(f.get(`${P1}Line18_ReadOrder[0].c1_3[0]`)).toBe(false);
    expect(result.openItems.find((i) => i.id === "blank:f1040sa:scha.5a")?.severity).toBe("blocking");
  });

  it("inclusion: included when scha.17 has an amount, omitted when every mapped line is not applicable (standard deduction wins)", () => {
    expect(formInclusion(schAMap, coreView()).include).toBe(true);
    let lines = coreView().lines;
    for (const m of schAMap.lines) {
      if (m.kind === "money") lines = withLine(lines, m.line as Parameters<typeof withLine>[1], { status: "not_applicable", amount: 0 });
    }
    expect(formInclusion(schAMap, coreView({ lines })).include).toBe(false);
  });
});
