// L1.B5: printed money lines that no map claims (plan section 5.3). Reuses the gap report (lib/tax2025-pdf-gap.ts: printed
// money lines of a form that no map entry fills; a heuristic over the IRS field descriptions). A line that is a PART of a
// footing rule but has no key means that footing cannot be proven: high. Every other unkeyed line is listed (info, one
// finding per form) so "the engine does not model this printed line" is visible rather than silent.

import { buildGapReport } from "@/lib/tax2025-pdf-gap";
import { lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { FOOTING_RULES } from "@/lib/tax-review/l1/footing-rules";
import { formIsFiled } from "@/lib/tax-review/l1/helpers";

/** "11a. Subtract line 10 ..." -> "11a". */
export function printedLineId(text: string): string | null {
  const m = /^(\d{1,2}[a-z]?)\./.exec(text.trim());
  return m?.[1] ?? null;
}

/** The printed line ids that take part in a footing rule of one form (as total or part). */
function ruleLineIds(formId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of FOOTING_RULES) {
    if (r.form !== formId) continue;
    for (const k of [r.total, ...r.parts.map((t) => t.key)]) {
      try {
        const m = lineMeta(k);
        // only lines printed on THIS form count (a part may belong to another form)
        if (k.startsWith(prefixOf(formId))) ids.add(m.formLine);
      } catch {
        /* a pending key has no printed line */
      }
    }
  }
  return ids;
}

function prefixOf(formId: string): string {
  switch (formId) {
    case "f1040":
      return "f1040.";
    case "f1040s1":
      return "sch1.";
    case "f1040s2":
      return "sch2.";
    case "f1040s3":
      return "sch3.";
    case "f1040sa":
      return "scha.";
    case "f1040sb":
      return "schb.";
    case "f1040sc":
      return "schc.";
    case "f1040sse":
      return "se.";
    case "f1040sd":
      return "schd.";
    case "f8995":
      return "f8995.";
    case "f8959":
      return "f8959.";
    case "f1040s1a":
      return "sch1a.";
    default:
      return `${formId}.`;
  }
}

/** The printed line ids the form map fills with a money field. */
function filledLineIds(ctx: L1Context, formId: string): Set<string> {
  const ids = new Set<string>();
  const map = ctx.maps.find((m) => m.formId === formId);
  for (const e of map?.lines ?? []) {
    if (e.kind !== "money") continue;
    try {
      ids.add(lineMeta(e.line as LineKey).formLine);
    } catch {
      /* a pending key has no printed line */
    }
  }
  return ids;
}

export const unkeyedLinesCheck: L1Check = {
  id: "L1.B5",
  description: "Printed money lines that no form map claims (footing cannot be proven for a part without a key)",
  run(ctx: L1Context): Finding[] {
    const gaps = buildGapReport(ctx.view, ctx.maps, ctx.catalogs);
    const out: Finding[] = [];
    for (const gap of gaps) {
      if (!formIsFiled(ctx, gap.formId)) continue;
      const inRule = ruleLineIds(gap.formId);
      // a printed line the map already fills with a money field: another field of the same line (a "type / description" box next to the amount) is a sub-field, not a missing amount
      const filledLines = filledLineIds(ctx, gap.formId);
      const keyed: string[] = [];
      const others: string[] = [];
      for (const u of gap.unmappedMoneyLines) {
        const id = printedLineId(u.text);
        if (id !== null && inRule.has(id) && !filledLines.has(id)) keyed.push(id);
        else others.push(id ?? u.field);
      }
      for (const id of keyed) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.B5.footing-part",
            severity: "high",
            area: "forms",
            formKey: gap.formId,
            ruleTag: id,
            message: `${gap.formId}: printed line ${id} is part of a total that the review checks, but no form map fills it, so that total cannot be proven to add up.`,
            evidence: [{ ref: `form:${gap.formId}`, amount: null, status: `line ${id} not modeled` }],
            recommendedAction: "Check this line by hand on the printed form. If it is zero or does not apply to you, accept this finding with that reason.",
            acceptable: true,
          })
        );
      }
      if (others.length > 0) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.B5.unmodeled",
            severity: "info",
            area: "forms",
            formKey: gap.formId,
            ruleTag: "list",
            message: `${gap.formId}: ${others.length} printed money line(s) are not modeled by the app and are left blank (${others.slice(0, 10).join(", ")}${others.length > 10 ? ", ..." : ""}). A blank is a zero on the form; check the list against your own situation.`,
            evidence: [{ ref: `form:${gap.formId}`, amount: others.length, status: "count" }],
            recommendedAction: "Read the list and make sure none of those lines applies to you.",
            acceptable: true,
          })
        );
      }
    }
    return out;
  },
};
