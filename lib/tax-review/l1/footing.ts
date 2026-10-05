// L1.F1 / L1.F2 / L1.F3: footing, cross-form links and footing-coverage drift (plan section 5.3).
//
//   F1  every printed total equals the sum of its printed parts (FOOTING_RULES category "footing", the printed-table row
//       totals, the Form 8949 rows and Totals rows);
//   F2  a line carried from one form to another equals its source (FOOTING_RULES category "link", the 1040 standard-vs-itemized
//       choice, 1040 line 7a against Schedule D, the headline rows against their lines);
//   F3  every form of the packet has a footing decision (a rule, a special check, or an explicit "not covered" reason).
//
// Evaluated on the EFFECTIVE view, from the printed-form rules in footing-rules.ts, NOT by calling the engine's own arithmetic,
// so an engine bug, an override that did not recompute its dependents, or a hand-mutated line is a finding.

import { makeFinding, type EvidenceItem, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context } from "@/lib/tax-review/l1/context";
import { FOOTING_RULES, NOT_COVERED_FORMS, SPECIAL_COVERED_FORMS, TABLE_RULES, type FootingRule, type TableRule } from "@/lib/tax-review/l1/footing-rules";
import { evidenceOf, formIsFiled, lineName, lineState, lineTitle, plainStatus, usd } from "@/lib/tax-review/l1/helpers";
import { HEADLINE_ROWS } from "@/lib/tax2025/overrides";
import type { LineKey } from "@/lib/tax2025/line-catalog";
import type { PdfTableRow } from "@/lib/tax2025/pdf/types";

export type RuleOutcome =
  | { status: "ok" }
  | { status: "skipped"; why: string }
  | { status: "mismatch"; expected: number; actual: number; parts: { key: LineKey; sign: 1 | -1; amount: number }[] }
  | { status: "unproven"; unknown: { key: string; state: string }[] };

/** Evaluate one footing / link rule against the effective lines. */
export function evaluateRule(ctx: L1Context, rule: FootingRule): RuleOutcome {
  if (!formIsFiled(ctx, rule.form, rule.engineForm)) return { status: "skipped", why: "form not filed" };
  const total = lineState(ctx, rule.total);
  if (total.amount === null) return { status: "skipped", why: "the total has no amount" };
  if (rule.skipIfBlank === true && total.status === "not_applicable") return { status: "skipped", why: "that part of the form is not used" };
  const parts: { key: LineKey; sign: 1 | -1; amount: number }[] = [];
  const unknown: { key: string; state: string }[] = [];
  let anyPartPresent = false;
  for (const t of rule.parts) {
    const s = lineState(ctx, t.key);
    if (s.status === "absent") continue; // a line the engine does not emit is not part of this return
    anyPartPresent = true;
    if (s.amount === null) {
      unknown.push({ key: t.key, state: s.status });
      continue;
    }
    parts.push({ key: t.key, sign: t.sign ?? 1, amount: s.amount });
  }
  if (rule.category === "link" && !anyPartPresent) return { status: "skipped", why: "the source line is not emitted" };
  const skippedByForm = rule.skipWhenNotApplicable === true && total.status === "not_applicable";
  if (unknown.length > 0) return skippedByForm ? { status: "skipped", why: "the form says to skip this line" } : { status: "unproven", unknown };
  const raw = rule.combine === "min" && parts.length > 0 ? Math.min(...parts.map((p) => p.sign * p.amount)) : parts.reduce((acc, p) => acc + p.sign * p.amount, 0);
  const expected = rule.floor0 === true ? Math.max(0, raw) : rule.cap0 === true ? Math.min(0, raw) : raw;
  // The form says to skip a line (print it blank) only when its own test says "zero or less". A line the engine skipped while
  // the parts make a positive amount is a real mismatch (expected N, printed none), not a skip.
  if (skippedByForm && expected <= 0) return { status: "skipped", why: "the form says to skip this line" };
  if (Math.abs(total.amount - expected) > (rule.tolerance ?? 0)) return { status: "mismatch", expected, actual: total.amount, parts };
  return { status: "ok" };
}

