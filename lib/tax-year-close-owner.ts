// Who may mark a tax year filed or reopen it, resolved for the signed-in account (tax-carry-screen-and-year-close). Kept apart from
// the close store on purpose: this file imports the approver rule (a pure function under lib/tax-review/), and the store, which the
// carry-screen write guard reads, must not pull the review code in. READ-ONLY (two reads); no auth of its own, callers check
// the session first.

import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { resolveYearCloser, type YearCloserResolution } from "@/lib/tax-year-close/closer";

/** Who may mark a year filed: the owner's account only. Fail-soft for display (a failure is "not allowed", with a reason). */
export async function resolveCloserForUser(userId: string): Promise<YearCloserResolution> {
  try {
    const [users, ekc] = await Promise.all([db.user.findMany({ select: { id: true, name: true } }), getEntityBySlug("ek-consulting")]);
    return resolveYearCloser(users, ekc?.name ?? null, userId);
  } catch (e) {
    console.error("tax year close: owner could not be resolved:", e instanceof Error ? e.name : "unknown error");
    return { allowed: false, ownerName: null, reason: "The owner's account could not be checked just now. Try again shortly." };
  }
}
