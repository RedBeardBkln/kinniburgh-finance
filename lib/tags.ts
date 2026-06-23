export interface TagNode {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
  children: TagNode[];
}

/**
 * Build a tag hierarchy from a flat list.
 * Returns only root nodes; children are nested within.
 */
export function buildTagTree(
  tags: { id: string; name: string; shortName: string; parentId: string | null }[]
): TagNode[] {
  const map = new Map<string, TagNode>();
  for (const t of tags) {
    map.set(t.id, { ...t, children: [] });
  }

  const roots: TagNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children alphabetically at each level
  function sortChildren(node: TagNode) {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  }
  roots.sort((a, b) => a.name.localeCompare(b.name));
  roots.forEach(sortChildren);

  return roots;
}

/** Flatten a tag tree back to a sorted list for display. */
export function flattenTagTree(roots: TagNode[]): TagNode[] {
  const result: TagNode[] = [];
  function walk(nodes: TagNode[]) {
    for (const n of nodes) {
      result.push(n);
      if (n.children.length > 0) walk(n.children);
    }
  }
  walk(roots);
  return result;
}

/**
 * Normalize a payee name for rule matching.
 * Lowercases, strips punctuation, collapses whitespace.
 */
export function normalizePayee(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TagRuleCandidate {
  tagId: string;
  payeePattern: string | null;
  amountMin: number | null;
  amountMax: number | null;
  accountId: string | null;
}

/**
 * Find the best matching tag rule for a transaction.
 * Returns the tagId of the highest-priority match, or null if none found.
 * Priority: exact payee + amount + account > exact payee + account > exact payee > prefix payee.
 */
export function matchTagRule(
  rules: TagRuleCandidate[],
  opts: {
    normalizedPayee: string;
    amount: number; // absolute value
    accountId: string;
  }
): string | null {
  const { normalizedPayee, amount, accountId } = opts;

  // Score each rule: higher = better match
  let bestScore = -1;
  let bestTagId: string | null = null;

  for (const rule of rules) {
    let score = 0;

    // Payee match
    if (rule.payeePattern) {
      const pattern = rule.payeePattern.toLowerCase();
      if (normalizedPayee === pattern) {
        score += 100; // exact
      } else if (normalizedPayee.startsWith(pattern)) {
        score += 50; // prefix
      } else if (normalizedPayee.includes(pattern)) {
        score += 25; // contains (handles bank-prefixed payees like "POS TARGET 00123")
      } else {
        continue; // no match
      }
    }

    // Amount range
    if (rule.amountMin !== null || rule.amountMax !== null) {
      const min = rule.amountMin ?? -Infinity;
      const max = rule.amountMax ?? Infinity;
      if (amount >= min && amount <= max) {
        score += 20;
      } else {
        continue;
      }
    }

    // Account match
    if (rule.accountId) {
      if (rule.accountId === accountId) {
        score += 10;
      } else {
        continue;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestTagId = rule.tagId;
    }
  }

  return bestTagId;
}
