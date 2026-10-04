import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { sch3Map } from "@/lib/tax2025/pdf/maps/sch3";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { coreView, withLine } from "./fixtures/tax2025-pdf-mfj-core.fixture";

const P1 = "topmostSubform[0].Page1[0].";

/** Hand-formatted read-back of the synthetic MFJ fixture on the Schedule 3 map. */
const EXPECTED: Record<string, string | boolean> = {
  [`${P1}f1_01[0]`]: "Alex Example and Sam Q Example",
  [`${P1}f1_03[0]`]: "150", // line 1 foreign tax credit
  // line 7 not applicable -> blank
  [`${P1}f1_25[0]`]: "150", // line 8 total nonrefundable credits
  [`${P1}f1_27[0]`]: "3,000", // line 10 amount paid with the extension request
  // line 11 computed 0 -> blank
  [`${P1}f1_37[0]`]: "3,000", // line 15 total other payments and refundable credits
};

registerCommonMapTests({
  map: sch3Map,
  fieldCount: 37,
  view: coreView(),
  expected: EXPECTED,
  spot: [
    [`${P1}f1_03[0]`, /1\. Foreign tax credit\. Attach Form 1116 if required/],
    [`${P1}f1_04[0]`, /2\. Credit for child and dependent care expenses from Form 2441/],
    [`${P1}f1_06[0]`, /4\. Retirement savings contributions credit\. Attach Form 8880/],
    [`${P1}f1_07[0]`, /5a\. Residential clean energy credit from Form 5695, line 15/],
    [`${P1}f1_08[0]`, /5b\. Energy efficient home improvement credit/],
    [`${P1}Line6a_ReadOrder[0].f1_09[0]`, /6\. Other nonrefundable credits: a\. General business credit/],
    [`${P1}f1_14[0]`, /6f\. Clean vehicle credit\. Attach Form 8936/],
    [`${P1}f1_24[0]`, /7\. Total other nonrefundable credits\. Add lines 6a through 6z/],
    [`${P1}f1_25[0]`, /8\. Add lines 1 through 4, 5a, 5b, and 7\..*line 20/],
    [`${P1}f1_27[0]`, /10\. Amount paid with request for extension to file/],
    [`${P1}f1_28[0]`, /11\. Excess social security and tier 1 R R T A tax withheld/],
    [`${P1}f1_36[0]`, /14\. Total other payments or refundable credits\. Add lines 13a through 13z/],
    [`${P1}f1_37[0]`, /15\. Add lines 9 through 12 and 14\..*line 31/],
  ],
});

describe("Schedule 3 map: policy details", () => {
  it("a missing_input credit line stays blank, SSN and the reserved line 6e are empty", async () => {
    const lines = withLine(coreView().lines, "sch3.4", { status: "missing_input", amount: null, reason: "Form 8880 not answered" });
    const result = await fillForm("f1040s3", coreView({ lines }), sch3Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_06[0]`)).toBe("");
    expect(f.get(`${P1}f1_02[0]`)).toBe("");
    expect(f.get(`${P1}f1_13[0]`)).toBe("");
    expect(result.openItems.find((i) => i.id === "blank:f1040s3:sch3.4")?.severity).toBe("blocking");
  });

  it("Form 5695 is dropped: a not-applicable 5a/5b prints blank (a carryforward would be an engine open item)", async () => {
    const result = await fillForm("f1040s3", coreView(), sch3Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_07[0]`)).toBe("");
    expect(f.get(`${P1}f1_08[0]`)).toBe("");
  });
});
