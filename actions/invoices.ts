"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, sessionUser, todayNY, type ActionError } from "@/lib/invoicing/action-kit";
import { detailToDraftInput } from "@/lib/invoicing/draft-input";
import { MAX_SHORT } from "@/lib/invoicing/constants";
import { loadInvoiceDetail } from "@/lib/invoicing/documents-build";
import { CHANGED_IN_OTHER_TAB, InvoicingRefusal, userMessageFor } from "@/lib/invoicing/errors";
import { requireInvoicingEntity, requireInvoicingOwner } from "@/lib/invoicing/gate-build";
import * as store from "@/lib/invoicing/store";
import { cleanText, parseCalendarDate, validateDraft, type DraftInput } from "@/lib/invoicing/validate";

// Invoice drafts, issue, void, duplicate (plan task 1.7). Every export starts with `await requireAuth();` (a test pins it), then
// resolves the entity through the gate and the owner rule. EVERY export here is owner-only (fail closed; owner decision 2026-10-16:
// Eva, and any other signed-in non-owner, has read-only access to invoicing; a guard test pins the owner gate on every mutating export).
//
// Totals: the browser shows live totals from lib/invoicing/money.ts, but nothing the browser computed is trusted. Every save
// recomputes with the same module; issuing re-validates the stored draft in strict mode and refuses if the recomputed totals differ
// from the stored ones. The number is taken and the status flipped in ONE transaction (lib/invoicing/store.ts#issueInvoice).
// Issued and void documents are read-only: this file has no path that edits their lines or amounts.

async function requireAuth(): Promise<{ id: string; name: string | null }> {
  return sessionUser();
}

const slugSchema = z.string().min(1).max(60);
const line = z.object({
  description: z.string().max(1000),
  quantity: z.string().max(20),
  unit: z.string().max(40).nullish(),
  unitPrice: z.string().max(20),
  discountKind: z.string().max(10).nullish(),
  discountValue: z.string().max(20).nullish(),
  glCodeId: z.string().max(40).nullish(),
  taxable: z.boolean().optional(),
  workDate: z.string().max(10).nullish(),
  itemId: z.string().max(40).nullish(),
  unitCostCents: z.number().int().nullish(),
  markupBps: z.number().int().nullish(),
  costTransactionId: z.string().max(40).nullish(),
  receiptId: z.string().max(40).nullish(),
});
const draftSchema = z.object({
  clientId: z.string().max(40),
  billingModel: z.string().max(20).optional(),
  title: z.string().max(300).nullish(),
  poNumber: z.string().max(200).nullish(),
  issueDate: z.string().max(10).nullish(),
  netDays: z.union([z.number().int(), z.string().max(4)]).nullish(),
  notes: z.string().max(4000).nullish(),
  internalNotes: z.string().max(4000).nullish(),
  discountKind: z.string().max(10).nullish(),
  discountValue: z.string().max(20).nullish(),
  includeRemitTo: z.boolean().optional(),
  showEin: z.boolean().optional(),
  lines: z.array(line).max(300),
});
const saveSchema = z.object({
  slug: slugSchema,
  documentId: z.string().uuid().nullable(),
  expectedUpdatedAt: z.string().max(40).nullable(),
  draft: draftSchema,
});
export type SaveDraftInput = z.input<typeof saveSchema>;

function pages(slug: string, id?: string) {
  revalidatePath(`/business/${slug}/invoices`);
  if (id) revalidatePath(`/business/${slug}/invoices/${id}`);
  revalidatePath(`/business/${slug}/clients`);
}

