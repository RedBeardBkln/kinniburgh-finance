import { db } from "@/lib/db";
import {
  buildReceiptGiftView,
  type LinkedGiftView,
  type ReceiptGiftView,
} from "@/lib/donation-receipt";
import { formatDateEt, taxYearOfDate, toIsoDateInput } from "@/lib/tax-log-dates";

// ── Read-only DB loaders for donation receipts (donation-receipt-document-type) ──
// Strictly read-only: nothing here writes, starts an extraction, or creates a
// donation. Every read filters archivedAt: null. Output is plain serializable
// data for the review-screen panel and the donation-log "waiting" card. The
// receipt's values come only through buildReceiptGiftView, which reads them via
// resolveTaxDocForCompute (effective values: the owner's corrections win).

const DOC_SELECT = {
  id: true,
  documentName: true,
  docType: true,
  taxYear: true,
  entityId: true,
  extractionStatus: true,
  extractionData: true,
  extractionCorrections: true,
  extractionConfirmedAt: true,
} as const;

async function personalEntityId(): Promise<string | null> {
  const personal = await db.entity.findFirst({
    where: { type: "personal", archivedAt: null },
    select: { id: true },
  });
  return personal?.id ?? null;
}

function toLinkedGift(d: { id: string; date: Date; recipient: string; amountCents: number }): LinkedGiftView {
  return {
    id: d.id,
    dateIso: toIsoDateInput(d.date),
    dateLabel: formatDateEt(d.date),
    recipient: d.recipient,
    amountCents: d.amountCents,
    year: taxYearOfDate(d.date),
  };
}

/** The receipt panel's view for one document, or null when it is not a live donation_receipt. */
export async function loadReceiptGiftForDocument(documentId: string): Promise<ReceiptGiftView | null> {
  const [personalId, doc] = await Promise.all([
    personalEntityId(),
    db.document.findFirst({
      where: { id: documentId, archivedAt: null, docType: "donation_receipt" },
      select: DOC_SELECT,
    }),
  ]);
  if (!doc) return null;

  const linked = await db.donation.findMany({
    where: { receiptDocumentId: doc.id, archivedAt: null },
    select: { id: true, date: true, recipient: true, amountCents: true },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  return buildReceiptGiftView(doc, {
    personalEntityId: personalId,
    linkedGifts: linked.map(toLinkedGift),
  });
}

/**
 * Personal donation_receipt documents with no non-archived gift linked, for the
 * donation log's "Receipts waiting to be logged" card. A receipt filed under the
 * viewed year OR with no year on file is listed (a null-year receipt would
 * otherwise be undiscoverable). A receipt reappears if its gift is archived.
 */
export async function loadUnlinkedReceipts(personalId: string, year: number): Promise<ReceiptGiftView[]> {
  const docs = await db.document.findMany({
    where: {
      entityId: personalId,
      archivedAt: null,
      docType: "donation_receipt",
      OR: [{ taxYear: year }, { taxYear: null }],
      donationReceipts: { none: { archivedAt: null } },
    },
    select: DOC_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return docs.map((doc) =>
    buildReceiptGiftView(doc, { personalEntityId: personalId, linkedGifts: [] })
  );
}
