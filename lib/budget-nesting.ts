// Nests budget-line rows under their parent tag's row when both are budgeted
// on the same account (e.g. HBO Max nests under Streaming). A tag whose
// parent has no budget line of its own in this account stays at the top
// level — an ancestor without a budget line never pulls its descendants
// up under it.

export interface NestableBudgetLine {
  id: string;
  tagId: string;
}

export interface NestedBudgetRow<T extends NestableBudgetLine> {
  line: T;
  depth: number;
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

  const ordered: NestedBudgetRow<T>[] = [];
  function visit(line: T, depth: number) {
    ordered.push({ line, depth });
    const kids = (childrenByParentTagId.get(line.tagId) ?? []).sort(compare);
    for (const kid of kids) visit(kid, depth + 1);
  }
  for (const root of [...roots].sort(compare)) visit(root, 0);

  return ordered;
}
