import { db } from "@/lib/db";
import { isEntityActiveForYear } from "@/lib/tax-entities";

const SLUG_SV = "sudden-valley";

/**
 * Whether Sudden Valley has any tax relevance for `year` (it was formed in
 * Feb 2026, so false for 2025 and earlier). Uses the same entity rule as the
 * Tax Workspaces page and the Forms page, so they can never disagree. Read-only.
 * A missing entity counts as not active (fail closed: show nothing about it).
 */
export async function isSuddenValleyActiveForYear(year: number): Promise<boolean> {
  const sv = await db.entity.findFirst({
    where: { slug: SLUG_SV, archivedAt: null },
    select: { type: true, foundedDate: true, taxStatusNotes: true },
  });
  return sv ? isEntityActiveForYear(sv, year) : false;
}
