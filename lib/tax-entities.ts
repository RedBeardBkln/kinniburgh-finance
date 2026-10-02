// Pure rule: which entities have a tax filing for a given tax year.
// Shared by the Tax Workspaces page (app/tax/page.tsx) and the per-year Forms
// page (lib/tax-forms-build.ts) so the two can never disagree.
//
// Personal is always included. A business formed after the tax year started has
// no filing for that year (e.g. Sudden Valley, founded Feb 2026, has no 2025
// filing). A business with no foundedDate recorded is included by default
// (undocumented-but-real formation date, e.g. EK Consulting's "founded 2021,
// exact date not documented") UNLESS its taxStatusNotes explicitly says it is
// not yet formed (e.g. Mezzo) — no dedicated "formed" field exists on Entity
// yet, so this string check is a stopgap; remove it if/when that field is added.

export interface EntityYearInput {
  type: string; // "personal" | "business"
  foundedDate: Date | null;
  taxStatusNotes: string | null;
}

export function isEntityActiveForYear(entity: EntityYearInput, year: number): boolean {
  if (entity.type === "personal") return true;
  if (entity.foundedDate) return entity.foundedDate.getUTCFullYear() <= year;
  return !(entity.taxStatusNotes ?? "").toLowerCase().includes("not yet formed");
}

export function entitiesForYear<T extends EntityYearInput>(entities: readonly T[], year: number): T[] {
  return entities.filter((e) => isEntityActiveForYear(e, year));
}
