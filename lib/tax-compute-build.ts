import { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { computePL } from "@/lib/reports";
import {
  SALT_CAP_MFJ_2025,
  type ComputePersonalTaxReturnInput,
  type MileageEntryInput,
} from "@/lib/tax-compute";
import { sumCtWithholding } from "@/lib/tax-extraction-schema";
import {
  AWAITING_VERIFICATION_STATUS,
  resolveTaxDocForCompute,
  TAX_EXTRACTION_POLICY,
  type TaxExtractionPolicy,
} from "@/lib/tax-extraction-policy";

// ── DB-wiring layer for the tax computation engine (TY2025) ──────────────────
// Resolves real Prisma data (Document, Paystub, MileageEntry, TaxQuestion,
// computePL) into the exact input shape lib/tax-compute.ts#computePersonalTaxReturn
// requires. Mix of pure resolver/classifier/parser functions (no `db` import,
// unit-tested in lib/__tests__/tax-compute-build.test.ts) plus one DB-aware
// orchestrator (buildPersonalTaxComputeInput, imports `db`, not unit-tested —
// matches this repo's established "pure matcher + DB-aware runner" pattern,
// e.g. lib/dedupe.ts / lib/dedupe-runner.ts).
//
// See .claude/pipeline/tax-compute-wiring/01-plan.md for the full live-data
// investigation this module is grounded in. Ground rule (CLAUDE.md #1 /
// carried over from lib/tax-compute.ts): never fabricate a number — every
// value either comes from real stored data or is explicitly null/flagged
// through `buildGaps`.
//
// NOT wired to any live server action/page yet (deliberate scope boundary —
// see plan Risks). No changes to lib/tax-compute.ts itself.

// ── Paystub label classification (grounded in real, live label text) ────────

/**
 * Classifies a Paystub.taxBreakdown entry's label. Two real CT-withholding
 * label variants are confirmed live across the household's 2 real paystubs
 * ("Connecticut State Income Tax" and "CT Income Tax") — both must match.
 * "Connecticut Paid Family"/"CT PFML" are a separate payroll tax (CT PFML),
 * never CT income tax withholding — correctly bucketed as excluded, not
 * ct_income_tax.
 */
export function classifyTaxBreakdownLabel(
  label: string
): "federal_income_tax" | "ct_income_tax" | "fica_or_other_excluded" | "unrecognized" {
  if (/federal/i.test(label) && /income tax/i.test(label)) return "federal_income_tax";
  if (/\b(connecticut|ct)\b/i.test(label) && /income tax/i.test(label)) return "ct_income_tax";
  if (/social security|medicare|paid family|pfml/i.test(label)) return "fica_or_other_excluded";
  return "unrecognized";
}

/**
 * Classifies a Paystub.additionalWithholding entry's label. This array's own
 * schema comment scopes it to exactly "extra federal/state tax money elected
 * on the W-4" — no third category — so any non-federal label here is treated
 * as this household's one resident state (CT). Documented assumption, not a
 * guess: re-check if this household ever has a second state's withholding on
 * a paystub.
 */
export function classifyAdditionalWithholdingLabel(
  label: string
): "federal" | "state_ct" | "unrecognized" {
  if (/federal/i.test(label)) return "federal";
  if (/state|connecticut|\bct\b/i.test(label)) return "state_ct";
  return "unrecognized";
}

export interface PaystubWithholdingInput {
  id: string;
  payDate: Date | null;
  extractStatus: string;
  taxBreakdown: unknown; // Paystub.taxBreakdown Json — { label, amountCents }[] shape expected
  additionalWithholding: unknown;
}

export interface PaystubWithholdingResult {
  federalWithholdingCents: number;
  ctWithholdingCents: number;
  paystubsIncluded: number;
  unrecognizedLabels: { paystubId: string; label: string; amountCents: number }[];
}

/**
 * Filters internally to extractStatus === "complete" && payDate !== null &&
 * payDate's UTC year === taxYear (mirrors computeMileageDeduction's own
 * "caller passes everything, function filters by year" convention). For
 * TY2025 today this returns paystubsIncluded: 0 — both real paystubs are
 * TY2026-dated (2026-08-31/2026-08-28) — which is correct, not a bug.
 */
export function sumPaystubWithholding(
  paystubs: PaystubWithholdingInput[],
  taxYear: number
): PaystubWithholdingResult {
  let federalWithholdingCents = 0;
  let ctWithholdingCents = 0;
  let paystubsIncluded = 0;
  const unrecognizedLabels: PaystubWithholdingResult["unrecognizedLabels"] = [];

  for (const p of paystubs) {
    if (p.extractStatus !== "complete") continue;
    if (!p.payDate || p.payDate.getUTCFullYear() !== taxYear) continue;
    paystubsIncluded += 1;

    const taxBreakdown = Array.isArray(p.taxBreakdown)
      ? (p.taxBreakdown as { label?: unknown; amountCents?: unknown }[])
      : [];
    for (const entry of taxBreakdown) {
      const label = typeof entry.label === "string" ? entry.label : "";
      const amountCents = typeof entry.amountCents === "number" ? entry.amountCents : 0;
      const classification = classifyTaxBreakdownLabel(label);
      if (classification === "federal_income_tax") federalWithholdingCents += amountCents;
      else if (classification === "ct_income_tax") ctWithholdingCents += amountCents;
      else if (classification === "unrecognized") {
        unrecognizedLabels.push({ paystubId: p.id, label, amountCents });
      }
      // fica_or_other_excluded: intentionally excluded from both sums, never
      // treated as unrecognized (it IS recognized — just out of scope).
    }

    const additionalWithholding = Array.isArray(p.additionalWithholding)
      ? (p.additionalWithholding as { label?: unknown; amountCents?: unknown }[])
      : [];
    for (const entry of additionalWithholding) {
      const label = typeof entry.label === "string" ? entry.label : "";
      const amountCents = typeof entry.amountCents === "number" ? entry.amountCents : 0;
      const classification = classifyAdditionalWithholdingLabel(label);
      if (classification === "federal") federalWithholdingCents += amountCents;
      else if (classification === "state_ct") ctWithholdingCents += amountCents;
      else unrecognizedLabels.push({ paystubId: p.id, label, amountCents });
    }
  }

  return { federalWithholdingCents, ctWithholdingCents, paystubsIncluded, unrecognizedLabels };
}

// ── Unparseable-extraction detector (grounded in the real mistagged-1098 doc) ─

/**
 * Flags any document whose extraction fell into
 * lib/doc-extract.ts#parseExtractionResponse's JSON.parse catch branch — the
 * exact literal summary text that branch produces. General, non-magic-string
 * -guessing check (not "does this doc mention 1098") that happens to catch
 * the real live mistagged-Pennymac-as-w2 document precisely, and will catch
 * any future doc/docType mismatch the same way.
 */
export function findUnparseableExtractions(
  documents: {
    id: string;
    docType: string;
    taxYear: number | null;
    extractionStatus: string | null;
    extractionData: unknown;
  }[]
): { id: string; docType: string; taxYear: number | null }[] {
  return documents
    .filter((d) => {
      if (d.extractionStatus !== "complete") return false;
      const summary = (d.extractionData as { summary?: unknown } | null)?.summary;
      return summary === "Could not parse extraction response.";
    })
    .map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear }));
}

