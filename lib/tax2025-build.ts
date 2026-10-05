import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { assetCountsForYear } from "@/lib/fixed-assets";
import { computePL } from "@/lib/reports";
import { parseDollarAnswerToCents, parseSqftAnswer, sumPaystubWithholding } from "@/lib/tax-compute-build";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";
import { taxYearBoundsUtc, toIsoDateInput } from "@/lib/tax-log-dates";
import { effectiveAnswers, parseStoredAnswers } from "@/lib/tax-questionnaire";
import { RETURN_COMPLETENESS_ID, questionnaireById } from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT, parseCompletenessAnswers } from "@/lib/tax2025/answers";
import { inferPrimaryResidence, inferScheduleCOwner, planningFromRows } from "@/lib/tax2025/derive";
import type { DonationFact, FixedAssetFact, GlLineFact, Ty2025Facts } from "@/lib/tax2025/facts";
import { dollarsToCents } from "@/lib/tax2025/money";
import { resolveFacts, type RawAnswers, type RawDocument, type RawTy2025Inputs, type ResolvedFacts } from "@/lib/tax2025/resolve-facts";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Decisions, Ty2025Return } from "@/lib/tax2025/types";

// ── DB-aware loader for the TY2025 return engine (lib/tax2025/) ──────────────
// STRICTLY READ-ONLY: only findMany / findUnique / computePL (a groupBy read). It
// never calls ensurePersonalWorkspace, never writes, never touches the network.
// Everything it returns is plain data fed to the pure, unit-tested functions
// resolveFacts() and computeTy2025Return(); this module itself is not unit-tested
// (repo convention: a DB-touching wrapper around tested pure functions), but its
// pure pieces (owner / primary-residence inference, planning mapping) live in
// lib/tax2025/derive.ts and are tested.
//
// What it reads (plan 1a, section 8.1): Personal documents (mapped through
// resolveTaxDocForCompute so only EFFECTIVE, verified-labelled extraction data
// reaches the engine, including the 2024 return as a document), paystubs, the
// Personal workspace's Planning answers, the EK Consulting P&L (computePL), mileage,
// fixed assets and the donation log. Phase 1b also reads the Personal entity's
// "Return completeness" TaxQuestionnaire row (its EFFECTIVE answers, through
// lib/tax2025/answers.ts) for estimated / extension payments, the "stated none"
// statements and the per-person retirement / HSA / tips / overtime answers.
//
// SECURITY / 1c CHECKLIST: this module has NO auth. A page or server action that uses it must call requireAuth() itself and may pass
// only `ret` (and chosen facts) to a client component: never `resolved`, never `loadTy2025RawInputs` output (the full effective
// extraction of every document: payer EINs, addresses, loan last-4). buildTy2025Return's `raw` is already reduced to a document-free summary.

/**
 * Raw inputs WITHOUT the documents' extraction data, names or issuer details: only what a caller needs to explain a result.
 * The full `RawTy2025Inputs` (effective extraction of every document: payer EINs, addresses, loan last-4) never leaves this module's
 * `loadTy2025RawInputs`.
 */
export type SafeRawSummary = Omit<RawTy2025Inputs, "documents"> & {
  documents: { id: string; docType: string; taxYear: number | null; verified: boolean; legacyFormat: boolean; subjectType: string | null }[];
};

export interface Ty2025Build {
  raw: SafeRawSummary;
  resolved: ResolvedFacts;
  facts: Ty2025Facts;
  ret: Ty2025Return;
}