function listParts(parts: readonly { key: LineKey; sign: 1 | -1; amount: number }[]): string {
  const shown = parts.filter((p) => p.amount !== 0);
  const head = shown.slice(0, 8).map((p) => `${p.sign === -1 ? "minus " : ""}${lineName(p.key)} ${usd(p.amount)}`);
  const more = shown.length > 8 ? ` and ${shown.length - 8} more` : "";
  return shown.length === 0 ? "all of its parts are zero" : `${head.join(", ")}${more}`;
}

function ruleFinding(rule: FootingRule, outcome: Exclude<RuleOutcome, { status: "ok" } | { status: "skipped" }>, ctx: L1Context): Finding {
  const checkId = `${rule.category === "link" ? "L1.F2" : "L1.F1"}.${rule.id}`;
  const quoteForm = rule.quoteForm ?? rule.form;
  const citation = { sources: [{ kind: "form_text" as const, id: `${quoteForm}:${rule.sourceId.split(":")[1] ?? ""}`, quote: rule.quote }], sourceStatus: "verified" as const };
  const keys = [rule.total, ...rule.parts.map((t) => t.key)];
  const evidence: EvidenceItem[] = evidenceOf(ctx, keys).filter((e, i) => i === 0 || e.amount !== 0 || e.status !== "not_applicable").slice(0, 30);
  if (outcome.status === "mismatch") {
    const diff = outcome.actual - outcome.expected;
    return makeFinding({
      layer: "L1",
      check: checkId,
      severity: "blocker",
      area: rule.area,
      formKey: rule.form,
      lineKey: rule.total,
      message:
        `${lineTitle(rule.total)} is ${usd(outcome.actual)}, but the printed form says it is ${rule.category === "link" ? "carried from" : "the sum of"}: ${listParts(outcome.parts)}, which makes ${usd(outcome.expected)} (difference ${usd(diff)}). ` +
        `The form says: "${rule.quote}"` +
        (rule.tolerance ? ` (allowed difference ${usd(rule.tolerance)}: ${rule.toleranceReason ?? ""})` : ""),
      evidence,
      citation,
      recommendedAction: "Do not file with this difference. Find which of the lines was changed or not recomputed (an override, a document correction or a hand edit), fix it at the source and run the review again.",
      acceptable: false,
    });
  }
  return makeFinding({
    layer: "L1",
    check: checkId,
    severity: "high",
    area: rule.area,
    formKey: rule.form,
    lineKey: rule.total,
    message:
      `${lineTitle(rule.total)} is ${usd(lineState(ctx, rule.total).amount ?? 0)} but the review cannot prove it adds up: ${outcome.unknown.map((u) => `${lineName(u.key)} has no amount (${plainStatus(u.state)})`).join("; ")}. ` +
      `The form says: "${rule.quote}"`,
    evidence,
    citation,
    recommendedAction: "Find out why that line has no amount while its total does; if the total silently treated it as zero, fix the input. If you confirm it really is zero, accept this finding with that reason.",
    acceptable: true,
  });
}

function runRules(ctx: L1Context, category: "footing" | "link"): Finding[] {
  const out: Finding[] = [];
  for (const rule of FOOTING_RULES) {
    if (rule.category !== category) continue;
    const r = evaluateRule(ctx, rule);
    if (r.status === "mismatch" || r.status === "unproven") out.push(ruleFinding(rule, r, ctx));
  }
  return out;
}

// ── Printed tables ────────────────────────────────────────────────────────────

function numericColumn(rows: readonly PdfTableRow[], column: string): { total: number; bad: number } {
  let total = 0;
  let bad = 0;
  for (const r of rows) {
    const v = r.cells[column];
    if (typeof v === "number" && Number.isSafeInteger(v)) total += v;
    else if (v !== null && v !== undefined && v !== "") bad += 1;
  }
  return { total, bad };
}