// ── W2 / 1099 / itemized-document resolvers ──────────────────────────────────
//
// Pass 3 (document-extraction-status-and-review): the loaders hand these
// resolvers EFFECTIVE extraction data (owner corrections overlaid on the AI read,
// see lib/tax-extraction-policy.ts) shaped exactly like the stored
// extractionData, so the resolvers keep reading `data.<flatKey>`. They also
// receive provenance (`verified`, `legacyFormat`) and report which contributing
// documents are unverified / older-format so the caller can label them in
// buildGaps. The only number-changing behaviour added in pass 3 is documented
// on each function (property tax, 1099-INT box 1, W-2 CT state lines).

/** Provenance the loaders attach to every tax document. Both optional: undefined = unverified / current format. */
export interface DocProvenance {
  /** Owner marked this extraction verified. */
  verified?: boolean;
  /** Extracted before the current schema: newer boxes were never read. */
  legacyFormat?: boolean;
  /** The last re-extract never finished; the stored (previous) reading is still being used. */
  reextractIncomplete?: boolean;
}

export interface W2DocInput extends DocProvenance {
  id: string;
  docType: string;
  taxYear: number | null;
  extractionStatus: string | null;
  extractionData: unknown;
}

/** A contributing document's provenance, for buildGaps labelling. */
export interface DocProvenanceRef {
  id: string;
  label: string;
}

export interface W2SumResult {
  wagesCents: number;
  /**
   * Sum of W-2 box 3 (Social Security wages) and box 7 (Social Security tips) over the included
   * documents, for Schedule SE line 8a (defect D1). NOT wired into the v1 draft (it still passes no
   * priorSocialSecurityWages); the v2 engine (lib/tax2025) reads boxes per person instead.
   */
  socialSecurityWagesCents: number;
  socialSecurityTipsCents: number;
  medicareWagesCents: number;
  federalWithheldCents: number;
  ctWithheldCents: number;
  includedDocs: { id: string; employerName: string | null; wagesCents: number }[];
  unusableDocs: { id: string; reason: string }[];
  /** Included docs whose extraction the owner has not verified. */
  unverifiedDocs: DocProvenanceRef[];
  /** Included docs in the older extraction format. */
  legacyFormatDocs: DocProvenanceRef[];
  /** Included docs with W-2 state lines that are not CT (or have no readable state code). */
  nonCtStateLineDocs: { id: string; label: string; lineCount: number; withheldCents: number }[];
}

/**
 * Filters docType === "w2" && taxYear === input taxYear && extractionStatus
 * === "complete"; requires typeof data.wagesCents === "number" to include a
 * doc (the mistagged-1098 case has no data.wagesCents at all — correctly
 * excluded here and separately caught by findUnparseableExtractions).
 *
 * CT withholding: when the document carries W-2 state lines (current schema:
 * boxes 15-17 as `stateLines`), ONLY lines whose stateCode === "CT" are summed
 * into ctWithheldCents; other states / unreadable codes are excluded and
 * reported (nonCtStateLineDocs). Older documents have no state lines, so the
 * legacy assumption still applies to them: their flat stateWithheldCents is
 * assumed CT (the household's one resident state).
 */
