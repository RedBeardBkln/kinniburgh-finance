// L1.B3: printed-line label audit (plan section 5.3). A "swapped line" (two fields exchanged in a form map, so each amount lands
// on the other's printed line) is invisible to every check that uses the maps themselves, because the maps are also what filled
// the PDF. This check compares the map with an INDEPENDENT table: for every money field, the line number printed next to the
// field on the blank form (data/forms/2025/line-labels.json, found from the PDF text positions with pdf.js, not from the
// IRS field descriptions). The line the map puts in that field must be the line printed beside it.
//
// Coverage is reported honestly: a form that has no label table (Schedule B, D, Form 8949, 8995, 8959, CT-1040 at the time of
// writing) is listed as not audited, never silently passed.

import { lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { isLineKey, makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { evidenceRefForField } from "@/lib/tax-review/l1/pdf-read";

export interface LabelAudit {
  findings: Finding[];
  compared: number;
  /** Forms with money fields but no label table. */
  formsNotAudited: string[];
}

/** A printed label equals the engine's printed line, or is the single letter sub-label next to it (1040 line 7b prints only "b"). */
export function labelMatches(printed: string, found: string): boolean {
  return found === printed || (found.length === 1 && /^\d+[a-z]$/.test(printed) && printed.endsWith(found));
}

export function auditLabels(ctx: Pick<L1Context, "maps" | "lineLabels">): LabelAudit {
  const findings: Finding[] = [];
  const formsNotAudited: string[] = [];
  let compared = 0;
  for (const map of ctx.maps) {
    const table = ctx.lineLabels[map.formId];
    const money = map.lines.filter((l) => l.kind === "money");
    if (money.length === 0) continue;
    if (table === undefined) {
      formsNotAudited.push(map.formId);
      continue;
    }
    for (const entry of money) {
      if (entry.kind !== "money") continue;
      const key = String(entry.line);
      if (!isLineKey(key)) continue; // a pending key has no printed line in the catalog yet
      const found = table[entry.field];
      if (found === undefined) continue; // the label table has no row for this field
      compared += 1;
      const meta = lineMeta(key as LineKey);
      if (labelMatches(meta.formLine, found)) continue;
      findings.push(
        makeFinding({
          layer: "L1",
          check: "L1.B3.label",
          severity: "blocker",
          area: "forms",
          formKey: map.formId,
          lineKey: key as LineKey,
          ruleTag: entry.field,
          message: `The ${map.formId} form map puts ${meta.form} line ${meta.formLine} (${meta.label}) in a field that the blank form prints next to line "${found}". The amount would land on the wrong printed line.`,
          evidence: [{ ref: evidenceRefForField(map.formId, entry.field), amount: null, status: `printed line ${found}` }],
          citation: { sources: [{ kind: "form_text", id: `${map.formId}:${found}`, quote: `line ${found}` }], sourceStatus: "verified" },
          recommendedAction: "Do not file packets built from this form map. The map has a defect: fix the field assignment and rebuild.",
          acceptable: false,
        })
      );
    }
  }
  return { findings, compared, formsNotAudited };
}

export const labelAuditCheck: L1Check = {
  id: "L1.B3",
  description: "Each money field's line, per the form map, is the line printed beside it on the blank form",
  run(ctx) {
    return auditLabels(ctx).findings;
  },
};
