// View-model for the dashboard's Budget Lines table: lines grouped by account, parents above indented children, in the
// same order and with the same nesting rule as /budgets (it reuses nestBudgetLines). Pure and client-safe: no Decimal,
// no database.
import { nestBudgetLines } from "@/lib/budget-nesting";

export interface TreeLineInput {
  id: string;
  tagId: string;
  accountId: string;
  accountName: string;
  /** Leaf segment of the tag, e.g. "Groceries". */
  shortName: string;
  /** Full tag path, e.g. "Food & Drink / Groceries". */
  fullName: string;
}

export interface TreeRow<T extends TreeLineInput> {
  line: T;
  depth: number;
  /** The line this one nests under (same account), or null for a root row. */
  parentId: string | null;
  hasChildren: boolean;
  /** Every ancestor line id, nearest first (used to hide rows under a collapsed parent). */
  ancestorIds: string[];
}

export interface TreeGroup<T extends TreeLineInput> {
  accountId: string;
  accountName: string;
  rows: TreeRow<T>[];
}

/** The /budgets sibling order: alphabetical by the tag's short name. */
export function compareByShortName(a: TreeLineInput, b: TreeLineInput): number {
  return a.shortName.localeCompare(b.shortName);
}

export function buildBudgetTreeGroups<T extends TreeLineInput>(
  lines: T[],
  tagParentId: (tagId: string) => string | null | undefined
): TreeGroup<T>[] {
  const byAccount = new Map<string, T[]>();
  for (const line of lines) {
    const group = byAccount.get(line.accountId);
    if (group) group.push(line);
    else byAccount.set(line.accountId, [line]);
  }

  const groups: TreeGroup<T>[] = [];
  for (const [accountId, accountLines] of byAccount) {
    const ordered = nestBudgetLines(accountLines, tagParentId, compareByShortName);
    const stack: string[] = []; // line id at each depth along the current path
    const rows: TreeRow<T>[] = ordered.map(({ line, depth }) => {
      stack.length = depth;
      const ancestorIds = [...stack].reverse();
      const parentId = depth > 0 ? stack[depth - 1] ?? null : null;
      stack[depth] = line.id;
      return { line, depth, parentId, hasChildren: false, ancestorIds };
    });
    const parents = new Set(rows.map((r) => r.parentId).filter((p): p is string => p !== null));
    for (const row of rows) row.hasChildren = parents.has(row.line.id);
    groups.push({ accountId, accountName: accountLines[0]?.accountName ?? "", rows });
  }
  groups.sort((a, b) => a.accountName.localeCompare(b.accountName) || a.accountId.localeCompare(b.accountId));
  return groups;
}

/** Rows to show given the set of collapsed parent ids: a collapsed parent hides every descendant, never itself. */
export function visibleRows<T extends TreeLineInput>(rows: TreeRow<T>[], collapsed: ReadonlySet<string>): TreeRow<T>[] {
  if (collapsed.size === 0) return rows;
  return rows.filter((r) => !r.ancestorIds.some((id) => collapsed.has(id)));
}

/**
 * The label for a row. A root row whose tag has a parent shows the full path ("Food & Drink / Groceries") so it still
 * reads in context; a nested row shows only its own name because its parent is the row above.
 */
export function rowLabel(row: { depth: number; line: TreeLineInput }): string {
  return row.depth > 0 ? row.line.shortName : row.line.fullName;
}
