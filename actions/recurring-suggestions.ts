"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { collectModelledRefs, todayForNewYork } from "@/lib/upcoming-ledger";
import { loadUpcomingLedgerInput } from "@/lib/upcoming-ledger-input";
import { fetchDetectionData, runDetection } from "@/lib/recurring-detect-build";
import { addDismissed, removeDismissed, type DetectionBundle } from "@/lib/recurring-detect";
import { getDismissedSuggestions, setDismissedSuggestions } from "@/lib/settings";

// Owner actions on the "Looks recurring" review list (lib/recurring-detect.ts). Every export starts with
// `await requireAuth();` (a test pins it). The SERVER re-runs the detector and builds the RecurringExpense from
// what it finds: the client only names a series (entity + key) and can never supply an amount, a name or a date.
// Dismissals are an AppSetting JSON entry (lib/settings.ts), not a table: no migration.
// Nothing here writes an AuditLog row, matching actions/recurring-expenses.ts (no payee text is ever logged).

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

type Result = { success: true } | { error: string };

const refSchema = z.object({
  entityId: z.string().uuid(),
  seriesKey: z.string().min(1).max(300),
});

// Same shape and limits as actions/recurring-expenses.ts (kept in step by hand: that file is not changed here).
const createSchema = z.object({
  entityId: z.string().uuid(),
  name: z.string().min(1).max(200),
  amountCents: z.number().int().positive(),
  frequency: z.enum(["monthly", "weekly", "biweekly", "quarterly", "annually"]),
  dueDay: z.number().int().min(1).max(31).nullable(),
  tagId: z.string().uuid().nullable(),
  notes: z.string().max(500),
});

/** A tag is linked only when most of the history carries it. */
const TAG_LINK_MIN_SHARE = 0.6;

function revalidateAll() {
  revalidatePath("/forecast");
  revalidatePath("/");
  revalidatePath("/budgets");
}

export async function addSuggestedRecurringExpense(input: { entityId: string; seriesKey: string }): Promise<Result> {
  await requireAuth();
  const parsed = refSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request" };
  const { entityId, seriesKey } = parsed.data;
  if (!seriesKey.startsWith(`${entityId}|`)) return { error: "Invalid request" };

  // Re-run the detector on the server, exactly as the page does (recorded items + 18 months of history).
  let detection: DetectionBundle;
  try {
    const now = new Date();
    const today = todayForNewYork(now);
    const [{ input }, data] = await Promise.all([
      loadUpcomingLedgerInput({ entityId, days: 30, now }),
      fetchDetectionData({ entityId, today }),
    ]);
    detection = runDetection(data, collectModelledRefs(input), today).bundle;
  } catch {
    return { error: "Recurring-pattern checks are unavailable right now." };
  }

  const found = [...detection.suggestions, ...detection.dismissed].find((s) => s.key === seriesKey);
  if (!found) {
    if (detection.suppressed.some((s) => s.key === seriesKey)) return { error: "Already recorded" };
    return { error: "That pattern is no longer detected." };
  }
  if (found.kind !== "outflow") return { error: "Only recurring expenses can be added here." };

  // A second click (or a parallel one) must not create a second row.
  const existing = await db.recurringExpense.findFirst({
    where: { entityId, name: found.payee },
    select: { id: true },
  });
  if (existing) return { error: "Already recorded" };

  // Link the budget category only when it is clearly this payee AND nothing else already uses it (a linked
  // recurring expense overrides a Budget amount on /budgets).
  let tagId: string | null = null;
  if (found.dominantTagId && found.tagShare >= TAG_LINK_MIN_SHARE) {
    const tag = found.dominantTagId;
    const [budget, bill, recurring] = await Promise.all([
      db.budget.findFirst({ where: { entityId, tagId: tag }, select: { id: true } }),
      db.scheduledBill.findFirst({
        where: { budgetTagId: tag, OR: [{ budgetEntityId: entityId }, { budgetEntityId: null, entityId }] },
        select: { id: true },
      }),
      db.recurringExpense.findFirst({ where: { entityId, tagId: tag }, select: { id: true } }),
    ]);
    if (!budget && !bill && !recurring) tagId = tag;
  }

  const data = createSchema.safeParse({
    entityId,
    name: found.payee,
    amountCents: found.typicalAmount.times(100).toDecimalPlaces(0).toNumber(),
    frequency: found.cadence === "annual" ? "annually" : found.cadence,
    dueDay: found.cadence === "monthly" ? found.typicalDay : null,
    tagId,
    notes:
      "Added from a recurring pattern in your transactions." +
      (found.amountMode === "varies" ? " The amount varies; this is the typical (median) amount." : ""),
  });
  if (!data.success) return { error: "Could not build a recurring expense from this pattern." };

  await db.recurringExpense.create({ data: { ...data.data, nextDueDate: found.nextExpected } });
  revalidateAll();
  return { success: true };
}

export async function dismissSuggestion(input: { entityId: string; seriesKey: string }): Promise<Result> {
  await requireAuth();
  const parsed = refSchema.safeParse(input);
  if (!parsed.success || !parsed.data.seriesKey.startsWith(`${parsed.data.entityId}|`)) return { error: "Invalid request" };
  const { entityId, seriesKey } = parsed.data;
  const current = await getDismissedSuggestions(entityId);
  await setDismissedSuggestions(entityId, addDismissed(current, seriesKey, new Date().toISOString()));
  revalidateAll();
  return { success: true };
}

export async function restoreSuggestion(input: { entityId: string; seriesKey: string }): Promise<Result> {
  await requireAuth();
  const parsed = refSchema.safeParse(input);
  if (!parsed.success || !parsed.data.seriesKey.startsWith(`${parsed.data.entityId}|`)) return { error: "Invalid request" };
  const { entityId, seriesKey } = parsed.data;
  const current = await getDismissedSuggestions(entityId);
  await setDismissedSuggestions(entityId, removeDismissed(current, seriesKey));
  revalidateAll();
  return { success: true };
}
