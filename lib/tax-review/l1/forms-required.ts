// L1.G1: required-form completeness (plan section 5.3). For every form the engine says the return needs (required: true) or
// cannot rule out (required: "blocking"): the app must have a form map, a pinned blank PDF, and the packet must actually
// contain the filled form. A form that is required but cannot be produced here (Schedule 1-A and Form 8960 until their PDFs
// are merged, Form 8283, Form 2210 ...) is a BLOCKER with one instruction: prepare that form outside this app and list it in
// the package index. This is correct behaviour, not a bug: approval stays impossible until every required form exists.

import { requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { plainText } from "@/lib/tax-review/l1/helpers";

export const requiredFormsCheck: L1Check = {
  id: "L1.G1",
  description: "Every form the engine requires exists in the packet (a map, a pinned blank, a filled file)",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    const required = Object.entries(ctx.view.formsRequired ?? {}).filter(([, v]) => v !== undefined && v.required !== false);
    const titles = new Map(requiredFormsWithoutPdf({ formsRequired: ctx.view.formsRequired }).map((m) => [m.formId as string, m.title]));
    for (const [engineId, v] of required) {
      if (v === undefined) continue;
      const map = ctx.maps.find((m) => m.engineFormId === engineId || (engineId === "f1040" && m.formId === "f1040"));
      const title = titles.get(engineId) ?? engineId;
      const state = v.required === "blocking" ? "the engine cannot rule it out yet" : "the engine says it is required";
      if (map === undefined) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.G1.no-pdf",
            severity: "blocker",
            area: "forms",
            formKey: engineId,
            ruleTag: engineId,
            message: `${title}: ${state} (${plainText(v.reason, 200)}), but this app has no PDF for it. The amounts that flow from it may already appear on other forms with no supporting form in the package.`,
            evidence: [{ ref: `form:${engineId}`, amount: null, status: "no pdf" }],
            recommendedAction: "Prepare this form outside this app and list it in the package index. Approval stays blocked until every required form exists.",
            acceptable: false,
          })
        );
        continue;
      }
      if (!ctx.blankFormIds.has(map.formId)) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.G1.no-blank",
            severity: "blocker",
            area: "forms",
            formKey: engineId,
            ruleTag: engineId,
            message: `${title}: ${state}, and a form map exists, but its blank PDF is not pinned in the form manifest, so it cannot be filled.`,
            evidence: [{ ref: `form:${engineId}`, amount: null, status: "no blank" }],
            recommendedAction: "Prepare this form outside this app. (A missing blank is a defect in the app's form registry.)",
            acceptable: false,
          })
        );
        continue;
      }
      const emitted = ctx.packet.files.some((f) => f.formId === map.formId);
      if (!emitted) {
        const note = ctx.packet.forms.find((f) => f.formId === map.formId);
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.G1.not-emitted",
            severity: "blocker",
            area: "forms",
            formKey: engineId,
            ruleTag: engineId,
            message: `${title}: ${state}, but the packet does not contain it${note !== undefined && !note.included ? ` (${plainText(note.reason, 200)})` : ""}.`,
            evidence: [{ ref: `form:${engineId}`, amount: null, status: "not in packet" }],
            recommendedAction: "Do not file without this form. Rebuild the packet; if it is still missing, prepare the form outside this app.",
            acceptable: false,
          })
        );
      }
    }
    return out;
  },
};