export function sumW2Documents(documents: W2DocInput[], taxYear: number): W2SumResult {
  let wagesCents = 0;
  let socialSecurityWagesCents = 0;
  let socialSecurityTipsCents = 0;
  let medicareWagesCents = 0;
  let federalWithheldCents = 0;
  let ctWithheldCents = 0;
  const includedDocs: W2SumResult["includedDocs"] = [];
  const unusableDocs: W2SumResult["unusableDocs"] = [];
  const unverifiedDocs: DocProvenanceRef[] = [];
  const legacyFormatDocs: DocProvenanceRef[] = [];
  const nonCtStateLineDocs: W2SumResult["nonCtStateLineDocs"] = [];

  for (const doc of documents) {
    if (doc.docType !== "w2" || doc.taxYear !== taxYear) continue;
    if (doc.extractionStatus !== "complete") continue;
    const data = (doc.extractionData as { data?: Record<string, unknown> } | null)?.data;
    if (typeof data?.wagesCents !== "number") {
      unusableDocs.push({
        id: doc.id,
        reason:
          "extraction has no numeric wagesCents — likely a mistagged/garbled document; excluded, never counted as $0",
      });
      continue;
    }
    wagesCents += data.wagesCents;
    if (typeof data.socialSecurityWagesCents === "number") socialSecurityWagesCents += data.socialSecurityWagesCents;
    if (typeof data.socialSecurityTipsCents === "number") socialSecurityTipsCents += data.socialSecurityTipsCents;
    if (typeof data.medicareWagesCents === "number") medicareWagesCents += data.medicareWagesCents;
    if (typeof data.federalWithheldCents === "number") federalWithheldCents += data.federalWithheldCents;
    const employerName = typeof data.employerName === "string" ? data.employerName : null;
    const label = employerName ?? "unknown employer";

    const stateLines = Array.isArray(data.stateLines) ? data.stateLines : [];
    if (stateLines.length > 0) {
      // sumCtWithholding is non-null for a non-empty list.
      ctWithheldCents += sumCtWithholding(stateLines) ?? 0;
      let otherCount = 0;
      let otherCents = 0;
      for (const line of stateLines) {
        const rec = typeof line === "object" && line !== null ? (line as Record<string, unknown>) : {};
        if (rec.stateCode === "CT") continue;
        otherCount += 1;
        if (typeof rec.stateWithheldCents === "number") otherCents += rec.stateWithheldCents;
      }
      if (otherCount > 0) {
        nonCtStateLineDocs.push({ id: doc.id, label, lineCount: otherCount, withheldCents: otherCents });
      }
    } else if (typeof data.stateWithheldCents === "number") {
      ctWithheldCents += data.stateWithheldCents;
    }

    includedDocs.push({ id: doc.id, employerName, wagesCents: data.wagesCents });
    if (doc.verified !== true) unverifiedDocs.push({ id: doc.id, label });
    if (doc.legacyFormat === true) legacyFormatDocs.push({ id: doc.id, label });
  }

  return {
    wagesCents,
    socialSecurityWagesCents,
    socialSecurityTipsCents,
    medicareWagesCents,
    federalWithheldCents,
    ctWithheldCents,
    includedDocs,
    unusableDocs,
    unverifiedDocs,
    legacyFormatDocs,
    nonCtStateLineDocs,
  };
}

export interface Doc1099Input extends DocProvenance {
  id: string;
  docType: string;
  taxYear: number | null;
  extractionStatus: string | null;
  extractionData: unknown;
}

export interface Interest1099Result {
  interestIncomeCents: number;
  federalWithheldCents: number;
  includedDocs: { id: string; payerName: string | null; amountCents: number }[];
  excludedNonInterestDocs: { id: string; formVariant: string | null; amountCents: number }[];
  /** Included docs whose extraction the owner has not verified. */
  unverifiedDocs: DocProvenanceRef[];
  /** Included docs in the older extraction format (interest read from the legacy headline amount). */
  legacyFormatDocs: DocProvenanceRef[];
  /** Included docs where the current schema's interest box 1 differed from the legacy headline amount. */
  box1OverridesLegacyAmountDocs: { id: string; label: string; box1Cents: number; amountCents: number }[];
}

/**
 * Interest income (Form 1040 line 2b = 1099 interest box 1 ONLY, plan Q3: box 3
 * US-savings-bond interest is captured/displayed but not added by default).
 *   1. Current-schema docs: int_box1Cents when it is a number (this includes a
 *      consolidated 1099, whose interest section is its own box 1).
 *   2. Otherwise the legacy rule: formVariant === "1099-INT" counts amountCents
 *      (matches lib/tax-form-plan.ts's interest check); any other variant (e.g.
 *      the real live Robinhood 1099-DIV) is excluded and reported separately,
 *      never silently summed in as "interest."
 * Federal withholding: int_box4Cents when present, else the legacy flat
 * federalWithheldCents but only for a 1099-INT variant doc (DIV/NEC withholding
 * on a consolidated form has no line yet and is not summed, as before).
 */
export function sum1099InterestIncome(documents: Doc1099Input[], taxYear: number): Interest1099Result {
  let interestIncomeCents = 0;
  let federalWithheldCents = 0;
  const includedDocs: Interest1099Result["includedDocs"] = [];
  const excludedNonInterestDocs: Interest1099Result["excludedNonInterestDocs"] = [];
  const unverifiedDocs: DocProvenanceRef[] = [];
  const legacyFormatDocs: DocProvenanceRef[] = [];
  const box1OverridesLegacyAmountDocs: Interest1099Result["box1OverridesLegacyAmountDocs"] = [];

  for (const doc of documents) {
    if (doc.docType !== "1099" || doc.taxYear !== taxYear) continue;
    if (doc.extractionStatus !== "complete") continue;
    const data = (doc.extractionData as { data?: Record<string, unknown> } | null)?.data;
    const formVariant = typeof data?.formVariant === "string" ? data.formVariant : null;
    const amountCents = typeof data?.amountCents === "number" ? data.amountCents : 0;
    const payerName = typeof data?.payerName === "string" ? data.payerName : null;
    const label = payerName ?? "unknown payer";
    const box1 = typeof data?.int_box1Cents === "number" ? data.int_box1Cents : null;

    if (box1 !== null) {
      interestIncomeCents += box1;
      if (typeof data?.int_box4Cents === "number") federalWithheldCents += data.int_box4Cents;
      else if (formVariant === "1099-INT" && typeof data?.federalWithheldCents === "number") {
        federalWithheldCents += data.federalWithheldCents;
      }
      includedDocs.push({ id: doc.id, payerName, amountCents: box1 });
      if (formVariant === "1099-INT" && typeof data?.amountCents === "number" && data.amountCents !== box1) {
        box1OverridesLegacyAmountDocs.push({ id: doc.id, label, box1Cents: box1, amountCents: data.amountCents });
      }
    } else {
      if (formVariant !== "1099-INT") {
        excludedNonInterestDocs.push({ id: doc.id, formVariant, amountCents });
        continue;
      }
      interestIncomeCents += amountCents;
      if (typeof data?.federalWithheldCents === "number") federalWithheldCents += data.federalWithheldCents;
      includedDocs.push({ id: doc.id, payerName, amountCents });
    }
    if (doc.verified !== true) unverifiedDocs.push({ id: doc.id, label });
    if (doc.legacyFormat === true) legacyFormatDocs.push({ id: doc.id, label });
  }

  return {
    interestIncomeCents,
    federalWithheldCents,
    includedDocs,
    excludedNonInterestDocs,
    unverifiedDocs,
    legacyFormatDocs,
    box1OverridesLegacyAmountDocs,
  };
}