function tableFinding(rule: TableRule, rows: readonly PdfTableRow[], ctx: L1Context): Finding[] {
  if (!formIsFiled(ctx, rule.form, rule.engineForm)) return [];
  const total = lineState(ctx, rule.total);
  if (total.amount === null) return [];
  if (rows.length === 0) {
    // a printed line with an amount but no rows under it cannot be proven (fail closed: never a silent pass)
    if (total.amount === 0) return [];
    return [
      makeFinding({
        layer: "L1",
        check: `L1.F1.${rule.id}`,
        severity: "blocker",
        area: rule.area,
        formKey: rule.form,
        lineKey: rule.total,
        message: `${lineTitle(rule.total)} is ${usd(total.amount)} but the printed table under it has no rows, so the line cannot be proven to add up. The form says: "${rule.quote}"`,
        evidence: [...evidenceOf(ctx, [rule.total]), { ref: `table:${rule.table}`, amount: 0, status: "no rows" }],
        citation: { sources: [{ kind: "form_text", id: `${rule.form}:${rule.total.split(".").slice(1).join(".")}`, quote: rule.quote }], sourceStatus: "verified" },
        recommendedAction: "Do not file with this difference. Compare the line with its source documents and rebuild the packet.",
        acceptable: false,
      }),
    ];
  }
  const { total: sumRows, bad } = numericColumn(rows, rule.column);
  // Each row is rounded to whole dollars on its own while the printed line is rounded once from the cents.
  const tolerance = Math.floor(rows.length / 2);
  if (bad === 0 && Math.abs(total.amount - sumRows) <= tolerance) return [];
  return [
    makeFinding({
      layer: "L1",
      check: `L1.F1.${rule.id}`,
      severity: "blocker",
      area: rule.area,
      formKey: rule.form,
      lineKey: rule.total,
      message:
        bad > 0
          ? `${lineTitle(rule.total)}: ${bad} printed row(s) have no whole-dollar amount, so the rows cannot be added up against the line.`
          : `${lineTitle(rule.total)} is ${usd(total.amount)} but the ${rows.length} printed row(s) above it add up to ${usd(sumRows)} (difference ${usd(total.amount - sumRows)}; rows are rounded one by one, so up to ${usd(tolerance)} is rounding). The form says: "${rule.quote}"`,
      evidence: [...evidenceOf(ctx, [rule.total]), { ref: `table:${rule.table}`, amount: sumRows, status: "rows" }],
      citation: { sources: [{ kind: "form_text", id: `${rule.form}:${rule.total.split(".").slice(1).join(".")}`, quote: rule.quote }], sourceStatus: "verified" },
      recommendedAction: "Do not file with this difference. Compare the printed rows with the source documents and the line total, fix the source and run the review again.",
      acceptable: false,
    }),
  ];
}

// ── Form 8949 ─────────────────────────────────────────────────────────────────

/** Schedule D line fed by each Form 8949 box (the printed text of Schedule D: 1b A/G, 2 B/H, 3 C/I, 8b D/J, 9 E/K, 10 F/L). */
export const F8949_BOX_TO_SCHD_LINE: Readonly<Record<string, string>> = { A: "1b", G: "1b", B: "2", H: "2", C: "3", I: "3", D: "8b", J: "8b", E: "9", K: "9", F: "10", L: "10" };

const CELLS = ["d", "e", "g", "h"] as const;

