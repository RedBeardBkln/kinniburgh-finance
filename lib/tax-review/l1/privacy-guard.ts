// L1.D4: privacy guard (plan section 5.3). Every text surface the app produces is scanned for what must never appear in it:
// an SSN-like number, a bare 9-digit run, a long digit run (account / routing / loan number) and an unmasked EIN.
//   - cover page text, the CSV export, the review sheet, the open-item / decision / override text of the view and the
//     packet notices: all of the above;
//   - the PDF fields themselves: SSN-like text only (an employer FEIN is a legitimate entry on the CT withholding table).
// Findings never echo the text they found.

import { containsSsnLikeText } from "@/lib/tax-extraction-schema";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { readPacketFiles } from "@/lib/tax-review/l1/pdf-read";

function coverText(ctx: L1Context): string[] {
  if (ctx.cover === null) return [];
  return ctx.cover.blocks.map((b) => (b.kind === "kv" ? `${b.label} ${b.value}` : b.kind === "spacer" ? "" : b.text));
}

function viewText(ctx: L1Context): string[] {
  const v = ctx.view;
  return [
    ...v.openItems.flatMap((i) => [i.message, i.action]),
    ...v.decisions.flatMap((d) => [d.label, d.effectNote ?? "", d.overrideNote ?? ""]),
    ...v.overrides.map((o) => o.note),
    ...v.resolvedByOverride.flatMap((r) => [r.message, r.note]),
    ...v.acknowledged.map((a) => a.note),
    ...Object.values(v.lines).flatMap((l) => (l === undefined ? [] : [l.reason ?? "", l.label])),
    ...ctx.packet.openItems.map((i) => i.message),
  ];
}

export const privacyGuardCheck: L1Check = {
  id: "L1.D4",
  description: "No SSN-like number, 9-digit run, long digit run or unmasked EIN in any text the app produces",
  async run(ctx: L1Context): Promise<Finding[]> {
    const out: Finding[] = [];
    const surfaces: { name: string; texts: string[]; full: boolean }[] = [
      { name: "the cover page", texts: coverText(ctx), full: true },
      { name: "the CSV export", texts: [ctx.csvText], full: true },
      { name: "the review sheet", texts: [JSON.stringify(ctx.sheet)], full: true },
      { name: "the return view (open items, decisions, overrides)", texts: viewText(ctx), full: true },
    ];
    for (const s of surfaces) {
      const issues = new Set(s.texts.flatMap((t) => findRedactionIssues(t)));
      if (issues.size === 0) continue;
      // An employer ID on its own is a business identifier that the CT-1040 withholding list prints on purpose: shown, not blocked.
      const einOnly = [...issues].every((i) => i === "ein_like");
      out.push(
        makeFinding({
          layer: "L1",
          check: einOnly ? "L1.D4.ein" : "L1.D4.text",
          severity: einOnly ? "low" : "blocker",
          area: "privacy",
          ruleTag: s.name,
          message: `${s.name[0]?.toUpperCase() ?? ""}${s.name.slice(1)} contains text that looks like ${[...issues].map((i) => ({ ssn_like: "a Social Security number", nine_digit_run: "a 9-digit number", long_digit_run: "a long account-type number", ein_like: "an employer ID in full (the Connecticut withholding list prints employer IDs on purpose)" })[i]).join(", ")}. The text is not shown here.`,
          evidence: [{ ref: `check:privacy.${s.name.replace(/[^a-z]+/gi, "-").slice(0, 40)}`, amount: issues.size, status: [...issues].join(",") }],
          recommendedAction: einOnly
            ? "Keep this output private: do not post it or send it to anyone you do not trust with your employers' IDs."
            : "Do not share or file this output. Find the document, note or answer that carries the number and remove it, then rebuild.",
          acceptable: einOnly,
        })
      );
    }
    // the PDFs: SSN-like text only
    const files = ctx.read ?? (await readPacketFiles(ctx.packet.files));
    for (const f of files) {
      const hit = [...f.fields.values()].some((v) => typeof v === "string" && containsSsnLikeText(v));
      if (hit) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.D4.pdf",
            severity: "blocker",
            area: "privacy",
            formKey: f.formId,
            ruleTag: f.name,
            message: `${f.name} has a field holding text that looks like a Social Security number. This app never writes taxpayer ids into forms.`,
            evidence: [{ ref: `form:${f.formId}`, amount: null, status: "ssn-like text" }],
            recommendedAction: "Do not file this PDF. Rebuild the packet and find where the number came from.",
            acceptable: false,
          })
        );
      }
    }
    return out;
  },
};