export interface ItemizedDocInput extends DocProvenance {
  id: string;
  docType: string;
  taxYear: number | null;
  extractionStatus: string | null;
  extractionData: unknown;
}

export interface ItemizedDocSumResult {
  mortgageInterestCents: number;
  mortgageInterestDocCount: number;
  propertyTaxCents: number;
  /** property_tax documents on file for the year (any amount state). */
  propertyTaxDocCount: number;
  /** property_tax documents that carry an effective paidInTaxYearCents (these are the ones summed). */
  propertyTaxPaidDocCount: number;
  notes: string[];
  /** Contributing docs (mortgage interest, property tax paid) the owner has not verified. */
  unverifiedDocs: DocProvenanceRef[];
  /** Contributing docs in the older extraction format. */
  legacyFormatDocs: DocProvenanceRef[];
}

/**
 * mortgage_interest: sums interestCents across complete docs; always pushes a
 * note when mortgageInterestDocCount > 0 (the monthly-statement-vs-annual-1098
 * ambiguity is structural, not resolved by having more documents) and a
 * different note when the count is 0. 1098 box 10 (box10Cents, often escrowed
 * real-estate taxes) is display-only (plan Q2): it is NEVER added to property
 * tax here (double-count risk against a separate bill; your call).
 *
 * property_tax: propertyTaxCents sums the effective `paidInTaxYearCents` of each
 * complete property_tax document for the tax year. That amount is owner-entered
 * (the AI never fills it: a bill shows what is billed and due, not what was
 * paid), so a bill with no paid amount contributes $0 and says so in the notes.
 * Before pass 3 this was always $0.
 */
export function sumItemizedDocInputs(documents: ItemizedDocInput[], taxYear: number): ItemizedDocSumResult {
  let mortgageInterestCents = 0;
  let mortgageInterestDocCount = 0;
  let propertyTaxCents = 0;
  let propertyTaxDocCount = 0;
  let propertyTaxPaidDocCount = 0;
  const unverifiedDocs: DocProvenanceRef[] = [];
  const legacyFormatDocs: DocProvenanceRef[] = [];
  const notes: string[] = [];
  const box10Docs: { label: string; cents: number }[] = [];

  for (const doc of documents) {
    if (doc.taxYear !== taxYear || doc.extractionStatus !== "complete") continue;
    const data = (doc.extractionData as { data?: Record<string, unknown> } | null)?.data;
    if (doc.docType === "mortgage_interest") {
      if (typeof data?.interestCents === "number") {
        mortgageInterestCents += data.interestCents;
        mortgageInterestDocCount += 1;
        const label = typeof data.servicerName === "string" ? data.servicerName : "mortgage document";
        if (doc.verified !== true) unverifiedDocs.push({ id: doc.id, label });
        if (doc.legacyFormat === true) legacyFormatDocs.push({ id: doc.id, label });
        if (typeof data.box10Cents === "number" && data.box10Cents > 0) {
          box10Docs.push({ label, cents: data.box10Cents });
        }
      }
    } else if (doc.docType === "property_tax") {
      propertyTaxDocCount += 1;
      if (typeof data?.paidInTaxYearCents === "number") {
        propertyTaxCents += data.paidInTaxYearCents;
        propertyTaxPaidDocCount += 1;
        const label = typeof data.jurisdictionName === "string" ? data.jurisdictionName : "property tax bill";
        if (doc.verified !== true) unverifiedDocs.push({ id: doc.id, label });
        if (doc.legacyFormat === true) legacyFormatDocs.push({ id: doc.id, label });
      }
    }
  }

  if (mortgageInterestDocCount > 0) {
    notes.push(
      `${mortgageInterestDocCount} mortgage_interest document(s) with usable extraction summed to $${(
        mortgageInterestCents / 100
      ).toFixed(2)} — the monthly-statement-vs-annual-1098 ambiguity is structural (a caller may be summing monthly statements instead of one annual 1098, or vice versa); verify document period/type before relying on this figure`
    );
  } else {
    notes.push(
      "0 mortgage_interest documents with usable extraction found for this tax year — mortgage interest deduction is $0, not necessarily because none exists (see findUnparseableExtractions for a possibly-mistagged document)"
    );
  }

  for (const b of box10Docs) {
    notes.push(
      `1098 from ${b.label} reports box 10 "other" of $${(b.cents / 100).toFixed(2)} — shown for reference only and NOT added to property tax (it is often escrowed real-estate tax that a separate bill may also cover; whether to count it is your decision)`
    );
  }

  if (propertyTaxDocCount === 0) {
    notes.push("0 property_tax documents uploaded for this tax year — propertyTaxCents is $0");
  } else {
    if (propertyTaxPaidDocCount > 0) {
      notes.push(
        `${propertyTaxPaidDocCount} property_tax document(s) carry a "paid in the tax year" amount that sums to $${(
          propertyTaxCents / 100
        ).toFixed(2)} (Schedule A state/local taxes) — that amount is entered by you on the document's review screen, never read from the bill`
      );
    }
    const withoutPaid = propertyTaxDocCount - propertyTaxPaidDocCount;
    if (withoutPaid > 0) {
      notes.push(
        `${withoutPaid} property_tax document(s) uploaded for this tax year have no "paid in the tax year" amount yet — they contribute $0 until you enter it on the document's review screen (a bill shows what is billed and due, not what was paid)`
      );
    }
  }

  return {
    mortgageInterestCents,
    mortgageInterestDocCount,
    propertyTaxCents,
    propertyTaxDocCount,
    propertyTaxPaidDocCount,
    notes,
    unverifiedDocs,
    legacyFormatDocs,
  };
}