function parseStamp(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Creates or updates an invoice DRAFT (owner only). Incomplete drafts are fine; issuing re-validates strictly. */
export async function saveDraft(input: SaveDraftInput): Promise<{ success: true; id: string; updatedAt: string } | ActionError> {
  const user = await requireAuth();
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { error: "Some of the invoice details are invalid." };
  const { slug, documentId, expectedUpdatedAt, draft } = parsed.data;
  try {
    const { entity, profile } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    const goLive = parseCalendarDate(profile.goLiveOn);
    if (!goLive) return { error: "The invoicing start date is missing. Open settings." };
    const checked = validateDraft(draft as DraftInput, { today: todayNY(), goLiveOn: goLive, forIssue: false });
    if (!checked.ok) return { error: checked.error };
    const stamp = parseStamp(expectedUpdatedAt);
    if (documentId !== null && !stamp) return { error: CHANGED_IN_OTHER_TAB };
    const saved = await store.saveDraft({ entityId: entity.id, userId: user.id, documentId, expectedUpdatedAt: stamp, draft: checked.value });
    await audit(user.id, documentId ? "invoicing_draft_edit" : "invoicing_draft_create", { entityId: entity.id, documentId: saved.id, lineCount: checked.value.lines.length });
    pages(slug, saved.id);
    return { success: true, id: saved.id, updatedAt: saved.updatedAt.toISOString() };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const issueSchema = z.object({ slug: slugSchema, documentId: z.string().uuid(), expectedUpdatedAt: z.string().max(40) });

/**
 * Issues a draft (owner only): re-validates it strictly from what is STORED, checks the stored totals still equal the recomputed ones,
 * then takes the next number and flips the status in one transaction. Two tabs issuing the same draft: one wins, the other is told
 * it changed. Issuing needs the setup to be complete (account map and business address).
 */
export async function issueInvoice(input: z.input<typeof issueSchema>): Promise<{ success: true; displayNumber: string } | ActionError> {
  const user = await requireAuth();
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const { slug, documentId, expectedUpdatedAt } = parsed.data;
  try {
    const { entity, profile } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    if (!profile.setupComplete) return { error: `Invoices cannot be issued yet: ${profile.setupMissing.join(" and ")} ${profile.setupMissing.length === 1 ? "is" : "are"} not set. Open settings.` };
    const goLive = parseCalendarDate(profile.goLiveOn);
    const stamp = parseStamp(expectedUpdatedAt);
    if (!goLive || !stamp) return { error: CHANGED_IN_OTHER_TAB };
    const today = todayNY();
    const detail = await loadInvoiceDetail(entity.id, documentId, today);
    if (!detail || detail.status !== "draft") return { error: CHANGED_IN_OTHER_TAB };
    if (detail.updatedAt !== stamp.toISOString()) return { error: CHANGED_IN_OTHER_TAB };
    const checked = validateDraft(detailToDraftInput(detail), { today, goLiveOn: goLive, forIssue: true });
    if (!checked.ok) return { error: checked.error };
    if (checked.value.totals.totalCents !== detail.totalCents || checked.value.totals.subtotalCents !== detail.subtotalCents || checked.value.totals.discountCents !== detail.discountCents) {
      return { error: "The saved totals do not match the recalculated totals. Open the draft, save it again and retry." };
    }
    const issueDate = checked.value.issueDate;
    if (!issueDate) return { error: "Choose an issue date." };
    const glCodeIds = checked.value.lines.map((l) => l.glCodeId).filter((x): x is string => x !== null);
    const issued = await store.issueInvoice({
      entityId: entity.id,
      userId: user.id,
      documentId,
      expectedUpdatedAt: stamp,
      issueDate,
      netDays: checked.value.netDays ?? profile.defaultNetDays,
      glCodeIds,
    });
    await audit(user.id, "invoicing_invoice_issue", { entityId: entity.id, documentId, number: issued.number, totalCents: detail.totalCents });
    pages(slug, documentId);
    return { success: true, displayNumber: issued.displayNumber };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const voidSchema = z.object({ slug: slugSchema, documentId: z.string().uuid(), reason: z.string().max(400) });

/**
 * Voids an issued invoice (owner only). Allowed only when no payment is applied to it. The row and its number are kept
 * (numbers are never reused); the derived books reverse it on the void date.
 */
export async function voidInvoice(input: z.input<typeof voidSchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const { slug, documentId } = parsed.data;
  try {
    const { entity } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    const reason = cleanText(parsed.data.reason, { label: "Reason", max: MAX_SHORT, required: true, noAccountNumbers: true });
    if (!reason.ok) return { error: reason.error };
    await store.voidInvoice({ entityId: entity.id, userId: user.id, documentId, reason: reason.value ?? "" });
    await audit(user.id, "invoicing_invoice_void", { entityId: entity.id, documentId });
    pages(slug, documentId);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const archiveSchema = z.object({ slug: slugSchema, documentId: z.string().uuid(), expectedUpdatedAt: z.string().max(40) });

/** Archives a DRAFT (owner only; it is hidden; it was never numbered). Issued invoices are voided, never archived. */
export async function archiveDraft(input: z.input<typeof archiveSchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = archiveSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const { slug, documentId } = parsed.data;
  try {
    const { entity } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    const stamp = parseStamp(parsed.data.expectedUpdatedAt);
    if (!stamp) return { error: CHANGED_IN_OTHER_TAB };
    await store.archiveDraft({ entityId: entity.id, userId: user.id, documentId, expectedUpdatedAt: stamp });
    await audit(user.id, "invoicing_draft_archive", { entityId: entity.id, documentId });
    pages(slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const duplicateSchema = z.object({ slug: slugSchema, documentId: z.string().uuid() });

/** Copies an invoice's client, lines and notes into a NEW draft (owner only; no number, no dates, no payments). */
export async function duplicateInvoice(input: z.input<typeof duplicateSchema>): Promise<{ success: true; id: string } | ActionError> {
  const user = await requireAuth();
  const parsed = duplicateSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const { slug, documentId } = parsed.data;
  try {
    const { entity, profile } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    const today = todayNY();
    const goLive = parseCalendarDate(profile.goLiveOn);
    if (!goLive) return { error: "The invoicing start date is missing. Open settings." };
    const detail = await loadInvoiceDetail(entity.id, documentId, today);
    if (!detail) throw new InvoicingRefusal("That invoice was not found.");
    const checked = validateDraft(detailToDraftInput(detail, { forDuplicate: true }), { today, goLiveOn: goLive, forIssue: false });
    if (!checked.ok) return { error: checked.error };
    const saved = await store.saveDraft({ entityId: entity.id, userId: user.id, documentId: null, expectedUpdatedAt: null, draft: checked.value });
    await audit(user.id, "invoicing_invoice_duplicate", { entityId: entity.id, documentId: saved.id, sourceId: documentId });
    pages(slug, saved.id);
    return { success: true, id: saved.id };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}
