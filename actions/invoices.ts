"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, sessionUser, todayNY, type ActionError } from "@/lib/invoicing/action-kit";
import { detailToDraftInput } from "@/lib/invoicing/draft-input";
import { loadClient } from "@/lib/invoicing/clients-build";
import { buildInvoiceEmail, emailPreflight, invoiceRecipients, isSendableAddress, SEND_FAILURE_MESSAGES, type SendFailureCategory } from "@/lib/invoicing/email";
import { formatCents } from "@/lib/invoicing/money";
import { loadInvoicePdfSource } from "@/lib/invoicing/pdf-build";
import { renderInvoicePdf } from "@/lib/invoicing/pdf/render";
import { sendEmail } from "@/lib/resend";
import { MAX_LIVE_LINKS_PER_INVOICE, MAX_SHORT } from "@/lib/invoicing/constants";
import { loadInvoiceDetail } from "@/lib/invoicing/documents-build";
import { CHANGED_IN_OTHER_TAB, InvoicingRefusal, userMessageFor } from "@/lib/invoicing/errors";
import { requireInvoicingEntity, requireInvoicingOwner } from "@/lib/invoicing/gate-build";
import * as store from "@/lib/invoicing/store";
import { invoiceLinkUrl, mintInvoiceToken, tokenExpiry } from "@/lib/invoicing/access-token";
import { loadPaySettings, type PaySettings } from "@/lib/invoicing/pay-build";
import { payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";
import { payEnvironment } from "@/lib/invoicing/stripe/pay-env";
import { cleanText, parseCalendarDate, validateDraft, type DraftInput } from "@/lib/invoicing/validate";

// Invoice drafts, issue, void, duplicate (plan task 1.7) and e-mail delivery (task 1.10: an invoice is e-mailed ONLY when the owner
// clicks Send / Resend or "Save as final and send"; nothing sends on issue, on a schedule or from a cron). Every export starts with `await requireAuth();` (a test pins it), then
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

const sendSchema = z.object({ slug: slugSchema, documentId: z.string().uuid(), requestKey: z.string().uuid() });

/** Whether the e-mail carried the client's view-and-pay link (Phase 2). */
type PayLinkOutcome = "included" | "omitted_not_configured" | "not_applicable";

/**
 * E-mails an ISSUED invoice, with its PDF attached, to the client's contacts ticked "Receives invoices" (owner only; only ever on an
 * explicit click), from the invoice sender INVOICE_EMAIL_FROM (never the app's EMAIL_FROM). Fails closed before any provider call when
 * that sender is unset, malformed or on resend.dev, or the
 * client has no recipient. `requestKey` is fresh per click and becomes the provider's idempotency key, so a double-submitted click
 * sends once. On delivery: `sentAt` (first send), `lastSentAt`, `sendCount` and an "emailed" timeline row (count only, never an
 * address). A provider failure leaves the invoice as it was and adds an "email_failed" row. Addresses and provider messages are never
 * logged; errors are logged by name only.
 */
export async function sendInvoice(
  input: z.input<typeof sendSchema>
): Promise<{ success: true; recipientCount: number; sendCount: number; payLink: PayLinkOutcome } | (ActionError & { sendFailure?: SendFailureCategory })> {
  const user = await requireAuth();
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  const { slug, documentId, requestKey } = parsed.data;
  try {
    const { entity, profile } = await requireInvoicingEntity(slug);
    await requireInvoicingOwner(user.id, entity.name);
    const detail = await loadInvoiceDetail(entity.id, documentId, todayNY());
    if (!detail) throw new InvoicingRefusal("That invoice was not found.");
    if (detail.status !== "issued") return { error: detail.status === "void" ? "A voided invoice cannot be e-mailed." : "Only a final (issued) invoice can be e-mailed. Save it as final first." };
    const client = await loadClient(entity.id, detail.clientId, { includeArchived: true });
    const to = client ? invoiceRecipients(client.contacts) : [];
    if (to.length === 0) return { error: SEND_FAILURE_MESSAGES.no_recipients, sendFailure: "no_recipients" };
    const preflight = emailPreflight(process.env);
    if (!preflight.ok) return { error: SEND_FAILURE_MESSAGES.not_configured, sendFailure: "not_configured" };

    const source = await loadInvoicePdfSource(documentId);
    if (source.status !== "ok" || source.entityId !== entity.id) throw new InvoicingRefusal("That invoice was not found.");

    // Phase 2 (plan P1 / P4): the client's view-and-pay link. When online payments apply, ONE new link is minted for THIS send (its
    // mintKey is the send's requestKey, so a double-submitted click is refused here, before the provider is called, and two different
    // links can never go out under one provider idempotency key). A configuration gap omits the link, never the e-mail.
    let payLink: PayLinkOutcome = "not_applicable";
    let payUrl: string | null = null;
    let tokenId: string | null = null;
    let settings: PaySettings;
    try {
      settings = await loadPaySettings(entity.id);
    } catch (err) {
      console.error("Online-payment settings could not be read", err instanceof Error ? err.name : "UnknownError");
      settings = { status: "not_set_up" };
    }
    if (settings.status === "ok" && settings.stripePayEnabled) {
      const env = payEnvironment(process.env);
      const eligible = payOnlineEligibility({ enabled: true, configured: env.configured, baseUrl: env.baseUrl, status: detail.status, balanceCents: detail.balanceCents });
      if (eligible.ok && env.baseUrl) {
        const now = new Date();
        const { token, tokenHash } = mintInvoiceToken();
        const minted = await store.mintAccessToken({
          entityId: entity.id,
          documentId,
          tokenHash,
          mintKey: `send:${documentId}:${requestKey}`,
          purpose: "email",
          expiresAt: tokenExpiry(now, settings.publicTokenTtlDays),
          createdById: user.id,
          now,
          maxLive: MAX_LIVE_LINKS_PER_INVOICE,
        });
        tokenId = minted.tokenId;
        payUrl = invoiceLinkUrl(env.baseUrl, token);
        payLink = "included";
      } else if (!eligible.ok && (eligible.reason === "not_configured" || eligible.reason === "no_base_url")) {
        payLink = "omitted_not_configured";
      }
    }
    /** A minted link that did not go out is revoked (best effort, logged by name only). */
    const revokeUnsent = async () => {
      if (!tokenId) return;
      try {
        await store.revokeAccessTokenById({ entityId: entity.id, tokenId, userId: user.id, now: new Date() });
      } catch (revErr) {
        console.error("Unsent client link could not be revoked", revErr instanceof Error ? revErr.name : "UnknownError");
      }
    };

    let rendered: Awaited<ReturnType<typeof renderInvoicePdf>>;
    try {
      rendered = await renderInvoicePdf(payUrl ? { ...source.input, payOnline: { url: payUrl } } : source.input, { logo: source.logo });
    } catch (err) {
      await revokeUnsent();
      throw err;
    }
    const pdf = source.input;
    const email = buildInvoiceEmail({
      displayNumber: pdf.displayNumber ?? "",
      businessName: pdf.business.dbaName?.trim() || pdf.business.name,
      totalText: formatCents(pdf.totalCents),
      balanceText: formatCents(pdf.balanceCents),
      dueText: pdf.dueText,
      footerText: pdf.footerText,
      payUrl,
    });
    const replyTo = profile.replyToEmail && isSendableAddress(profile.replyToEmail.trim()) ? profile.replyToEmail.trim() : undefined;
    try {
      await sendEmail({
        from: preflight.from,
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        replyTo,
        attachments: [{ filename: source.filename, content: Buffer.from(rendered.bytes) }],
        idempotencyKey: `invoice-send/${documentId}/${requestKey}`,
      });
    } catch (err) {
      console.error("Invoice e-mail failed", err instanceof Error ? err.name : "UnknownError");
      await revokeUnsent();
      try {
        await store.recordSendFailure({ entityId: entity.id, userId: user.id, documentId, category: "provider_error" });
      } catch (logErr) {
        console.error("Invoice e-mail failure row failed", logErr instanceof Error ? logErr.name : "UnknownError");
      }
      pages(slug, documentId);
      return { error: SEND_FAILURE_MESSAGES.provider_error, sendFailure: "provider_error" };
    }
    let sendCount: number;
    try {
      ({ sendCount } = await store.markInvoiceSent({ entityId: entity.id, userId: user.id, documentId, recipientCount: to.length, at: new Date(), payLink: payLink === "included" }));
    } catch (err) {
      console.error("Invoice sent, but recording it failed", err instanceof Error ? err.name : "UnknownError");
      return { error: "The invoice was e-mailed, but recording the send failed. Reload the page before sending again." };
    }
    await audit(user.id, "invoicing_invoice_email", { entityId: entity.id, documentId, recipientCount: to.length, sendNumber: sendCount, payLink: payLink === "included" });
    pages(slug, documentId);
    return { success: true, recipientCount: to.length, sendCount, payLink };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

const flagSchema = z.object({ slug: slugSchema, flagEventId: z.string().uuid() });

/**
 * Marks an online-payment flag (overpayment, a payment on a closed invoice, a failed bank payment, a refund or a dispute) as reviewed
 * (owner only). Nothing is reversed or changed: the flag only stops being listed as open. Repeating it changes nothing.
 */
export async function markStripeFlagReviewed(input: z.input<typeof flagSchema>): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = flagSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.markStripeFlagReviewed({ entityId: entity.id, userId: user.id, flagEventId: parsed.data.flagEventId });
    await audit(user.id, "invoicing_stripe_flag_review", { entityId: entity.id, flagEventId: parsed.data.flagEventId });
    pages(parsed.data.slug);
    revalidatePath(`/business/${parsed.data.slug}/invoicing/payments-online`);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}