// ── Free-text numeric answer parsers (grounded in the real "skipped" shape) ──

/**
 * If skippedReason is non-null, OR answer is null/undefined/empty string,
 * returns { cents: null, unparseable: false } — genuinely "not answered," not
 * malformed (grounded in the real live shape: retirement_contributions's
 * answer is literally the string "skipped" with skippedReason: "Skipped for
 * now" — a case a naive parser could mistake for "the user typed the word
 * skipped as a dollar figure" if it didn't check skippedReason first).
 * Otherwise, strict regex match required; no match (or a non-string answer)
 * returns { cents: null, unparseable: true }. Never attempts to extract a
 * number out of prose (e.g. the real live "Yes" or "Paid Q1-Q4 estimates
 * totaling $X" answers are correctly unparseable, not silently interpreted).
 */
export function parseDollarAnswerToCents(
  answer: unknown,
  skippedReason: string | null
): { cents: number | null; unparseable: boolean } {
  if (skippedReason !== null) return { cents: null, unparseable: false };
  if (answer === null || answer === undefined || answer === "") return { cents: null, unparseable: false };
  if (typeof answer !== "string") return { cents: null, unparseable: true };

  const match = /^\$?\s*([\d,]+)(\.\d{1,2})?\s*$/.exec(answer.trim());
  if (!match) return { cents: null, unparseable: true };

  const dollarsPart = match[1]!.replace(/,/g, "");
  const centsFraction = match[2]; // e.g. ".5" or ".50", includes the leading dot
  const centsPart = centsFraction ? centsFraction.slice(1).padEnd(2, "0") : "00";
  const cents = Number(dollarsPart) * 100 + Number(centsPart);
  return { cents, unparseable: false };
}

/** Same not-answered/skipped handling as parseDollarAnswerToCents. Strict
 *  digits-only (optionally followed by "sq ft"/"sqft"/"sq.ft.") regex —
 *  rejects any prose. */
export function parseSqftAnswer(
  answer: unknown,
  skippedReason: string | null
): { sqft: number | null; unparseable: boolean } {
  if (skippedReason !== null) return { sqft: null, unparseable: false };
  if (answer === null || answer === undefined || answer === "") return { sqft: null, unparseable: false };
  if (typeof answer !== "string") return { sqft: null, unparseable: true };

  const match = /^(\d{1,5})\s*(sq\s?\.?\s?ft\.?)?$/i.exec(answer.trim());
  if (!match) return { sqft: null, unparseable: true };

  return { sqft: Number(match[1]), unparseable: false };
}

/**
 * Only returns a non-null sqft when eligibilityAnswer === "yes_exclusive" AND
 * parseSqftAnswer(sqftAnswer, sqftSkippedReason) succeeds — a stray sqft
 * number left over after the user answers "no"/"yes_shared" to eligibility is
 * deliberately ignored (with a note explaining why), never used to compute a
 * deduction the household isn't entitled to.
 */
export function resolveHomeOfficeSqft(
  eligibilityAnswer: unknown, // home_office_ekc TaxQuestion.answer
  sqftAnswer: unknown, // home_office_sqft TaxQuestion.answer (new key)
  sqftSkippedReason: string | null
): { sqft: number | null; note: string | null } {
  const parsedSqft = parseSqftAnswer(sqftAnswer, sqftSkippedReason);

  if (eligibilityAnswer !== "yes_exclusive") {
    if (parsedSqft.sqft !== null) {
      return {
        sqft: null,
        note:
          "home office eligibility was not answered 'yes, exclusive use' — a square-footage answer exists but is ignored, since the household hasn't confirmed exclusive-use eligibility for this deduction",
      };
    }
    return {
      sqft: null,
      note: "home office eligibility not confirmed as 'yes, exclusive use' — no home office deduction applied",
    };
  }

  if (parsedSqft.sqft !== null) {
    return { sqft: parsedSqft.sqft, note: null };
  }
  if (parsedSqft.unparseable) {
    return {
      sqft: null,
      note:
        "home office eligibility is confirmed, but the square-footage answer could not be parsed as a plain number — needs a corrected answer",
    };
  }
  return {
    sqft: null,
    note:
      "home office eligibility is confirmed ('yes, exclusive use') but square footage has not been answered yet — deduction is currently $0 though the household is eligible",
  };
}

// ── Extraction-basis gap notes (pass 3) ───────────────────────────────────────

function nameList(refs: DocProvenanceRef[]): string {
  const names = refs.slice(0, 6).map((r) => r.label);
  return refs.length > 6 ? `${names.join(", ")} and ${refs.length - 6} more` : names.join(", ");
}

