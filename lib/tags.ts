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

/**
 * Normalize a user-entered payee pattern.
 * Preserves symbols (apostrophes, ampersands, commas, etc.) so "Lowe's" and
 * "Stop & Shop" display as typed. Matching still ignores these symbols — see
 * matchTagRule(), which compares alnum()-stripped strings on both sides.
 * Use this when storing rule patterns; use normalizePayee for transaction payees.
 */
export function normalizePattern(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip all non-alphanumeric for robust fuzzy comparison between old and new
 * normalizations. Lowercases first — callers are expected to pass an
 * already-normalized (lowercase) payee, but the character class here only
 * ever matched [a-z0-9], so any caller that (accidentally or not) passed a
 * mixed-case string had every uppercase letter silently dropped rather than
 * matched case-insensitively. Confirmed this was live: bank-statement-import
 * transactions store payeeNormalized as a raw, un-lowercased copy of
 * payeeRaw (a separate bug, fixed at its source in actions/documents.ts),
 * and for those rows this stripped every capitalized word's leading letter,
 * making matchTagRule silently fail to match text that was visibly identical
 * to a human.
 */
export function alnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Suggest a shorter, more generally-matching payee pattern from a specific
 * transaction's normalized payee, for pre-filling the "create a tag rule"
 * dialog. Bank payee strings routinely append a one-off suffix after the
 * actual vendor name — a phone number ("xfinity mobile - 888-936-4968 pa"),
 * a statement-specific date range ("interest earned credit - interest
 * period 2025-07-28 ~ 2025-08-27"), a reference number — and matchTagRule's
 * contains-match means a rule that keeps that suffix verbatim can only ever
 * match that exact transaction again, never the next month's version of the
 * same recurring charge. Confirmed against real saved rules that this was
 * happening silently: the rule saved fine, "apply to past transactions"
 * then legitimately found zero matches, because nothing else on record
 * shares that one-off suffix.
 *
 * Truncates at the earliest of: a " - "/" ~ " separator, a run of 3+ digits
 * (phone/reference numbers), or a YYYY-MM-DD-shaped date. Falls back to the
 * original string if truncation would leave under 3 characters, so this
 * only ever shortens toward something still matchable — never produces an
 * unusable empty suggestion.
 */
export function suggestPayeePattern(normalizedPayee: string): string {
  const cutPatterns = [
    /\s[-~]\s/, // " - " or " ~ " separator before a trailing detail
    /\d{3,}/, // phone/reference number runs
    /\d{4}-\d{2}-\d{2}/, // ISO-shaped dates
  ];

  let cutIndex = -1;
  for (const pattern of cutPatterns) {
    const match = normalizedPayee.match(pattern);
    if (match && match.index !== undefined) {
      if (cutIndex === -1 || match.index < cutIndex) cutIndex = match.index;
    }
  }

  if (cutIndex === -1) return normalizedPayee;

  const truncated = normalizedPayee.slice(0, cutIndex).trim();
  return truncated.length >= 3 ? truncated : normalizedPayee;
}

export interface TagRuleCandidate {
  tagId: string;
  payeePattern: string | null;
  amountMin: number | null;
  amountMax: number | null;
  accountId: string | null;
  accountIds?: string[] | null; // multi-account filter; takes priority over accountId
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

    // Payee match — use alnum-only comparison so apostrophes/hyphens don't matter
    if (rule.payeePattern) {
      const sp = alnum(normalizedPayee);
      const sPattern = alnum(rule.payeePattern);
      if (sp === sPattern) {
        score += 100; // exact
      } else if (sp.startsWith(sPattern)) {
        score += 50; // prefix
      } else if (sp.includes(sPattern)) {
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

    // Account match — check accountIds array first, then fall back to single accountId
    const acctFilter =
      rule.accountIds && rule.accountIds.length > 0
        ? rule.accountIds
        : rule.accountId
        ? [rule.accountId]
        : null;
    if (acctFilter) {
      if (acctFilter.includes(accountId)) {
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
