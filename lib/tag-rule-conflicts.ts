import { alnum } from "@/lib/tags";

/**
 * Conflict detection between tag rules.
 *
 * matchTagRule() (lib/tags.ts) picks ONE winning rule per transaction using
 * alnum()-stripped contains-matching on the payee, an optional amount range and
 * an optional account filter. Two rules therefore "compete" whenever some
 * transaction could satisfy both: their payee patterns overlap (equal, or one
 * contained in the other), their amount ranges intersect, and their account
 * scopes intersect.
 */

export interface RuleShape {
  id?: string;
  payeePattern: string | null;
  tagId: string;
  amountMin: number | null;
  amountMax: number | null;
  accountId: string | null;
  accountIds?: string[] | null;
}

export type ConflictKind =
  /** Same payee, same tag, same scope — creating it adds nothing. */
  | "duplicate"
  /** Overlapping scope but a different tag — the two rules fight over transactions. */
  | "competing"
  /** Same tag, overlapping scope, but one pattern is broader — redundant or shadowed. */
  | "overlapping";

export interface RuleConflict {
  kind: ConflictKind;
  ruleId: string | null;
  payeePattern: string | null;
  tagId: string;
  amountMin: number | null;
  amountMax: number | null;
  accountIds: string[] | null;
  /** Human-readable explanation, safe to show in the UI. */
  reason: string;
}

/** A conflict decorated with display names for the UI. */
export type RuleConflictView = RuleConflict & { tagName: string };

/** Effective account scope: null means "any account". */
function accountScope(r: RuleShape): string[] | null {
  if (r.accountIds && r.accountIds.length > 0) return r.accountIds;
  if (r.accountId) return [r.accountId];
  return null;
}

function sameSet(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function accountsOverlap(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return true;
  const s = new Set(a);
  return b.some((x) => s.has(x));
}

function amountsOverlap(a: RuleShape, b: RuleShape): boolean {
  const aMin = a.amountMin ?? -Infinity;
  const aMax = a.amountMax ?? Infinity;
  const bMin = b.amountMin ?? -Infinity;
  const bMax = b.amountMax ?? Infinity;
  return aMin <= bMax && bMin <= aMax;
}

/** How two payee patterns relate under matchTagRule's contains-matching. */
type PatternRelation = "equal" | "overlap" | "none";

function patternRelation(a: string | null, b: string | null): PatternRelation {
  // A null pattern matches every payee, so it overlaps with anything.
  if (a === null || b === null) return a === b ? "equal" : "overlap";
  const sa = alnum(a);
  const sb = alnum(b);
  if (sa === sb) return "equal";
  if (sa === "" || sb === "") return "overlap";
  if (sa.includes(sb) || sb.includes(sa)) return "overlap";
  return "none";
}

/**
 * Find existing rules that duplicate, compete with, or overlap a candidate
 * rule. `existing` should exclude the candidate itself when editing (pass
 * `excludeId`).
 */
export function findRuleConflicts(
  candidate: RuleShape,
  existing: RuleShape[],
  opts: { excludeId?: string } = {}
): RuleConflict[] {
  const candScope = accountScope(candidate);
  const conflicts: RuleConflict[] = [];

  for (const rule of existing) {
    if (opts.excludeId && rule.id === opts.excludeId) continue;

    const relation = patternRelation(candidate.payeePattern, rule.payeePattern);
    if (relation === "none") continue;

    const ruleScope = accountScope(rule);
    if (!amountsOverlap(candidate, rule)) continue;
    if (!accountsOverlap(candScope, ruleScope)) continue;

    const sameTag = candidate.tagId === rule.tagId;
    const sameScope =
      sameSet(candScope, ruleScope) &&
      (candidate.amountMin ?? null) === (rule.amountMin ?? null) &&
      (candidate.amountMax ?? null) === (rule.amountMax ?? null);

    let kind: ConflictKind;
    let reason: string;
    if (sameTag && relation === "equal" && sameScope) {
      kind = "duplicate";
      reason = "Identical rule already exists (same payee, tag, amount range, and accounts).";
    } else if (!sameTag) {
      kind = "competing";
      reason =
        relation === "equal"
          ? "Same payee pattern is already mapped to a different tag — only one will win per transaction."
          : "Payee patterns overlap and map to different tags — some transactions could match both.";
    } else {
      kind = "overlapping";
      reason =
        relation === "equal"
          ? "Same payee and tag already exist with a different amount range or account scope."
          : "Same tag, but one payee pattern is contained in the other — one rule is likely redundant.";
    }

    conflicts.push({
      kind,
      ruleId: rule.id ?? null,
      payeePattern: rule.payeePattern,
      tagId: rule.tagId,
      amountMin: rule.amountMin,
      amountMax: rule.amountMax,
      accountIds: ruleScope,
      reason,
    });
  }

  // Most serious first: duplicate, competing, overlapping.
  const rank: Record<ConflictKind, number> = { duplicate: 0, competing: 1, overlapping: 2 };
  return conflicts.sort((x, y) => rank[x.kind] - rank[y.kind]);
}

/**
 * Conflicts an edit would introduce: those in `after` that the rule did not
 * already have before the edit. Pre-existing overlaps must not block unrelated
 * edits (otherwise a rule that already overlaps something can never be edited
 * without a forced approval, and fixing one of several overlaps is gated on
 * the rest).
 */
export function introducedConflicts(before: RuleConflict[], after: RuleConflict[]): RuleConflict[] {
  const key = (c: RuleConflict) => `${c.ruleId}:${c.kind}`;
  const had = new Set(before.map(key));
  return after.filter((c) => !had.has(key(c)));
}

/**
 * Case-insensitive, punctuation-insensitive search over rules. Matches the
 * query against the payee pattern (alnum-stripped, so "lowes" finds "lowe's"),
 * the tag name, and the account nicknames.
 */
export function ruleMatchesSearch(
  query: string,
  fields: { payeePattern: string; tagName: string; accountLabels: string[] }
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const qa = alnum(q);
  if (qa && alnum(fields.payeePattern).includes(qa)) return true;
  if (fields.tagName.toLowerCase().includes(q)) return true;
  return fields.accountLabels.some((l) => l.toLowerCase().includes(q));
}
