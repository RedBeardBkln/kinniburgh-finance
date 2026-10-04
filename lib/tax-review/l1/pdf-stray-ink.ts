// L1.B2: no stray ink (plan section 5.3). Every non-empty field or checked box of every PDF must be one the form map
// deliberately fills (a money line, a table cell, a header name, a mapped checkbox or answer text). A field the map claims
// only as "blank by design" (SSN, EIN, bank numbers, signatures and PINs, the paid-preparer and third-party-designee block,
// address / phone / occupation) must be EMPTY: for a self-prepared return the paid-preparer block in particular stays blank.

import { collectClaims } from "@/lib/tax2025/pdf/completeness";
import { BLANK_REASON_LABELS, type BlankReason, type MapBlank } from "@/lib/tax2025/pdf/types";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { bindFiles, evidenceRefForField, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";

/** Blank reasons that name a person's private identifier or a block that must stay empty on a self-prepared return. */
const MUST_STAY_EMPTY: readonly BlankReason[] = ["ssn", "ein", "bank", "signature_pin", "preparer", "contact_address"];

function blankReasonOf(blank: readonly MapBlank[], field: string): BlankReason | null {
  for (const b of blank) {
    if ("field" in b) {
      if (b.field === field) return b.reason;
    } else {
      b.match.lastIndex = 0;
      if (b.match.test(field)) return b.reason;
    }
  }
  return null;
}

export const strayInkCheck: L1Check = {
  id: "L1.B2",
  description: "No field is filled that the map does not fill; private and paid-preparer fields are empty",
  async run(ctx: L1Context): Promise<Finding[]> {
    const files = ctx.read ?? (await readPacketFiles(ctx.packet.files));
    const out: Finding[] = [];
    for (const { file, map } of bindFiles(ctx, files)) {
      if (map === null) continue; // L1.B1 reports an unbound file
      const names = [...file.fields.keys()];
      const claims = collectClaims(map, names);
      const filledBy = new Map<string, boolean>(); // field -> claimed by something other than "blank"
      for (const c of claims) filledBy.set(c.field, (filledBy.get(c.field) ?? false) || c.by !== "blank");
      for (const [name, value] of file.fields) {
        const hasInk = typeof value === "boolean" ? value : value.trim() !== "";
        if (!hasInk) continue;
        const fillable = filledBy.get(name) === true;
        if (fillable) continue;
        const reason = blankReasonOf(map.blank, name);
        const label = reason === null ? null : BLANK_REASON_LABELS[reason];
        const mustStay = reason !== null && MUST_STAY_EMPTY.includes(reason);
        out.push(
          makeFinding({
            layer: "L1",
            check: reason === "preparer" ? "L1.B2.preparer" : mustStay ? "L1.B2.private" : "L1.B2.stray",
            severity: "blocker",
            area: mustStay ? "privacy" : "forms",
            formKey: file.formId,
            ruleTag: `${file.name}|${name}`,
            message:
              reason === "preparer"
                ? `${file.name}: the paid-preparer / third-party-designee block holds an entry. For a return you prepared yourself it must stay empty.`
                : mustStay
                  ? `${file.name}: a field that must stay empty (${label ?? "private identifier"}) holds an entry. Taxpayer ids, bank numbers, signatures and PINs are never filled by this app.`
                  : `${file.name}: a field that the form map does not fill holds a value${label === null ? "" : ` (left blank on purpose: ${label})`}.`,
            evidence: [{ ref: evidenceRefForField(file.formId, name), amount: null, status: typeof value === "boolean" ? "checked" : "printed" }],
            recommendedAction: "Do not file this PDF. Rebuild the packet from the app; never edit fields by hand in the generated files.",
            acceptable: false,
          })
        );
      }
    }
    return out;
  },
};
