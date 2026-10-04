// Small helpers shared by the rules that emit EVERY printed line of a form (Schedule 1-A, Form 8960): a line's value
// is a whole-dollar amount or the reason it has none, and each later line is derived from the whole-dollar lines above
// it (exactly as a person filling in the form), so the printed form foots by construction. A line whose source has no
// value is blocked with the worst status and every distinct reason; never a silent 0.
//
// Pure. No constants here.

import type { Decimal } from "@prisma/client/runtime/library";
import { lineMeta } from "@/lib/tax2025/line-catalog";
import { ZERO, amountLine, blockedLine, roundLine } from "@/lib/tax2025/money";
import { worstBlocked, type LineKey, type RuleLine, type RuleStatus } from "@/lib/tax2025/types";

export type Blocked = Exclude<RuleStatus, "computed" | "not_applicable">;

/** A printed line that has no amount, with the reason and the name of the missing input. */
export interface BlockedVal {
  ok: false;
  status: Blocked;
  reason: string;
  missing: string;
}

/** A printed line's whole-dollar value, or why it has none. */
export type Val = { ok: true; v: Decimal } | BlockedVal;

export function block(status: Blocked, reason: string, missing: string): BlockedVal {
  return { ok: false, status, reason, missing };
}

/** Several blocking values as one: worst status, every distinct reason. */
export function mergeBlocked(bad: readonly BlockedVal[]): BlockedVal {
  const status = (worstBlocked(bad.map((b) => b.status)) ?? "missing_input") as Blocked;
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  return { ok: false, status, reason: uniq(bad.map((b) => b.reason)).join(" "), missing: uniq(bad.map((b) => b.missing)).join("; ") };
}

/**
 * Line emitters: each pushes one RuleLine and returns the value later lines build on. `missingSink` (optional) collects the
 * names of the inputs behind every blocked line (the rule's `inputsMissing`).
 */
export function makeEmitters(lines: RuleLine[], missingSink?: Set<string>) {
  /** An amount line (rounded to whole dollars); the returned value is the rounded amount. */
  const amt = (key: LineKey, exact: Decimal, status: "computed" | "not_applicable", reason: string): Val => {
    const m = lineMeta(key);
    lines.push(amountLine(key, m.label, m.formLine, exact, status, reason));
    return { ok: true, v: roundLine(exact) };
  };
  /** A blocked line (no amount). `informational` lines never block the return (they become advisory items). */
  const blk = (key: LineKey, b: BlockedVal, informational = false): BlockedVal => {
    const m = lineMeta(key);
    if (missingSink !== undefined && b.missing !== "") for (const name of b.missing.split("; ")) missingSink.add(name);
    const l = blockedLine(key, m.label, m.formLine, b.status, b.reason);
    lines.push(informational ? { ...l, informational: true } : l);
    return b;
  };
  /** key = fn(whole-dollar values of deps); blocked (worst status, merged reasons) when a dep has no value. */
  const calc = (key: LineKey, deps: readonly Val[], fn: (v: Decimal[]) => Decimal, reason: string, status: "computed" | "not_applicable" = "computed"): Val => {
    const bad = deps.filter((d): d is BlockedVal => !d.ok);
    if (bad.length > 0) return blk(key, mergeBlocked(bad));
    return amt(key, fn(deps.map((d) => (d as { ok: true; v: Decimal }).v)), status, reason);
  };
  /** A not_applicable zero that states why. */
  const na = (key: LineKey, reason: string): Val => amt(key, ZERO, "not_applicable", reason);
  return { amt, blk, calc, na };
}
export type Emitters = ReturnType<typeof makeEmitters>;
