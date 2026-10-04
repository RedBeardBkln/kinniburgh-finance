// L1.G2: filing-method implications (plan section 5.3). Not errors: things the owner must know before choosing paper or
// electronic filing. Nothing here asserts a rule of law; where a point depends on an IRS instruction the finding says so and
// is marked unverified (the point must be confirmed at the linked instructions, which the source pack will quote later).
//   - Form 8949 summary rows with an attached broker statement;
//   - the CT-1040 in this package is a flat printed form;
//   - the fields the owner completes by hand (taxpayer ids, bank details, signatures, preparer block).

import { BLANK_REASON_LABELS, type BlankReason } from "@/lib/tax2025/pdf/types";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";

const HAND_REASONS: readonly BlankReason[] = ["ssn", "ein", "bank", "signature_pin", "contact_address", "preparer"];

export const filingMethodCheck: L1Check = {
  id: "L1.G2",
  description: "Filing-method implications: Form 8949 summary statements, the flat CT-1040, fields to complete by hand",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    const sd = ctx.ret.scheduleD;
    const summaryRows = (sd?.categories ?? []).filter((c) => c.routing === "form_8949_summary").reduce((n, c) => n + c.rows.length, 0);
    if (summaryRows > 0) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.G2.form8949-statement",
          severity: "medium",
          area: "packaging",
          formKey: "f8949",
          message: `Your capital gains go on Form 8949 as ${summaryRows} summary row(s) that say "see attached statement" (one row per broker per category). The broker statement has to travel with the return. If you file on paper, attach it; if you file electronically, check how your filing software attaches a statement before you start (this review has not verified the instruction; read the Form 8949 instructions on irs.gov).`,
          evidence: [{ ref: "check:form8949-summary", amount: summaryRows, status: "summary rows" }],
          citation: { sources: [{ kind: "source_pack", id: "irs-form-8949-instructions", url: "https://www.irs.gov/instructions/i8949" }], sourceStatus: "unverified" },
          recommendedAction: "Read the Form 8949 instructions on irs.gov for your filing method, and keep the broker statement with your copy of the return.",
          acceptable: true,
        })
      );
    }
    const ct = ctx.packet.forms.find((f) => f.formId === "ct1040" && f.included);
    if (ct !== undefined) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.G2.ct-flat",
          severity: "info",
          area: "packaging",
          formKey: "ct1040",
          message: "The Connecticut CT-1040 in this package is a printed form with fields added by this app. Print it and file it on paper; whether a self-filer can submit it electronically is not verified here.",
          evidence: [{ ref: "form:ct1040", amount: null, status: "flat form" }],
          citation: { sources: [{ kind: "engine", id: "ct-overlay" }], sourceStatus: "not_applicable" },
          recommendedAction: "Check the Connecticut Department of Revenue Services website for the ways you can file.",
          acceptable: true,
        })
      );
    }
    const counts = new Map<BlankReason, number>();
    for (const f of ctx.packet.forms) {
      if (!f.included) continue;
      for (const [reason, n] of Object.entries(f.blankByDesign) as [BlankReason, number][]) counts.set(reason, (counts.get(reason) ?? 0) + n);
    }
    const lines = HAND_REASONS.filter((r) => (counts.get(r) ?? 0) > 0).map((r) => `${BLANK_REASON_LABELS[r]} (${counts.get(r)} field(s))`);
    if (lines.length > 0) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.G2.by-hand",
          severity: "info",
          area: "packaging",
          message: `You complete these by hand on the printed forms; this app never stores or fills them: ${lines.join("; ")}. Form 1040 has a signature line for you and one for your spouse.`,
          evidence: [{ ref: "check:by-hand", amount: lines.length, status: "categories" }],
          citation: { sources: [], sourceStatus: "not_applicable" },
          recommendedAction: "Use this as your checklist before you sign. The paid-preparer block stays empty because you prepared the return yourself.",
          acceptable: true,
        })
      );
    }
    return out;
  },
};
