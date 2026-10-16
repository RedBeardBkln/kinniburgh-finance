// The ONLY writer of the invoicing tables (plan section 8.1; a guard test pins it). Server only. No auth here: the actions
// (actions/invoicing-setup.ts, clients.ts, reimbursable-items.ts, invoices.ts, billing-payments.ts) have already run
// `requireAuth()`, the entity gate and (for owner-only operations) the owner rule.
//
// Rules this file keeps:
//  - archive-only: nothing is deleted or upserted. The ONE exception is `replaceDraftLines`, which deletes the lines of a DRAFT
//    document (a draft is not a financial record) after asserting, in the same transaction, that the document is still a draft.
//  - BillingEvent is append-only (only `appendEvent` creates; there is no update or delete path), and its payload passes
//    `assertSafeEventData` (ids, counts and cents only).
//  - numbers are allocated AT ISSUE inside the same transaction as the status flip, under the profile row lock, so a failed
//    issue burns nothing and two tabs issuing the same draft cannot both win.
//  - allocation writes take SELECT ... FOR UPDATE on the invoice and payment rows, recompute the sums, then insert.
//  - every query carries entityId; a row of another entity is "not found".
//  - a bank Transaction is only ever READ (and locked FOR UPDATE while a deposit is linked), never written.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decimalToCents } from "@/lib/invoicing/cents";
import { depositCapacityOk } from "@/lib/invoicing/deposit-match";
import { InvoicingRefusal, CHANGED_IN_OTHER_TAB, isUniqueViolation } from "@/lib/invoicing/errors";
import { assertSafeEventData, type EventKind } from "@/lib/invoicing/events";
import type { GlMap } from "@/lib/invoicing/gl-map";
import { canVoidInvoice, canVoidPayment } from "@/lib/invoicing/state";
import { canChangeCounter, formatDisplayNumber } from "@/lib/invoicing/numbering";
import { dueDateFor, type ValidatedDraft, type ValidatedPayment } from "@/lib/invoicing/validate";
import type { ValidatedItem } from "@/lib/invoicing/items";

export const TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
type Tx = Prisma.TransactionClient;

// ── Timeline ──────────────────────────────────────────────────────────────────────

export interface EventArgs {
  entityId: string;
  kind: EventKind;
  actorId: string | null;
  documentId?: string | null;
  paymentId?: string | null;
  clientId?: string | null;
  eventKey?: string | null;
  data?: Record<string, unknown>;
}

/** Appends one timeline row. Append-only: this is the only function that creates a BillingEvent. */
async function appendEvent(client: Tx, e: EventArgs): Promise<void> {
  await client.billingEvent.create({
    data: {
      entityId: e.entityId,
      kind: e.kind,
      actorId: e.actorId,
      documentId: e.documentId ?? null,
      paymentId: e.paymentId ?? null,
      clientId: e.clientId ?? null,
      eventKey: e.eventKey ?? null,
      data: assertSafeEventData(e.data ?? {}) as Prisma.InputJsonValue,
    },
  });
}

// ── Profile ───────────────────────────────────────────────────────────────────────

export interface ProfileSetup {
  goLiveOn: Date;
  invoicePrefix: string;
  nextInvoiceNumber: number;
  quotePrefix: string;
  nextQuoteNumber: number;
  numberPad: number;
  defaultNetDays: number;
  termsLabel: string;
  glMap: GlMap;
  businessAddress: string | null;
  replyToEmail: string | null;
  fromName: string | null;
  footerText: string | null;
  termsText: string | null;
  remitToMailingAddress: string | null;
  checkPayableTo: string | null;
}

