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

export interface Ty2025Build {
  raw: RawTy2025Inputs;
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
    db.document.findMany({ where: { entityId: personal.id, archivedAt: null } }),
    db.paystub.findMany({ where: { entityId: personal.id, archivedAt: null } }),
    db.taxWorkspace.findUnique({ where: { entityId_taxYear: { entityId: personal.id, taxYear } } }),
    db.user.findMany({ select: { id: true, name: true } }),
    db.donation.findMany({
      where: { entityId: personal.id, archivedAt: null, date: { gte: bounds.start, lt: bounds.endExclusive } },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  const questions = workspace
    ? await db.taxQuestion.findMany({ where: { workspaceId: workspace.id }, select: { key: true, answer: true, skippedReason: true } })
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
  let mileage: RawTy2025Inputs["ekc"]["mileage"] = [];
  let fixedAssets: FixedAssetFact[] = [];
  if (ekc) {
    const [pl, mileageRows, assetRows] = await Promise.all([
      computePL(ekc.id, bounds.start, yearEnd),
      db.mileageEntry.findMany({ where: { entityId: ekc.id, archivedAt: null, date: { gte: bounds.start, lt: bounds.endExclusive } } }),
      db.fixedAsset.findMany({ where: { entityId: ekc.id, archivedAt: null }, orderBy: [{ placedInServiceDate: "asc" }, { createdAt: "asc" }] }),
    ]);
    glLines = [
      ...pl.incomeLines.map((l): GlLineFact => ({ glCodeId: l.glCodeId, code: l.code, name: l.name, glType: "revenue", totalCents: dollarsToCents(l.total) })),
      ...pl.expenseLines.map((l): GlLineFact => ({ glCodeId: l.glCodeId, code: l.code, name: l.name, glType: "expense", totalCents: dollarsToCents(l.total) })),
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
    ekc: { glLines, booksEmpty, glExcludedTransactionCount, mileage, fixedAssets },
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
  const resolved = resolveFacts(raw);
  const ret = computeTy2025Return(resolved.facts, decisions, { conflicts: resolved.conflicts, openItems: resolved.openItems });
  return { raw, resolved, facts: resolved.facts, ret };
}
