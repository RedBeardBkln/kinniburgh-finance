import { db } from "@/lib/db";
import { computePL } from "@/lib/reports";
import { buildPersonalTaxComputeInput } from "@/lib/tax-compute-build";
import { computePersonalTaxReturn } from "@/lib/tax-compute";
import { describeDocumentRow } from "@/lib/document-extraction-state";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";
import { taxYearBoundsUtc } from "@/lib/tax-log-dates";
import { countBuildingAssetsForYear, countEkcAssetsForYear } from "@/lib/fixed-assets";
import {
  buildFormsPageData,
  type FormsPageData,
  type FormsDocumentInput,
  type FormsQuestionInput,
  type TaxDraftSummary,
} from "@/lib/tax-forms";

// ── Read-only DB assembler for the per-tax-year Forms page ──────────────────
// Gathers raw data and hands it to the pure lib/tax-forms.ts builder. STRICTLY
// READ-ONLY: it never calls ensurePersonalWorkspace / ensureTaxWorkspace and
// never writes. If the Personal workspace for the year does not exist, the
// planning-question answers are simply [] and the page links to open it.
//
// Mirrors the data gathering already done in app/tax/personal/[year]/page.tsx
// (documents, questions, computePL for EK Consulting / Sudden Valley, mileage
// count, solar loan cost, and — for tax year 2025 ONLY — the TY2025 draft).

const SLUG_EKC = "ek-consulting";
const SLUG_SV = "sudden-valley";

async function resolveTaxDraft(year: number): Promise<TaxDraftSummary> {
  // The compute engine only exists for TY2025; never invoke it for other years.
  if (year !== 2025) return { status: "not_computed" };
  try {
    const resolved = await buildPersonalTaxComputeInput(year);
    if ("error" in resolved) return { status: "unavailable", reason: resolved.error };
    const result = computePersonalTaxReturn(resolved.input);
    return {
      status: "available",
      deductionMethod: result.federal.deductionMethod,
      selfEmploymentTaxPositive: result.federal.selfEmploymentTax.totalSETax.gt(0),
    };
  } catch {
    return { status: "unavailable", reason: "the tax computation could not run" };
  }
}