function f8949Findings(ctx: L1Context): Finding[] {
  const out: Finding[] = [];
  const partRows = [...(ctx.view.tables["f8949.partI"] ?? []), ...(ctx.view.tables["f8949.partII"] ?? [])];
  if (partRows.length === 0) return out;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  // (1) each printed row: (h) = (d) - (e) + (g), within the whole-dollar rounding of three columns
  partRows.forEach((r, i) => {
    const d = num(r.cells["d"]);
    const e = num(r.cells["e"]);
    const g = num(r.cells["g"]) ?? 0;
    const h = num(r.cells["h"]);
    if (d === null || e === null || h === null) return;
    const diff = h - (d - e + g);
    if (Math.abs(diff) > 1) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.F1.f8949.row",
          severity: "blocker",
          area: "income",
          formKey: "f8949",
          ruleTag: `row-${i + 1}`,
          message: `Form 8949 summary row ${i + 1} (box ${String(r.cells["box"] ?? "?")}) prints (h) ${usd(h)} but (d) ${usd(d)} minus (e) ${usd(e)} plus (g) ${usd(g)} makes ${usd(d - e + g)}. The form says: "Subtract column (e) from column (d) and combine the result with column (g)."`,
          evidence: [{ ref: `table:f8949.row-${i + 1}`, amount: h, status: "printed" }, { ref: `table:f8949.row-${i + 1}.expected`, amount: d - e + g, status: "recomputed" }],
          citation: { sources: [{ kind: "form_text", id: "f8949:h", quote: "Subtract column (e) from column (d) and combine the result with column (g)" }], sourceStatus: "verified" },
          recommendedAction: "Do not file with this difference. Compare the row with the broker statement and fix its source.",
          acceptable: false,
        })
      );
    }
  });
  // (2) the rows of every box that feeds a Schedule D line add up to that line's cells (rows are rounded one by one)
  const byLine = new Map<string, PdfTableRow[]>();
  for (const r of partRows) {
    const line = F8949_BOX_TO_SCHD_LINE[String(r.cells["box"] ?? "")];
    if (line === undefined) continue;
    byLine.set(line, [...(byLine.get(line) ?? []), r]);
  }
  for (const [line, rows] of byLine) {
    for (const c of CELLS) {
      const key = `schd.${line}.${c}`;
      const cell = lineState(ctx, key);
      if (cell.status === "absent" || cell.amount === null) continue;
      const sum = rows.reduce((acc, r) => acc + (num(r.cells[c]) ?? 0), 0);
      const tolerance = Math.floor(rows.length / 2) + (c === "h" ? 1 : 0);
      if (Math.abs(cell.amount - sum) > tolerance) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.F1.f8949.to-schd",
            severity: "blocker",
            area: "income",
            formKey: "f8949",
            lineKey: key as LineKey,
            ruleTag: key,
            message: `Schedule D line ${line} column (${c}) is ${usd(cell.amount)} but the Form 8949 summary rows that feed it add up to ${usd(sum)} (up to ${usd(tolerance)} is rounding). The form says: "Enter each total here and include on your Schedule D, line ${line}".`,
            evidence: [...evidenceOf(ctx, [key]), { ref: `table:f8949.line-${line}.${c}`, amount: sum, status: "rows" }],
            citation: { sources: [{ kind: "form_text", id: `f8949:totals-${line}`, quote: `include on your Schedule D, line ${line}` }], sourceStatus: "verified" },
            recommendedAction: "Do not file with this difference. Compare the Form 8949 rows with the Schedule D line and the broker statement.",
            acceptable: false,
          })
        );
      }
    }
  }
  // (3) a Schedule D line that carries an amount from Form 8949 boxes but has no summary row at all
  if (ctx.ret.scheduleD?.form8949Required === true) {
    for (const line of ["1b", "2", "3", "8b", "9", "10"]) {
      if (byLine.has(line)) continue;
      const d = lineState(ctx, `schd.${line}.d`);
      const e = lineState(ctx, `schd.${line}.e`);
      if ((d.amount ?? 0) !== 0 || (e.amount ?? 0) !== 0) {
        out.push(
          makeFinding({
            layer: "L1",
            check: "L1.F1.f8949.missing-rows",
            severity: "blocker",
            area: "income",
            formKey: "f8949",
            ruleTag: line,
            message: `Schedule D line ${line} has proceeds or cost but no Form 8949 summary row feeds it.`,
            evidence: evidenceOf(ctx, [`schd.${line}.d`, `schd.${line}.e`]),
            citation: { sources: [{ kind: "form_text", id: `f8949:totals-${line}`, quote: `include on your Schedule D, line ${line}` }], sourceStatus: "verified" },
            recommendedAction: "Do not file without the Form 8949 sheet for this category.",
            acceptable: false,
          })
        );
      }
    }
  }
  return out;
}

// ── F1 ────────────────────────────────────────────────────────────────────────

export const footingCheck: L1Check = {
  id: "L1.F1",
  description: "Every printed total equals the sum of its printed parts (all forms in the packet)",
  run(ctx) {
    const out = runRules(ctx, "footing");
    for (const rule of TABLE_RULES) {
      const rows = (ctx.view.tables as Partial<Record<string, readonly PdfTableRow[]>>)[rule.table] ?? [];
      out.push(...tableFinding(rule, rows, ctx));
    }
    out.push(...f8949Findings(ctx));
    return out;
  },
};

// ── F2 ────────────────────────────────────────────────────────────────────────

