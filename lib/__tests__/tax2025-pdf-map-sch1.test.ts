import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { sch1Map } from "@/lib/tax2025/pdf/maps/sch1";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { coreView, withLine } from "./fixtures/tax2025-pdf-mfj-core.fixture";

const P1 = "topmostSubform[0].Page1[0].";
const P2 = "topmostSubform[0].Page2[0].";

/** Hand-formatted read-back of the synthetic MFJ fixture on the Schedule 1 map. */
const EXPECTED: Record<string, string | boolean> = {
  [`${P1}f1_01[0]`]: "Alex Example and Sam Q Example", // name(s) shown on Form 1040
  [`${P1}f1_07[0]`]: "52,000", // line 3 business income (Schedule C)
  // line 9 computed 0 -> blank
  [`${P1}f1_38[0]`]: "52,000", // line 10 additional income
  // line 13 computed 0 -> blank
  [`${P2}f2_05[0]`]: "2,315", // line 15 deductible part of SE tax
  // line 25 computed 0 -> blank
  [`${P2}f2_30[0]`]: "2,315", // line 26 adjustments to income
};

registerCommonMapTests({
  map: sch1Map,
  fieldCount: 73,
  view: coreView(),
  expected: EXPECTED,
  spot: [
    [`${P1}f1_04[0]`, /1\. Taxable refunds, credits, or offsets of state and local income taxes/],
    [`${P1}f1_07[0]`, /3\. Business income or \(loss\)\. Attach Schedule C/],
    [`${P1}f1_09[0]`, /5\. Rental real estate, royalties, partnerships, S corporations, trusts, etc\. Attach Schedule E/],
    [`${P1}f1_12[0]`, /7\. Amount\./],
    [`${P1}f1_34[0]`, /8v\. Digital assets received as ordinary income/],
    [`${P1}f1_36[0]`, /8z\. and amount/],
    [`${P1}f1_37[0]`, /9\. Total other income\. Add lines 8a through 8z/],
    [`${P1}f1_38[0]`, /10\. Combine lines 1 through 7 and 9\..*line 8/],
    [`${P2}f2_03[0]`, /13\. Health savings account deduction\. Attach Form 8889/],
    [`${P2}f2_05[0]`, /15\. Deductible part of self-employment tax\. Attach Schedule S E/],
    [`${P2}f2_06[0]`, /16\. Self-employed S E P, S I M P L E, and qualified plans/],
    [`${P2}f2_07[0]`, /17\. Self-employed health insurance deduction/],
    [`${P2}f2_12[0]`, /20\. Amount\./],
    [`${P2}f2_28[0]`, /24z\. and amount/],
    [`${P2}f2_30[0]`, /26\. Add lines 11 through 23 and 25\..*line 10/],
  ],
});

describe("Schedule 1 map: policy details", () => {
  it("not_yet_computed and missing_input lines stay blank (never 0) and raise items", async () => {
    let lines = withLine(coreView().lines, "sch1.13", { status: "not_yet_computed", amount: null, reason: "HSA not computed" });
    lines = withLine(lines, "sch1.17", { status: "missing_input", amount: null, reason: "SE health insurance not answered" });
    const result = await fillForm("f1040s1", coreView({ lines }), sch1Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P2}f2_03[0]`)).toBe("");
    expect(f.get(`${P2}f2_07[0]`)).toBe("");
    const byId = new Map(result.openItems.map((i) => [i.id, i]));
    expect(byId.get("blank:f1040s1:sch1.13")?.severity).toBe("advisory");
    expect(byId.get("blank:f1040s1:sch1.17")?.severity).toBe("blocking");
  });

  it("SSN fields (header and the line 19b recipient) are empty in the output", async () => {
    const result = await fillForm("f1040s1", coreView(), sch1Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_02[0]`)).toBe("");
    expect(f.get(`${P2}Line19b_CombField[0].f2_10[0]`)).toBe("");
    expect(result.blankByDesign.ssn).toBe(2);
  });
});