export async function createProfile(entityId: string, data: ProfileSetup): Promise<void> {
  try {
    await db.invoicingProfile.create({
      data: { entityId, enabled: true, ...data, glMap: data.glMap as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new InvoicingRefusal("Invoicing is already set up for this business.");
    throw err;
  }
}

/** Editable, non-secret profile fields. The counters and go-live have their own functions. */
export interface ProfilePatch {
  invoicePrefix?: string;
  numberPad?: number;
  defaultNetDays?: number;
  termsLabel?: string;
  businessAddress?: string | null;
  replyToEmail?: string | null;
  fromName?: string | null;
  showEinOnInvoice?: boolean;
  footerText?: string | null;
  termsText?: string | null;
  remitToMailingAddress?: string | null;
  checkPayableTo?: string | null;
  includeRemitToByDefault?: boolean;
  quotePrefix?: string;
  glMap?: GlMap;
}

export async function updateProfile(entityId: string, patch: ProfilePatch): Promise<void> {
  const { glMap, ...rest } = patch;
  const res = await db.invoicingProfile.updateMany({
    where: { entityId },
    data: { ...rest, ...(glMap ? { glMap: glMap as unknown as Prisma.InputJsonValue } : {}) },
  });
  if (res.count !== 1) throw new InvoicingRefusal("Invoicing is not set up for this business.");
}

/** Raises a document counter ("invoice" or "quote"). It can only go up and never to a number already used (numbers are never reused). */
async function setCounter(entityId: string, kind: "invoice" | "quote", requested: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "InvoicingProfile" WHERE "entityId" = ${entityId} FOR UPDATE`;
    const profile = await tx.invoicingProfile.findUnique({ where: { entityId }, select: { nextInvoiceNumber: true, nextQuoteNumber: true } });
    if (!profile) throw new InvoicingRefusal("Invoicing is not set up for this business.");
    const max = await tx.billingDocument.aggregate({ where: { entityId, kind, number: { not: null } }, _max: { number: true } });
    const current = kind === "invoice" ? profile.nextInvoiceNumber : profile.nextQuoteNumber;
    const ck = canChangeCounter(current, requested, max._max.number ?? null);
    if (!ck.ok) throw new InvoicingRefusal(ck.error);
    await tx.invoicingProfile.update({ where: { entityId }, data: kind === "invoice" ? { nextInvoiceNumber: requested } : { nextQuoteNumber: requested } });
  }, TX_OPTIONS);
}

/** Raises the invoice counter. It can only go up and never to a number already used. */
export async function setInvoiceCounter(entityId: string, requested: number): Promise<void> {
  await setCounter(entityId, "invoice", requested);
}

/** Raises the quote counter (same rules; the quote workflow itself is task 1.11). */
export async function setQuoteCounter(entityId: string, requested: number): Promise<void> {
  await setCounter(entityId, "quote", requested);
}

/** Go-live can only be changed while no invoice has been issued (an issued invoice pins the books to it). */
export async function setGoLive(entityId: string, goLiveOn: Date): Promise<void> {
  await db.$transaction(async (tx) => {
    const issued = await tx.billingDocument.count({ where: { entityId, status: { not: "draft" } } });
    if (issued > 0) throw new InvoicingRefusal("The start date cannot be changed once an invoice has been issued.");
    await tx.invoicingProfile.update({ where: { entityId }, data: { goLiveOn } });
  }, TX_OPTIONS);
}

export async function setBusinessEinEncrypted(entityId: string, encrypted: string | null, last4: string | null): Promise<void> {
  await db.invoicingProfile.update({ where: { entityId }, data: { einEncrypted: encrypted, einLast4: last4 } });
}

/**
 * Stores (or clears, when null) the owner-typed bank text AND the "include by default" flag in ONE statement (one write path, so the
 * text and its flag can never disagree after a partial failure). Stamps the approval pair only when text is stored; clearing the
 * text always clears the flag.
 */
export async function setRemitBankEncrypted(entityId: string, encrypted: string | null, userId: string, includeByDefault = false): Promise<void> {
  const now = new Date();
  await db.invoicingProfile.update({
    where: { entityId },
    data:
      encrypted === null
        ? { remitToEncrypted: null, remitToUpdatedAt: null, remitToApprovedAt: null, remitToApprovedById: null, includeRemitToByDefault: false }
        : { remitToEncrypted: encrypted, remitToUpdatedAt: now, remitToApprovedAt: now, remitToApprovedById: userId, includeRemitToByDefault: includeByDefault },
  });
}

export async function setLogo(entityId: string, key: string | null, mime: string | null): Promise<void> {
  await db.invoicingProfile.update({ where: { entityId }, data: { logoKey: key, logoMime: mime } });
}

// ── Clients and contacts ──────────────────────────────────────────────────────────

export interface ClientData {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  defaultNetDays: number | null;
  defaultTaxable: boolean;
  notes: string | null;
}

export async function createClient(entityId: string, userId: string, data: ClientData): Promise<string> {
  try {
    const row = await db.client.create({ data: { entityId, createdById: userId, ...data }, select: { id: true } });
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new InvoicingRefusal("A client with that name already exists (archived clients keep their names).");
    throw err;
  }
}

export async function updateClient(entityId: string, id: string, data: ClientData): Promise<void> {
  try {
    const res = await db.client.updateMany({ where: { id, entityId, archivedAt: null }, data });
    if (res.count !== 1) throw new InvoicingRefusal("That client was not found.");
  } catch (err) {
    if (isUniqueViolation(err)) throw new InvoicingRefusal("A client with that name already exists (archived clients keep their names).");
    throw err;
  }
}

/**
 * Archives a client. Refused while any ISSUED invoice of the client still has a balance due, so an unpaid invoice never ends up with
 * a client that cannot be found (there is no restore). Void invoices, paid invoices and drafts do not block. The check and the
 * archive run in one transaction.
 */
export async function archiveClient(entityId: string, id: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const open = await tx.billingDocument.findMany({
      where: { entityId, clientId: id, kind: "invoice", status: "issued" },
      select: { totalCents: true, allocations: { where: { voidedAt: null }, select: { amountCents: true } } },
    });
    const withBalance = open.filter((i) => i.totalCents - i.allocations.reduce((s, a) => s + a.amountCents, 0) > 0).length;
    if (withBalance > 0) {
      throw new InvoicingRefusal(
        `This client has ${withBalance} issued invoice${withBalance === 1 ? "" : "s"} with a balance due. Record the payment (or void the invoice) before archiving the client.`
      );
    }
    const res = await tx.client.updateMany({ where: { id, entityId, archivedAt: null }, data: { archivedAt: new Date() } });
    if (res.count !== 1) throw new InvoicingRefusal("That client was not found.");
  }, TX_OPTIONS);
}

export async function setClientEinEncrypted(entityId: string, id: string, encrypted: string | null, last4: string | null): Promise<void> {
  const res = await db.client.updateMany({ where: { id, entityId, archivedAt: null }, data: { einEncrypted: encrypted, einLast4: last4 } });
  if (res.count !== 1) throw new InvoicingRefusal("That client was not found.");
}

/** Links (or unlinks, with null) the W-9 Document. The document must be a live w9 document of this entity. */
export async function setClientW9(entityId: string, clientId: string, documentId: string | null, receivedOn: Date | null): Promise<void> {
  await db.$transaction(async (tx) => {
    if (documentId) {
      const doc = await tx.document.findFirst({ where: { id: documentId, entityId, docType: "w9", archivedAt: null }, select: { id: true } });
      if (!doc) throw new InvoicingRefusal("That W-9 document was not found for this business.");
    }
    const res = await tx.client.updateMany({
      where: { id: clientId, entityId, archivedAt: null },
      data: { w9DocumentId: documentId, w9ReceivedOn: documentId ? receivedOn : null },
    });
    if (res.count !== 1) throw new InvoicingRefusal("That client was not found.");
  }, TX_OPTIONS);
}

export interface ContactData {
  name: string;
  email: string;
  phone: string | null;
  role: string;
  roleLabel: string | null;
  receivesInvoices: boolean;
}

async function assertClient(tx: Tx, entityId: string, clientId: string, opts: { allowArchived?: boolean } = {}): Promise<void> {
  const c = await tx.client.findFirst({ where: { id: clientId, entityId, ...(opts.allowArchived ? {} : { archivedAt: null }) }, select: { id: true } });
  if (!c) throw new InvoicingRefusal("That client was not found.");
}

export async function addContact(entityId: string, clientId: string, data: ContactData): Promise<string> {
  return db.$transaction(async (tx) => {
    await assertClient(tx, entityId, clientId);
    const row = await tx.clientContact.create({ data: { clientId, ...data }, select: { id: true } });
    return row.id;
  }, TX_OPTIONS);
}

export async function updateContact(entityId: string, contactId: string, data: ContactData): Promise<void> {
  const res = await db.clientContact.updateMany({ where: { id: contactId, archivedAt: null, client: { entityId } }, data });
  if (res.count !== 1) throw new InvoicingRefusal("That contact was not found.");
}

export async function archiveContact(entityId: string, contactId: string): Promise<void> {
  const res = await db.clientContact.updateMany({ where: { id: contactId, archivedAt: null, client: { entityId } }, data: { archivedAt: new Date(), receivesInvoices: false } });
  if (res.count !== 1) throw new InvoicingRefusal("That contact was not found.");
}

// ── Reimbursable items ────────────────────────────────────────────────────────────

/**
 * Every account an invoice line or catalog item points at must be a live REVENUE account of this entity (GlCode.type is "revenue",
 * never "income"). The editor's dropdown already hides the others; this is the server-side rule, so a hand-built request cannot
 * post revenue credits to an expense or asset account (where accrual P&L, which sums only revenue accounts, would drop the line).
 */
async function assertGlIds(tx: Tx, entityId: string, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const found = await tx.glCode.count({ where: { id: { in: unique }, entityId, archivedAt: null, type: "revenue" } });
  if (found !== unique.length) throw new InvoicingRefusal("One of the chosen income accounts was not found, is archived or is not a revenue account.");
}

export async function createItem(entityId: string, userId: string, data: ValidatedItem): Promise<string> {
  try {
    return await db.$transaction(async (tx) => {
      await assertGlIds(tx, entityId, [data.glCodeId]);
      const row = await tx.reimbursableItem.create({ data: { entityId, createdById: userId, ...data }, select: { id: true } });
      return row.id;
    }, TX_OPTIONS);
  } catch (err) {
    if (isUniqueViolation(err)) throw new InvoicingRefusal("An item with that name already exists (archived items keep their names).");
    throw err;
  }
}

export async function updateItem(entityId: string, id: string, data: ValidatedItem): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await assertGlIds(tx, entityId, [data.glCodeId]);
      const res = await tx.reimbursableItem.updateMany({ where: { id, entityId, archivedAt: null }, data });
      if (res.count !== 1) throw new InvoicingRefusal("That item was not found.");
    }, TX_OPTIONS);
  } catch (err) {
    if (isUniqueViolation(err)) throw new InvoicingRefusal("An item with that name already exists (archived items keep their names).");
    throw err;
  }
}

export async function archiveItem(entityId: string, id: string): Promise<void> {
  const res = await db.reimbursableItem.updateMany({ where: { id, entityId, archivedAt: null }, data: { archivedAt: new Date() } });
  if (res.count !== 1) throw new InvoicingRefusal("That item was not found.");
}

// ── Invoice drafts ────────────────────────────────────────────────────────────────

/**
 * Replaces the lines of a DRAFT document. THE one place rows are deleted in this feature: drafts are not financial records, and
 * issued / void documents have no update path. It first asserts, in the same transaction, that the document is still a draft.
 */
async function replaceDraftLines(tx: Tx, entityId: string, documentId: string, lines: ValidatedDraft["lines"]): Promise<void> {
  const draft = await tx.billingDocument.findFirst({ where: { id: documentId, entityId, status: "draft", archivedAt: null }, select: { id: true } });
  if (!draft) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
  await tx.billingLine.deleteMany({ where: { documentId } });
  if (lines.length > 0) {
    await tx.billingLine.createMany({
      data: lines.map((l) => ({
        documentId,
        sortOrder: l.sortOrder,
        description: l.description,
        quantity: new Prisma.Decimal(l.quantityMilli).div(1000).toFixed(3),
        unit: l.unit,
        unitPriceCents: l.unitPriceCents,
        discountKind: l.discount?.kind ?? null,
        discountValue: l.discount?.value ?? null,
        lineTotalCents: l.lineTotalCents,
        glCodeId: l.glCodeId,
        taxable: l.taxable,
        workDate: l.workDate,
        itemId: l.itemId,
        unitCostCents: l.unitCostCents,
        markupBps: l.markupBps,
        costTransactionId: l.costTransactionId,
        receiptId: l.receiptId,
      })),
    });
  }
}

/** Checks every row a draft points at belongs to this entity and is live; returns the client's own payment-terms default. */
async function assertDraftReferences(tx: Tx, entityId: string, draft: ValidatedDraft): Promise<{ clientDefaultNetDays: number | null }> {
  const client = await tx.client.findFirst({ where: { id: draft.clientId, entityId, archivedAt: null }, select: { id: true, defaultNetDays: true } });
  if (!client) throw new InvoicingRefusal("That client was not found or is archived.");
  await assertGlIds(tx, entityId, draft.lines.map((l) => l.glCodeId).filter((x): x is string => x !== null));
  const itemIds = [...new Set(draft.lines.map((l) => l.itemId).filter((x): x is string => x !== null))];
  if (itemIds.length > 0 && (await tx.reimbursableItem.count({ where: { id: { in: itemIds }, entityId } })) !== itemIds.length) {
    throw new InvoicingRefusal("One of the catalog items was not found.");
  }
  const txIds = [...new Set(draft.lines.map((l) => l.costTransactionId).filter((x): x is string => x !== null))];
  if (txIds.length > 0 && (await tx.transaction.count({ where: { id: { in: txIds }, entityId, archivedAt: null } })) !== txIds.length) {
    throw new InvoicingRefusal("One of the linked cost transactions was not found.");
  }
  const receiptIds = [...new Set(draft.lines.map((l) => l.receiptId).filter((x): x is string => x !== null))];
  if (receiptIds.length > 0 && (await tx.receipt.count({ where: { id: { in: receiptIds }, entityId, archivedAt: null } })) !== receiptIds.length) {
    throw new InvoicingRefusal("One of the linked receipts was not found.");
  }
  return { clientDefaultNetDays: client.defaultNetDays ?? null };
}

function headerData(draft: ValidatedDraft, defaultNetDays: number) {
  const netDays = draft.netDays ?? defaultNetDays;
  return {
    clientId: draft.clientId,
    billingModel: draft.billingModel,
    title: draft.title,
    poNumber: draft.poNumber,
    issueDate: draft.issueDate,
    netDays,
    dueDate: draft.issueDate ? dueDateFor(draft.issueDate, netDays) : null,
    notes: draft.notes,
    internalNotes: draft.internalNotes,
    subtotalCents: draft.totals.subtotalCents,
    discountKind: draft.discount?.kind ?? null,
    discountValue: draft.discount?.value ?? null,
    discountCents: draft.totals.discountCents,
    totalCents: draft.totals.totalCents,
    includeRemitTo: draft.includeRemitTo,
    showEin: draft.showEin,
  };
}

/**
 * Creates (documentId null) or updates an invoice DRAFT with its lines. On update `expectedUpdatedAt` must match the row, otherwise
 * another tab changed it and nothing is written.
 */
export async function saveDraft(args: { entityId: string; userId: string; documentId: string | null; expectedUpdatedAt: Date | null; draft: ValidatedDraft }): Promise<{ id: string; updatedAt: Date }> {
  const { entityId, userId, documentId, expectedUpdatedAt, draft } = args;
  return db.$transaction(async (tx) => {
    const profile = await tx.invoicingProfile.findUnique({ where: { entityId }, select: { defaultNetDays: true } });
    if (!profile) throw new InvoicingRefusal("Invoicing is not set up for this business.");
    const refs = await assertDraftReferences(tx, entityId, draft);
    // Terms precedence: this invoice's own days, else the client's default, else the profile default (0 = due upon receipt).
    const data = headerData(draft, refs.clientDefaultNetDays ?? profile.defaultNetDays);
    let id: string;
    if (documentId === null) {
      const row = await tx.billingDocument.create({ data: { entityId, kind: "invoice", status: "draft", createdById: userId, ...data }, select: { id: true } });
      id = row.id;
      await appendEvent(tx, { entityId, kind: "created", actorId: userId, documentId: id, clientId: draft.clientId, data: { lineCount: draft.lines.length, totalCents: data.totalCents } });
    } else {
      if (!expectedUpdatedAt) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
      const res = await tx.billingDocument.updateMany({
        where: { id: documentId, entityId, kind: "invoice", status: "draft", archivedAt: null, updatedAt: expectedUpdatedAt },
        data,
      });
      if (res.count !== 1) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
      id = documentId;
      await appendEvent(tx, { entityId, kind: "edited", actorId: userId, documentId: id, clientId: draft.clientId, data: { lineCount: draft.lines.length, totalCents: data.totalCents } });
    }
    await replaceDraftLines(tx, entityId, id, draft.lines);
    const fresh = await tx.billingDocument.findUnique({ where: { id }, select: { updatedAt: true } });
    return { id, updatedAt: fresh?.updatedAt ?? new Date() };
  }, TX_OPTIONS);
}

export async function archiveDraft(args: { entityId: string; userId: string; documentId: string; expectedUpdatedAt: Date }): Promise<void> {
  const { entityId, userId, documentId, expectedUpdatedAt } = args;
  await db.$transaction(async (tx) => {
    const res = await tx.billingDocument.updateMany({
      where: { id: documentId, entityId, kind: "invoice", status: "draft", archivedAt: null, updatedAt: expectedUpdatedAt },
      data: { archivedAt: new Date() },
    });
    if (res.count !== 1) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
    await appendEvent(tx, { entityId, kind: "archived", actorId: userId, documentId });
  }, TX_OPTIONS);
}

/**
 * Issues a draft: allocates the next number under the profile row lock and flips the status in ONE transaction. A draft that was
 * issued or edited by someone else in the meantime updates zero rows and the whole transaction (including the counter) rolls back.
 * The caller has already re-validated the draft in strict mode and passes the date/terms it will freeze.
 */
export async function issueInvoice(args: {
  entityId: string;
  userId: string;
  documentId: string;
  expectedUpdatedAt: Date;
  issueDate: Date;
  netDays: number;
  glCodeIds: string[];
}): Promise<{ number: number; displayNumber: string }> {
  const { entityId, userId, documentId, expectedUpdatedAt, issueDate, netDays } = args;
  return db.$transaction(async (tx) => {
    await assertGlIds(tx, entityId, args.glCodeIds);
    // An archived client's draft cannot be issued (the client left the lists; only its already-issued invoices stay payable).
    const draft = await tx.billingDocument.findFirst({ where: { id: documentId, entityId, kind: "invoice", status: "draft", archivedAt: null }, select: { clientId: true } });
    if (!draft) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
    const owner = await tx.client.findFirst({ where: { id: draft.clientId, entityId }, select: { archivedAt: true } });
    if (!owner || Boolean(owner.archivedAt)) throw new InvoicingRefusal("This invoice's client is archived, so the draft cannot be issued.");
    // The row lock on the profile serialises concurrent issues; the returned value is the number this issue takes.
    const rows = await tx.$queryRaw<{ n: number; prefix: string; pad: number }[]>`
      UPDATE "InvoicingProfile" SET "nextInvoiceNumber" = "nextInvoiceNumber" + 1
      WHERE "entityId" = ${entityId}
      RETURNING "nextInvoiceNumber" - 1 AS n, "invoicePrefix" AS prefix, "numberPad" AS pad`;
    const row = rows[0];
    if (!row) throw new InvoicingRefusal("Invoicing is not set up for this business.");
    const displayNumber = formatDisplayNumber(row.prefix, row.n, row.pad);
    const res = await tx.billingDocument.updateMany({
      where: { id: documentId, entityId, kind: "invoice", status: "draft", archivedAt: null, updatedAt: expectedUpdatedAt },
      data: { status: "issued", number: row.n, displayNumber, issuedAt: new Date(), issueDate, netDays, dueDate: dueDateFor(issueDate, netDays) },
    });
    if (res.count !== 1) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB); // rolls back the counter increment
    await appendEvent(tx, { entityId, kind: "issued", actorId: userId, documentId, data: { number: row.n } });
    return { number: row.n, displayNumber };
  }, TX_OPTIONS);
}

export async function voidInvoice(args: { entityId: string; userId: string; documentId: string; reason: string }): Promise<void> {
  const { entityId, userId, documentId, reason } = args;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BillingDocument" WHERE "id" = ${documentId} FOR UPDATE`;
    const doc = await tx.billingDocument.findFirst({
      where: { id: documentId, entityId, kind: "invoice" },
      select: { status: true, allocations: { where: { voidedAt: null }, select: { id: true } } },
    });
    if (!doc) throw new InvoicingRefusal("That invoice was not found.");
    const ck = canVoidInvoice(doc.status, doc.allocations.length);
    if (!ck.ok) throw new InvoicingRefusal(ck.error);
    const res = await tx.billingDocument.updateMany({
      where: { id: documentId, entityId, status: "issued" },
      data: { status: "void", voidedAt: new Date(), voidReason: reason },
    });
    if (res.count !== 1) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
    await appendEvent(tx, { entityId, kind: "voided", actorId: userId, documentId });
  }, TX_OPTIONS);
}

// ── Payments and allocations ──────────────────────────────────────────────────────

const maxDate = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/** Locks the deposit row, checks it is a real, live, positive, non-transfer deposit of this entity and that the shared-sum rule holds. */
async function checkDeposit(tx: Tx, entityId: string, depositId: string, thisNetCents: number, excludePaymentId: string | null): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Transaction" WHERE "id" = ${depositId} FOR UPDATE`;
  const dep = await tx.transaction.findFirst({ where: { id: depositId, entityId, archivedAt: null, transferPairId: null }, select: { amount: true, pending: true } });
  if (!dep) throw new InvoicingRefusal("That bank deposit was not found (it may be archived or a transfer).");
  // Only POSTED deposits can be linked. The bank sync archives a pending row and creates the posted one under a NEW id when it
  // clears, so a link to a pending row would go stale and the posted deposit would then look like unlinked revenue (a double count).
  if (dep.pending) throw new InvoicingRefusal("That deposit is still pending at the bank. Link it after it has posted.");
  const depositCents = decimalToCents(dep.amount);
  if (depositCents <= 0) throw new InvoicingRefusal("That bank transaction is not a deposit.");
  const others = await tx.billingPayment.findMany({
    where: { depositTransactionId: depositId, status: "recorded", ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}) },
    select: { amountCents: true, feeCents: true },
  });
  const otherNet = others.reduce((s, o) => s + o.amountCents - o.feeCents, 0);
  if (!depositCapacityOk(depositCents, otherNet, thisNetCents)) {
    throw new InvoicingRefusal("That deposit is already fully matched to other payments.");
  }
}

