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
import { TAG_LINK_MIN_SHARE } from "@/lib/recurring-add-step";
import { seriesMarker } from "@/lib/recurring-series-marker";
import { validateRecurringName } from "@/lib/recurring-name";

// Owner actions on the "Looks recurring" review list (lib/recurring-detect.ts). Every export starts with
// `await requireAuth();` (a test pins it). The SERVER re-runs the detector and builds the RecurringExpense from
// what it finds: the client names a series (entity + key), may choose a budget tag and a display name (both validated
// here), and can never supply an amount, frequency, day or date.
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

function revalidateAll() {
  revalidatePath("/forecast");
  revalidatePath("/");
  revalidatePath("/budgets");
}

// What the browser may send when adding: the series, the owner's tag choice and an optional name. Nothing else is read
// (zod drops unknown keys, so an extra amount / frequency / day in a hand-made request is ignored, never used).
// tagId: undefined = the owner was not asked (older callers: the server's own >= 60% rule), null = "No tag", else a Tag id.
const addSchema = refSchema.extend({
  tagId: z.string().uuid().nullable().optional(),
  name: z.string().max(500).optional(),
});

export type AddResult = { success: true; notice?: string } | { error: string };

export async function addSuggestedRecurringExpense(input: {
  entityId: string;
  seriesKey: string;
  tagId?: string | null;
  name?: string;
}): Promise<AddResult> {
  await requireAuth();
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request" };
  const { entityId, seriesKey, tagId: chosenTagId, name: chosenNameRaw } = parsed.data;
  if (!seriesKey.startsWith(`${entityId}|`)) return { error: "Invalid request" };

  // The name is validated before any database call: 1-80 characters, no HTML, never ID-like.
  let chosenName: string | null = null;
  if (chosenNameRaw !== undefined) {
    const checked = validateRecurringName(chosenNameRaw);
    if (!checked.ok) return { error: checked.error };
    chosenName = checked.value;
  }

  // Tags are household-wide (the Tag table has no archived flag and no entity), the same list the Forecast and Budgets
  // pages offer for every entity; so "valid" means the id still exists.
  if (typeof chosenTagId === "string") {
    const tag = await db.tag.findUnique({ where: { id: chosenTagId }, select: { id: true } });
    if (!tag) return { error: "That budget category no longer exists." };
  }

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

  // A second click (or a parallel one) must not create a second row, even when the first was renamed: the row made
  // from this pattern carries its series key in notes (lib/recurring-series-marker.ts); the default name is also
  // checked, which covers rows made before the marker existed and a hand-entered row of the same name.
  const [sameName, sameSeries] = await Promise.all([
    db.recurringExpense.findFirst({ where: { entityId, name: found.payee }, select: { id: true } }),
    db.recurringExpense.findFirst({ where: { entityId, notes: { contains: seriesMarker(found.key) } }, select: { id: true } }),
  ]);
  if (sameName || sameSeries) return { error: "Already recorded" };

  let tagId: string | null = null;
  let notice: string | undefined;
  if (chosenTagId === undefined) {
    // Not asked: link the budget category only when it is clearly this payee AND nothing else already uses it (a
    // linked recurring expense overrides a Budget amount on /budgets).
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
  } else if (chosenTagId !== null) {
    // The owner chose it; several recurring expenses may share one category. Say so when a budget line or a
    // scheduled bill already uses it, because Budgets and the upcoming list then combine the records.
    tagId = chosenTagId;
    const [budget, bill] = await Promise.all([
      db.budget.findFirst({ where: { entityId, tagId: chosenTagId }, select: { id: true } }),
      db.scheduledBill.findFirst({
        where: { budgetTagId: chosenTagId, OR: [{ budgetEntityId: entityId }, { budgetEntityId: null, entityId }] },
        select: { id: true },
      }),
    ]);
    if (budget || bill) {
      notice =
        "Added and linked. That category already has a budget line or a scheduled bill, so Budgets and the upcoming list combine it with this expense; worth a look that they agree.";
    }
  }

  const data = createSchema.safeParse({
    entityId,
    name: chosenName ?? found.payee,
    // Everything below comes from the SERVER's own reading of the history, never from the request.
    amountCents: found.typicalAmount.times(100).toDecimalPlaces(0).toNumber(),
    frequency: found.cadence === "annual" ? "annually" : found.cadence,
    dueDay: found.cadence === "monthly" ? found.typicalDay : null,
    tagId,
    notes:
      "Added from a recurring pattern in your transactions." +
      (found.amountMode === "varies" ? " The amount varies; this is the typical (median) amount." : "") +
      ` ${seriesMarker(found.key)}`,
  });
  if (!data.success) return { error: "Could not build a recurring expense from this pattern." };

  await db.recurringExpense.create({ data: { ...data.data, nextDueDate: found.nextExpected } });
  revalidateAll();
  return notice ? { success: true, notice } : { success: true };
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
