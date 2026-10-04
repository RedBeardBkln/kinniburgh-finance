import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { sch2Map } from "@/lib/tax2025/pdf/maps/sch2";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { registerCommonMapTests } from "./tax2025-pdf-map-test-kit";
import { coreView, withLine } from "./fixtures/tax2025-pdf-mfj-core.fixture";

const P1 = "form1[0].Page1[0].";
const P2 = "form1[0].Page2[0].";

/** Hand-formatted read-back of the synthetic MFJ fixture on the Schedule 2 map. */
const EXPECTED: Record<string, string | boolean> = {
  [`${P1}f1_01[0]`]: "Alex Example and Sam Q Example",
  // line 2 (AMT) and line 3 computed 0 -> blank
  [`${P1}f1_15[0]`]: "4,629", // line 4 self-employment tax
  // line 7 computed 0 -> blank
  [`${P1}f1_22[0]`]: "215", // line 11 Additional Medicare Tax
  // line 12 NIIT computed 0 -> blank
  [`${P2}f2_24[0]`]: "4,844", // line 21 total other taxes
};

registerCommonMapTests({
  map: sch2Map,
  fieldCount: 63,
  view: coreView(),
  expected: EXPECTED,
  spot: [
    [`${P1}Line1a_ReadOrder[0].f1_03[0]`, /1\. Additions to tax: a\. Excess advance premium tax credit repayment/],
    [`${P1}f1_07[0]`, /1e\. Amount\./],
    [`${P1}f1_11[0]`, /1z\. Add lines 1a through 1y/],
    [`${P1}f1_12[0]`, /2\. Alternative minimum tax\. Attach Form 6251/],
    [`${P1}f1_13[0]`, /3\. Add lines 1z and 2\..*line 17/],
    [`${P1}f1_15[0]`, /4\. Amount\./],
    [`${P1}f1_18[0]`, /7\. Total additional social security and Medicare tax\. Add lines 5 and 6/],
    [`${P1}f1_22[0]`, /11\. Additional Medicare Tax\. Attach Form 8959/],
    [`${P1}f1_23[0]`, /12\. Net investment income tax\. Attach Form 8960/],
    [`${P2}f2_04[0]`, /17c\. Additional tax on H S A distributions/],
    [`${P2}f2_20[0]`, /17z\. and amount/],
    [`${P2}f2_21[0]`, /18\. Total additional taxes\. Add lines 17a through 17z/],
    [`${P2}f2_22[0]`, /19\. Recapture of net E P E from Form 4255, line 1d/],
    [`${P2}f2_24[0]`, /21\. Add lines 4, 7 through 16, 18, and 19\..*total other taxes/],
  ],
});

describe("Schedule 2 map: policy details", () => {
  it("a computed AMT of 0 stays blank; a needs_cpa line stays blank with a blocking item", async () => {
    const lines = withLine(coreView().lines, "sch2.2", { status: "needs_cpa_judgment", amount: null, reason: "AMT screen needs the CPA" });
    const result = await fillForm("f1040s2", coreView({ lines }), sch2Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_12[0]`)).toBe("");
    expect(result.openItems.find((i) => i.id === "blank:f1040s2:sch2.2")?.severity).toBe("blocking");
  });

  it("SSN is empty; the Form 4255 / exemption check boxes and the reserved line 10 are blank by design", async () => {
    const result = await fillForm("f1040s2", coreView(), sch2Map, DEFAULT_FILL_OPTIONS);
    const f = await readAllFields(result.bytes);
    expect(f.get(`${P1}f1_02[0]`)).toBe("");
    expect(f.get(`${P1}f1_21[0]`)).toBe(""); // line 10 reserved
    expect(result.blankByDesign.ssn).toBe(1);
  });
});