/**
 * Plain-language notes about WHERE the draft's document-derived numbers come
 * from: unverified AI reads, older-format extractions, and the places the
 * current schema changed what was read. Built from what the resolvers actually
 * returned (never a static list); empty when everything used is verified and
 * current. These notes never change a number.
 */
export function extractionBasisGaps(
  w2Sum: W2SumResult,
  interest1099: Interest1099Result,
  itemizedDocs: ItemizedDocSumResult
): string[] {
  const gaps: string[] = [];

  if (w2Sum.unverifiedDocs.length > 0) {
    gaps.push(
      `${w2Sum.unverifiedDocs.length} of ${w2Sum.includedDocs.length} W-2 document(s) feeding wages/withholding are unverified AI extractions (${nameList(
        w2Sum.unverifiedDocs
      )}) — review and verify them on the Documents screen before relying on wages and withholding`
    );
  }
  if (w2Sum.legacyFormatDocs.length > 0) {
    gaps.push(
      `W-2 document(s) in the older extraction format (${nameList(
        w2Sum.legacyFormatDocs
      )}): state lines, box 12 and box 13 were never read and N/A boxes stay blank until re-extracted; their state withholding is assumed to be Connecticut`
    );
  }
  for (const d of w2Sum.nonCtStateLineDocs) {
    gaps.push(
      `W-2 from ${d.label} has ${d.lineCount} state line(s) that are not Connecticut (or have no readable state code), $${(
        d.withheldCents / 100
      ).toFixed(2)} withheld — excluded from the CT withholding total; verify the state codes on the document's review screen`
    );
  }

  if (interest1099.unverifiedDocs.length > 0) {
    gaps.push(
      `${interest1099.unverifiedDocs.length} 1099 document(s) feeding interest income are unverified AI extractions (${nameList(
        interest1099.unverifiedDocs
      )}) — verify them before relying on line 2b`
    );
  }
  if (interest1099.legacyFormatDocs.length > 0) {
    gaps.push(
      `1099 document(s) in the older extraction format (${nameList(
        interest1099.legacyFormatDocs
      )}): interest is read from the single headline amount because the per-box interest figures were never read; re-extract to capture them`
    );
  }
  for (const d of interest1099.box1OverridesLegacyAmountDocs) {
    gaps.push(
      `1099 from ${d.label}: interest box 1 ($${(d.box1Cents / 100).toFixed(2)}) differs from the headline amount ($${(
        d.amountCents / 100
      ).toFixed(2)}); the draft uses box 1`
    );
  }

  if (itemizedDocs.unverifiedDocs.length > 0) {
    gaps.push(
      `${itemizedDocs.unverifiedDocs.length} document(s) feeding the itemized-deduction inputs are unverified AI extractions or owner-entered, not-yet-verified amounts (${nameList(
        itemizedDocs.unverifiedDocs
      )}) — verify them before relying on mortgage interest / property tax`
    );
  }
  if (itemizedDocs.legacyFormatDocs.length > 0) {
    gaps.push(
      `Itemized-deduction document(s) in the older extraction format (${nameList(
        itemizedDocs.legacyFormatDocs
      )}): the 1098 box detail (points, mortgage insurance, box 10) was never read; re-extract to capture it`
    );
  }
  return gaps;
}

// ── Top-level pure resolver ───────────────────────────────────────────────────

export interface RawPersonalTaxComputeInput {
  taxYear: number;
  /** All Document rows, any taxYear, archivedAt: null, for the personal
   *  entity — sub-resolvers filter by taxYear internally; the full set (not
   *  pre-filtered) is needed so findUnparseableExtractions can scan broadly. */
  personalDocuments: (W2DocInput & Doc1099Input & ItemizedDocInput)[];
  /** All Paystub rows for the personal entity. */
  paystubs: PaystubWithholdingInput[];
  /** This year's TaxWorkspace's questions ([] if no workspace exists yet for this year). */
  taxQuestions: { key: string; answer: unknown; skippedReason: string | null }[];
  /** Already date-filtered to [yearStart, yearEnd] by the caller, matching
   *  app/tax/personal/[year]/page.tsx's existing query pattern. */
  mileageEntries: MileageEntryInput[];
  /** computePL(ekConsultingEntityId, yearStart, yearEnd).totalIncome */
  ekConsultingGlIncomeTotal: Decimal;
  /** computePL(ekConsultingEntityId, yearStart, yearEnd).totalExpenses */
  ekConsultingGlExpenseTotal: Decimal;
}

export interface ResolvedPersonalTaxComputeInput {
  /** Exact shape lib/tax-compute.ts needs. */
  input: ComputePersonalTaxReturnInput;
  /** Wiring-layer-specific caveats, distinct from (and meant to be merged
   *  with, by a future caller) computePersonalTaxReturn's own `gaps` array. */
  buildGaps: string[];
  /** True whenever both GL totals are zero — a hard signal a future
   *  UI/caller must never render scheduleC.netProfit as a trustworthy number
   *  when this is true. */
  scheduleCDataMissing: boolean;
}

/**
 * Pure — wires every resolver above together, assembles the exact
 * ComputePersonalTaxReturnInput (throwing nothing; computePersonalTaxReturn's
 * own taxYear !== 2025 guard is the single source of truth for year
 * validation, this function doesn't duplicate it), and builds `buildGaps` by
 * actually inspecting what each sub-resolver returned (never a static list).
 */
