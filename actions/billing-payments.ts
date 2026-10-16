"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, sessionUser, todayNY, type ActionError } from "@/lib/invoicing/action-kit";
import { MAX_SHORT } from "@/lib/invoicing/constants";
import { userMessageFor } from "@/lib/invoicing/errors";
import { requireInvoicingEntity, requireInvoicingOwner } from "@/lib/invoicing/gate-build";
import { loadClient } from "@/lib/invoicing/clients-build";
import { loadDepositCandidates, loadPayment, type DepositCandidateView } from "@/lib/invoicing/payments-build";
import * as store from "@/lib/invoicing/store";
import { cleanText, parseCalendarDate, validatePayment } from "@/lib/invoicing/validate";
import { parseDollarsToCents } from "@/lib/money-input";

// Payments (plan task 1.9). Every export starts with `await requireAuth();` (a test pins it). Recording, voiding, applying and linking
// deposits are OWNER-ONLY (fail closed through the owner rule). A payment is a client remittance: it may cover several invoices, a
// part of one, or none (the rest stays unapplied = a deposit on account). It never writes the bank Transaction: a deposit is LINKED to the
// payment it settles (BillingPayment.depositTransactionId), so the deposit keeps its revenue coding in the ledger P&L and the accrual
// view does not count it twice (plan D2). AuditLog rows carry ids, counts and cents only; no reference, note or reason text.

async function requireAuth(): Promise<{ id: string; name: string | null }> {
  return sessionUser();
}

const slugSchema = z.string().min(1).max(60);

function pages(slug: string, clientId?: string) {
  revalidatePath(`/business/${slug}/invoices`);
  if (clientId) revalidatePath(`/business/${slug}/clients/${clientId}`);
}

const recordSchema = z.object({
  slug: slugSchema,
  clientId: z.string().max(40),
  method: z.string().max(20),
  receivedOn: z.string().max(10),
  amount: z.string().max(20),
  fee: z.string().max(20).nullish(),
  reference: z.string().max(200).nullish(),
  notes: z.string().max(4000).nullish(),
  depositTransactionId: z.string().max(40).nullish(),
  requestKey: z.string().max(40),
  allocations: z.array(z.object({ invoiceId: z.string().max(40), amount: z.string().max(20) })).max(200),
});
export type RecordPaymentInput = z.input<typeof recordSchema>;

/**
 * Records a payment with its applications to invoices and an optional bank deposit link, in one transaction. `requestKey` is minted
 * when the form opens, so a double click records ONE payment (the second call returns the first, marked duplicate). Over-applying an
 * invoice, applying more than the payment, and over-linking a shared deposit are refused.
 */