export async function loadFormsPageData(year: number): Promise<FormsPageData> {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  const [entities, people, docRows, workspaces] = await Promise.all([
    db.entity.findMany({
      where: { archivedAt: null, type: { in: ["personal", "business"] } },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      select: { id: true, name: true, slug: true, type: true, foundedDate: true, taxStatusNotes: true },
    }),
    // id + name only — never select email/passwordHash/totpSecret.
    db.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.document.findMany({
      where: {
        archivedAt: null,
        OR: [{ taxYear: year }, { taxYear: { lt: year }, docType: "tax_return" }],
      },
      select: {
        id: true,
        docType: true,
        documentName: true,
        entityId: true,
        taxYear: true,
        extractionStatus: true,
        extractionData: true,
        extractionCorrections: true,
        extractionConfirmedAt: true,
        extractionError: true,
        updatedAt: true,
        archivedAt: true,
        subjectType: true,
        issuerName: true,
        subjectUser: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.taxWorkspace.findMany({
      where: { taxYear: year },
      select: {
        id: true,
        entityId: true,
        checklistItems: { select: { completed: true } },
        questions: { select: { key: true, answer: true, skippedReason: true } },
      },
    }),
  ]);

  const personal = entities.find((e) => e.type === "personal") ?? null;
  const ekc = entities.find((e) => e.slug === SLUG_EKC) ?? null;
  const sv = entities.find((e) => e.slug === SLUG_SV) ?? null;

  const personalWorkspace = personal ? workspaces.find((w) => w.entityId === personal.id) ?? null : null;
  const questions: FormsQuestionInput[] = (personalWorkspace?.questions ?? []).map((q) => ({
    key: q.key,
    answer: q.answer,
    skippedReason: q.skippedReason,
  }));

  const workspaceIds: Record<string, string> = {};
  const checklists: Record<string, { completed: number; total: number }> = {};
  for (const w of workspaces) {
    workspaceIds[w.entityId] = w.id;
    if (w.checklistItems.length > 0) {
      checklists[w.entityId] = {
        completed: w.checklistItems.filter((i) => i.completed).length,
        total: w.checklistItems.length,
      };
    }
  }

  // Effective values (owner corrections overlaid on the AI read; verified-else-AI
  // per TAX_EXTRACTION_POLICY) + provenance. `extraction` is the same
  // describeExtraction state the Documents list shows, so the two always agree.
  const resolvedById = new Map(
    docRows.map((d) => [
      d.id,
      resolveTaxDocForCompute({
        docType: d.docType,
        extractionStatus: d.extractionStatus,
        extractionData: d.extractionData,
        extractionCorrections: d.extractionCorrections,
        extractionConfirmedAt: d.extractionConfirmedAt,
      }),
    ])
  );
  const documents: FormsDocumentInput[] = docRows.map((d) => ({
    id: d.id,
    docType: d.docType,
    documentName: d.documentName,
    entityId: d.entityId,
    taxYear: d.taxYear,
    extractionStatus: d.extractionStatus,
    extractionData: resolvedById.get(d.id)?.extractionData ?? d.extractionData,
    archivedAt: d.archivedAt,
    subjectType: d.subjectType,
    subjectUser: d.subjectUser ? { id: d.subjectUser.id, name: d.subjectUser.name } : null,
    issuerName: d.issuerName,
    verified: resolvedById.get(d.id)?.verified ?? false,
    extraction: describeDocumentRow(d),
  }));

  // ── Inputs for the existing computed form-readiness plan ──────────────────
  const safePL = async (entityId: string | null) => {
    if (!entityId) return null;
    try {
      const pl = await computePL(entityId, yearStart, yearEnd);
      return { incomeLines: pl.incomeLines, expenseLines: pl.expenseLines };
    } catch {
      return null; // P&L is a readiness signal only — a failure must not break the page
    }
  };

  // Half-open [Jan 1, next Jan 1) so a gift dated noon UTC on Dec 31 is in and Jan 1 is out.
  const bounds = taxYearBoundsUtc(year);

  const [ekcPL, svPL, ekcMileageCount, solarLoanAccount, taxDraft, donationCount, fixedAssetRows] = await Promise.all([
    safePL(ekc?.id ?? null),
    safePL(sv?.id ?? null),
    ekc
      ? db.mileageEntry.count({
          where: { entityId: ekc.id, archivedAt: null, date: { gte: yearStart, lte: yearEnd } },
        })
      : Promise.resolve(0),
    personal
      ? db.account.findUnique({
          where: { entityId_nickname: { entityId: personal.id, nickname: "Solar loan" }, archivedAt: null },
          include: { debtDetail: true },
        })
      : Promise.resolve(null),
    resolveTaxDraft(year),
    personal
      ? db.donation.count({
          where: { entityId: personal.id, archivedAt: null, date: { gte: bounds.start, lt: bounds.endExclusive } },
        })
      : Promise.resolve(0),
    // The (tiny) non-archived asset set; year inclusion is a unit-tested pure helper, not a Prisma filter.
    ekc || sv
      ? db.fixedAsset.findMany({
          where: { entityId: { in: [ekc?.id, sv?.id].filter((x): x is string => !!x) }, archivedAt: null },
          select: { entityId: true, placedInServiceDate: true, isRealProperty: true, landValueCents: true },
        })
      : Promise.resolve([]),
  ]);

  return buildFormsPageData({
    taxYear: year,
    people,
    entities,
    documents,
    questions,
    personalWorkspaceExists: personalWorkspace !== null,
    workspaceIds,
    checklists,
    formPlanInput: {
      documents: documents
        .filter((d) => personal !== null && d.entityId === personal.id && d.taxYear === year)
        .map((d) => {
          // Policy-aware status/data (verified_only drops unverified docs here).
          const resolved = resolvedById.get(d.id);
          return {
            docType: d.docType,
            extractionStatus: resolved?.extractionStatus ?? d.extractionStatus,
            extractionData: resolved?.extractionData ?? d.extractionData,
            verified: resolved?.verified ?? false,
          };
        }),
      questions,
      ekConsultingPL: ekcPL,
      suddenValleyPL: svPL,
      ekConsultingMileageCount: ekcMileageCount,
      solarLoanOriginalCostCents: solarLoanAccount?.debtDetail?.originalBalanceCents ?? null,
      donationCount,
      ekConsultingFixedAssetCount: countEkcAssetsForYear(fixedAssetRows, ekc?.id ?? null, year),
      suddenValleyBuildingAssetCount: countBuildingAssetsForYear(fixedAssetRows, sv?.id ?? null, year),
    },
    taxDraft,
  });
}