export async function recordPayment(args: { entityId: string; userId: string; payment: ValidatedPayment }): Promise<{ id: string; duplicate: boolean }> {
  const { entityId, userId, payment: p } = args;
  const dup = async () => {
    const existing = await db.billingPayment.findUnique({ where: { requestKey: p.requestKey }, select: { id: true, entityId: true } });
    if (!existing || existing.entityId !== entityId) return null;
    return { id: existing.id, duplicate: true as const };
  };
  const first = await dup();
  if (first) return first;
  try {
    const result = await db.$transaction(async (tx) => {
      const invoiceIds = p.allocations.map((a) => a.invoiceId);
      // A payment that settles an open invoice is accepted even if its client was archived later (existing archived clients must not
      // strand an unpaid invoice); the invoice checks below still require it to belong to that client and to be issued. A payment
      // that applies to no invoice still needs a live client.
      await assertClient(tx, entityId, p.clientId, { allowArchived: invoiceIds.length > 0 });
      // Lock the invoice rows in ONE deterministic order (sorted ids): two concurrent multi-invoice payments that list the same
      // invoices in opposite order then queue on the same first lock instead of deadlocking.
      const lockOrder = [...new Set(invoiceIds)].sort();
      if (lockOrder.length > 0) await tx.$queryRaw`SELECT "id" FROM "BillingDocument" WHERE "id" IN (${Prisma.join(lockOrder)}) ORDER BY "id" FOR UPDATE`;
      // Idempotency INSIDE the locked section: a second submit of the same form waits on the invoice lock, then finds the first
      // payment here instead of tripping the over-allocation check against the first one's own application.
      const again = await tx.billingPayment.findUnique({ where: { requestKey: p.requestKey }, select: { id: true, entityId: true } });
      if (again) {
        if (again.entityId !== entityId) throw new InvoicingRefusal("The form is out of date. Reload the page.");
        return { id: again.id, duplicate: true };
      }
      const invoices = invoiceIds.length
        ? await tx.billingDocument.findMany({
            where: { id: { in: invoiceIds }, entityId, kind: "invoice", clientId: p.clientId },
            select: { id: true, status: true, issueDate: true, totalCents: true, allocations: { where: { voidedAt: null }, select: { amountCents: true } } },
          })
        : [];
      if (invoices.length !== invoiceIds.length) throw new InvoicingRefusal("One of the invoices was not found for this client.");
      const byId = new Map(invoices.map((i) => [i.id, i]));
      for (const a of p.allocations) {
        const inv = byId.get(a.invoiceId)!;
        if (inv.status !== "issued") throw new InvoicingRefusal("Payments can only be applied to issued invoices.");
        const open = inv.totalCents - inv.allocations.reduce((s, x) => s + x.amountCents, 0);
        if (a.amountCents > open) throw new InvoicingRefusal("An amount applied is more than that invoice's balance.");
      }
      if (p.depositTransactionId) await checkDeposit(tx, entityId, p.depositTransactionId, p.amountCents - p.feeCents, null);
      const row = await tx.billingPayment.create({
        data: {
          entityId,
          clientId: p.clientId,
          method: p.method,
          receivedOn: p.receivedOn,
          amountCents: p.amountCents,
          feeCents: p.feeCents,
          reference: p.reference,
          notes: p.notes,
          depositTransactionId: p.depositTransactionId,
          source: "manual",
          requestKey: p.requestKey,
          createdById: userId,
        },
        select: { id: true },
      });
      for (const a of p.allocations) {
        const inv = byId.get(a.invoiceId)!;
        await tx.billingAllocation.create({
          data: {
            entityId,
            invoiceId: a.invoiceId,
            paymentId: row.id,
            amountCents: a.amountCents,
            appliedOn: maxDate(p.receivedOn, inv.issueDate ?? p.receivedOn),
            createdById: userId,
          },
        });
        await appendEvent(tx, { entityId, kind: "allocated", actorId: userId, documentId: a.invoiceId, paymentId: row.id, data: { amountCents: a.amountCents } });
      }
      await appendEvent(tx, {
        entityId,
        kind: "payment_recorded",
        actorId: userId,
        paymentId: row.id,
        clientId: p.clientId,
        data: { amountCents: p.amountCents, feeCents: p.feeCents, allocationCount: p.allocations.length, hasDeposit: p.depositTransactionId !== null },
      });
      return { id: row.id, duplicate: false };
    }, TX_OPTIONS);
    return result;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await dup();
      if (again) return again;
    }
    throw err;
  }
}

