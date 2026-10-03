// Map completeness (plan section 6.3, "the key guard"): every catalog field must be
// claimed by exactly one of a map's lines, tables, header or blank lists. A field
// claimed twice, claimed but absent from the form, or claimed by nothing is a
// defect. fill.ts throws on the first two at run time; the tests also fail on
// the third so every field of every mapped form gets an explicit decision.

import type { FormMap } from "@/lib/tax2025/pdf/types";

export type ClaimSource = "lines" | "tables" | "header" | "blank";

export interface Claim {
  field: string;
  by: ClaimSource;
}

/** Every (field, source) claim a map makes, expanding blank `match` regexes over the form's real field names. */
export function collectClaims(map: FormMap, formFieldNames: readonly string[]): Claim[] {
  const claims: Claim[] = [];
  for (const l of map.lines) claims.push({ field: l.field, by: "lines" });
  for (const t of map.tables) {
    for (const row of t.rows) for (const field of Object.values(row)) claims.push({ field, by: "tables" });
  }
  for (const h of map.header) claims.push({ field: h.field, by: "header" });
  for (const b of map.blank) {
    if ("field" in b) {
      claims.push({ field: b.field, by: "blank" });
    } else {
      for (const name of formFieldNames) {
        b.match.lastIndex = 0;
        if (b.match.test(name)) claims.push({ field: name, by: "blank" });
      }
    }
  }
  return claims;
}

export interface CompletenessReport {
  /** Claimed by the map but not a field of the form. */
  unknown: string[];
  /** Claimed more than once (in any combination of sources). */
  duplicated: string[];
  /** On the form but claimed by nothing. */
  unclaimed: string[];
}

export function checkCompleteness(map: FormMap, formFieldNames: readonly string[]): CompletenessReport {
  const known = new Set(formFieldNames);
  const counts = new Map<string, number>();
  for (const c of collectClaims(map, formFieldNames)) counts.set(c.field, (counts.get(c.field) ?? 0) + 1);
  const unknown: string[] = [];
  const duplicated: string[] = [];
  for (const [field, n] of counts) {
    if (!known.has(field)) unknown.push(field);
    if (n > 1) duplicated.push(field);
  }
  const unclaimed = formFieldNames.filter((f) => !counts.has(f));
  return { unknown: unknown.sort(), duplicated: duplicated.sort(), unclaimed: unclaimed.sort() };
}
