// Grouping of stored versions for the /tax/facts page (tax-facts-carry-forward-store).
//
// Every version of a key is kept (history is never hidden); the latest version is the one with the highest version
// number. A key whose latest version is retired or resolved goes to the "retired" group (still visible, collapsed).
//
// PURE: no DB, no network, no clock. Inputs are never mutated.

import { FACT_CATEGORIES, type FactCategory, type TaxFactRow } from "@/lib/tax-facts/types";

export interface FactGroup {
  factKey: string;
  category: FactCategory;
  latest: TaxFactRow;
  /** Every version, newest first. */
  history: TaxFactRow[];
  retired: boolean;
}

export interface GroupedFacts {
  /** Active facts (and open items) by category, in category order; empty categories are omitted. */
  active: Array<{ category: FactCategory; groups: FactGroup[] }>;
  /** Retired facts and resolved open items, still visible. */
  retired: FactGroup[];
}

export function groupFacts(rows: readonly TaxFactRow[]): GroupedFacts {
  const byKey = new Map<string, TaxFactRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.factKey);
    if (list) list.push(row);
    else byKey.set(row.factKey, [row]);
  }

  const groups: FactGroup[] = [];
  for (const [factKey, versions] of byKey) {
    const history = [...versions].sort((a, b) => b.version - a.version);
    const latest = history[0];
    if (!latest) continue;
    groups.push({
      factKey,
      category: latest.category,
      latest,
      history,
      retired: latest.changeKind === "retired" || latest.changeKind === "resolved",
    });
  }
  groups.sort((a, b) => (a.factKey < b.factKey ? -1 : a.factKey > b.factKey ? 1 : 0));

  const active = FACT_CATEGORIES.map((category) => ({
    category,
    groups: groups.filter((g) => !g.retired && g.category === category),
  })).filter((c) => c.groups.length > 0);
  return { active, retired: groups.filter((g) => g.retired) };
}

/** "14,300" or "14300.50" (dollars) as whole cents; null when it is not a plain amount. Integer math only. */
export function parseDollarsToCents(text: string): number | null {
  const m = /^-?\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?$|^-?\d{1,9}(?:\.\d{1,2})?$/.exec(text.trim());
  if (!m) return null;
  const negative = text.trim().startsWith("-");
  const [whole = "0", frac = ""] = text.trim().replace(/^-/, "").replace(/,/g, "").split(".");
  const cents = parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, "0") || "0", 10);
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}