export async function voidPayment(args: { entityId: string; userId: string; paymentId: string; reason: string }): Promise<void> {
  const { entityId, userId, paymentId, reason } = args;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BillingPayment" WHERE "id" = ${paymentId} FOR UPDATE`;
    const pay = await tx.billingPayment.findFirst({
      where: { id: paymentId, entityId },
      select: { status: true, clientId: true, allocations: { where: { voidedAt: null }, select: { id: true } } },
    });
    if (!pay) throw new InvoicingRefusal("That payment was not found.");
    const ck = canVoidPayment(pay.status, pay.allocations.length);
    if (!ck.ok) throw new InvoicingRefusal(ck.error);
    const res = await tx.billingPayment.updateMany({ where: { id: paymentId, entityId, status: "recorded" }, data: { status: "void", voidedAt: new Date(), voidReason: reason } });
    if (res.count !== 1) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
    await appendEvent(tx, { entityId, kind: "payment_voided", actorId: userId, paymentId, clientId: pay.clientId });
  }, TX_OPTIONS);
}

/** Removes one application of a payment from an invoice (the allocation is voided, never deleted). */
export async function deallocate(args: { entityId: string; userId: string; allocationId: string }): Promise<void> {
  const { entityId, userId, allocationId } = args;
  await db.$transaction(async (tx) => {
    const alloc = await tx.billingAllocation.findFirst({ where: { id: allocationId, entityId, voidedAt: null }, select: { id: true, invoiceId: true, paymentId: true, amountCents: true } });
    if (!alloc) throw new InvoicingRefusal("That application was not found (it may already be removed).");
    await tx.$queryRaw`SELECT "id" FROM "BillingDocument" WHERE "id" = ${alloc.invoiceId} FOR UPDATE`;
    const res = await tx.billingAllocation.updateMany({ where: { id: allocationId, entityId, voidedAt: null }, data: { voidedAt: new Date() } });
    if (res.count !== 1) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
    await appendEvent(tx, { entityId, kind: "deallocated", actorId: userId, documentId: alloc.invoiceId, paymentId: alloc.paymentId, data: { amountCents: alloc.amountCents } });
  }, TX_OPTIONS);
}