export function resolvePersonalTaxComputeInput(
  raw: RawPersonalTaxComputeInput
): ResolvedPersonalTaxComputeInput {
  const {
    taxYear,
    personalDocuments,
    paystubs,
    taxQuestions,
    mileageEntries,
    ekConsultingGlIncomeTotal,
    ekConsultingGlExpenseTotal,
  } = raw;

  const buildGaps: string[] = [];

  const w2Sum = sumW2Documents(personalDocuments, taxYear);
  const interest1099 = sum1099InterestIncome(personalDocuments, taxYear);
  const itemizedDocs = sumItemizedDocInputs(personalDocuments, taxYear);
  const unparseableExtractions = findUnparseableExtractions(personalDocuments);
  const paystubWithholding = sumPaystubWithholding(paystubs, taxYear);

  // Merge W2 structured withholding + 1099 federal withholding + paystub
  // label-matched withholding — additive so this stays automatically correct
  // once real same-year paystubs exist (contributes $0 for TY2025 today, see
  // plan finding 3).
  const totalFederalWithholdingCents =
    w2Sum.federalWithheldCents + interest1099.federalWithheldCents + paystubWithholding.federalWithholdingCents;
  const totalCtWithholdingCents = w2Sum.ctWithheldCents + paystubWithholding.ctWithholdingCents;

  const findQuestion = (key: string) => taxQuestions.find((q) => q.key === key) ?? null;

  const retirementQ = findQuestion("retirement_contribution_amount");
  const retirementParsed = parseDollarAnswerToCents(retirementQ?.answer ?? null, retirementQ?.skippedReason ?? null);

  const estimatedTaxQ = findQuestion("estimated_tax_payments_amount");
  const estimatedTaxParsed = parseDollarAnswerToCents(
    estimatedTaxQ?.answer ?? null,
    estimatedTaxQ?.skippedReason ?? null
  );

  const homeOfficeEligibilityQ = findQuestion("home_office_ekc");
  const homeOfficeSqftQ = findQuestion("home_office_sqft");
  const homeOffice = resolveHomeOfficeSqft(
    homeOfficeEligibilityQ?.answer ?? null,
    homeOfficeSqftQ?.answer ?? null,
    homeOfficeSqftQ?.skippedReason ?? null
  );

  // ── buildGaps: only what each sub-resolver actually flagged ────────────────
  for (const doc of w2Sum.unusableDocs) {
    buildGaps.push(`W2 document ${doc.id} excluded from wages/withholding totals: ${doc.reason}`);
  }
  if (w2Sum.includedDocs.length > 0) {
    buildGaps.push(
      `W2 documents included in wages total: ${w2Sum.includedDocs
        .map((d) => `${d.employerName ?? "unknown employer"} ($${(d.wagesCents / 100).toFixed(2)})`)
        .join(", ")} — verify each is a distinct real job, not a duplicate/correction, before trusting total wages`
    );
  }
  for (const doc of interest1099.excludedNonInterestDocs) {
    buildGaps.push(
      `1099 document ${doc.id} excluded from interest income (formVariant: ${
        doc.formVariant ?? "unknown"
      }) — not a 1099-INT`
    );
  }
  buildGaps.push(...itemizedDocs.notes);
  buildGaps.push(...extractionBasisGaps(w2Sum, interest1099, itemizedDocs));
  for (const doc of personalDocuments) {
    if (doc.taxYear !== taxYear || doc.extractionStatus !== AWAITING_VERIFICATION_STATUS) continue;
    buildGaps.push(
      `${doc.docType} document ${doc.id} was left out of the draft because only verified extractions are used (verified-only policy) — open it on the Documents screen and mark it verified to include it`
    );
  }
  for (const doc of personalDocuments) {
    if (doc.taxYear !== taxYear || doc.reextractIncomplete !== true) continue;
    buildGaps.push(
      `${doc.docType} document ${doc.id}: the last re-extract did not finish, so the draft is using its previous stored reading — open it on the Documents screen and re-extract or review it`
    );
  }
  for (const doc of unparseableExtractions) {
    buildGaps.push(
      `Document ${doc.id} (docType: ${doc.docType}) has an unparseable extraction — Claude could not fit it into the ${doc.docType} schema, likely a mistagged document; relabel and re-upload to fix`
    );
  }
  for (const label of paystubWithholding.unrecognizedLabels) {
    buildGaps.push(
      `Paystub ${label.paystubId} has an unrecognized withholding label "${label.label}" ($${(
        label.amountCents / 100
      ).toFixed(2)}) — excluded from both federal and CT withholding totals, needs manual review`
    );
  }
  if (retirementParsed.cents === null) {
    buildGaps.push(
      retirementParsed.unparseable
        ? "retirement_contribution_amount answer could not be parsed as a plain dollar figure"
        : "retirement contribution amount not yet answered — no structured retirement contribution figure captured"
    );
  }
  if (estimatedTaxParsed.cents === null) {
    buildGaps.push(
      estimatedTaxParsed.unparseable
        ? "estimated_tax_payments_amount answer could not be parsed as a plain dollar figure — estimated payments assumed $0"
        : "estimated tax payments amount not yet answered — estimated payments assumed $0"
    );
  }
  if (homeOffice.note) {
    buildGaps.push(homeOffice.note);
  }

  const scheduleCDataMissing = ekConsultingGlIncomeTotal.isZero() && ekConsultingGlExpenseTotal.isZero();
  if (scheduleCDataMissing) {
    buildGaps.push(
      `EK Consulting LLC has zero GL-coded transactions for tax year ${taxYear} — Schedule C net profit is computed as $0 income minus deductions, which does NOT reflect real business activity. This number must not be trusted until transactions are synced/imported and GL-coded for this entity.`
    );
  }

  const input: ComputePersonalTaxReturnInput = {
    taxYear,
    wages: new Decimal(w2Sum.wagesCents).div(100),
    medicareWages: new Decimal(w2Sum.medicareWagesCents).div(100),
    interestIncome: new Decimal(interest1099.interestIncomeCents).div(100),
    glIncomeTotal: ekConsultingGlIncomeTotal,
    glExpenseTotal: ekConsultingGlExpenseTotal,
    mileageEntries,
    homeOfficeSqft: homeOffice.sqft,
    mortgageInterestCents: itemizedDocs.mortgageInterestCents,
    propertyTaxCents: itemizedDocs.propertyTaxCents,
    ctIncomeTaxWithheldCents: totalCtWithholdingCents,
    charitableCents: null, // no donation-log data source exists anywhere in the schema
    saltCapCents: SALT_CAP_MFJ_2025 * 100,
    federalWithholdingCents: totalFederalWithholdingCents,
    estimatedPaymentsCents: estimatedTaxParsed.cents,
    ctWithholdingCents: totalCtWithholdingCents,
  };

  return { input, buildGaps, scheduleCDataMissing };
}

