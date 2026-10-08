// The carry screen's write guard (tax-carry-screen-and-year-close): may facts be carried INTO this tax year?
//
// Order matters. The cheap rules (not a year, TY2025 and earlier, too far ahead) are checked first and need no database, so a
// refused year never touches it. Only then is the latest year marked filed read, FAIL-CLOSED: a table that does not exist yet
// means nothing is filed (the migration is not applied), but any other read error refuses the write. A reopened year does not
// block. This reads the close events only; it never writes and is not read by the engine, the fingerprint or the approval flow.

import { checkCarryTarget } from "@/lib/tax-facts/carry-target";
import { readLatestClosedYear } from "@/lib/tax-year-close-store";

export const CLOSED_CHECK_FAILED_MESSAGE =
  "Could not check whether a tax year is marked filed, so nothing was changed. Try again shortly.";

export async function checkCarryTargetGuarded(year: number, now: Date = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const floor = checkCarryTarget(year, { latestClosedYear: null, now });
  if (!floor.ok) return { ok: false, error: floor.message };
  const closed = await readLatestClosedYear();
  if (!closed.ok) return { ok: false, error: CLOSED_CHECK_FAILED_MESSAGE };
  const full = checkCarryTarget(year, { latestClosedYear: closed.year, now });
  return full.ok ? { ok: true } : { ok: false, error: full.message };
}
