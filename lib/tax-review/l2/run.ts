// L2: the independent recalculation (AI Return Reviewer plan 5.4 / 8.3, Phase C). `runL2(input)` takes the same pieces the L1 context
// carries (the computed return, its effective view and the raw facts), recomputes the federal and Connecticut return with a SECOND,
// separately written calculator (lib/tax-review/l2/**), diffs every recomputed line against the printed amount and returns findings
// (layer "L2"), the covered / not-covered table and a summary. It fails closed: anything that stops it from recomputing (an incomplete
// return, a filing status the engine does not support, an exception) is `status: "not_run"` with the reason, never a pass.
//
// PURE: no DB, no network, no clock. It imports from lib/tax2025 only the numeric constants registry (and types / the data-only line
// catalog); lib/__tests__/tax-review-l2-independence.test.ts pins that.

import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { EffectiveReturn } from "@/lib/tax2025/overrides";
import type { Ty2025Return } from "@/lib/tax2025/types";
import { buildCoverage, NOT_COVERED, type L2Coverage } from "@/lib/tax-review/l2/coverage";
import { computeCt } from "@/lib/tax-review/l2/ct";
import { diffLedger, findingsOfDiff, type DiffResult } from "@/lib/tax-review/l2/diff";
import { decisionsOf, engineLineOf } from "@/lib/tax-review/l2/engine-view";
import { computeFederal } from "@/lib/tax-review/l2/federal";
import { Ledger, type OracleInputs } from "@/lib/tax-review/l2/ledger";
import { makeFinding, type Finding } from "@/lib/tax-review/types";

export const L2_VERSION = 1;

export interface L2Input {
  ret: Ty2025Return;
  effective: EffectiveReturn | null;
  facts: Ty2025Facts;
  options?: {
    /** Default true: only a complete return (no blocking item, every headline amount computed) is recomputed. Tests turn it off to probe partial returns. */
    requireComplete?: boolean;
  };
}

export interface L2Summary {
  linesCompared: number;
  linesMatched: number;
  /** Differences of exactly $1 (low). */
  roundingDifferences: number;
  /** Lines (and headline rows) that differ by more than $1: blockers. */
  mismatchCount: number;
  /** Lines the return leaves blank where the recalculation gets a non-zero amount. */
  engineBlankCount: number;
  engineInputLines: number;
  notRecomputedLines: number;
}

export interface L2Result {
  status: "ran" | "not_run";
  /** Why it did not run (null when it ran). */
  reason: string | null;
  findings: Finding[];
  coverage: L2Coverage[];
  summary: L2Summary;
}

const EMPTY_SUMMARY: L2Summary = { linesCompared: 0, linesMatched: 0, roundingDifferences: 0, mismatchCount: 0, engineBlankCount: 0, engineInputLines: 0, notRecomputedLines: 0 };

function notRun(reason: string): L2Result {
  return { status: "not_run", reason, findings: [], coverage: [], summary: { ...EMPTY_SUMMARY } };
}

/** The recalculated lines themselves (the federal and Connecticut ledger), for tests and the live run. Throws on a bug; runL2 catches. */
export function oracleLedger(input: L2Input): Ledger {
  const { ret, effective, facts } = input;
  const oracleInputs: OracleInputs = {
    facts,
    decisions: decisionsOf(ret, effective),
    schC: ret.scheduleC,
    engineAmount: (key) => engineLineOf(ret, effective, key)?.amount ?? null,
  };
  const ledger = new Ledger();
  const fed = computeFederal(oracleInputs);
  for (const [k, line] of fed.lines) ledger.lines.set(k, line);
  for (const a of fed.abstentions) ledger.abstain(a.area, a.reason);
  computeCt(oracleInputs, ledger);
  return ledger;
}

/** The independent recalculation. Never throws; never returns `ran` unless every step completed. */
export function runL2(input?: L2Input): L2Result {
  if (input === undefined) return notRun("no return was supplied to the recalculation");
  const { ret, effective, facts } = input;
  try {
    if (ret.filingStatus !== "mfj" || facts.household.filingStatus.value !== "mfj") return notRun("the recalculation covers married filing jointly only");
    const headline = effective?.headline ?? ret.headline;
    if ((input.options?.requireComplete ?? true) && (!headline.complete || headline.blockingItemCount > 0)) {
      return notRun(`the return is not complete (${headline.blockingItemCount} blocking item${headline.blockingItemCount === 1 ? "" : "s"}${headline.complete ? "" : ", not every headline amount is computed"}): a recalculation only compares a complete return`);
    }
    const ledger = oracleLedger(input);
    const diff = diffLedger(ledger, ret, effective);
    const coverage = buildCoverage(ledger, diff, ret, effective);
    const findings = [...findingsOfDiff(diff), coverageFinding(diff, coverage)];
    return { status: "ran", reason: null, findings, coverage, summary: summaryOf(diff) };
  } catch (err) {
    // fail closed; only the error class is kept (nothing from the facts)
    return notRun(`the recalculation could not run (${err instanceof Error ? err.name : "unknown error"})`);
  }
}

function summaryOf(diff: DiffResult): L2Summary {
  const lineMismatch = diff.comparisons.filter((c) => c.kind === "mismatch").length;
  const headMismatch = diff.headline.filter((h) => h.kind === "mismatch").length;
  return {
    linesCompared: diff.compared,
    linesMatched: diff.matched,
    roundingDifferences: diff.comparisons.filter((c) => c.kind === "rounding").length + diff.headline.filter((h) => h.kind === "rounding").length,
    mismatchCount: lineMismatch + headMismatch,
    engineBlankCount: diff.comparisons.filter((c) => c.kind === "engine_blank").length + diff.headline.filter((h) => h.kind === "engine_blank").length,
    engineInputLines: diff.engineInputs.length,
    notRecomputedLines: diff.notRecomputed.length,
  };
}

/** One info finding that says plainly how much was and was not recomputed (the coverage never hides in a list nobody opens). */
function coverageFinding(diff: DiffResult, coverage: L2Coverage[]): Finding {
  const notChecked = coverage.filter((c) => !c.compared).length + 0;
  const names = NOT_COVERED.slice(0, 4)
    .map((n) => n.area.split(" (")[0])
    .join("; ");
  return makeFinding({
    layer: "L2",
    check: "L2.coverage",
    severity: "info",
    area: "process",
    message: `The independent recalculation compared ${diff.compared} lines of the federal and Connecticut return (${diff.matched} equal). ${diff.engineInputs.length} rare or stated lines were taken from the return as inputs and ${diff.notRecomputed.length} could not be produced; ${notChecked} areas are listed as not checked, among them: ${names}. Agreement proves the arithmetic, not the facts or the legal position.`.slice(0, 1100),
    recommendedAction: "Read the covered / not-covered table: anything listed as not checked still needs your own look.",
    acceptable: true,
  });
}

/** What the run stores for the gate (state.ts reads `status` and `coverage`): `ran` is stored as "completed", anything else as "not_run". */
export function l2SummaryOf(result: L2Result): { status: "completed" | "not_run"; reason: string | null; version: number; mismatchCount: number; coverage: L2Coverage[]; counts: L2Summary } {
  return { status: result.status === "ran" ? "completed" : "not_run", reason: result.reason, version: L2_VERSION, mismatchCount: result.summary.mismatchCount, coverage: result.coverage, counts: result.summary };
}
