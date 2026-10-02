// Pure, client-safe extraction-state model for documents (no DB, no server
// imports). One function answers "what should the Extraction column say about
// this document, and what can the owner do about it?" so /documents, the Tax
// tab and the server-side run gates all agree.
//
// It COMPOSES the existing helpers rather than copying them:
//   - effectiveDocumentStatus (lib/statement-import): a stale "processing" lock
//     reads as "failed"
//   - hasUsableExtraction (lib/statement-import): data judged by the data, never
//     by the status label (a "complete" label can sit on an unparseable stub)
//
// Meaning of the stored fields (see the plan, section 4):
//   - extractionStatus = "the AI run finished" (null|pending|processing|complete|failed|skipped)
//   - extractionConfirmedAt != null = the owner marked the values verified
//     (a separate fact; the AI output itself is never edited)

import { isTaxDocType } from "@/lib/document-attribution";
import { countCorrections } from "@/lib/extraction-corrections";
import { effectiveDocumentStatus, hasUsableExtraction } from "@/lib/statement-import";
import {
  CURRENT_SCHEMA_VERSION,
  EXPANDED_RAW_DOC_TYPES,
  isUsableTaxExtraction,
} from "@/lib/tax-extraction-schema";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ExtractionKind =
  | "na"
  | "processing"
  | "skipped"
  | "failed"
  | "not_extracted"
  | "verified"
  | "extracted_outdated"
  | "extracted_unverified"
  | "extracted";

export type ExtractionTone = "muted" | "blue" | "red" | "amber" | "green";

export type ExtractionAction = "run" | "retry" | "review" | "reextract" | "extract_anyway";

/** Plain, JSON-serializable (safe to pass from a server component to a client one). */
export interface ExtractionDisplay {
  kind: ExtractionKind;
  label: string;
  tone: ExtractionTone;
  /** Why it failed / what went wrong last time. Never contains document text. */
  reason?: string;
  /** Tooltip-level extra context. */
  hint?: string;
  actions: ExtractionAction[];
  /** Tax doc extracted before the current schema (older format). */
  outdated: boolean;
  /** Number of owner-corrected fields. */
  correctionCount: number;
}

export interface DescribeExtractionInput {
  docType: string;
  extractionStatus: string | null;
  updatedAt: Date;
  extractionData: unknown;
  extractionConfirmedAt: Date | null;
  /** Number of owner-corrected fields (0 = none). */
  correctionCount: number;
  extractionError: string | null;
}

// ── Extractable types ─────────────────────────────────────────────────────────

/**
 * docTypes that have an extraction schema/prompt. `extension` and `other` do
 * not: running them would burn an API call to write a summary nobody uses.
 * Also enforced server-side in runExtraction so every entry point is covered.
 */
export const EXTRACTABLE_DOC_TYPES = [
  "w2",
  "1099",
  "k1",
  "mortgage_interest",
  "property_tax",
  "tax_return",
  "bank_statement",
  "statement",
  "mortgage_statement",
  "insurance_policy",
  "policy",
  "utility_bill",
] as const;

export function isExtractableDocType(docType: string): boolean {
  return (EXTRACTABLE_DOC_TYPES as readonly string[]).includes(docType);
}

/** Statement docs: their "confirmed" lives on BankStatement and means something else. */
function isStatementDocType(docType: string): boolean {
  return docType === "bank_statement" || docType === "statement";
}

// ── Schema currency (legacy / "older format" detection) ───────────────────────

/**
 * Raw docTypes whose extraction schema was expanded (lib/tax-extraction-schema).
 * A stored extraction of one of these without `schemaVersion >=
 * CURRENT_SCHEMA_VERSION` is "older format" and a candidate for re-extraction.
 * Derived from the schema registry (single source of truth).
 */
export const EXPANDED_SCHEMA_DOC_TYPES: readonly string[] = EXPANDED_RAW_DOC_TYPES;

export { CURRENT_SCHEMA_VERSION };

function readSchemaVersion(extractionData: unknown): number {
  if (typeof extractionData !== "object" || extractionData === null) return 1;
  const v = (extractionData as { schemaVersion?: unknown }).schemaVersion;
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

/** False only for a doc type with an expanded schema whose stored data predates it. */
export function isCurrentSchema(docType: string, extractionData: unknown): boolean {
  if (!EXPANDED_SCHEMA_DOC_TYPES.includes(docType)) return true;
  return readSchemaVersion(extractionData) >= CURRENT_SCHEMA_VERSION;
}

// ── Usability ─────────────────────────────────────────────────────────────────

interface ExtractionShape {
  docType?: string;
  data?: Record<string, unknown> | null;
  transactionRows?: unknown[] | null;
}

function asExtraction(extractionData: unknown): ExtractionShape | null {
  if (typeof extractionData !== "object" || extractionData === null || Array.isArray(extractionData)) {
    return null;
  }
  return extractionData as ExtractionShape;
}

/**
 * Real, reviewable data for this document type (judged by the data, not the
 * label). For tax forms "usable" is stronger than "some key exists": at least
 * one money field the schema registry marks as a usable signal must be
 * non-null, so an all-null extraction (the model read nothing) shows as failed
 * instead of "extracted".
 */
export function isUsableExtraction(docType: string, extractionData: unknown): boolean {
  const extraction = asExtraction(extractionData);
  if (!hasUsableExtraction(extraction)) return false;
  return isUsableTaxExtraction(docType, extractionData);
}

// ── Error text ────────────────────────────────────────────────────────────────

export const EXTRACTION_ERROR_MAX_LENGTH = 300;

/**
 * Short, single-line failure reason safe to persist and show: error MESSAGE
 * only (never document text), control characters collapsed, length-capped.
 */
export function sanitizeExtractionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Extraction failed";
  return cleaned.length > EXTRACTION_ERROR_MAX_LENGTH
    ? `${cleaned.slice(0, EXTRACTION_ERROR_MAX_LENGTH - 1)}…`
    : cleaned;
}

