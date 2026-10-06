// Forms the ENGINE can call required (Ty2025Return.formsRequired) that this packet cannot generate
// because no field map exists for them. They must never be silently absent: the cover lists every
// one the engine says is required (true) or cannot rule out ("blocking") with the engine's reason.
//
// `ENGINE_FORM_TITLES` is an exhaustive Record over the engine's FormId union, so a new engine form id
// is a COMPILE error until it is named here; `EXPLICIT_NO_PDF` is the list of ids without a map, and a
// test pins that it equals (all engine ids) minus (ids served by a registered map).

import type { FormId } from "@/lib/tax2025/types";
import type { PdfReturnView } from "@/lib/tax2025/pdf/types";

export const ENGINE_FORM_TITLES: Readonly<Record<FormId, string>> = {
  f1040: "Form 1040",
  sch1: "Schedule 1 (Form 1040)",
  sch2: "Schedule 2 (Form 1040)",
  sch3: "Schedule 3 (Form 1040)",
  scha: "Schedule A (Form 1040)",
  schb: "Schedule B (Form 1040)",
  schc: "Schedule C (Form 1040)",
  schse: "Schedule SE (Form 1040)",
  f8995: "Form 8995",
  f8959: "Form 8959",
  f6251: "Form 6251 (Alternative Minimum Tax)",
  f8960: "Form 8960 (Net Investment Income Tax)",
  f8283: "Form 8283 (Noncash Charitable Contributions)",
  f2210: "Form 2210 (Underpayment of Estimated Tax)",
  sch1a: "Schedule 1-A (Form 1040), Additional Deductions",
  f8889: "Form 8889 (Health Savings Accounts)",
  f8880: "Form 8880 (Saver's Credit)",
  f5695: "Form 5695 (Residential Energy Credits)",
  f4562: "Form 4562 (Depreciation and Amortization)",
  f8829: "Form 8829 (Business Use of Your Home)",
  schd: "Schedule D (Form 1040), Capital Gains and Losses",
  f8949: "Form 8949 (Sales and Other Dispositions of Capital Assets)",
  f8606: "Form 8606 (Nondeductible IRAs)",
  ct1040: "CT-1040",
};

/** Engine form ids this packet has no PDF map for (the CPA prepares them). */
export const EXPLICIT_NO_PDF: readonly FormId[] = [
  "f6251",
  "f8283",
  "f2210",
  "f8889",
  "f8880",
  "f5695",
  "f4562",
  "f8829",
];

export interface MissingRequiredForm {
  formId: FormId;
  title: string;
  /** true = the engine says it is required; "blocking" = it cannot tell until a blocking item is resolved. */
  required: true | "blocking";
  reason: string;
}

/** Forms the engine requires (or cannot rule out) that have no PDF map, in the explicit-list order. */
export function requiredFormsWithoutPdf(view: Pick<PdfReturnView, "formsRequired">): MissingRequiredForm[] {
  const out: MissingRequiredForm[] = [];
  for (const id of EXPLICIT_NO_PDF) {
    const v = view.formsRequired?.[id];
    if (v === undefined || v.required === false) continue;
    out.push({ formId: id, title: ENGINE_FORM_TITLES[id], required: v.required, reason: v.reason });
  }
  return out;
}
