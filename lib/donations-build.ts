import { db } from "@/lib/db";
import { flagsForDonation, flagsForYear, loggedTotals, type DonationFlag } from "@/lib/donation-substantiation";
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
  flags: DonationFlag[];
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
  years: number[];
}

function docLabel(d: { documentName: string | null; docType: string }): string {
  return d.documentName && d.documentName.trim() !== "" ? d.documentName : d.docType;
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
      years,
    };
  }

  const bounds = taxYearBoundsUtc(year);
  const [donations, workspace] = await Promise.all([
    db.donation.findMany({
      where: { entityId: personal.id, archivedAt: null, date: { gte: bounds.start, lt: bounds.endExclusive } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      include: { receiptDocument: { select: { documentName: true, docType: true } } },
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
    flags: flagsForDonation(d),
  }));

  return {
    year,
    personalEntityId: personal.id,
    noneConfirmed: isNoneConfirmed(workspace?.questions ?? [], NONE_CONFIRMATION_KEYS.donations),
    rows,
    yearFlags: flagsForYear(donations),
    totals: loggedTotals(donations),
    documents: docRows.map((d) => ({ id: d.id, label: docLabel(d) })),
    years,
  };
}
