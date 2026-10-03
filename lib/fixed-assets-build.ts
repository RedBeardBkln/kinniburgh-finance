import { db } from "@/lib/db";
import { isEntityActiveForYear } from "@/lib/tax-entities";
import { assetCountsForYear, entriesSatisfyFormsLine } from "@/lib/fixed-assets";
import { formatDateEt, toIsoDateInput } from "@/lib/tax-log-dates";
import { NONE_CONFIRMATION_KEYS, isNoneConfirmed } from "@/lib/tax-none-confirmation";
import type { DocumentOption } from "@/lib/donations-build";

// ── Read-only DB assembler for /tax/fixed-assets/[year] ──────────────────────
// Strictly read-only. Every read filters archivedAt: null. Output is plain
// serializable data. Nothing here computes depreciation, a MACRS class, a
// Section 179 / bonus figure, or a building basis (cost minus land).

const SLUG_EKC = "ek-consulting";
const SLUG_SV = "sudden-valley";

export interface FixedAssetRowView {
  id: string;
  description: string;
  /** "YYYY-MM-DD" for the edit form. */
  placedInServiceIso: string;
  placedInServiceLabel: string;
  costBasisCents: number;
  isRealProperty: boolean;
  landValueCents: number | null;
  businessUsePercent: number;
  invoiceDocumentId: string | null;
  invoiceName: string | null;
  notes: string | null;
  /** Placed in service after the viewed year: shown muted as "after {year}". */
  afterViewedYear: boolean;
}

export interface FixedAssetSectionView {
  entityId: string;
  entityName: string;
  slug: string;
  /** The planning-question key that confirms "none" for this entity. */
  noneQuestionKey: string;
  noneConfirmed: boolean;
  /** Sudden Valley's register is about a building: pre-check "real property" in the form. */
  defaultRealProperty: boolean;
  /**
   * True only when the recorded assets actually satisfy this entity's Forms-page
   * line (EKC: any asset in service by the year; Sudden Valley: a building with a
   * land value in service by the year). Not the same as "rows exist".
   */
  lineSatisfiedByEntries: boolean;
  rows: FixedAssetRowView[];
  documents: DocumentOption[];
}

export interface FixedAssetsPageView {
  year: number;
  sections: FixedAssetSectionView[];
  years: number[];
}

function docLabel(d: { documentName: string | null; docType: string }): string {
  return d.documentName && d.documentName.trim() !== "" ? d.documentName : d.docType;
}

export async function loadFixedAssetsPage(year: number): Promise<FixedAssetsPageView> {
  const [entities, workspaceYears, personal] = await Promise.all([
    db.entity.findMany({
      where: { archivedAt: null, type: "business", slug: { in: [SLUG_EKC, SLUG_SV] } },
      select: { id: true, name: true, slug: true, type: true, foundedDate: true, taxStatusNotes: true },
    }),
    db.taxWorkspace.findMany({ select: { taxYear: true }, distinct: ["taxYear"] }),
    db.entity.findFirst({ where: { type: "personal", archivedAt: null }, select: { id: true } }),
  ]);

  const yearSet = new Set<number>(workspaceYears.map((w) => w.taxYear));
  yearSet.add(new Date().getUTCFullYear());
  yearSet.add(year);
  const years = Array.from(yearSet).sort((a, b) => b - a);

  // EK Consulting always; Sudden Valley only for years it is active (like the Forms page).
  const active = entities
    .filter((e) => e.slug === SLUG_EKC || (e.slug === SLUG_SV && isEntityActiveForYear(e, year)))
    .sort((a, b) => (a.slug === SLUG_EKC ? -1 : b.slug === SLUG_EKC ? 1 : 0));

  const workspace = personal
    ? await db.taxWorkspace.findUnique({
        where: { entityId_taxYear: { entityId: personal.id, taxYear: year } },
        select: {
          questions: {
            where: { key: { in: [NONE_CONFIRMATION_KEYS.fixedAssetsEkc, NONE_CONFIRMATION_KEYS.fixedAssetsSv] } },
            select: { key: true, answer: true, skippedReason: true },
          },
        },
      })
    : null;
  const questions = workspace?.questions ?? [];

  const sections: FixedAssetSectionView[] = [];
  for (const e of active) {
    const assets = await db.fixedAsset.findMany({
      where: { entityId: e.id, archivedAt: null },
      orderBy: [{ placedInServiceDate: "asc" }, { createdAt: "asc" }],
      include: { invoiceDocument: { select: { documentName: true, docType: true } } },
    });
    const linkedIds = assets.map((a) => a.invoiceDocumentId).filter((x): x is string => !!x);
    const docRows = await db.document.findMany({
      where: {
        archivedAt: null,
        entityId: e.id,
        OR: [{ taxYear: year }, ...(linkedIds.length > 0 ? [{ id: { in: linkedIds } }] : [])],
      },
      select: { id: true, documentName: true, docType: true },
      orderBy: { createdAt: "desc" },
    });
    const isSv = e.slug === SLUG_SV;
    const noneQuestionKey = isSv ? NONE_CONFIRMATION_KEYS.fixedAssetsSv : NONE_CONFIRMATION_KEYS.fixedAssetsEkc;
    sections.push({
      entityId: e.id,
      entityName: e.name,
      slug: e.slug ?? "",
      noneQuestionKey,
      noneConfirmed: isNoneConfirmed(questions, noneQuestionKey),
      defaultRealProperty: isSv,
      lineSatisfiedByEntries: entriesSatisfyFormsLine(assets, e.id, isSv, year),
      rows: assets.map((a) => ({
        id: a.id,
        description: a.description,
        placedInServiceIso: toIsoDateInput(a.placedInServiceDate),
        placedInServiceLabel: formatDateEt(a.placedInServiceDate),
        costBasisCents: a.costBasisCents,
        isRealProperty: a.isRealProperty,
        landValueCents: a.landValueCents,
        businessUsePercent: a.businessUsePercent,
        invoiceDocumentId: a.invoiceDocumentId,
        invoiceName: a.invoiceDocument ? docLabel(a.invoiceDocument) : null,
        notes: a.notes,
        afterViewedYear: !assetCountsForYear(a.placedInServiceDate, year),
      })),
      documents: docRows.map((d) => ({ id: d.id, label: docLabel(d) })),
    });
  }

  return { year, sections, years };
}
