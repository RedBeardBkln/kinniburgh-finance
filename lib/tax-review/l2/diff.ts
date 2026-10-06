// L2 oracle: the differ. Compares every line the oracle recomputed with the amount the return prints and raises findings through the
// shared Finding model (layer "L2"). Pure.
//
// Tolerance (plan 5.4 / the Phase C brief): a printed whole-dollar line that differs from the recalculation by MORE than $1 is a
// blocker (acceptable only with a written reason); a difference of exactly $1 is a rounding-level difference, reported as a low finding
// (the two calculators round some sums of cents in a different order); a line the return leaves blank where the recalculation gets a
// non-zero amount is a medium finding.

import { LINE_KEYS, lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import type { EffectiveReturn } from "@/lib/tax2025/overrides";
import type { Headline, Ty2025Return } from "@/lib/tax2025/types";
import { engineLineOf } from "@/lib/tax-review/l2/engine-view";
import type { Ledger } from "@/lib/tax-review/l2/ledger";
import type { Maybe } from "@/lib/tax-review/l2/money";
import { makeFinding, type EvidenceItem, type Finding, type FindingArea, type Severity } from "@/lib/tax-review/types";

export const ROUNDING_TOLERANCE_DOLLARS = 1;

export type ComparisonKind = "match" | "rounding" | "mismatch" | "engine_blank";

export interface LineComparison {
  key: string;
  oracle: number;
  engine: Maybe<number>;
  engineStatus: string;
  overridden: boolean;
  delta: Maybe<number>;
  kind: ComparisonKind;
  /** Differing lines this one was derived from (so a downstream difference is not mistaken for a second defect). */
  upstream: string[];
}

export interface HeadlineComparison {
  row: string;
  key: string;
  oracle: Maybe<number>;
  engine: Maybe<number>;
  kind: ComparisonKind | "not_recomputed";
}

export interface DiffResult {
  comparisons: LineComparison[];
  headline: HeadlineComparison[];
  /** Lines the oracle recomputed from the facts (diffed). */
  compared: number;
  matched: number;
  /** Lines taken from the engine as inputs (not diffed). */
  engineInputs: string[];
  /** Lines in the ledger the oracle could not produce on this return. */
  notRecomputed: string[];
}

function classify(oracle: number, engine: Maybe<number>): { kind: ComparisonKind; delta: Maybe<number> } {
  if (engine === null) return { kind: oracle === 0 ? "match" : "engine_blank", delta: null };
  const delta = engine - oracle;
  if (delta === 0) return { kind: "match", delta };
  return { kind: Math.abs(delta) <= ROUNDING_TOLERANCE_DOLLARS ? "rounding" : "mismatch", delta };
}

/** Diffs the ledger against the return. `ret`/`effective` are only read. */
export function diffLedger(ledger: Ledger, ret: Ty2025Return, effective: EffectiveReturn | null): DiffResult {
  const comparisons: LineComparison[] = [];
  const engineInputs: string[] = [];
  const notRecomputed: string[] = [];
  const differing = new Set<string>();
  // keys in dependency order are not guaranteed, so classify first, then mark upstream differences
  for (const line of ledger.lines.values()) {
    if (line.source === "engine") {
      engineInputs.push(line.key);
      continue;
    }
    if (line.value === null) {
      notRecomputed.push(line.key);
      continue;
    }
    const e = engineLineOf(ret, effective, line.key);
    if (e === null) {
      notRecomputed.push(line.key);
      continue;
    }
    if (e.informational && e.amount === null) continue;
    const { kind, delta } = classify(line.value, e.amount);
    comparisons.push({ key: line.key, oracle: line.value, engine: e.amount, engineStatus: e.status, overridden: e.overridden, delta, kind, upstream: [] });
    if (kind === "mismatch" || kind === "rounding" || kind === "engine_blank") differing.add(line.key);
  }
  for (const c of comparisons) {
    if (c.kind === "match") continue;
    c.upstream = (ledger.lines.get(c.key)?.deps ?? []).filter((d) => differing.has(d) && d !== c.key);
  }
  const headline = compareHeadline(ledger, effective?.headline ?? ret.headline);
  return {
    comparisons,
    headline,
    compared: comparisons.length,
    matched: comparisons.filter((c) => c.kind === "match").length,
    engineInputs,
    notRecomputed,
  };
}

const HEADLINE_ROWS: { row: string; key: string; pick: (h: Headline) => Maybe<number>; oracle: (l: Ledger) => Maybe<number> }[] = [
  { row: "Federal AGI", key: "federal.agi", pick: (h) => h.federal.agi.amount, oracle: (l) => l.get("f1040.11a") },
  { row: "Federal taxable income", key: "federal.taxableIncome", pick: (h) => h.federal.taxableIncome.amount, oracle: (l) => l.get("f1040.15") },
  { row: "Federal total tax", key: "federal.totalTax", pick: (h) => h.federal.totalTax.amount, oracle: (l) => l.get("f1040.24") },
  { row: "Federal total payments", key: "federal.totalPayments", pick: (h) => h.federal.totalPayments.amount, oracle: (l) => l.get("f1040.33") },
  {
    row: "Federal balance (owed positive)",
    key: "federal.balance",
    pick: (h) => h.federal.balance.amount,
    oracle: (l) => {
      const t = l.get("f1040.24");
      const p = l.get("f1040.33");
      return t === null || p === null ? null : t - p;
    },
  },
  { row: "Connecticut AGI", key: "connecticut.ctAgi", pick: (h) => h.connecticut.ctAgi.amount, oracle: (l) => l.get("ct1040.ctAgi") },
  { row: "Connecticut income tax", key: "connecticut.tax", pick: (h) => h.connecticut.tax.amount, oracle: (l) => l.get("ct1040.6") },
  { row: "Connecticut payments", key: "connecticut.totalPayments", pick: (h) => h.connecticut.totalPayments.amount, oracle: (l) => l.get("ct1040.21") },
  { row: "Connecticut balance (owed positive)", key: "connecticut.balance", pick: (h) => h.connecticut.balance.amount, oracle: (l) => l.get("ct1040.balance") },
];

function compareHeadline(ledger: Ledger, headline: Headline): HeadlineComparison[] {
  return HEADLINE_ROWS.map((r) => {
    const oracle = r.oracle(ledger);
    const engine = r.pick(headline);
    if (oracle === null) return { row: r.row, key: r.key, oracle, engine, kind: "not_recomputed" as const };
    return { row: r.row, key: r.key, oracle, engine, kind: classify(oracle, engine).kind };
  });
}

// ── Findings ──────────────────────────────────────────────────────────────────

const FORM_OF_PREFIX: readonly [string, string][] = [
  ["f1040.", "f1040"],
  ["sch1a.", "sch1a"],
  ["sch1.", "sch1"],
  ["sch2.", "sch2"],
  ["sch3.", "sch3"],
  ["scha.", "scha"],
  ["schb.", "schb"],
  ["schc.", "schc"],
  ["schd.", "schd"],
  ["se.", "schse"],
  ["f8995.", "f8995"],
  ["f8959.", "f8959"],
  ["f8960.", "f8960"],
  ["f8606a.", "f8606"],
  ["f8606b.", "f8606"],
  ["f6251.", "f6251"],
  ["qdcg.", "f1040"],
  ["std.", "f1040"],
  ["ct1040.", "ct1040"],
];

export function formKeyOfLine(key: string): string | undefined {
  return FORM_OF_PREFIX.find(([p]) => key.startsWith(p))?.[1];
}

export function areaOfLine(key: string): FindingArea {
  const num = (prefix: string): number => parseInt(key.slice(prefix.length), 10);
  if (key.startsWith("ct1040.")) return "state";
  if (key.startsWith("f8606")) return "adjustments";
  if (key.startsWith("f1040.")) {
    const n = num("f1040.");
    if (n >= 1 && n <= 9) return "income";
    if (n === 10 || n === 11) return "adjustments";
    if (n >= 12 && n <= 15) return "deductions";
    if (n >= 16 && n <= 24) return "tax";
    return "payments";
  }
  if (key.startsWith("sch1.")) return num("sch1.") <= 10 ? "income" : "adjustments";
  if (key.startsWith("sch3.")) return num("sch3.") <= 8 ? "credits" : "payments";
  if (key.startsWith("scha.") || key.startsWith("std.") || key.startsWith("f8995.") || key.startsWith("sch1a.")) return "deductions";
  if (key.startsWith("schb.") || key.startsWith("schc.") || key.startsWith("schd.")) return "income";
  return "tax"; // sch2, se, f8959, f8960, f6251, qdcg
}

function money(n: number | null): string {
  if (n === null) return "no amount";
  return n < 0 ? `-$${Math.abs(n).toLocaleString("en-US")}` : `$${n.toLocaleString("en-US")}`;
}

function lineName(key: string): string {
  try {
    const m = lineMeta(key as LineKey);
    return `${m.form} line ${m.formLine} (${m.label})`;
  } catch {
    return key;
  }
}

const isLineKey = (key: string): key is LineKey => (LINE_KEYS as readonly string[]).includes(key);

/** One finding per differing line (and per differing headline row). Matching lines raise nothing. */
export function findingsOfDiff(diff: DiffResult): Finding[] {
  const findings: Finding[] = [];
  for (const c of diff.comparisons) {
    if (c.kind === "match") continue;
    // a one-dollar difference that follows from a one-dollar difference upstream is the same rounding, not a new finding
    if (c.kind === "rounding" && c.upstream.length > 0) continue;
    // (Form 8995 lines 16 / 17, the loss carried to 2026, used to be a medium special case while the engine printed 0 there; since engine ty2025-1b.6 they are
    // computed like any other line, so a difference is a blocker.)
    const severity: Severity = c.kind === "mismatch" ? "blocker" : c.kind === "rounding" ? "low" : "medium";
    const downstream = c.upstream.length > 0 ? ` It follows from ${c.upstream.length === 1 ? "an upstream difference" : "upstream differences"} (${c.upstream.slice(0, 4).join(", ")}): look at the earliest line first.` : "";
    const override = c.overridden ? " This line is pinned by a recorded owner override, so the difference may be intended." : "";
    const message =
      c.kind === "engine_blank"
        ? `Independent recalculation: ${lineName(c.key)} has no amount in the return (status ${c.engineStatus}), but recomputing it from the same facts gives ${money(c.oracle)}.${override}`
        : `Independent recalculation: ${lineName(c.key)} is ${money(c.engine)} in the return and ${money(c.oracle)} in the recalculation (difference ${money(c.delta === null ? null : Math.abs(c.delta))}${c.kind === "rounding" ? ", within the $1 rounding tolerance" : ""}).${downstream}${override}`;
    const evidence: EvidenceItem[] = [];
    if (isLineKey(c.key)) evidence.push({ ref: c.key, amount: c.engine, status: c.overridden ? "overridden" : c.engineStatus });
    evidence.push({ ref: `check:l2.${c.key}`, amount: c.oracle, status: "oracle" });
    for (const up of c.upstream.slice(0, 3)) if (isLineKey(up)) evidence.push({ ref: up, amount: null, status: "differs" });
    const form = formKeyOfLine(c.key);
    findings.push(
      makeFinding({
        layer: "L2",
        check: `L2.diff.${c.key}`,
        severity,
        area: areaOfLine(c.key),
        ...(form !== undefined ? { formKey: form } : {}),
        ...(isLineKey(c.key) ? { lineKey: c.key } : {}),
        message,
        evidence,
        citation: { sources: [{ kind: "form_text", id: `${form ?? "form"}:${c.key}` }], sourceStatus: "not_applicable" },
        recommendedAction:
          c.kind === "rounding"
            ? "Check the sum of cents behind this line; a one-dollar difference between two correct roundings can be accepted with a reason."
            : "Find which of the two is wrong: re-add the facts behind this line by hand, or accept the difference with a written reason if the recalculation is the one that is off.",
        acceptable: true,
      })
    );
  }
  for (const h of diff.headline) {
    if (h.kind === "match" || h.kind === "not_recomputed" || h.kind === "rounding") continue;
    const severity: Severity = h.kind === "mismatch" ? "blocker" : "medium";
    findings.push(
      makeFinding({
        layer: "L2",
        check: `L2.diff.head.${h.key}`,
        severity,
        area: h.key.startsWith("connecticut") ? "state" : "tax",
        message: `Independent recalculation: the headline "${h.row}" is ${money(h.engine)} in the return and ${money(h.oracle)} in the recalculation.`,
        evidence: [
          { ref: `head:${h.key}`, amount: h.engine, status: "headline" },
          { ref: `check:l2.head.${h.key}`, amount: h.oracle, status: "oracle" },
        ],
        recommendedAction: "Compare the headline with the lines it is built from, then with the recalculation; accept with a written reason only if the recalculation is the one that is off.",
        acceptable: true,
      })
    );
  }
  return findings;
}