// ── describeExtraction ────────────────────────────────────────────────────────

export const NOT_EXTRACTED_TYPE_ERROR = "This document type is not extracted";
export const ALREADY_UP_TO_DATE_ERROR = "Skipped - already up to date";
export const STALE_READING_ERROR = "The AI reading changed - reload the page and review it again.";
export const VERIFIED_REEXTRACT_ERROR =
  "This document is verified. Re-extracting will mark it unverified - confirm to continue.";

const UNUSABLE_COMPLETE_REASON = "Marked extracted but nothing readable was saved";

/**
 * The single source of truth for what the Extraction column shows. First
 * matching rule wins (plan section 5). `now` is injectable for tests.
 */
export function describeExtraction(
  input: DescribeExtractionInput,
  now: number = Date.now()
): ExtractionDisplay {
  const { docType } = input;
  const base = { outdated: false, correctionCount: input.correctionCount };

  // 1. Types with no extraction at all.
  if (!isExtractableDocType(docType)) {
    return { ...base, kind: "na", label: "N/A", tone: "muted", actions: [] };
  }

  const status = effectiveDocumentStatus(input.extractionStatus, input.updatedAt, now);
  const usable = isUsableExtraction(docType, input.extractionData);
  const isTax = isTaxDocType(docType);

  // 2. A live (non-stale) extraction is running.
  if (status === "processing") {
    return {
      ...base,
      kind: "processing",
      label: "Processing...",
      tone: "blue",
      hint: "Extraction is running. Refresh the page in a moment.",
      actions: [],
    };
  }

  if (!usable) {
    // 3. Deliberately skipped.
    if (status === "skipped") {
      return { ...base, kind: "skipped", label: "Skipped", tone: "muted", actions: ["extract_anyway"] };
    }
    // 4. Tried and produced nothing usable.
    if (status === "failed" || status === "complete") {
      let reason: string;
      if (input.extractionError) reason = input.extractionError;
      else if (input.extractionStatus === "processing") reason = "Timed out - the extraction never finished";
      else if (status === "complete") reason = UNUSABLE_COMPLETE_REASON;
      else reason = "Extraction failed";
      return { ...base, kind: "failed", label: "Failed", tone: "red", reason, actions: ["retry"] };
    }
    // 5. Never run (null / pending).
    return { ...base, kind: "not_extracted", label: "Not extracted", tone: "amber", actions: ["run"] };
  }

  // Usable data beats the label: a failed re-extract of a good document stays
  // "extracted" with a small note, never a bare Failed.
  const lastAttemptFailed = status === "failed" || !!input.extractionError;
  const reason = lastAttemptFailed
    ? `Last re-extract failed${input.extractionError ? `: ${input.extractionError}` : ""}`
    : undefined;

  const hasCorrections = input.correctionCount > 0;
  const verified = input.extractionConfirmedAt !== null && status === "complete";

  if (isTax) {
    const outdated = !isCurrentSchema(docType, input.extractionData);
    // 6. Verified (an outdated verified doc keeps this row, with a suffix).
    if (verified) {
      const edits = hasCorrections
        ? ` - ${input.correctionCount} edit${input.correctionCount === 1 ? "" : "s"}`
        : "";
      return {
        kind: "verified",
        label: `Verified${edits}${outdated ? " (older format)" : ""}`,
        tone: "green",
        reason,
        actions: ["review", "reextract"],
        outdated,
        correctionCount: input.correctionCount,
      };
    }
    // 7. Extracted before the current schema.
    if (outdated) {
      return {
        kind: "extracted_outdated",
        label: "Extracted - older format",
        tone: "amber",
        reason,
        hint: "Missing fields the forms need; re-extract to read them",
        actions: ["review", "reextract"],
        outdated: true,
        correctionCount: input.correctionCount,
      };
    }
    // 8. Current schema, not yet verified.
    return {
      kind: "extracted_unverified",
      label: "Extracted - needs review",
      tone: "amber",
      reason,
      actions: ["review", "reextract"],
      outdated: false,
      correctionCount: input.correctionCount,
    };
  }

  // 9. Non-tax, owner-confirmed (statements never show Verified: their
  //    "confirmed" is the import ledger stage on BankStatement).
  if (input.extractionConfirmedAt !== null && !isStatementDocType(docType)) {
    return { ...base, kind: "verified", label: "Verified", tone: "green", reason, actions: ["review"] };
  }
  // 10. Non-tax, extracted.
  return {
    ...base,
    kind: "extracted",
    label: "Extracted",
    tone: "green",
    reason,
    hint: isStatementDocType(docType) ? "Import status lives on the Statements page" : undefined,
    actions: ["review"],
  };
}