function check12e(ctx: L1Context): Finding[] {
  const l12e = lineState(ctx, "f1040.12e");
  const std = lineState(ctx, "std.total");
  if (l12e.amount === null || std.amount === null) return [];
  const itemized = lineState(ctx, "scha.17");
  const expected = itemized.amount !== null && itemized.amount > std.amount ? itemized.amount : std.amount;
  if (l12e.amount === expected) return [];
  return [
    makeFinding({
      layer: "L1",
      check: "L1.F2.f1040.12e",
      severity: "blocker",
      area: "deductions",
      formKey: "f1040",
      lineKey: "f1040.12e",
      message: `${lineTitle("f1040.12e")} is ${usd(l12e.amount)}, but the larger of the standard deduction (${usd(std.amount)}) and the itemized deductions on Schedule A line 17 (${itemized.amount === null ? "none" : usd(itemized.amount)}) is ${usd(expected)}. The form says: "Standard deduction or itemized deductions (from Schedule A)."`,
      evidence: evidenceOf(ctx, ["f1040.12e", "std.total", "scha.17"]),
      citation: { sources: [{ kind: "form_text", id: "f1040:12e", quote: "12e. Standard deduction or itemized deductions (from Schedule A)." }], sourceStatus: "verified" },
      recommendedAction: "Do not file with this difference: line 12e must be the deduction that applies. Fix the source and run the review again.",
      acceptable: false,
    }),
  ];
}

function check7a(ctx: L1Context): Finding[] {
  if (ctx.ret.scheduleD?.required !== true) return [];
  const l7a = lineState(ctx, "f1040.7a");
  const l16 = lineState(ctx, "schd.16");
  if (l7a.amount === null || l16.amount === null) return [];
  const l21 = lineState(ctx, "schd.21");
  // The printed Schedule D: a gain on line 16 goes to line 7a; a loss goes there as the smaller of the loss or the loss limit on line 21.
  if (l16.amount < 0 && l21.amount === null) return [];
  const expected = l16.amount >= 0 ? l16.amount : -(l21.amount ?? 0);
  if (l7a.amount === expected) return [];
  return [
    makeFinding({
      layer: "L1",
      check: "L1.F2.f1040.7a",
      severity: "blocker",
      area: "income",
      formKey: "f1040",
      lineKey: "f1040.7a",
      message: `${lineTitle("f1040.7a")} is ${usd(l7a.amount)}, but Schedule D line 16 is ${usd(l16.amount)}${l16.amount < 0 ? ` and line 21 (the allowed loss) is ${usd(l21.amount ?? 0)}` : ""}, so line 7a should be ${usd(expected)}. The form says: "If line 16 is a gain, enter the amount from line 16 on Form 1040, 1040-S R, or 1040-N R, line 7a ... If line 16 is a loss ... enter here and on Form 1040 ... line 7a, the smaller of: The loss on line 16"`,
      evidence: evidenceOf(ctx, ["f1040.7a", "schd.16", "schd.21"]),
      citation: { sources: [{ kind: "form_text", id: "f1040sd:16", quote: "If line 16 is a gain, enter the amount from line 16 on Form 1040" }], sourceStatus: "verified" },
      recommendedAction: "Do not file with this difference. Check Schedule D lines 16 and 21 and Form 1040 line 7a.",
      acceptable: false,
    }),
  ];
}

