"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { resolvePersonalEntityId } from "@/lib/tax-facts-store";
import { insertCloseEvent, type InsertCloseResult } from "@/lib/tax-year-close-store";
import { resolveYearCloser } from "@/lib/tax-year-close/closer";
import { MAX_CLOSE_TAX_YEAR, MIN_CLOSE_TAX_YEAR, NOTE_MAX } from "@/lib/tax-year-close/types";
import { parseFiledOn, validateCloseNote, validateReopenReason } from "@/lib/tax-year-close/validate";

// Mark a household tax year filed ("closed") and reopen it for revision. Owner-only (the owner's own account, like approving
// the return). Insert-only: each call adds one event row; nothing is updated or deleted. The note and the reopen reason are tax
// records and are NEVER written to AuditLog (the audit row holds the event id, the year, the seq and the kind only). The label
// changes no computation, form, PDF, fingerprint or approval, and no existing tax action checks it.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

export type YearCloseActionResult =
  | { ok: true; id: string; seq: number; kind: "closed" | "reopened" }
  | { ok: false; error: string; code?: "conflict" | "migration_missing" };

const yearSchema = z.number().int().min(MIN_CLOSE_TAX_YEAR).max(MAX_CLOSE_TAX_YEAR);
const closeSchema = z.object({ taxYear: yearSchema, filedOn: z.string().max(10), note: z.string().max(NOTE_MAX).nullable().optional() });
const reopenSchema = z.object({ taxYear: yearSchema, reason: z.string().max(NOTE_MAX) });

function revalidateYear(year: number): void {
  for (const p of [
    "/tax",
    `/tax/forms/${year}`,
    `/tax/personal/${year}`,
    `/tax/donations/${year}`,
    `/tax/fixed-assets/${year}`,
    "/tax/facts",
  ]) {
    revalidatePath(p);
  }
}

/** The owner check and the household entity, resolved after the input is valid and before anything is written. */
async function authorize(
  userId: string
): Promise<{ ok: true; entityId: string; author: { id: string; name: string } } | { ok: false; error: string }> {
  const [users, ekc] = await Promise.all([db.user.findMany({ select: { id: true, name: true } }), getEntityBySlug("ek-consulting")]);
  const closer = resolveYearCloser(users, ekc?.name ?? null, userId);
  if (!closer.allowed) return { ok: false, error: closer.reason ?? "Only the owner's own account can do this." };
  const me = users.find((u) => u.id === userId);
  if (!me) return { ok: false, error: "Your user record was not found." };
  const entityId = await resolvePersonalEntityId();
  if (!entityId) return { ok: false, error: "The Personal entity was not found." };
  return { ok: true, entityId, author: { id: me.id, name: me.name } };
}

/** Mark a tax year filed: the date you filed and an optional note (no confirmation numbers; they are refused). */
export async function closeTaxYear(input: z.input<typeof closeSchema>): Promise<YearCloseActionResult> {
  const user = await requireAuth();
  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  // Everything the owner typed is checked before any database call.
  const now = new Date();
  const filedOn = parseFiledOn(v.filedOn, v.taxYear, now);
  if (!filedOn.ok) return { ok: false, error: filedOn.error };
  const note = validateCloseNote(v.note);
  if (!note.ok) return { ok: false, error: note.error };

  const who = await authorize(user.id);
  if (!who.ok) return { ok: false, error: who.error };
  const res: InsertCloseResult = await insertCloseEvent(
    who.entityId,
    who.author,
    { kind: "closed", taxYear: v.taxYear, filedOn: v.filedOn.trim(), note: note.value },
    now
  );
  if (res.ok) revalidateYear(v.taxYear);
  return res;
}

/** Reopen a filed tax year for revision. A reason is required (3 to 500 characters). */
export async function reopenTaxYear(input: z.input<typeof reopenSchema>): Promise<YearCloseActionResult> {
  const user = await requireAuth();
  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const reason = validateReopenReason(v.reason);
  if (!reason.ok) return { ok: false, error: reason.error };

  const who = await authorize(user.id);
  if (!who.ok) return { ok: false, error: who.error };
  const res = await insertCloseEvent(who.entityId, who.author, { kind: "reopened", taxYear: v.taxYear, reason: reason.value }, new Date());
  if (res.ok) revalidateYear(v.taxYear);
  return res;
}
