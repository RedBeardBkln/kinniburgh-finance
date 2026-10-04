// L2 oracle: how the oracle reads the engine's output (the printed, effective amount of a line) and its recorded decisions.
// Only the SHAPE of the engine return is read here (types); no engine function is called.

import type { LineKey } from "@/lib/tax2025/line-catalog";
import type { EffectiveReturn } from "@/lib/tax2025/overrides";
import type { RuleDecision, Ty2025Return } from "@/lib/tax2025/types";
import type { OracleDecisions } from "@/lib/tax-review/l2/ledger";
import type { Maybe } from "@/lib/tax-review/l2/money";

export interface EngineLineView {
  /** The amount that is (or would be) printed, whole dollars; null when the line carries no amount. */
  amount: Maybe<number>;
  status: string;
  /** An owner override pins this line (the printed amount is the override). */
  overridden: boolean;
  informational: boolean;
}

const AMOUNT_STATUSES: ReadonlySet<string> = new Set(["computed", "not_applicable", "overridden"]);

/** The engine's line as the packet prints it: the effective line when an override layer exists, else the computed line. */
export function engineLineOf(ret: Ty2025Return, effective: EffectiveReturn | null, key: string): EngineLineView | null {
  const eff = effective?.lines[key as LineKey];
  if (eff !== undefined) {
    const status = String(eff.effective.status);
    return {
      amount: AMOUNT_STATUSES.has(status) ? eff.effective.amount : null,
      status,
      overridden: eff.override !== undefined || status === "overridden",
      informational: eff.base.informational === true,
    };
  }
  const line = ret.lines[key as LineKey];
  if (line === undefined) return null;
  return { amount: AMOUNT_STATUSES.has(line.status) ? line.amount : null, status: line.status, overridden: false, informational: line.informational === true };
}

/** The recorded decisions (effective ones when an override layer exists), with the engine's conservative defaults when none is recorded. */
export function decisionsOf(ret: Ty2025Return, effective: EffectiveReturn | null): OracleDecisions {
  const list: readonly RuleDecision[] = effective?.decisions ?? ret.decisions;
  const pick = (id: string): string | undefined => list.find((d) => d.id === id)?.chosen;
  const x1 = pick("X1");
  const x3 = pick("X3");
  const x5 = pick("X5");
  return {
    homeOffice: x1 === "actual" ? "actual" : "simplified",
    qbiForm: x3 === "8995a" ? "8995a" : "8995",
    arbor: x5 === "capitalize" ? "capitalize" : "schedule_a",
  };
}
