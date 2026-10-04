// L1.B6: PDF metadata and field tooltips (plan sections 5.3 and 5.7).
//   draft packet : every PDF must say DRAFT in its document properties (the per-page stamp is not readable from the field
//                  data, so the subject is the machine-checkable marker);
//   final package: no document property and no field tooltip may carry draft / override / AI / app / preparer-of-record
//                  wording. The package says only what the owner may file (see specs/11 once it exists).
// Page content text (stamp, cover) is not read here: those are built from models that have their own banned-token tests.

import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context, ReadPdfFile } from "@/lib/tax-review/l1/context";
import { readPacketFiles } from "@/lib/tax-review/l1/pdf-read";

/** Words that must not appear in a FINAL package's document properties (plan 7.5 / 5.7 banned list). */
export const FINAL_BANNED_PROPERTY = /claude|artificial|\bAI\b|banana stand|this app|draft|provisional|computed by|\bCPA\b|review/i;
/** Words that must not appear in a final field tooltip (the printed IRS tooltips themselves legitimately say "review" nowhere, but "override" / "undecided" are ours). */
export const FINAL_BANNED_TOOLTIP = /claude|artificial|\bAI\b|banana stand|this app|draft|provisional|computed by|\bCPA\b|override|undecided/i;

const INFO_KEYS = ["title", "subject", "keywords", "author", "creator", "producer"] as const;

function infoProblems(file: ReadPdfFile, mode: L1Context["mode"]): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  for (const k of INFO_KEYS) {
    const v = file.info[k];
    if (v === undefined || v === "") continue;
    if (mode === "final" && FINAL_BANNED_PROPERTY.test(v)) out.push({ field: k, text: v });
  }
  return out;
}

export const pdfMetadataCheck: L1Check = {
  id: "L1.B6",
  description: "Draft packets say DRAFT in their properties; final packages carry no draft / override / AI / app wording in properties or tooltips",
  async run(ctx: L1Context): Promise<Finding[]> {
    const files = ctx.read ?? (await readPacketFiles(ctx.packet.files));
    const out: Finding[] = [];
    for (const file of files) {
      if (ctx.mode === "draft") {
        const marker = [file.info.subject, file.info.title, file.info.keywords].some((v) => v !== undefined && /draft/i.test(v));
        if (!marker) {
          out.push(
            makeFinding({
              layer: "L1",
              check: "L1.B6.draft-marker",
              severity: "blocker",
              area: "packaging",
              formKey: file.formId,
              ruleTag: file.name,
              message: `${file.name} is part of a draft packet but its document properties do not say DRAFT, so a clean-looking copy could be mistaken for a final one.`,
              evidence: [{ ref: `form:${file.formId}`, amount: null, status: "no draft marker" }],
              recommendedAction: "Do not use this file. Rebuild the draft packet.",
              acceptable: false,
            })
          );
        }
        continue;
      }
      for (const p of infoProblems(file, ctx.mode)) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.B6.property",
            severity: "blocker",
            area: "packaging",
            formKey: file.formId,
            ruleTag: `${file.name}|${p.field}`,
            message: `${file.name}: the document ${p.field} contains wording that must not be in a final package (draft, review, AI, app or preparer-tool wording).`,
            evidence: [{ ref: `form:${file.formId}`, amount: null, status: `property ${p.field}` }],
            recommendedAction: "Do not release this package. Rebuild the final package from the app.",
            acceptable: false,
          })
        );
      }
      for (const [field, tip] of file.tooltips) {
        if (!FINAL_BANNED_TOOLTIP.test(tip)) continue;
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.B6.tooltip",
            severity: "blocker",
            area: "packaging",
            formKey: file.formId,
            ruleTag: `${file.name}|${field}`,
            message: `${file.name}: a field tooltip carries draft, override or tool wording (it is saved inside the PDF and anyone who opens the file can read it).`,
            evidence: [{ ref: `pdf:${file.formId}:${field.split(".").slice(-2).join(".")}`, amount: null, status: "tooltip" }],
            recommendedAction: "Do not release this package. Rebuild the final package from the app.",
            acceptable: false,
          })
        );
      }
    }
    return out;
  },
};