export async function loadTy2025RawInputs(taxYear: 2025): Promise<RawTy2025Inputs | { error: string }> {
  const personal = await getEntityBySlug("personal");
  if (!personal) return { error: "Personal entity not found" };
  const ekc = await getEntityBySlug("ek-consulting");
  const bounds = taxYearBoundsUtc(taxYear);
  const yearEnd = new Date(bounds.endExclusive.getTime() - 1000);

  const [documents, paystubs, workspace, users, donations] = await Promise.all([
    db.document.findMany({ where: { entityId: personal.id, archivedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.paystub.findMany({ where: { entityId: personal.id, archivedAt: null }, orderBy: { id: "asc" } }),
    db.taxWorkspace.findUnique({ where: { entityId_taxYear: { entityId: personal.id, taxYear } } }),
    db.user.findMany({ select: { id: true, name: true }, orderBy: { id: "asc" } }),
    db.donation.findMany({
      where: { entityId: personal.id, archivedAt: null, date: { gte: bounds.start, lt: bounds.endExclusive } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  const questions = workspace
    ? await db.taxQuestion.findMany({ where: { workspaceId: workspace.id }, select: { key: true, answer: true, skippedReason: true }, orderBy: { key: "asc" } })
    : [];
  const planning = planningFromRows(
    questions.map((q) => ({ key: q.key, answer: q.answer, skippedReason: q.skippedReason })),
    { parseDollarAnswerToCents, parseSqftAnswer }
  );

  // The "Return completeness" questionnaire row (read-only; wrapped so a missing table never breaks the loader).
  const completenessDef = questionnaireById(RETURN_COMPLETENESS_ID);
  const completenessRow = completenessDef
    ? await db.taxQuestionnaire
        .findUnique({
          where: { taxYear_entityId_questionnaireId: { taxYear, entityId: personal.id, questionnaireId: RETURN_COMPLETENESS_ID } },
          select: { answers: true, definitionVersion: true },
        })
        .catch(() => null)
    : null;
  let answers: RawAnswers | undefined;
  if (completenessDef && completenessRow) {
    const effective = effectiveAnswers(completenessDef, parseStoredAnswers(completenessRow.answers), [], RC_CONTEXT);
    const parsed = parseCompletenessAnswers(effective, users.map((u) => ({ userId: u.id, name: u.name })));
    answers = {
      statedNone: parsed.statedNone,
      returnAnswers: parsed.returnAnswers,
      ...(parsed.dividendBoxes2b2dConfirmedZero !== undefined ? { dividendBoxes2b2dConfirmedZero: parsed.dividendBoxes2b2dConfirmedZero } : {}),
      ...(parsed.seHealthInsuranceCents !== undefined ? { seHealthInsuranceCents: parsed.seHealthInsuranceCents } : {}),
      ...(parsed.seRetirementCents !== undefined ? { seRetirementCents: parsed.seRetirementCents } : {}),
      ...(parsed.federalEstimates ? { federalEstimates: parsed.federalEstimates } : {}),
      ...(parsed.ctEstimates ? { ctEstimates: parsed.ctEstimates } : {}),
      ...(parsed.federalExtensionPaymentCents !== undefined ? { federalExtensionPaymentCents: parsed.federalExtensionPaymentCents } : {}),
      ...(parsed.ctExtensionPaymentCents !== undefined ? { ctExtensionPaymentCents: parsed.ctExtensionPaymentCents } : {}),
      ...(parsed.federalOverpaymentAppliedCents !== undefined ? { federalOverpaymentAppliedCents: parsed.federalOverpaymentAppliedCents } : {}),
      ...(parsed.ctOverpaymentAppliedCents !== undefined ? { ctOverpaymentAppliedCents: parsed.ctOverpaymentAppliedCents } : {}),
      ...(parsed.ctPriorYearBalancePaidIn2025Cents !== undefined ? { ctPriorYearBalancePaidIn2025Cents: parsed.ctPriorYearBalancePaidIn2025Cents } : {}),
    };
  }
  const returnCompletenessStale = completenessDef !== null && completenessRow !== null && completenessRow.definitionVersion !== completenessDef.version;

  const rawDocs: RawDocument[] = documents.map((d) => {
    const resolved = resolveTaxDocForCompute(d);
    return {
      id: d.id,
      docType: d.docType,
      taxYear: d.taxYear,
      extractionStatus: resolved.extractionStatus,
      extractionData: resolved.extractionData,
      verified: resolved.verified,
      legacyFormat: resolved.legacyFormat,
      reextractIncomplete: resolved.reextractIncomplete,
      subjectType: d.subjectType,
      subjectUserId: d.subjectUserId,
      documentName: d.documentName,
    };
  });

  const stubWithholding = sumPaystubWithholding(
    paystubs.map((p) => ({
      id: p.id,
      payDate: p.payDate,
      extractStatus: p.extractStatus,
      taxBreakdown: p.taxBreakdown,
      additionalWithholding: p.additionalWithholding,
    })),
    taxYear
  );

  // EK Consulting books (read-only P&L), mileage and fixed assets
  let glLines: GlLineFact[] = [];
  let booksEmpty = true;
  let glExcludedTransactionCount = 0;
  let uncodedTransactionCount = 0;
  let mileage: RawTy2025Inputs["ekc"]["mileage"] = [];
  let fixedAssets: FixedAssetFact[] = [];
  if (ekc) {
    // Same filters and UTC window as computePL (lib/reports.ts). computePL silently skips transactions that have no GL
    // code and reports every total as abs(); these two extra READ-ONLY groupBy queries surface (a) the uncoded 2025
    // transactions and (b) the SIGNED net per GL code, so neither can hide a number.
    const txWhere = { entityId: ekc.id, archivedAt: null, transferPairId: null, postedAt: { gte: bounds.start, lte: yearEnd } };
    const [pl, uncodedRows, signedRows, mileageRows, assetRows] = await Promise.all([
      computePL(ekc.id, bounds.start, yearEnd),
      db.transaction.groupBy({ by: ["glCodeId"], where: { ...txWhere, glCodeId: null }, _count: { _all: true } }),
      db.transaction.groupBy({ by: ["glCodeId"], where: { ...txWhere, glCodeId: { not: null } }, _sum: { amount: true } }),
      db.mileageEntry.findMany({ where: { entityId: ekc.id, archivedAt: null, date: { gte: bounds.start, lt: bounds.endExclusive } }, orderBy: [{ date: "asc" }, { id: "asc" }] }),
      db.fixedAsset.findMany({ where: { entityId: ekc.id, archivedAt: null }, orderBy: [{ placedInServiceDate: "asc" }, { createdAt: "asc" }, { id: "asc" }] }),
    ]);
    uncodedTransactionCount = uncodedRows
      .filter((r) => r.glCodeId === null)
      .reduce((n, r) => n + (r._count?._all ?? 0), 0);
    const signedByCode = new Map<string, number>();
    for (const r of signedRows) {
      if (r.glCodeId !== null && r._sum?.amount != null) signedByCode.set(r.glCodeId, dollarsToCents(r._sum.amount));
    }
    const signed = (id: string): { signedCents?: number } => (signedByCode.has(id) ? { signedCents: signedByCode.get(id)! } : {});
    glLines = [
      ...pl.incomeLines.map((l): GlLineFact => ({ glCodeId: l.glCodeId, code: l.code, name: l.name, glType: "revenue", totalCents: dollarsToCents(l.total), ...signed(l.glCodeId) })),
      ...pl.expenseLines.map((l): GlLineFact => ({ glCodeId: l.glCodeId, code: l.code, name: l.name, glType: "expense", totalCents: dollarsToCents(l.total), ...signed(l.glCodeId) })),
    ];
    booksEmpty = glLines.length === 0;
    glExcludedTransactionCount = pl.excludedFromPL.transactionCount;
    mileage = mileageRows.map((m) => ({ id: m.id, miles: m.miles, ratePerMile: m.ratePerMile.toString(), dateIso: toIsoDateInput(m.date) }));
    fixedAssets = assetRows
      .filter((a) => assetCountsForYear(a.placedInServiceDate, taxYear))
      .map(
        (a): FixedAssetFact => ({
          id: a.id,
          description: a.description,
          placedInServiceIso: toIsoDateInput(a.placedInServiceDate),
          costBasisCents: a.costBasisCents,
          isRealProperty: a.isRealProperty,
          landValueCents: a.landValueCents,
          businessUsePercent: a.businessUsePercent,
        })
      );
  }

  const donationFacts: DonationFact[] = donations.map((d) => ({
    id: d.id,
    dateIso: toIsoDateInput(d.date),
    recipient: d.recipient,
    kind: d.kind === "noncash" ? "noncash" : "cash",
    amountCents: d.amountCents,
    substantiation: d.substantiation,
    receiptDocumentId: d.receiptDocumentId,
  }));

  return {
    taxYear,
    people: users.map((u) => ({ userId: u.id, name: u.name })),
    scheduleCOwner: ekc ? inferScheduleCOwner(ekc.name, users) : null,
    documents: rawDocs,
    planning,
    ...(answers ? { answers } : {}),
    returnCompletenessStale,
    primaryResidence: inferPrimaryResidence(rawDocs, taxYear),
    paystubs: { federalWithheldCents: stubWithholding.federalWithholdingCents, ctWithheldCents: stubWithholding.ctWithholdingCents },
    ekc: { glLines, booksEmpty, glExcludedTransactionCount, uncodedTransactionCount, mileage, fixedAssets },
    donations: donationFacts,
  };
}

/**
 * Loads, resolves and computes the TY2025 return for the household. `decisions`
 * are the recorded CPA/owner choices (an override-storage table arrives in a later
 * phase; until then callers pass none and every choice is "default, undecided").
 */
export async function buildTy2025Return(
  taxYear: 2025,
  decisions: Ty2025Decisions = {}
): Promise<Ty2025Build | { error: string }> {
  const raw = await loadTy2025RawInputs(taxYear);
  if ("error" in raw) return raw;
  return buildTy2025FromRaw(raw, decisions);
}

/**
 * The pure tail of buildTy2025Return: resolve + compute from raw inputs that were ALREADY loaded. Exposed so the return review
 * (lib/tax-review-build.ts) can keep the very same raw inputs it computed the return from (one read, no race between two loads).
 */
export function buildTy2025FromRaw(raw: RawTy2025Inputs, decisions: Ty2025Decisions = {}): Ty2025Build {
  const resolved = resolveFacts(raw);
  const ret = computeTy2025Return(resolved.facts, decisions, { conflicts: resolved.conflicts, openItems: resolved.openItems });
  const safeRaw: SafeRawSummary = {
    ...raw,
    documents: raw.documents.map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, legacyFormat: d.legacyFormat, subjectType: d.subjectType })),
  };
  return { raw: safeRaw, resolved, facts: resolved.facts, ret };
}