export async function recordPayment(input: RecordPaymentInput): Promise<{ success: true; id: string; duplicate: boolean } | ActionError> {
  const user = await requireAuth();
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) return { error: "Some of the payment details are invalid." };
  try {
    const { entity, profile } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const goLive = parseCalendarDate(profile.goLiveOn);
    if (!goLive) return { error: "The invoicing start date is missing. Open settings." };
    const checked = validatePayment(
      { ...parsed.data, fee: parsed.data.fee ?? null, reference: parsed.data.reference ?? null, notes: parsed.data.notes ?? null, depositTransactionId: parsed.data.depositTransactionId ?? null },
      { today: todayNY(), goLiveOn: goLive }
    );
    if (!checked.ok) return { error: checked.error };
    const r = await store.recordPayment({ entityId: entity.id, userId: user.id, payment: checked.value });
    if (!r.duplicate) {
      await audit(user.id, "invoicing_payment_record", {
        entityId: entity.id,
        paymentId: r.id,
        amountCents: checked.value.amountCents,
        feeCents: checked.value.feeCents,
        allocationCount: checked.value.allocations.length,
        hasDeposit: checked.value.depositTransactionId !== null,
      });
    }
    pages(parsed.data.slug, parsed.data.clientId);
    return { success: true, id: r.id, duplicate: r.duplicate };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const voidSchema = z.object({ slug: slugSchema, paymentId: z.string().uuid(), reason: z.string().max(400) });

/** Voids a payment (owner only). Its applications to invoices must be removed first. The row is kept. */
export async function voidPayment(input: z.input<typeof voidSchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const reason = cleanText(parsed.data.reason, { label: "Reason", max: MAX_SHORT, required: true, noAccountNumbers: true });
    if (!reason.ok) return { error: reason.error };
    const before = await loadPayment(entity.id, parsed.data.paymentId);
    await store.voidPayment({ entityId: entity.id, userId: user.id, paymentId: parsed.data.paymentId, reason: reason.value ?? "" });
    await audit(user.id, "invoicing_payment_void", { entityId: entity.id, paymentId: parsed.data.paymentId });
    pages(parsed.data.slug, before?.clientId);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const removeSchema = z.object({ slug: slugSchema, allocationId: z.string().uuid() });

/** Removes one application of a payment from an invoice (owner only). The application is voided, never deleted. */
export async function removeApplication(input: z.input<typeof removeSchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.deallocate({ entityId: entity.id, userId: user.id, allocationId: parsed.data.allocationId });
    await audit(user.id, "invoicing_payment_unapply", { entityId: entity.id, allocationId: parsed.data.allocationId });
    pages(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const applySchema = z.object({ slug: slugSchema, paymentId: z.string().uuid(), invoiceId: z.string().uuid(), amount: z.string().max(20) });

/** Applies what is left of an existing payment to an invoice of the same client (owner only). */
export async function applyPaymentToInvoice(input: z.input<typeof applySchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const cents = parseDollarsToCents(parsed.data.amount);
    if (!cents.ok) return { error: `Amount: ${cents.error}` };
    await store.allocateExisting({ entityId: entity.id, userId: user.id, paymentId: parsed.data.paymentId, invoiceId: parsed.data.invoiceId, amountCents: cents.cents, today: todayNY() });
    await audit(user.id, "invoicing_payment_apply", { entityId: entity.id, paymentId: parsed.data.paymentId, invoiceId: parsed.data.invoiceId, amountCents: cents.cents });
    pages(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const linkSchema = z.object({ slug: slugSchema, paymentId: z.string().uuid(), depositTransactionId: z.string().uuid() });

/** Links a bank deposit to a payment (owner only). The deposit itself is never changed. */
export async function linkDeposit(input: z.input<typeof linkSchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.linkDeposit({ entityId: entity.id, userId: user.id, paymentId: parsed.data.paymentId, depositTransactionId: parsed.data.depositTransactionId });
    await audit(user.id, "invoicing_deposit_link", { entityId: entity.id, paymentId: parsed.data.paymentId, transactionId: parsed.data.depositTransactionId });
    pages(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const unlinkSchema = z.object({ slug: slugSchema, paymentId: z.string().uuid() });

export async function unlinkDeposit(input: z.input<typeof unlinkSchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = unlinkSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.unlinkDeposit({ entityId: entity.id, userId: user.id, paymentId: parsed.data.paymentId });
    await audit(user.id, "invoicing_deposit_unlink", { entityId: entity.id, paymentId: parsed.data.paymentId });
    pages(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const searchSchema = z.object({
  slug: slugSchema,
  paymentId: z.string().uuid().nullable(),
  clientId: z.string().uuid(),
  amount: z.string().max(20),
  fee: z.string().max(20).nullish(),
  receivedOn: z.string().max(10),
});

/**
 * Suggests bank deposits that could settle a payment (a read; client-reachable, so it has its own requireAuth). OWNER ONLY like the
 * payment form it serves (fail closed). Works for an already-archived client's open invoice (a payment on it is still accepted).
 * Best match first; nothing is linked until the owner confirms.
 */
export async function searchDepositCandidates(input: z.input<typeof searchSchema>): Promise<{ success: true; candidates: DepositCandidateView[] } | ActionError> {
  const user = await requireAuth();
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter the amount and received date first." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const amount = parseDollarsToCents(parsed.data.amount);
    if (!amount.ok) return { error: "Enter the amount and received date first." };
    const fee = parsed.data.fee && parsed.data.fee.trim() !== "" ? parseDollarsToCents(parsed.data.fee, { allowZero: true }) : { ok: true as const, cents: 0 };
    if (!fee.ok) return { error: "The fee is not a valid amount." };
    const receivedOn = parseCalendarDate(parsed.data.receivedOn);
    if (!receivedOn) return { error: "Enter the amount and received date first." };
    const client = await loadClient(entity.id, parsed.data.clientId, { includeArchived: true });
    if (!client) return { error: "That client was not found." };
    const candidates = await loadDepositCandidates(entity.id, { amountCents: amount.cents, feeCents: fee.cents, receivedOn, clientName: client.name, paymentId: parsed.data.paymentId });
    return { success: true, candidates };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}
