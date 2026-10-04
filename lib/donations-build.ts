import { db } from "@/lib/db";
import { flagsForDonation, flagsForYear, loggedTotals, type DonationFlag } from "@/lib/donation-substantiation";
import { loadUnlinkedReceipts } from "@/lib/donation-receipts-build";
import { readDonationReceipt, receiptFlags, type ReceiptFlag, type ReceiptGiftView } from "@/lib/donation-receipt";
import { isUsableExtraction } from "@/lib/document-extraction-state";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";
import { formatDateEt, taxYearBoundsUtc, toIsoDateInput } from "@/lib/tax-log-dates";
import { NONE_CONFIRMATION_KEYS, isNoneConfirmed } from "@/lib/tax-none-confirmation";

// ── Read-only DB assembler for /tax/donations/[year] ─────────────────────────
// Strictly read-only (never opens a workspace). Every read filters archivedAt: null.
// Output is plain serializable data (strings / numbers / booleans) for the client
// table and form. No deductible amount is computed anywhere.

export interface DonationRowView {
  id: string;
  /** "YYYY-MM-DD" for the edit form. */
  dateIso: string;
  /** America/New_York display date. */
  dateLabel: string;
  recipient: string;
  kind: string;
  amountCents: number;
  substantiation: string;
  receiptDocumentId: string | null;
  receiptName: string | null;
  notes: string | null;
  /** The gift's own substantiation flags, plus (for a linked donation_receipt) the receipt-derived ones. */
  flags: Array<DonationFlag | ReceiptFlag>;
}

export interface DocumentOption {
  id: string;
  label: string;
}

export interface DonationsPageView {
  year: number;
  personalEntityId: string | null;
  noneConfirmed: boolean;
  rows: DonationRowView[];
  yearFlags: DonationFlag[];
  totals: { cashCents: number; noncashCents: number };
  documents: DocumentOption[];
  /** Personal donation_receipt documents with no gift logged yet (year match or no year on file). */
  unlinkedReceipts: ReceiptGiftView[];
  years: number[];
}

function docLabel(d: { documentName: string | null; docType: string }): string {
  return d.documentName && d.documentName.trim() !== "" ? d.documentName : d.docType;
}

interface LinkedReceiptDoc {
  docType: string;
  extractionStatus: string | null;
  extractionData: unknown;
  extractionCorrections: unknown;
  extractionConfirmedAt: Date | null;
}

/**
 * Flags from a LINKED donation_receipt's effective reading (the owner's
 * corrections win), so the "goods or services were provided" flag stays
 * visible on the saved gift. Reads only through resolveTaxDocForCompute; empty
 * for any other kind of linked document or when the policy withholds the values.
 */
function savedReceiptFlags(doc: LinkedReceiptDoc | null): ReceiptFlag[] {
  if (!doc || doc.docType !== "donation_receipt") return [];
  // Nothing readable yet: no flags (an empty reading would only say "not stated").
  if (!isUsableExtraction("donation_receipt", doc.extractionData)) return [];
  const resolved = resolveTaxDocForCompute(doc);
  if (resolved.excludedByPolicy) return [];
  const effective = resolved.extractionData;
  const data =
    typeof effective === "object" && effective !== null ? (effective as { data?: unknown }).data : null;
  if (typeof data !== "object" || data === null) return [];
  return receiptFlags(readDonationReceipt(data), { mode: "saved" });
}

export async function loadDonationsPage(year: number): Promise<DonationsPageView> {
  const personal = await db.entity.findFirst({
    where: { type: "personal", archivedAt: null },
    select: { id: true },
  });
  const workspaceYears = await db.taxWorkspace.findMany({ select: { taxYear: true }, distinct: ["taxYear"] });
  const yearSet = new Set<number>(workspaceYears.map((w) => w.taxYear));
  yearSet.add(new Date().getUTCFullYear());
  yearSet.add(year);
  const years = Array.from(yearSet).sort((a, b) => b - a);

  if (!personal) {
    return {
      year,
      personalEntityId: null,
      noneConfirmed: false,
      rows: [],
      yearFlags: [],
      totals: { cashCents: 0, noncashCents: 0 },
      documents: [],
      unlinkedReceipts: [],
      years,
    };
  }

  const bounds = taxYearBoundsUtc(year);
  const [donations, workspace] = await Promise.all([
    db.donation.findMany({
      where: { entityId: personal.id, archivedAt: null, date: { gte: bounds.start, lt: bounds.endExclusive } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      include: {
        receiptDocument: {
          select: {
            documentName: true,
            docType: true,
            extractionStatus: true,
            extractionData: true,
            extractionCorrections: true,
            extractionConfirmedAt: true,
          },
        },
      },
    }),
    db.taxWorkspace.findUnique({
      where: { entityId_taxYear: { entityId: personal.id, taxYear: year } },
      select: { questions: { where: { key: NONE_CONFIRMATION_KEYS.donations }, select: { key: true, answer: true, skippedReason: true } } },
    }),
  ]);

  // Receipt picker: Personal's documents for the year, plus any already-linked
  // document (so editing never silently drops a link filed under another year).
  const linkedIds = donations.map((d) => d.receiptDocumentId).filter((x): x is string => !!x);
  const docRows = await db.document.findMany({
    where: {
      archivedAt: null,
      entityId: personal.id,
      OR: [{ taxYear: year }, ...(linkedIds.length > 0 ? [{ id: { in: linkedIds } }] : [])],
    },
    select: { id: true, documentName: true, docType: true },
    orderBy: { createdAt: "desc" },
  });

  const unlinkedReceipts = await loadUnlinkedReceipts(personal.id, year);

  const rows: DonationRowView[] = donations.map((d) => ({
    id: d.id,
    dateIso: toIsoDateInput(d.date),
    dateLabel: formatDateEt(d.date),
    recipient: d.recipient,
    kind: d.kind,
    amountCents: d.amountCents,
    substantiation: d.substantiation,
    receiptDocumentId: d.receiptDocumentId,
    receiptName: d.receiptDocument ? docLabel(d.receiptDocument) : null,
    notes: d.notes,
    flags: [...flagsForDonation(d), ...savedReceiptFlags(d.receiptDocument)],
  }));

  return {
    year,
    personalEntityId: personal.id,
    noneConfirmed: isNoneConfirmed(workspace?.questions ?? [], NONE_CONFIRMATION_KEYS.donations),
    rows,
    yearFlags: flagsForYear(donations),
    totals: loggedTotals(donations),
    documents: docRows.map((d) => ({ id: d.id, label: docLabel(d) })),
    unlinkedReceipts,
    years,
  };
}
