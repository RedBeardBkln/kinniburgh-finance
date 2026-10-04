// Fail closed on missing input (tester finding D3). Several checks have nothing to say when an input they need is absent (no
// override layer, no cover model, no label table, no source documents, no maps, an empty packet): silently reporting "nothing
// found" would let a broken pipeline look like a clean return. This guard turns every missing input into a BLOCKER that the owner
// cannot accept: the review cannot vouch for what it could not look at.

import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Context } from "@/lib/tax-review/l1/context";

function missing(what: string, covers: string): Finding {
  return makeFinding({
    layer: "L1",
    check: "L1.runner.input-missing",
    severity: "blocker",
    area: "process",
    ruleTag: what,
    message: `The review could not run its checks on ${covers}: ${what} was not available. A missing input is never treated as a pass.`,
    evidence: [{ ref: `check:input.${what.replace(/[^a-z]+/gi, "-").slice(0, 40)}`, amount: null, status: "missing" }],
    recommendedAction: "Run the review again. If it repeats, the review has a defect: do not approve until it is fixed.",
    acceptable: false,
  });
}

/** One blocker per missing input of an L1 context (the PDF read-back is guarded separately in runL1). */
export function inputGuard(ctx: L1Context): Finding[] {
  const out: Finding[] = [];
  if (ctx.effective === null) out.push(missing("the override layer (effective return)", "overrides and their stale / dependent lines"));
  if (ctx.cover === null) out.push(missing("the cover page model", "the cover page figures"));
  if (ctx.raw === null) out.push(missing("the source documents", "the documents behind every income, withholding and deduction line"));
  if (Object.keys(ctx.lineLabels).length === 0) out.push(missing("the printed-line label table", "swapped lines in the form maps"));
  if (ctx.maps.length === 0) out.push(missing("the form maps", "the printed forms"));
  if (ctx.packet.files.filter((f) => f.formId !== null).length === 0) out.push(missing("the filled PDF forms", "what the forms print"));
  if (ctx.csvText.trim() === "") out.push(missing("the CSV export", "the CSV figures"));
  if (Object.keys(ctx.catalogs).length === 0) out.push(missing("the blank form field catalogs", "printed money lines no map fills"));
  return out;
}
