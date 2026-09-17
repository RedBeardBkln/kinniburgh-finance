// Nests budget-line rows under their parent tag's row when both are budgeted
// on the same account (e.g. HBO Max nests under Streaming). A tag whose
// parent has no budget line of its own in this account stays at the top
// level — an ancestor without a budget line never pulls its descendants
// up under it.

// Type-only import — this file is shared with a client component
// (budget-page-client.tsx via nestBudgetLines), so it must never pull in a
// runtime value from "@prisma/client/runtime/library": that package's
// Node-only internals (node:fs, node:events, etc.) break the browser
// webpack build the moment any value (not just a type) from it is imported
// here. `resolveBudgetedAmounts` below takes its "zero" Decimal as a
// parameter from the (always server-side) caller instead of constructing
// one itself, specifically to avoid needing a runtime Decimal import.
import type { Decimal } from "@prisma/client/runtime/library";

export interface NestableBudgetLine {
  id: string;
  tagId: string;
}

export interface NestedBudgetRow<T extends NestableBudgetLine> {
  line: T;
  depth: number;
}

interface BudgetTree<T extends NestableBudgetLine> {
  childrenByParentTagId: Map<string, T[]>;
  roots: T[];
}

/**
 * Shared parent/child relationship building for a single account's flat
 * budget-line list: which lines are "roots" (their tag's parent has no
 * budget line of its own in this account) and which lines are children of
 * another line present in the same list. Both `nestBudgetLines` (rendering
 * order) and `resolveBudgetedAmounts`/`getRootBudgetLineIds` (auto-sum math)
 * share this single source of truth rather than building two independent,
 * potentially-inconsistent trees.
 */
function buildBudgetTree<T extends NestableBudgetLine>(
  lines: T[],
  tagParentId: (tagId: string) => string | null | undefined
): BudgetTree<T> {
  const byTagId = new Map(lines.map((l) => [l.tagId, l]));
  const childrenByParentTagId = new Map<string, T[]>();
  const roots: T[] = [];

  for (const line of lines) {
    const parentTagId = tagParentId(line.tagId) ?? null;
    if (parentTagId && byTagId.has(parentTagId)) {
      if (!childrenByParentTagId.has(parentTagId)) childrenByParentTagId.set(parentTagId, []);
      childrenByParentTagId.get(parentTagId)!.push(line);
    } else {
      roots.push(line);
    }
  }

  return { childrenByParentTagId, roots };
}

/**
 * Orders a single account's budget lines into parent-first, depth-first
 * order, with each line's depth reflecting how many budgeted ancestors it
 * nests under. Siblings (and top-level roots) are ordered by `compare`.
 */
export function nestBudgetLines<T extends NestableBudgetLine>(
  lines: T[],
  tagParentId: (tagId: string) => string | null | undefined,
  compare: (a: T, b: T) => number
): NestedBudgetRow<T>[] {
  const { childrenByParentTagId, roots } = buildBudgetTree(lines, tagParentId);

  const ordered: NestedBudgetRow<T>[] = [];
  function visit(line: T, depth: number) {
    ordered.push({ line, depth });
    const kids = (childrenByParentTagId.get(line.tagId) ?? []).sort(compare);
    for (const kid of kids) visit(kid, depth + 1);
  }
  for (const root of [...roots].sort(compare)) visit(root, 0);

  return ordered;
}

export interface ResolvableBudgetLine extends NestableBudgetLine {
  budgeted: Decimal | null;
}

/**
 * Resolves every line's effective budgeted amount within one account, bottom-up:
 * a non-null `budgeted` is used as-is; a null `budgeted` resolves to the sum of its
 * direct children's own resolved amounts (recursing arbitrarily deep); a null line
 * with no matching children resolves to $0. Guards against malformed cyclic
 * parent data (matches nestBudgetLines's existing "doesn't hang or crash" contract)
 * by treating an in-progress cycle as $0 rather than recursing forever.
 *
 * `zero` is a caller-supplied `Decimal` instance representing $0 (e.g.
 * `new Prisma.Decimal(0)`) — passed in rather than constructed here so this
 * module never needs a runtime import of the Prisma Decimal class (see the
 * type-only import note above).
 */
export function resolveBudgetedAmounts<T extends ResolvableBudgetLine>(
  lines: T[],
  tagParentId: (tagId: string) => string | null | undefined,
  zero: Decimal
): Map<string, Decimal> {
  const { childrenByParentTagId } = buildBudgetTree(lines, tagParentId);
  const resolved = new Map<string, Decimal>();
  const inProgress = new Set<string>();

  function resolve(line: T): Decimal {
    // Map.get returning `undefined` (not `!cached`) is what gates re-entry
    // here — a legitimately resolved Decimal(0) is a truthy object, not the
    // primitive 0, so `cached !== undefined` is the only safe check.
    const cached = resolved.get(line.id);
    if (cached !== undefined) return cached;
    if (line.budgeted !== null) {
      resolved.set(line.id, line.budgeted);
      return line.budgeted;
    }
    if (inProgress.has(line.id)) return zero; // cycle guard
    inProgress.add(line.id);
    const kids = childrenByParentTagId.get(line.tagId) ?? [];
    const sum = kids.reduce((acc, kid) => acc.plus(resolve(kid)), zero);
    inProgress.delete(line.id);
    resolved.set(line.id, sum);
    return sum;
  }

  for (const line of lines) resolve(line);
  return resolved;
}

/** The set of line ids that are NOT nested under another line in this same
 * account (i.e. `nestBudgetLines`'s depth-0 rows) — sum only these ids' resolved
 * amounts to get a non-double-counted total for this account. */
export function getRootBudgetLineIds<T extends NestableBudgetLine>(
  lines: T[],
  tagParentId: (tagId: string) => string | null | undefined
): Set<string> {
  const { roots } = buildBudgetTree(lines, tagParentId);
  return new Set(roots.map((l) => l.id));
}
