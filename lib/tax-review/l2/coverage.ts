// L2 oracle: the honest covered / not-covered table (plan 5.4: "a line the oracle does not cover must be listed as not covered, never
// silently passed"). Pure.

import type { Ty2025Return } from "@/lib/tax2025/types";
import type { DiffResult } from "@/lib/tax-review/l2/diff";
import type { FormsDiff } from "@/lib/tax-review/l2/forms-required";
import { engineLineOf } from "@/lib/tax-review/l2/engine-view";
import type { Ledger } from "@/lib/tax-review/l2/ledger";
import type { EffectiveReturn } from "@/lib/tax2025/overrides";

export interface L2Coverage {
  /** A form / line group, or a thing the recalculation does not check. */
  area: string;
  /** true = recomputed from the facts and diffed against the return on this run; false = NOT checked by the recalculation. */
  compared: boolean;
  note: string;
  linesCompared?: number;
  linesMatched?: number;
}

const GROUPS: { label: string; prefixes: readonly string[] }[] = [
  { label: "Form 1040 (lines 1a-37)", prefixes: ["f1040."] },
  { label: "Schedule 1 (income, adjustments, totals)", prefixes: ["sch1."] },
  { label: "Schedule 2 (additional taxes)", prefixes: ["sch2."] },
  { label: "Schedule 3 (credits and payments)", prefixes: ["sch3."] },
  { label: "Schedule A and the standard deduction", prefixes: ["scha.", "std."] },
  { label: "Schedule B (interest and dividend totals)", prefixes: ["schb."] },
  { label: "Schedule C (net profit, from the engine's classified GL amounts)", prefixes: ["schc."] },
  { label: "Schedule D and Form 8949 totals", prefixes: ["schd."] },
  { label: "Schedule SE", prefixes: ["se."] },
  { label: "Form 8995 (qualified business income deduction)", prefixes: ["f8995."] },
  { label: "Form 8959 (Additional Medicare Tax)", prefixes: ["f8959."] },
  { label: "Form 8960 (net investment income tax)", prefixes: ["f8960."] },
  { label: "Form 8606 (nondeductible IRAs, Part I: lines 2, 3 and 14)", prefixes: ["f8606a.", "f8606b."] },
  { label: "Schedule 1-A (tips, overtime, car loan interest, seniors)", prefixes: ["sch1a."] },
  { label: "Form 6251 (alternative minimum tax screen)", prefixes: ["f6251."] },
  { label: "Qualified Dividends and Capital Gain Tax Worksheet", prefixes: ["qdcg."] },
  { label: "Form 2210 Part I (required annual payment, lines 4-9)", prefixes: ["f2210."] },
  { label: "Form 8880 line 8 (AGI copy only)", prefixes: ["f8880."] },
  { label: "Form CT-1040 (lines 1-26, Schedule 1 totals, Schedule 3)", prefixes: ["ct1040."] },
];

/** What the recalculation never checks, whatever the facts are. Each reason is a statement about scope, not a result. */
export const NOT_COVERED: readonly { area: string; note: string }[] = [
  { area: "Fact resolution (which documents feed which fact, person attribution, year selection)", note: "The recalculation starts from the same facts the return was built from, so it cannot see a facts error. The source-document checks (L1) and the AI passes (L3) look at that." },
  { area: "GL account to Schedule C line classification", note: "The classified amounts per Schedule C line are an input. The 50% meals rule, the standard mileage deduction, the simplified home office deduction, and every total on Schedule C are recomputed." },
  { area: "Home office actual method (Form 8829) and depreciation (Form 4562, section 179)", note: "Not computed by the return itself; a return that needs them is not complete." },
  { area: "Form 2210 Part III penalty estimate (Form 1040 line 38) and Connecticut CT-1040 lines 27-30", note: "Informational estimates; the recalculation does not recompute them (Form 2210 Part I, the required annual payment, is recomputed)." },
  { area: "Forms 8889 (HSA), IRA deduction worksheet, Form 8880 (saver's credit), Form 1116 (foreign tax credit), Schedule 1 lines 16 and 17", note: "When the facts state the amount it is recomputed as stated; otherwise the return's own figure is taken as an input and listed as an input, not checked." },
  { area: "Schedule D Tax Worksheet, Form 6251 Part III, Form 8995-A, Schedule 8812, Forms 8863 / 2441 / 5695 credits", note: "Not recomputed; the return treats these as not applicable or blocks, and a return that reaches them is flagged by the recomputation's own list of what it could not recompute." },
  { area: "Connecticut Tax Tables for Connecticut AGI between $24,001 and $102,000, CT-6251, Schedule 2 (other-state credit), use tax worksheet", note: "The DRS tables are not in the source pack, so line 6 is not recomputed in that range; the other items are taken from the return when the owner stated them." },
  { area: "Form 1099-B transaction detail, Form 8949 statement pages, PDF field text, question wording, overrides", note: "The recalculation never reads the PDFs; L1 compares the printed forms with the return." },
];

/** The covered / not-covered table for one run. */
export function buildCoverage(ledger: Ledger, diff: DiffResult, ret: Ty2025Return, effective: EffectiveReturn | null, forms: FormsDiff): L2Coverage[] {
  const rows: L2Coverage[] = [];
  for (const g of GROUPS) {
    const compared = diff.comparisons.filter((c) => g.prefixes.some((p) => c.key.startsWith(p)));
    const inputs = diff.engineInputs.filter((k) => g.prefixes.some((p) => k.startsWith(p)));
    const missing = diff.notRecomputed.filter((k) => g.prefixes.some((p) => k.startsWith(p)));
    if (compared.length === 0 && inputs.length === 0 && missing.length === 0) continue;
    const matched = compared.filter((c) => c.kind === "match").length;
    const parts: string[] = [];
    parts.push(`${compared.length} line${compared.length === 1 ? "" : "s"} recomputed and compared, ${matched} equal`);
    if (inputs.length > 0) parts.push(`${inputs.length} rare or stated line${inputs.length === 1 ? "" : "s"} taken from the return as an input (not checked)`);
    if (missing.length > 0) parts.push(`${missing.length} line${missing.length === 1 ? "" : "s"} the recalculation could not produce for this return (not checked)`);
    rows.push({ area: g.label, compared: compared.length > 0, note: parts.join("; "), linesCompared: compared.length, linesMatched: matched });
  }
  if (forms.checked > 0) rows.push({ area: "Which forms the packet needs (Schedules B, C, D, SE, A, 1-A and Forms 8949, 8959, 8960, 8995, 8606, 6251)", compared: true, note: `${forms.checked} forms recomputed and compared with the return's packet plan, ${forms.checked - forms.differing} agree`, linesCompared: forms.checked, linesMatched: forms.checked - forms.differing });
  for (const a of ledger.abstentions) rows.push({ area: `Not recomputed on this return: ${a.area}`, compared: false, note: a.reason });
  // lines the return carries with a non-zero amount that the recalculation never touched: listed by name, never silently passed
  const touched = new Set<string>([...ledger.lines.keys()]);
  const uncovered: string[] = [];
  for (const key of Object.keys(ret.lines)) {
    if (touched.has(key)) continue;
    const e = engineLineOf(ret, effective, key);
    if (e !== null && e.amount !== null && e.amount !== 0 && !e.informational) uncovered.push(key);
  }
  if (uncovered.length > 0) rows.push({ area: "Lines with a non-zero amount that the recalculation does not cover", compared: false, note: uncovered.sort().join(", ") });
  for (const n of NOT_COVERED) rows.push({ area: n.area, compared: false, note: n.note });
  return rows;
}