/** Applies what is left of an existing payment to an invoice of the same client. */
export async function allocateExisting(args: { entityId: string; userId: string; paymentId: string; invoiceId: string; amountCents: number; today: Date }): Promise<void> {
  const { entityId, userId, paymentId, invoiceId, amountCents, today } = args;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BillingDocument" WHERE "id" = ${invoiceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "BillingPayment" WHERE "id" = ${paymentId} FOR UPDATE`;
    const pay = await tx.billingPayment.findFirst({
      where: { id: paymentId, entityId, status: "recorded" },
      select: { clientId: true, amountCents: true, receivedOn: true, allocations: { where: { voidedAt: null }, select: { amountCents: true } } },
    });
    if (!pay) throw new InvoicingRefusal("That payment was not found.");
    const inv = await tx.billingDocument.findFirst({
      where: { id: invoiceId, entityId, kind: "invoice", status: "issued", clientId: pay.clientId },
      select: { issueDate: true, totalCents: true, allocations: { where: { voidedAt: null }, select: { amountCents: true } } },
    });
    if (!inv) throw new InvoicingRefusal("That invoice was not found for this payment's client, or it is not issued.");
    const remainder = pay.amountCents - pay.allocations.reduce((s, x) => s + x.amountCents, 0);
    const open = inv.totalCents - inv.allocations.reduce((s, x) => s + x.amountCents, 0);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new InvoicingRefusal("The amount applied must be greater than zero.");
    if (amountCents > open) throw new InvoicingRefusal("That is more than the invoice balance.");
    if (amountCents > remainder) throw new InvoicingRefusal("That is more than what is left of this payment.");
    await tx.billingAllocation.create({
      data: { entityId, invoiceId, paymentId, amountCents, appliedOn: maxDate(maxDate(today, pay.receivedOn), inv.issueDate ?? today), createdById: userId },
    });
    await appendEvent(tx, { entityId, kind: "allocated", actorId: userId, documentId: invoiceId, paymentId, data: { amountCents } });
  }, TX_OPTIONS);
}

