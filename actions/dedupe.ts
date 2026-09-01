"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { runDuplicateDetectionEngine } from "@/lib/dedupe-runner";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

// ── Run duplicate detection across all accounts ───────────────────────────────

export async function runDuplicateDetection(
  detectedBy: "cron" | "manual" = "manual"
): Promise<{ archived: number; groups: number } | { error: string }> {
  await requireAuth();
  const result = await runDuplicateDetectionEngine(detectedBy);
  if (result.archived > 0) {
    revalidatePath("/transactions");
    revalidatePath("/settings/duplicate-log");
  }
  return result;
}

// ── List the action log ───────────────────────────────────────────────────────

export async function listDedupActions() {
  await requireAuth();
  const [actions, undone] = await Promise.all([
    db.dedupAction.findMany({
      where: { undoneAt: null },
      orderBy: { createdAt: "desc" },
    }),
    db.dedupAction.count({ where: { undoneAt: { not: null } } }),
  ]);
  return { actions, undoneCount: undone };
}

// ── Undo a single removal ──────────────────────────────────────────────────────

export async function undoDedupAction(
  actionId: string
): Promise<{ success: true } | { error: string }> {
  const user = await requireAuth();

  const action = await db.dedupAction.findUnique({ where: { id: actionId } });
  if (!action || action.undoneAt) return { error: "Log entry not found or already undone" };

  const result = await db.$transaction([
    // Restore the archived duplicate
    db.transaction.update({
      where: { id: action.duplicateTxId },
      data: { archivedAt: null },
    }),
    // Mark the log entry undone (kept for history; the protected-ids logic
    // above reads undoneAt to prevent re-archival)
    db.dedupAction.update({
      where: { id: actionId },
      data: { undoneAt: new Date(), undoneById: user.id },
    }),
  ]);

  if (!result[0]) return { error: "Original transaction no longer exists" };

  revalidatePath("/transactions");
  revalidatePath("/settings/duplicate-log");
  return { success: true };
}

// ── Undo every active removal ──────────────────────────────────────────────────

export async function undoAllDedupActions(): Promise<{ success: true; count: number }> {
  const user = await requireAuth();

  const active = await db.dedupAction.findMany({ where: { undoneAt: null } });
  let count = 0;
  for (const action of active) {
    await db.$transaction([
      db.transaction.update({
        where: { id: action.duplicateTxId },
        data: { archivedAt: null },
      }),
      db.dedupAction.update({
        where: { id: action.id },
        data: { undoneAt: new Date(), undoneById: user.id },
      }),
    ]);
    count++;
  }

  revalidatePath("/transactions");
  revalidatePath("/settings/duplicate-log");
  return { success: true, count };
}