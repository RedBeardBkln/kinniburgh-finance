// How tax documents' extracted values are allowed to feed the Forms page and the
// tax-compute wiring (document-extraction-status-and-review, pass 3).
//
// POLICY (plan Q1, default): "verified_else_ai" - a document's EFFECTIVE values
// (owner corrections overlaid on the AI read) are always used, and everything
// that consumes them says whether the document is verified, an unverified AI
// read, or in the older extraction format. Nothing is ever silent.
//
// To flip to "verified only" later change ONE constant: TAX_EXTRACTION_POLICY.
// Unverified documents are then handed to the unchanged pure resolvers with a
// status that none of them accepts ("awaiting_verification"), so their numbers
// drop out of the draft and out of Forms readiness, and the compute gap notes
// say so. Both modes are unit-tested.
//
// Pure: no DB, no Date.now(), safe for any component.

import { isCurrentSchema, isUsableExtraction } from "@/lib/document-extraction-state";
import { resolveEffectiveExtraction } from "@/lib/extraction-effective";
import { schemaTypeForDocType } from "@/lib/tax-extraction-schema";

export type TaxExtractionPolicy = "verified_else_ai" | "verified_only";

/** THE single switch. Default per plan Q1: use unverified AI reads, but label them. */
export const TAX_EXTRACTION_POLICY: TaxExtractionPolicy = "verified_else_ai";

/** extractionStatus handed to the resolvers for an unverified doc under "verified_only". */
export const AWAITING_VERIFICATION_STATUS = "awaiting_verification";

export interface TaxDocRowInput {
  /** Raw Document.docType. */
  docType: string;
  extractionStatus: string | null;
  extractionData: unknown;
  /** Absent on older callers/tests: treated as "no corrections". */
  extractionCorrections?: unknown;
  /** Absent on older callers/tests: treated as "not verified". */
  extractionConfirmedAt?: Date | null;
}

export interface ResolvedTaxDoc {
  /** Pass this where the resolvers expect Document.extractionStatus. */
  extractionStatus: string | null;
  /** Pass this where the resolvers expect Document.extractionData (effective values). */
  extractionData: unknown;
  /** Owner clicked "Confirm - mark verified" and the AI read is complete. */
  verified: boolean;
  /** Registry keys the owner corrected. */
  correctedKeys: string[];
  /** A tax doc extracted before the current schema (boxes the forms need were never read). */
  legacyFormat: boolean;
  /** True when "verified_only" took this unverified document out of the numbers. */
  excludedByPolicy: boolean;
  /**
   * The row is stuck "processing"/"failed" (a re-extract that never finished) but
   * its stored data is still a usable extraction, so it is used as if "complete"
   * (nothing silently drops out of the draft) and flagged so the caller can say so.
   */
  reextractIncomplete: boolean;
}

/** Statuses a good, previously-extracted doc can be left in by a re-extract that died. */
const UNFINISHED_REEXTRACT_STATUSES: readonly string[] = ["processing", "failed"];

/**
 * Maps one Document row to what the Forms/compute loaders hand the (unchanged)
 * pure resolvers: effective data (corrections overlaid, legacy keys kept), plus
 * provenance. Docs with no tax schema (bank statements, extension, other) pass
 * through untouched. For a legacy-shaped document with no corrections the
 * returned data is deep-equal to the stored data.
 */