/** The headline rows must equal the lines they are read from (HEADLINE_ROWS names them). Skipped when an override left the totals un-recomputed (D3 reports that). */
function headlineFindings(ctx: L1Context): Finding[] {
  if (ctx.view.overrideNotice.totalsNotRecomputed) return [];
  const h = ctx.view.headline;
  const rows: { id: keyof typeof HEADLINE_ROWS; amount: number | null; combine: (v: number[]) => number }[] = [
    { id: "federal.agi", amount: h.federal.agi.amount, combine: (v) => v[0] ?? 0 },
    { id: "federal.taxableIncome", amount: h.federal.taxableIncome.amount, combine: (v) => v[0] ?? 0 },
    { id: "federal.totalTax", amount: h.federal.totalTax.amount, combine: (v) => v[0] ?? 0 },
    { id: "federal.totalPayments", amount: h.federal.totalPayments.amount, combine: (v) => v[0] ?? 0 },
    { id: "federal.balance", amount: h.federal.balance.amount, combine: (v) => (v[0] ?? 0) - (v[1] ?? 0) },
    { id: "connecticut.ctAgi", amount: h.connecticut.ctAgi.amount, combine: (v) => v[0] ?? 0 },
    { id: "connecticut.tax", amount: h.connecticut.tax.amount, combine: (v) => v[0] ?? 0 },
    { id: "connecticut.totalPayments", amount: h.connecticut.totalPayments.amount, combine: (v) => v.reduce((a, b) => a + b, 0) },
    { id: "connecticut.balance", amount: h.connecticut.balance.amount, combine: (v) => v[0] ?? 0 },
  ];
  const out: Finding[] = [];
  for (const row of rows) {
    if (row.amount === null) continue;
    const keys = HEADLINE_ROWS[row.id] as readonly string[];
    const states = keys.map((k) => lineState(ctx, k));
    if (states.some((s) => s.amount === null)) continue;
    const expected = row.combine(states.map((s) => s.amount ?? 0));
    if (expected === row.amount) continue;
    out.push(
      makeFinding({
        layer: "L1",
        check: `L1.F2.headline.${row.id}`,
        severity: "blocker",
        area: "tax",
        ruleTag: row.id,
        message: `The headline figure "${row.id}" is ${usd(row.amount)} but the lines it is read from (${keys.map(lineName).join(", ")}) make ${usd(expected)}.`,
        evidence: [...evidenceOf(ctx, keys), { ref: `head:${row.id}`, amount: row.amount, status: "headline" }],
        citation: { sources: [{ kind: "engine", id: `headline:${row.id}` }], sourceStatus: "not_applicable" },
        recommendedAction: "Do not file with this difference: the summary and the forms disagree. Run the review again after the source is fixed.",
        acceptable: false,
      })
    );
  }
  return out;
}

export const linkCheck: L1Check = {
  id: "L1.F2",
  description: "Lines carried between forms equal their source (1040 <-> schedules, CT-1040 <-> federal), headline figures equal their lines",
  run(ctx) {
    return [...runRules(ctx, "link"), ...check12e(ctx), ...check7a(ctx), ...headlineFindings(ctx)];
  },
};

// ── F3 ────────────────────────────────────────────────────────────────────────

/** Form ids of the given maps that no rule covers and that are not listed with a reason. */
export function footingCoverageDrift(mapFormIds: readonly string[]): string[] {
  const covered = new Set<string>([...FOOTING_RULES.map((r) => r.form), ...TABLE_RULES.map((r) => r.form), ...Object.keys(SPECIAL_COVERED_FORMS), ...Object.keys(NOT_COVERED_FORMS)]);
  return mapFormIds.filter((id) => !covered.has(id));
}

export const coverageDriftCheck: L1Check = {
  id: "L1.F3",
  description: "Every form map of the packet has a footing decision (rules, a special check, or an explicit reason)",
  run(ctx) {
    const drift = footingCoverageDrift(ctx.maps.map((m) => m.formId));
    return drift.map((formId) =>
      makeFinding({
        layer: "L1",
        check: "L1.F3.drift",
        severity: "medium",
        area: "forms",
        formKey: formId,
        ruleTag: formId,
        message: `The form "${formId}" is in the packet but the review has no footing or link rule for it, so its totals are not checked by the arithmetic review. Add rules for it (or list it with a reason).`,
        evidence: [{ ref: `form:${formId}`, amount: null, status: "no footing rule" }],
        citation: { sources: [], sourceStatus: "not_applicable" },
        recommendedAction: "Check this form's totals by hand against its printed instructions, then accept this finding with that reason.",
        acceptable: true,
      })
    );
  },
};

/** Which printed lines the rules cover (for the run summary: counts only). */
export function footingCoverageSummary(ctx: L1Context): { rules: number; evaluated: number; skipped: number } {
  let evaluated = 0;
  let skipped = 0;
  for (const rule of FOOTING_RULES) {
    if (evaluateRule(ctx, rule).status === "skipped") skipped += 1;
    else evaluated += 1;
  }
  return { rules: FOOTING_RULES.length, evaluated, skipped };
}