// ── Row adapter ───────────────────────────────────────────────────────────────

/** The Document columns describeExtraction needs (matches a Prisma Document row). */
export interface DocumentExtractionRow {
  docType: string;
  extractionStatus: string | null;
  updatedAt: Date;
  extractionData: unknown;
  extractionConfirmedAt: Date | null;
  extractionCorrections: unknown;
  extractionError: string | null;
}

export function describeDocumentRow(
  doc: DocumentExtractionRow,
  now: number = Date.now()
): ExtractionDisplay {
  return describeExtraction(
    {
      docType: doc.docType,
      extractionStatus: doc.extractionStatus,
      updatedAt: doc.updatedAt,
      extractionData: doc.extractionData,
      extractionConfirmedAt: doc.extractionConfirmedAt,
      correctionCount: countCorrections(doc.extractionCorrections),
      extractionError: doc.extractionError,
    },
    now
  );
}

/**
 * Display state + bulk plan for a whole list in one call (kept in lib so the
 * server component never calls Date.now() itself during render).
 */
export function buildExtractionOverview(
  docs: (DocumentExtractionRow & { id: string })[],
  now: number = Date.now()
): { displayById: Record<string, ExtractionDisplay>; plan: BulkExtractionPlan } {
  const displayById: Record<string, ExtractionDisplay> = {};
  for (const d of docs) displayById[d.id] = describeDocumentRow(d, now);
  const plan = planBulkExtraction(
    docs.map((d) => ({
      id: d.id,
      docType: d.docType,
      extractionStatus: d.extractionStatus,
      updatedAt: d.updatedAt,
      extractionData: d.extractionData,
      extractionConfirmedAt: d.extractionConfirmedAt,
      correctionCount: countCorrections(d.extractionCorrections),
      extractionError: d.extractionError,
    })),
    now
  );
  return { displayById, plan };
}

// ── Server-side expectation re-check ──────────────────────────────────────────

export type ExtractionExpectation = "unextracted" | "outdated";

/**
 * Re-checks, against the FRESHLY READ row (not the client's possibly stale
 * view), that a bulk/list action is still wanted. Prevents double-spend from
 * stale tabs: "unextracted" proceeds only for not-extracted/failed docs;
 * "outdated" only for unverified, uncorrected older-format tax docs.
 */
export function meetsExtractionExpectation(
  expectation: ExtractionExpectation,
  input: DescribeExtractionInput,
  now: number = Date.now()
): boolean {
  const display = describeExtraction(input, now);
  if (expectation === "unextracted") {
    return display.kind === "not_extracted" || display.kind === "failed";
  }
  // Not verified, uncorrected. The confirmedAt check is explicit (not just "kind"):
  // a verified document whose forced re-extract died is no longer "complete", so it
  // reads as extracted_outdated, yet runExtraction's verified guard still refuses it.
  return (
    display.kind === "extracted_outdated" && input.correctionCount === 0 && input.extractionConfirmedAt === null
  );
}

// ── Bulk planning ─────────────────────────────────────────────────────────────

/** Max documents one bulk click will run (each is one paid API call). */
export const MAX_BULK_EXTRACT = 25;
/** How many extractions run at once within a bulk click. */
export const BULK_CONCURRENCY = 3;

export interface BulkPlanDoc extends DescribeExtractionInput {
  id: string;
}

export interface BulkExtractionPlan {
  /** Not extracted / failed, extractable, excluding statements, skipped, processing, N/A, verified. */
  missing: string[];
  /** Unverified, uncorrected older-format tax docs. */
  outdated: string[];
  /** Older-format tax docs that are verified or hand-corrected: never bulk-touched. */
  needIndividual: number;
}

export function planBulkExtraction(docs: BulkPlanDoc[], now: number = Date.now()): BulkExtractionPlan {
  const plan: BulkExtractionPlan = { missing: [], outdated: [], needIndividual: 0 };
  for (const doc of docs) {
    const display = describeExtraction(doc, now);
    if (display.kind === "not_extracted" || display.kind === "failed") {
      // Bank/credit statements are the heaviest calls and have their own
      // ledger-aware bulk on the Statements page.
      if (!isStatementDocType(doc.docType)) plan.missing.push(doc.id);
      continue;
    }
    if (display.outdated) {
      if (
        display.kind === "extracted_outdated" &&
        doc.correctionCount === 0 &&
        doc.extractionConfirmedAt === null
      ) {
        plan.outdated.push(doc.id);
      }
      else plan.needIndividual += 1;
    }
  }
  return plan;
}
