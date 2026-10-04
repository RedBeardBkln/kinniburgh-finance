// L1.D5: blank-not-zero (plan section 5.3 and CLAUDE.md). A line that has no amount is NEVER shown as 0 on any surface:
//   - the review sheet says "not computed", not "$0";
//   - the cover says "not computed", not "$0", for a headline figure without an amount;
//   - an informational line (an amount that is intentionally not estimated) stays blank AND is listed as an advisory item.
// (The PDF fields and the CSV cells are compared with the return by L1.B1 and L1.X1; this check adds the human-readable surfaces.)

import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { carriesAmount, lineTitle } from "@/lib/tax-review/l1/helpers";
import { isLineKey } from "@/lib/tax-review/types";

const ZERO_TEXT = /^-?\$?0(?:\.0+)?$/;

export const blankNotZeroCheck: L1Check = {
  id: "L1.D5",
  description: "A line without an amount is never shown as 0 (sheet, cover); informational lines are listed as advisory items",
  run(ctx: L1Context): Finding[] {
    const out: Finding[] = [];
    const noAmount = new Set<string>();
    for (const [key, line] of Object.entries(ctx.view.lines)) {
      if (line === undefined || carriesAmount(line.status)) continue;
      noAmount.add(key);
    }
    for (const g of [...ctx.sheet.federal, ...ctx.sheet.connecticut]) {
      for (const l of g.lines) {
        if (!noAmount.has(l.key) || l.amount !== null) continue;
        if (ZERO_TEXT.test(l.amountText.trim())) {
          out.push(
            makeFinding({
              layer: "L1",
              check: "L1.D5.sheet",
              severity: "blocker",
              area: "packaging",
              ruleTag: l.key,
              message: `${isLineKey(l.key) ? lineTitle(l.key) : l.key} has no amount but the review sheet shows it as zero.`,
              evidence: [{ ref: `sheet:${l.key}`, amount: null, status: "shown as 0" }],
              recommendedAction: "Do not rely on the sheet. A line with no amount must read \"not computed\".",
              acceptable: false,
            })
          );
        }
      }
    }
    if (ctx.cover !== null) {
      const h = ctx.view.headline;
      const rows: [string, number | null][] = [
        ["Federal AGI", h.federal.agi.amount],
        ["Federal taxable income", h.federal.taxableIncome.amount],
        ["Federal total tax", h.federal.totalTax.amount],
        ["Federal total payments", h.federal.totalPayments.amount],
        ["CT AGI", h.connecticut.ctAgi.amount],
        ["CT tax", h.connecticut.tax.amount],
        ["CT total payments", h.connecticut.totalPayments.amount],
      ];
      for (const [label, amount] of rows) {
        if (amount !== null) continue;
        const blk = ctx.cover.blocks.find((b) => b.kind === "kv" && b.label.startsWith(label));
        if (blk?.kind === "kv" && ZERO_TEXT.test(blk.value.trim())) {
          out.push(
            makeFinding({
              layer: "L1",
              check: "L1.D5.cover",
              severity: "blocker",
              area: "packaging",
              ruleTag: label,
              message: `The cover page shows "${label}" as zero although the return has no amount for it.`,
              evidence: [{ ref: `head:${label}`, amount: null, status: "shown as 0" }],
              recommendedAction: "Do not rely on the cover page. Rebuild the packet.",
              acceptable: false,
            })
          );
        }
      }
    }
    // informational lines: blank + an advisory open item that names them
    const advisoryLines = new Set(ctx.view.openItems.filter((i) => i.severity === "advisory").flatMap((i) => i.lineKeys));
    for (const [key, line] of Object.entries(ctx.view.lines)) {
      if (line === undefined || line.informational !== true || carriesAmount(line.status)) continue;
      if (advisoryLines.has(key)) continue;
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.D5.informational",
          severity: "medium",
          area: "process",
          ruleTag: key,
          message: `${isLineKey(key) ? lineTitle(key) : key} is intentionally left without an amount but no advisory item tells you so.`,
          evidence: [{ ref: key, amount: null, status: line.status }],
          recommendedAction: "Read the line's note on the review sheet and decide whether you need to fill it in yourself.",
          acceptable: true,
        })
      );
    }
    return out;
  },
};
