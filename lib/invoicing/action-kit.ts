// Small shared helpers for the invoicing server actions. NOT a "use server" file (its exports are not actions). Server only.
// Each action file defines its own local `requireAuth()` (the repo convention) and calls it as the first statement of every export.

import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertSafeEventData } from "@/lib/invoicing/events";
import { nyToday } from "@/lib/invoicing/state";

export type ActionError = { error: string };

/** The signed-in user or a thrown "Unauthorized" (what every action's local requireAuth does). */
export async function sessionUser(): Promise<{ id: string; name: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id, name: session.user.name ?? null };
}

/**
 * One id / count-only AuditLog row for an owner-initiated action (changeType free string, precedent actions/utility-usage.ts).
 * Never a name, an amount in words, a note, an address, a TIN or remit-to text: the payload passes the same guard as the timeline.
 * A failure to write the audit row is logged by name only and does not undo the action that already succeeded.
 */
export async function audit(userId: string, changeType: string, after: Record<string, string | number | boolean | null>): Promise<void> {
  try {
    await db.auditLog.create({ data: { changedBy: userId, changeType, before: Prisma.JsonNull, after: assertSafeEventData(after) as Prisma.InputJsonValue } });
  } catch (err) {
    console.error("Invoicing audit row failed", err instanceof Error ? err.name : "UnknownError");
  }
}

/** Today's America/New_York calendar day at 00:00 UTC. */
export function todayNY(): Date {
  return nyToday(new Date());
}