/** The Document columns the compute wiring reads (a Prisma Document row satisfies this). */
export interface ComputeDocumentRow {
  id: string;
  docType: string;
  taxYear: number | null;
  extractionStatus: string | null;
  extractionData: unknown;
  extractionCorrections?: unknown;
  extractionConfirmedAt?: Date | null;
}

/**
 * Pure: one Document row -> the document input the resolvers take. Effective
 * values (owner corrections overlaid; verified-else-AI per
 * TAX_EXTRACTION_POLICY) + provenance. For a legacy-shaped, uncorrected
 * document the extractionData handed on is deep-equal to the stored one, so the
 * draft numbers are unchanged.
 */
export function toComputeDocument(
  d: ComputeDocumentRow,
  policy: TaxExtractionPolicy = TAX_EXTRACTION_POLICY
): W2DocInput & Doc1099Input & ItemizedDocInput {
  const resolved = resolveTaxDocForCompute(d, policy);
  return {
    id: d.id,
    docType: d.docType,
    taxYear: d.taxYear,
    extractionStatus: resolved.extractionStatus,
    extractionData: resolved.extractionData,
    verified: resolved.verified,
    legacyFormat: resolved.legacyFormat,
    reextractIncomplete: resolved.reextractIncomplete,
  };
}

// ── DB-aware orchestrator ─────────────────────────────────────────────────────

/**
 * DB-aware (imports `db`), not unit-tested (matches this repo's established
 * "DB-touching wrapper around a tested pure function" precedent). Fetches,
 * mirroring app/tax/personal/[year]/page.tsx's existing query shapes exactly.
 */
export async function buildPersonalTaxComputeInput(
  taxYear: number
): Promise<ResolvedPersonalTaxComputeInput | { error: string }> {
  const personal = await getEntityBySlug("personal");
  if (!personal) {
    // Defensive — shouldn't happen given the seeded Personal entity, but the
    // caller must have a typed way to distinguish this from a real result.
    return { error: "Personal entity not found" };
  }

  const ekConsulting = await getEntityBySlug("ek-consulting");

  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearEnd = new Date(Date.UTC(taxYear, 11, 31, 23, 59, 59));

  const [documents, paystubs, workspace] = await Promise.all([
    db.document.findMany({ where: { entityId: personal.id, archivedAt: null } }),
    db.paystub.findMany({ where: { entityId: personal.id, archivedAt: null } }),
    db.taxWorkspace.findUnique({ where: { entityId_taxYear: { entityId: personal.id, taxYear } } }),
  ]);

  const orchestratorGaps: string[] = [];

  let taxQuestions: { key: string; answer: unknown; skippedReason: string | null }[] = [];
  if (workspace) {
    const questions = await db.taxQuestion.findMany({ where: { workspaceId: workspace.id } });
    taxQuestions = questions.map((q) => ({ key: q.key, answer: q.answer, skippedReason: q.skippedReason }));
  } else {
    orchestratorGaps.push(
      `No tax workspace exists yet for tax year ${taxYear} — no question answers available (home office sqft, retirement contribution amount, and estimated tax payment amount all resolve to unanswered)`
    );
  }

  let mileageEntries: MileageEntryInput[] = [];
  let ekConsultingGlIncomeTotal = new Decimal(0);
  let ekConsultingGlExpenseTotal = new Decimal(0);

  if (ekConsulting) {
    const [mileage, pl] = await Promise.all([
      db.mileageEntry.findMany({
        where: { entityId: ekConsulting.id, archivedAt: null, date: { gte: yearStart, lte: yearEnd } },
      }),
      computePL(ekConsulting.id, yearStart, yearEnd),
    ]);
    mileageEntries = mileage.map((m) => ({ miles: m.miles, ratePerMile: m.ratePerMile, date: m.date }));
    ekConsultingGlIncomeTotal = pl.totalIncome;
    ekConsultingGlExpenseTotal = pl.totalExpenses;
  } else {
    orchestratorGaps.push(
      "EK Consulting entity not found — Schedule C mileage/GL totals unavailable, treated as $0 (see scheduleCDataMissing)"
    );
  }

  const resolved = resolvePersonalTaxComputeInput({
    taxYear,
    personalDocuments: documents.map((d) => toComputeDocument(d)),
    paystubs: paystubs.map((p) => ({
      id: p.id,
      payDate: p.payDate,
      extractStatus: p.extractStatus,
      taxBreakdown: p.taxBreakdown,
      additionalWithholding: p.additionalWithholding,
    })),
    taxQuestions,
    mileageEntries,
    ekConsultingGlIncomeTotal,
    ekConsultingGlExpenseTotal,
  });

  return {
    ...resolved,
    buildGaps: [...orchestratorGaps, ...resolved.buildGaps],
  };
}