export function resolveTaxDocForCompute(
  row: TaxDocRowInput,
  policy: TaxExtractionPolicy = TAX_EXTRACTION_POLICY
): ResolvedTaxDoc {
  if (schemaTypeForDocType(row.docType) === null) {
    return {
      extractionStatus: row.extractionStatus,
      extractionData: row.extractionData,
      verified: false,
      correctedKeys: [],
      legacyFormat: false,
      excludedByPolicy: false,
      reextractIncomplete: false,
    };
  }

  // A forced re-extract claims the row ("processing") while keeping the old,
  // good data; if the function is killed the status never goes back to
  // "complete". The loaders only read "complete" docs, so judge by the data (the
  // same rule describeExtraction uses) and keep using it, labelled. Only
  // processing/failed rows are affected: a "complete" row (every legacy doc) is
  // handed on exactly as before.
  const reextractIncomplete =
    row.extractionStatus !== null &&
    UNFINISHED_REEXTRACT_STATUSES.includes(row.extractionStatus) &&
    isUsableExtraction(row.docType, row.extractionData);
  const statusForCompute = reextractIncomplete ? "complete" : row.extractionStatus;

  const effective = resolveEffectiveExtraction({
    docType: row.docType,
    extractionData: row.extractionData,
    extractionCorrections: row.extractionCorrections ?? null,
    extractionConfirmedAt: row.extractionConfirmedAt ?? null,
  });
  // "Verified" is only meaningful on a finished read (matches describeExtraction):
  // a doc whose re-extract never finished is conservatively treated as unverified.
  const verified = effective.verified && row.extractionStatus === "complete";
  const excludedByPolicy = policy === "verified_only" && !verified && statusForCompute === "complete";

  return {
    extractionStatus: excludedByPolicy ? AWAITING_VERIFICATION_STATUS : statusForCompute,
    extractionData: effective.extractionData,
    verified,
    correctedKeys: effective.correctedKeys,
    legacyFormat: !isCurrentSchema(row.docType, row.extractionData),
    excludedByPolicy,
    reextractIncomplete,
  };
}

// ── Safe-for-the-model document summaries (generateTaxReview) ─────────────────

/** Explicit identifier keys that must never be sent to the model (beyond the EIN/TIN/SSN-suffix rule). */
const IDENTIFIER_KEYS = new Set([
  "stateEmployerId",
  "statePayerId",
  "parcelId",
  "loanNumber",
  "accountNumber",
  "policyNumber",
]);

/** EIN / TIN / SSN / ITIN-like keys (employerEIN, payerEIN, entityEIN, recipientTIN, ...) and known identifier keys. */
export function isIdentifierKey(key: string): boolean {
  return IDENTIFIER_KEYS.has(key) || /(EIN|TIN|SSN|ITIN)$/.test(key) || /^(ein|tin|ssn|itin)$/i.test(key);
}

/**
 * Deep copy with identifier-like keys and null values removed (nulls are noise
 * the model does not need; identifiers are PII the review prompt itself says to
 * mask). Pure; never mutates its input.
 */
export function stripForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripForModel);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isIdentifierKey(key) || v === null || v === undefined) continue;
      out[key] = stripForModel(v);
    }
    return out;
  }
  return value;
}

export const MODEL_DOC_DATA_MAX_CHARS = 1200;

/**
 * One "- docType: summary — {data}" line for the AI tax review prompt, built
 * from EFFECTIVE values, labelled verified / unverified AI extraction / older
 * format, with EIN-like identifiers removed. Under "verified_only" an
 * unverified document's values are withheld (the line says so).
 */
export function buildModelDocLine(
  row: TaxDocRowInput,
  policy: TaxExtractionPolicy = TAX_EXTRACTION_POLICY
): string {
  const resolved = resolveTaxDocForCompute(row, policy);
  const extraction = resolved.extractionData as { summary?: unknown; data?: unknown } | null;
  if (!extraction) return `- ${row.docType}: uploaded (not extracted)`;
  if (resolved.excludedByPolicy) {
    return `- ${row.docType}: uploaded; extracted values withheld because they are not verified yet`;
  }
  const isTaxSchema = schemaTypeForDocType(row.docType) !== null;
  const label = isTaxSchema
    ? ` [${resolved.verified ? "verified by the owner" : "unverified AI extraction"}${
        resolved.legacyFormat ? ", older extraction format" : ""
      }${resolved.reextractIncomplete ? ", last re-extract did not finish" : ""}]`
    : "";
  const summary = typeof extraction.summary === "string" && extraction.summary ? extraction.summary : "no summary";
  let dataPart = "";
  if (extraction.data) {
    const json = JSON.stringify(stripForModel(extraction.data));
    if (json !== "{}") dataPart = ` — ${json.slice(0, MODEL_DOC_DATA_MAX_CHARS)}`;
  }
  return `- ${row.docType}${label}: ${summary}${dataPart}`;
}
