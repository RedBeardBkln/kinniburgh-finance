import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { schSEMap } from "@/lib/tax2025/pdf/maps/schSE";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { coreView, withLine } from "./fixtures/tax2025-pdf-mfj-core.fixture";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";

/** Hand-formatted read-back of the synthetic MFJ fixture on the Schedule SE map. */
const EXPECTED: Record<string, string | boolean> = {
  [`${P1}f1_1[0]`]: "Alex Example", // person with self-employment income (the taxpayer name)
  [`${P1}f1_5[0]`]: "52,000", // line 2 net profit from Schedule C
  [`${P1}f1_6[0]`]: "52,000", // 3
  [`${P1}f1_7[0]`]: "48,022", // 4a
  [`${P1}f1_9[0]`]: "48,022", // 4c
  [`${P1}f1_12[0]`]: "48,022", // 6
  [`${P1}f1_13[0]`]: "176,100", // 7 maximum earnings subject to social security tax
  [`${P1}Line8a_ReadOrder[0].f1_14[0]`]: "150,000", // 8a
  [`${P1}f1_17[0]`]: "150,000", // 8d
  [`${P1}f1_18[0]`]: "26,100", // 9
  [`${P1}f1_19[0]`]: "3,236", // 10
  [`${P1}f1_20[0]`]: "1,393", // 11
  [`${P1}f1_21[0]`]: "4,629", // 12 self-employment tax
  [`${P1}f1_22[0]`]: "2,315", // 13 deduction for one-half of SE tax
};

registerCommonMapTests({
  map: schSEMap,
  fieldCount: 27,
  view: coreView(),
  expected: EXPECTED,
  spot: [
    [`${P1}f1_3[0]`, /1a\. Net farm profit or \(loss\) from Schedule F, line 34/],
    [`${P1}f1_5[0]`, /2\. Net profit or \(loss\) from Schedule C, line 31/],
    [`${P1}f1_6[0]`, /3\. Combine lines 1a, 1b, and 2/],
    [`${P1}f1_7[0]`, /4a\. If line 3 is more than zero, multiply line 3 by 92\.35%/],
    [`${P1}f1_9[0]`, /4c\. Combine lines 4a and 4b/],
    [`${P1}f1_12[0]`, /6\. Add lines 4c and 5b/],
    [`${P1}f1_13[0]`, /7\. Maximum amount of combined wages and self-employment earnings.*\$176,100/],
    [`${P1}Line8a_ReadOrder[0].f1_14[0]`, /8a\. Total social security wages and tips/],
    [`${P1}f1_17[0]`, /8d\. Add lines 8a, 8b, and 8c/],
    [`${P1}f1_18[0]`, /9\. Subtract line 8d from line 7/],
    [`${P1}f1_19[0]`, /10\. Multiply the smaller of line 6 or line 9 by 12\.4%/],
    [`${P1}f1_20[0]`, /11\. Multiply line 6 by 2\.9%/],
    [`${P1}f1_21[0]`, /12\. Self-employment tax\..*Schedule 2 \(Form 1040\), line 4/],
    [`${P1}f1_22[0]`, /13\. Deduction for one-half of self-employment tax.*Schedule 1 \(Form 1040\), line 15/],
    [`${P2}f2_4[0]`, /17\. Enter the smaller of: two-thirds/],
  ],
});

describe("Schedule SE map: policy details", () => {
  it("SSN and the minister (Form 4361) box are empty; farm and optional-method lines stay blank when not applicable", async () => {
    const result = await fillForm("f1040sse", coreView(), schSEMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_2[0]`)).toBe("");
    expect(f.get(`${P1}c1_1[0]`)).toBe(false);
    for (const n of [`${P1}f1_3[0]`, `${P1}f1_4[0]`, `${P1}f1_8[0]`, `${P2}f2_1[0]`, `${P2}f2_2[0]`, `${P2}f2_3[0]`, `${P2}f2_4[0]`]) {
      expect(f.get(n), n).toBe("");
    }
  });

  it("a not_yet_computed line stays blank with an advisory item (never 0)", async () => {
    const lines = withLine(coreView().lines, "se.8b", { status: "not_yet_computed", amount: null, reason: "Form 4137 not modeled" });
    const result = await fillForm("f1040sse", coreView({ lines }), schSEMap, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_15[0]`)).toBe("");
    expect(result.openItems.find((i) => i.id === "blank:f1040sse:se.8b")?.severity).toBe("advisory");
  });
});