export async function linkDeposit(args: { entityId: string; userId: string; paymentId: string; depositTransactionId: string }): Promise<void> {
  const { entityId, userId, paymentId, depositTransactionId } = args;
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "BillingPayment" WHERE "id" = ${paymentId} FOR UPDATE`;
    const pay = await tx.billingPayment.findFirst({ where: { id: paymentId, entityId, status: "recorded" }, select: { amountCents: true, feeCents: true, depositTransactionId: true } });
    if (!pay) throw new InvoicingRefusal("That payment was not found.");
    if (pay.depositTransactionId) throw new InvoicingRefusal("This payment already has a bank deposit linked. Unlink it first.");
    await checkDeposit(tx, entityId, depositTransactionId, pay.amountCents - pay.feeCents, paymentId);
    const res = await tx.billingPayment.updateMany({ where: { id: paymentId, entityId, status: "recorded", depositTransactionId: null }, data: { depositTransactionId } });
    if (res.count !== 1) throw new InvoicingRefusal(CHANGED_IN_OTHER_TAB);
    await appendEvent(tx, { entityId, kind: "deposit_linked", actorId: userId, paymentId });
  }, TX_OPTIONS);
}

export async function unlinkDeposit(args: { entityId: string; userId: string; paymentId: string }): Promise<void> {
  const { entityId, userId, paymentId } = args;
  await db.$transaction(async (tx) => {
    const res = await tx.billingPayment.updateMany({ where: { id: paymentId, entityId, status: "recorded", depositTransactionId: { not: null } }, data: { depositTransactionId: null } });
    if (res.count !== 1) throw new InvoicingRefusal("That payment has no linked deposit.");
    await appendEvent(tx, { entityId, kind: "deposit_unlinked", actorId: userId, paymentId });
  }, TX_OPTIONS);
}
